import { useEffect, useRef } from 'react';
import { matchShortcut, REPEATING, type Shortcut } from '@shared/shortcuts';
import { markHumanAction } from '../chat/focusWatch';
import { chosenItem, syncKeyLists } from './keyRow';

// メニューバーの「移動」のショートカット（shared/shortcuts.ts）を、画面で動かす。
// キーは、アプリの画面で押したものは画面が受ける（ウインドウで、ほかより先に。エディタ・ターミナルにフォーカスがあっても効くように）。
// アプリ内ブラウザのページで押したもの・メニューを押したものは、main が知らせてくる（window.tanacode.shortcuts.onRun）。
// 動きは、受け持つ部品（エディタ・ブラウザ・ターミナル・App）がそれぞれ useShortcuts で足す。先に足したものから聞き、true を返したら終わる。
// 子の部品は親より先に足すので、App のもの（ほかが受けなかったときのもの）は最後に聞く

type Handler = (shortcut: Shortcut) => boolean;
const handlers: Handler[] = [];

export function useShortcuts(handler: Handler): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const run: Handler = (shortcut) => latest.current(shortcut);
    handlers.push(run);
    return () => {
      handlers.splice(handlers.indexOf(run), 1);
    };
  }, []);
}

// ダイアログ（.overlay）を開いている間は、何もしない（後ろの画面を動かさない）
export function runShortcut(shortcut: Shortcut): void {
  // キー・メニューで人が動かした（チャットの入力欄から移しても、focus.log に残さない）
  markHumanAction();
  if (document.querySelector('.overlay')) return;
  for (const handler of [...handlers]) if (handler(shortcut)) return;
}

// アプリの画面で押したキーを受ける（App に 1 つ）。ショートカットのキーは、ほかの部品（Monaco・xterm・入力欄）に渡さない
export function useShortcutKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const shortcut = matchShortcut({ code: e.code, key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
      if (shortcut) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat || REPEATING.has(shortcut)) runShortcut(shortcut);
        return;
      }
      if (!enterCardByArrow(e)) pickOptionByNumber(e);
    };
    // 数字のキーと、選択肢の頭の番号（global.css）は、キーで入っているときだけにする（enteredByKey）
    const onFocus = (e: FocusEvent) => {
      const target = e.target instanceof HTMLElement && enteredByKey(e.target) ? e.target : null;
      markNumbered(target?.closest<HTMLElement>('[data-answer-card]') ?? null);
    };
    // ウインドウの外・body へ外れた（次に入る先が無い）
    const onBlur = (e: FocusEvent) => {
      if (!e.relatedTarget) markNumbered(null);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onBlur, true);
    const off = window.tanacode.shortcuts.onRun(runShortcut);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onBlur, true);
      off();
    };
  }, []);
}

// キーで入った要素。フォーカスが入ったときに、キーで入ったか（:focus-visible か、focusByKey で移したか）を見て覚えておく
// （Chromium は、マウスで押したボタンでも、そのあとキーを押すと :focus-visible に変えるので、入ったときに見る）。
// 入力欄は、マウスで押しても :focus-visible になるので数えない（カードの入力欄・セッションの名前の欄を押して、キーで入ったことにしない）。
// 数字のキー（ここ）と、一覧の行の枠・矢印キー（keyRow.ts）が使う。ほかのフォーカスの知らせより先に見るよう、読み込んだときに付ける
let keyFocused: Element | null = null;
export const enteredByKey = (el: Element): boolean => keyFocused === el;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      keyFocused = target && (movingByKey(target) || (target.matches(':focus-visible') && !target.matches(TEXT_FIELD))) ? target : null;
    },
    true,
  );
}
// 文字を打つ欄
const TEXT_FIELD = 'input, textarea, select, [contenteditable="true"]';
// 質問・許可のカードの、番号で選べる選択肢（並び順。1〜9 のキーと、頭に出す番号で同じものを使う）
const numberedOptions = (card: HTMLElement) => [...card.querySelectorAll<HTMLButtonElement>('.menu-options > .menu-option')].slice(0, 9);
// 選択肢の頭に番号を出している（キーで入っている）質問・許可のカード。選択肢に data-key-number を付け、global.css がそれを出す
let numbered: HTMLElement | null = null;
function markNumbered(card: HTMLElement | null): void {
  if (numbered && numbered !== card) for (const option of numbered.querySelectorAll<HTMLElement>('[data-key-number]')) delete option.dataset.keyNumber;
  numbered = card;
  if (!card) return;
  for (const option of card.querySelectorAll<HTMLElement>('[data-key-number]')) delete option.dataset.keyNumber;
  numberedOptions(card).forEach((option, i) => (option.dataset.keyNumber = String(i + 1)));
}

