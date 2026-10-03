import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { applyTranslation, isMostlyForeign, planTranslation, type TranslateResult } from '@shared/translate';
import { errorMessage } from '../errorMessage';
import { ExternalLinkIcon, IconButton, TranslateIcon } from '../icons';
import { Busy } from '../layout/Busy';

// チャットの思考・応答の翻訳。ブロックに出しておくボタンと、ブロックの下に出す訳文。
// 訳すのは Mac の中だけ（main の translate.ts → 同梱の補助プログラム → macOS 標準の翻訳）。
// ボタンは、ブロックが主に日本語でない文のときだけ出す（1 つのブロックの一部だけが英語、ということはないので、全体で見る）

// 使えるか（macOS 15 以降で、補助プログラムがある）。アプリの中で変わらないので、main には一度だけ聞く
let availability: Promise<boolean> | null = null;

// はじめは出さず、画面に出てから（effect で）決める。作業の書き出し（renderToStaticMarkup で思考の行を描く）では
// effect が動かないので、押しても動かないボタンが HTML に入らない
function useTranslateAvailable(wanted: boolean): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    availability ??= window.tanacode.translate.available().then(
      (ok) => ok === true,
      () => false,
    );
    void availability.then((ok) => alive && setAvailable(ok));
    return () => {
      alive = false;
    };
  }, [wanted]);
  return available;
}

// 訳した文（キーは原文）。画面の中だけに持ち、保存はしない。多くなったら古いものから捨てる
const MAX_CACHED = 200;
const cache = new Map<string, string>();

// 覚えたもの（使えるか・訳した文）を捨てる。Storybook がストーリーごとに呼ぶ（前のストーリーの訳文や返事が残らないように）
export function resetBlockTranslation(): void {
  availability = null;
  cache.clear();
}

function remember(text: string, translated: string): void {
  cache.delete(text);
  cache.set(text, translated);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

type Failure = { message: string; needsLanguage?: boolean };
// 訳文を開いているか、訳している途中か、訳せなかったか（どれも、その原文に対してのもの）
type State = { text: string } & ({ kind: 'open'; translated: string } | { kind: 'loading' } | { kind: 'failed'; failure: Failure });

const LANGUAGE_NAMES = new Intl.DisplayNames(['ja'], { type: 'language' });

function languageName(code: string | undefined): string {
  if (!code) return '元の言語';
  try {
    return LANGUAGE_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

function failureOf(result: Extract<TranslateResult, { ok: false }>): Failure {
  const language = languageName(result.source);
  switch (result.error) {
    case 'same-language':
      return { message: '日本語の文なので、訳しませんでした。' };
    case 'not-installed':
      return { message: `翻訳データ（${language}・日本語）が入っていません。システム設定の「一般」→「言語と地域」→「翻訳言語…」から入れてください。`, needsLanguage: true };
    case 'unsupported':
      return { message: result.source ? `${language}は、macOS の翻訳が対応していない言語です。` : '言語を判定できませんでした。' };
    case 'failed':
      return { message: `訳せませんでした（${result.message ?? 'わけは分かりません'}）。` };
  }
}

export type BlockTranslation = {
  // 翻訳のボタン。出さないときは null
  button: ReactNode;
  // ブロックの下に出す訳文・訳している途中・訳せなかったわけ。閉じているときは null
  panel: ReactNode;
};

// text: ブロックの原文 / renderText: 訳文の描き方（応答は Markdown、思考はそのままの文字）
export function useBlockTranslation(text: string, renderText: (translated: string) => ReactNode): BlockTranslation {
  const foreign = useMemo(() => isMostlyForeign(text), [text]);
  const available = useTranslateAvailable(foreign);
  const [state, setState] = useState<State | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 原文が変わったら（書いている途中の応答など）、前の原文の訳文は出さない
  const current = state?.text === text ? state : null;

  const toggle = (e: MouseEvent<HTMLElement>) => {
    // 思考の見出し（summary）の中に置くので、押しても開閉しないようにする
    e.preventDefault();
    e.stopPropagation();
    if (current?.kind === 'loading') return;
    if (current?.kind === 'open') {
      setState(null);
      return;
    }
    // 訳せなかったあと（翻訳データを入れたあとなど）は、そのまま訳し直す。
    // 畳んだ思考で押したときは、訳文が見えるよう開く
    const details = e.currentTarget.closest('details');
    if (details) details.open = true;
    const cached = cache.get(text);
    if (cached !== undefined) {
      setState({ text, kind: 'open', translated: cached });
      return;
    }
    setState({ text, kind: 'loading' });
    const plan = planTranslation(text);
    window.tanacode.translate.run(plan.texts).then(
      (result) => {
        if (result.ok) {
          const translated = applyTranslation(plan, result.texts);
          remember(text, translated);
          if (alive.current) setState((s) => (s?.text === text ? { text, kind: 'open', translated } : s));
        } else if (alive.current) {
          setState((s) => (s?.text === text ? { text, kind: 'failed', failure: failureOf(result) } : s));
        }
      },
      (err: unknown) => {
        if (alive.current) setState((s) => (s?.text === text ? { text, kind: 'failed', failure: { message: `訳せませんでした（${errorMessage(err)}）。` } } : s));
      },
    );
  };

  if (!foreign || !available) return { button: null, panel: null };

  const button = (
    <IconButton
      size="sm"
      icon={TranslateIcon}
      label="日本語訳"
      tip="日本語訳（macOS の翻訳で、Mac の中で訳します）"
      className="chat-translate"
      pressed={current?.kind === 'open'}
      busy={current?.kind === 'loading'}
      onClick={toggle}
    />
  );

  let panel: ReactNode = null;
  if (current?.kind === 'open') {
    panel = (
      <div className="chat-translation">
        <div className="chat-translation-label">日本語訳</div>
        {renderText(current.translated)}
      </div>
    );
  } else if (current?.kind === 'loading') {
    panel = (
      <div className="chat-translation-note">
        <Busy>訳しています…</Busy>
      </div>
    );
  } else if (current?.kind === 'failed') {
    panel = (
      <div className="chat-translation-note failed">
        <span>{current.failure.message}</span>
        {current.failure.needsLanguage && (
          <IconButton size="sm" icon={ExternalLinkIcon} label="システム設定を開く" onClick={() => void window.tanacode.translate.openSettings()} />
        )}
      </div>
    );
  }
  return { button, panel };
}
