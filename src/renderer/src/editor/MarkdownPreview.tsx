import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { t } from '@shared/i18n';
import { marked, replaceExternalImages } from '../markdown';
import { token } from '../theme';
import { editorTheme, monaco } from './monaco';

// 入力のたびに描き直さないよう、少し待ってからまとめて描く
const RENDER_DELAY_MS = 150;
// 描き直すたびに、コードの色付け・mermaid の図をやり直さないよう、できたものを中身ごとに覚えておく（上限を超えたら古いものから捨てる）
const CACHE_LIMIT = 200;

// プレビューで描いてよいタグと属性（チャットの SANITIZE と同じ考え方で、明示の許可リストにする）。リポジトリの文書には HTML が
// 混ざるので、チャットより少し広く、GitHub が描くもの（中央寄せ・折りたたみ・キー・上付きなど）は残す。
// 見た目を偽るもの（style・class）、フォーム・ボタン・埋め込み・音や動画（外を読みにいく）は描かない。
// class はコードの言語の印（language-*）だけ、入力欄はタスクリストのチェックボックスだけを、消毒のあとで残す。
// 文書の中の目印（<a id>・<a name>）は、GitHub と同じく前置き（user-content-）を付けて残す（アプリの画面の id とぶつけない）
const SANITIZE = {
  ALLOWED_TAGS: [
    ...['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'blockquote', 'pre', 'code'],
    ...['strong', 'b', 'em', 'i', 'del', 's', 'ins', 'mark', 'sub', 'sup', 'small', 'kbd', 'abbr', 'q', 'cite', 'var', 'samp', 'wbr'],
    ...['ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
    ...['a', 'img', 'figure', 'figcaption', 'details', 'summary', 'input'],
  ],
  ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'width', 'height', 'start', 'align', 'colspan', 'rowspan', 'open', 'lang', 'dir', 'class', 'type', 'checked', 'disabled', 'id', 'name'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  SANITIZE_NAMED_PROPS: true,
};
// 消毒が id・name に付ける前置き（DOMPurify の SANITIZE_NAMED_PROPS）
const USER_CONTENT = 'user-content-';

// 消毒のあとで、class はコードの言語の印だけ、入力欄はタスクリストのチェックボックス（押しても変わらない）だけにする
function keepPreviewParts(root: DocumentFragment): void {
  for (const el of root.querySelectorAll('[class]')) {
    const language = el.tagName === 'CODE' ? [...el.classList].find((c) => /^language-[\w+#-]+$/.test(c)) : undefined;
    if (language) el.className = language;
    else el.removeAttribute('class');
  }
  for (const input of root.querySelectorAll('input')) {
    if (input.getAttribute('type') !== 'checkbox') input.remove();
    else input.setAttribute('disabled', '');
  }
}

type Props = {
  sessionId: string;
  path: string;
  // 編集中（未保存）の内容もそのまま映す
  model: monaco.editor.ITextModel;
  onOpenFile: (path: string, line?: number) => void;
};

// Markdown ファイルを整形して表示する。コードは Monaco と同じ色付け、mermaid は図にし、
// リポジトリ内の画像と相対リンク（別の .md など）も開けるようにする。外の画像は読み込まず、リンクにする
export function MarkdownPreview({ sessionId, path, model, onOpenFile }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(() => model.getValue());
  // 読み込んだ画像（パス → data URL）。描き直すたびに main から読み直さない。ディスク上で何か変わったら捨てて、次に描くときに読み直す
  const images = useRef(new Map<string, Promise<string | null>>());

  useEffect(() => {
    const cache = images.current;
    cache.clear();
    const off = window.tanacode.workspace.onFilesChanged(() => cache.clear());
    return () => {
      off();
      cache.clear();
    };
  }, [sessionId]);

  useEffect(() => {
    setText(model.getValue());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = model.onDidChangeContent(() => {
      timer ??= setTimeout(() => {
        timer = null;
        setText(model.getValue());
      }, RENDER_DELAY_MS);
    });
    return () => {
      sub.dispose();
      if (timer) clearTimeout(timer);
    };
  }, [model]);

  useEffect(() => {
    const root = ref.current!;
    let cancelled = false;
    // 文書として読むので、チャットと違い単独の改行は段落内の空白として扱う（GitHub と同じ）
    const html = marked.parse(text, { async: false, gfm: true, breaks: false });
    // 部品に分けてから差し込む。innerHTML に入れると、書き換える前の相対パスの画像を読みにいってしまう
    const fragment = DOMPurify.sanitize(html, { ...SANITIZE, RETURN_DOM_FRAGMENT: true });
    keepPreviewParts(fragment);
    // 外の画像（http(s)）は読み込まず、ブラウザで開くリンクにする
    replaceExternalImages(fragment);
    for (const img of fragment.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? '';
      if (isExternal(src) || src.startsWith('data:')) continue;
      img.removeAttribute('src');
      const target = resolvePath(path, src);
      if (target) img.dataset.path = target;
    }
    addHeadingIds(fragment);
    root.replaceChildren(fragment);

    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-path]')) {
      const target = img.dataset.path!;
      let url = images.current.get(target);
      if (!url) {
        url = window.tanacode.workspace.readImage(sessionId, target).catch(() => null);
        images.current.set(target, url);
      }
      void url.then((loaded) => {
        if (!cancelled && loaded) img.src = loaded;
      });
    }
    // 同じ図が文書の中に何回目に出てきたか（図ごとに覚えておくので、2 回目からは別に描く）
    const diagrams = new Map<string, number>();
    for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
      const lang = /language-([\w+#-]+)/.exec(code.className)?.[1]?.toLowerCase();
      if (lang === 'mermaid') {
        const source = code.textContent ?? '';
        const nth = diagrams.get(source) ?? 0;
        diagrams.set(source, nth + 1);
        void renderMermaid(code, nth, () => cancelled);
      }
      else if (lang) void colorize(code, lang, () => cancelled);
    }
    return () => {
      cancelled = true;
    };
  }, [text, path, sessionId]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    if (href.startsWith('#')) {
      // 見出し・文書の中の目印（どちらも前置きを付けた id・name）へ移る。URL として読めないもの（#100% など）は、書いたままの名前で探す
      let target = href.slice(1);
      try {
        target = decodeURIComponent(target);
      } catch {
        // 書いたまま
      }
      // 前置きまで書いたもの（#user-content-install。GitHub では効く）は、書いたままの名前でも探す（探すのはプレビューの中だけ）
      const names = [`${USER_CONTENT}${target}`, ...(target.startsWith(USER_CONTENT) ? [target] : [])].map((name) => CSS.escape(name));
      ref.current?.querySelector(names.map((name) => `[id="${name}"], [name="${name}"]`).join(', '))?.scrollIntoView({ block: 'start' });
      return;
    }
    // 外部のページはブラウザで開く（メインプロセスが window.open を受けて開く）
    if (isExternal(href)) {
      window.open(href);
      return;
    }
    const [file, hash = ''] = href.split('#');
    const target = resolvePath(path, file);
    const line = /^L(\d+)/.exec(hash)?.[1];
    if (target) onOpenFile(target, line ? Number(line) : undefined);
  };

  return (
    <div className="markdown-preview" onClick={onClick}>
      <div className="markdown markdown-doc" ref={ref} />
    </div>
  );
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

// Markdown ファイルからの相対パスを、リポジトリのルートからのパスにする（/ で始まるものはルートから）
function resolvePath(from: string, href: string): string | null {
  let target: string;
  try {
    target = decodeURIComponent(href);
  } catch {
    target = href;
  }
  if (!target) return null;
  const parts = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

// 見出しへのリンク（#使い方 など）が効くよう、GitHub と同じ形の id を付ける。前置き（user-content-）も GitHub と同じく付ける
// （アプリの画面の id や、mermaid が図を描くときの id（mermaid-1 など。同じ id の要素を消してから描く）とぶつけない）
function addHeadingIds(root: DocumentFragment): void {
  const used = new Map<string, number>();
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = (h.textContent ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    h.id = `${USER_CONTENT}${n ? `${base}-${n}` : base}`;
  }
}

// コードの言語の印 → Monaco の言語（描き直すたびに、コードごとに言語の一覧を探さない）
const languageIds = new Map<string, string | null>();

function languageId(lang: string): string | null {
  const known = languageIds.get(lang);
  if (known !== undefined) return known;
  const found = monaco.languages
    .getLanguages()
    .find(
      (l) =>
        l.id === lang ||
        l.aliases?.some((a) => a.toLowerCase() === lang) ||
        l.extensions?.some((ext) => ext.toLowerCase() === `.${lang}`),
    );
  return remember(languageIds, lang, found?.id ?? null);
}

// key → できたもの。上限を超えたら、いちばん古く入れたものを捨てる
function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return value;
}

// 言語とコード → 色付けした HTML
const colorized = new Map<string, Promise<string>>();
let themeSet = false;

async function colorize(code: HTMLElement, lang: string, cancelled: () => boolean): Promise<void> {
  const id = languageId(lang);
  if (!id) return;
  // 色付けは今のテーマを使うので、エディタより先に開いたときもアプリのテーマにしておく（テーマは変わらないので、はじめの 1 回だけ）
  if (!themeSet) {
    monaco.editor.setTheme(editorTheme());
    themeSet = true;
  }
  const text = code.textContent ?? '';
  const key = `${id}\n${text}`;
  const html = await (colorized.get(key) ?? remember(colorized, key, monaco.editor.colorize(text, id, { tabSize: 2 })));
  if (!cancelled()) code.innerHTML = html;
}

let mermaidLoader: Promise<typeof import('mermaid').default> | null = null;
let mermaidSeq = 0;
// 図の文（と、文書の中で何回目か）→ 描いた SVG（描けなければ、そのエラー）。mermaid の SVG は、描いたときの id（mermaid-1 など）で
// 色と矢印の形を当てるので、同じ図が 1 つの文書に 2 回あるときは、2 つめを別の id で描く（同じ SVG を並べると id が重なる）
const mermaidDrawn = new Map<string, Promise<{ svg: string } | { error: unknown }>>();

async function renderMermaid(code: HTMLElement, nth: number, cancelled: () => boolean): Promise<void> {
  // 大きいので、図があるときだけ読み込む
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    // 図の色もアプリのトークンに合わせる（base テーマに色を渡す）
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: token('font-ui'),
      themeVariables: {
        background: token('bg-surface'),
        primaryColor: token('bg-surface'),
        primaryBorderColor: token('border-strong'),
        primaryTextColor: token('text-primary'),
        textColor: token('text-primary'),
        lineColor: token('text-secondary'),
        secondaryColor: token('bg-hover'),
        tertiaryColor: token('bg-panel'),
        fontFamily: token('font-ui'),
      },
    });
    return mermaid;
  });
  const loader = mermaidLoader;
  const pre = code.parentElement!;
  const source = code.textContent ?? '';
  const key = `${nth}\n${source}`;
  const drawn = await (mermaidDrawn.get(key) ??
    remember(
      mermaidDrawn,
      key,
      loader.then((mermaid) => mermaid.render(`mermaid-${++mermaidSeq}`, source)).then(
        ({ svg }) => ({ svg }),
        (error: unknown) => ({ error }),
      ),
    ));
  if (cancelled()) return;
  if ('svg' in drawn) {
    const figure = document.createElement('div');
    figure.className = 'markdown-mermaid';
    figure.innerHTML = drawn.svg;
    pre.replaceWith(figure);
  } else {
    const err = drawn.error;
    const note = document.createElement('div');
    note.className = 'markdown-mermaid-error';
    note.textContent = t('editor.markdownPreview.diagramFailed', { error: err instanceof Error ? err.message : String(err) });
    pre.after(note);
  }
}