// キーで移すフォーカス。キーを押したのがアプリの画面なら、移した先は :focus-visible になり、枠が出る。
// アプリ内ブラウザのページで押した（画面にはキーが届かない）ときや、メニューを押したときは、:focus-visible にならないので、
// 移した先に data-key-focus を付けて、同じ枠を出す（global.css）。外れたら消す。
// フォーカスできない要素（質問のカード・エディタの欄）は、移している間だけ tabindex="-1" を付ける（マウスで押してもフォーカスが入らないよう、ふだんは付けない）
let moving: HTMLElement | null = null;
export function focusByKey(el: HTMLElement): void {
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) {
    el.tabIndex = -1;
    el.dataset.keyTabindex = '';
  }
  moving = el;
  try {
    el.focus();
  } finally {
    moving = null;
  }
  if (document.activeElement !== el) return;
  if (!el.matches(':focus-visible')) el.dataset.keyFocus = '';
  el.addEventListener(
    'blur',
    () => {
      if (el.dataset.keyTabindex !== undefined) {
        el.removeAttribute('tabindex');
        delete el.dataset.keyTabindex;
      }
      // 一覧の行（keyRow）は、行の中へ移ったときも付けたままにする（keyRow が外す）
      if (!el.hasAttribute('data-key-row')) delete el.dataset.keyFocus;
    },
    { once: true },
  );
}

// focusByKey で、今フォーカスを移しているところか（keyRow が、:focus-visible でなくてもキーで入ったと見るため）
export const movingByKey = (el: Element): boolean => moving === el;

// 隠している（hidden の中にある）か
export const isHidden = (el: Element): boolean => !!el.closest('[hidden]');

// 今フォーカスがある欄（タブを持つもの）
export type TabPane = 'editor' | 'browser' | 'terminal';
export function focusedPane(): TabPane | null {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  if (active.closest('.preview-pane')) return 'browser';
  if (active.closest('.terminal-panel')) return 'terminal';
  if (active.closest('section.editor')) return 'editor';
  return null;
}


// 並びの中で、今のものから前後へ delta 進んだもの。wrap なら端から反対の端へ回り、そうでなければ端で止まる。今のものが無ければ先頭
export function stepIn<T>(list: readonly T[], current: T | null | undefined, delta: number, wrap = false): T | null {
  if (list.length === 0) return null;
  const index = current === null || current === undefined ? -1 : list.indexOf(current);
  if (index < 0) return list[0];
  if (wrap) return list[(index + delta + list.length) % list.length];
  return list[Math.max(0, Math.min(list.length - 1, index + delta))];
}

// ⌘1: セッション一覧の、選んでいる行（畳んだ親の子を選んでいれば、その親の行。選んでいなければ先頭の行）
export function focusSessions(): boolean {
  const list = document.querySelector('.sidebar .session-list');
  const row = list?.querySelector<HTMLElement>('.session-row.active') ?? list?.querySelector<HTMLElement>('.session-row.active-within') ?? list?.querySelector<HTMLElement>('.session-row');
  if (!row) return false;
  focusByKey(row);
  return true;
}

// ⌃⌘↑・⌃⌘↓: 一覧に出ている並び（ロック・親子・畳んだもの・アーカイブ済みの開け閉めのまま）で、前後のセッションの行を押す。端では止まる
export function stepSession(delta: number): boolean {
  const rows = [...document.querySelectorAll<HTMLElement>('.sidebar .session-list .session-row')];
  const current = rows.find((row) => row.classList.contains('active')) ?? rows.find((row) => row.classList.contains('active-within'));
  const next = stepIn(rows, current, delta);
  if (!next) return false;
  if (next === current) return true;
  next.click();
  next.scrollIntoView?.({ block: 'nearest' });
  return true;
}

// ⌘2: チャットの入力欄（ターミナルモードなら、Claude Code の画面。新規セッションの画面なら、その入力欄）
export function focusChat(): boolean {
  const pane = document.querySelector('.main > section.claude');
  if (!pane) return false;
  const target = [...pane.querySelectorAll<HTMLElement>('.chat-input-row textarea, .claude-screen .xterm-helper-textarea')].find((el) => !isHidden(el));
  if (!target) return false;
  focusByKey(target);
  return true;
}

// ⌘3: サイドパネルの、開いているパネル。一覧の前にいた行か選んでいる行（エクスプローラーの開いているファイルなど）があればそこ、無ければ最初に止まれるところ
const FOCUSABLE = 'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function focusSide(): boolean {
  const body = [...document.querySelectorAll('.explorer .side-body')].find((el) => !isHidden(el));
  if (!body) return false;
  // 一覧（keyRow の keyList）の行は、Tab で入るのと同じく、今の行だけを数える
  syncKeyLists(body);
  const chosen = [...body.querySelectorAll('[data-key-list]')].map(chosenItem).find((el) => el && !isHidden(el));
  const target = chosen ?? [...body.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => !isHidden(el));
  if (!target) return false;
  focusByKey(target);
  return true;
}

// ⌘⇧A: 待っている質問・許可のカード。選択肢ではなく、カードそのものに入る（続けて Enter を押しても、答えにならない）
export function focusAnswerCard(): boolean {
  const card = [...document.querySelectorAll<HTMLElement>('.main > section.claude [data-answer-card]')].find((el) => !isHidden(el));
  if (!card) return false;
  focusByKey(card);
  return true;
}

// カラムの間の移動（App が受け持つもの）。カラムが無い・何も無いときは false（開きはしない）
export function columnShortcut(shortcut: Shortcut): boolean {
  switch (shortcut) {
    case 'focusSessions':
      return focusSessions();
    case 'focusChat':
      return focusChat();
    case 'focusSide':
      return focusSide();
    case 'focusQuestion':
      return focusAnswerCard();
    case 'previousSession':
      return stepSession(-1);
    case 'nextSession':
      return stepSession(1);
    default:
      return false;
  }
}

// ⌘⇧A でキーで入ったカード（カードそのもの）で ↓ を押すと、最初の選択肢へ移る（選択肢の間は、keyRow の keyList が ↑↓ で移す）。
// ↑ は、今までどおりチャットのスクロールに使う
function enterCardByArrow(e: KeyboardEvent): boolean {
  if (e.key !== 'ArrowDown' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return false;
  const card = document.activeElement;
  if (!(card instanceof HTMLElement) || !card.matches('[data-answer-card]') || !enteredByKey(card)) return false;
  const option = numberedOptions(card).find((el) => !el.disabled);
  if (!option) return false;
  e.preventDefault();
  focusByKey(option);
  return true;
}

// 質問のカードにキーで入っている間、1〜9 でその番号の選択肢へフォーカスを移す（答えるのは Enter）。
// カードの中の入力欄で打った数字は、文字として入れる。マウスで選択肢を押したあと（:focus-visible でない）は、何もしない（直す前と同じ）
function pickOptionByNumber(e: KeyboardEvent): void {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active.matches(TEXT_FIELD)) return;
  const card = active.closest<HTMLElement>('[data-answer-card]');
  if (!card || !enteredByKey(active)) return;
  const option = numberedOptions(card)[Number(e.key) - 1];
  if (!option || option.disabled) return;
  e.preventDefault();
  focusByKey(option);
}
