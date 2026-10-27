import type { FocusLostReport } from '@shared/ipc';

// チャットの入力欄から、人の操作でないのにフォーカスが外れたら、知らせる（main がアプリのログ userData/focus.log に書く）。
// 「打っている途中で急にフォーカスが外れる」不具合の原因を突き止められなかったので、次に起きたときに読めるようにする。
// - 人の操作とみなすもの: 外れる直前（HUMAN_MS 以内）にマウス・タッチで押した、か、入力欄で変換していないキーを押した（Tab・ショートカットで出た）。
//   変換中のキー（予測変換の候補を選ぶ Tab など）のあとに外れたものは残す
// - ウインドウごと離れた（ほかのアプリへ移った）ときは残さない
// - 入力欄が消えた・押せなくなった・隠れたときは、focusout が届かないことがある。外れた知らせが無いまま、キーが body に届いたら、そのときに残す
// 重くしない: 聞くのは、押す・キー・変換の始まりと終わり・フォーカスの出入りだけ（どれも、控えを書き換えるだけ）。調べて送るのは外れたときだけ。
// マウスの動きは変えない（どのイベントも止めない）
const INPUT = '.chat-input textarea';
const HUMAN_MS = 1000;
// 続けて外れたときに、送りすぎない
const MIN_INTERVAL_MS = 500;
const MAX_STACK = 4000;
// スタックに残す深さ（React の effect から呼んだときも、呼んだ部品まで届くように）
const STACK_FRAMES = 40;
// 変換が終わってから外れるまでがこれより短ければ、変換の途中で外れたとみなす（変換を終わらせたのは、外したこと）
const COMPOSED_MS = 50;

type Options = {
  report: (report: FocusLostReport) => void;
  now?: () => number;
  // ウインドウにフォーカスがあるか（テストで差し替える）
  hasFocus?: () => boolean;
  // 外れた先が決まるのを待つ（focusout のときは、まだ document.activeElement が決まっていない）
  later?: (run: () => void) => void;
};

// 要素を、ログで見分けられる短い文字にする（タグ・id・クラス・ラベルと、どの欄の中か）
export function describeElement(el: Element | null): string {
  if (!el) return 'null';
  if (el === document.body) return 'body';
  const id = el.id ? `#${el.id}` : '';
  const classes = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
  const label = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').slice(0, 60);
  const pane = el.closest('.terminal-panel, .preview-pane, .editor-pane, .diff-pane, .chat-list, .sidebar, .side-panel, .overlay, .menu-card, .claude-header');
  const where = pane && pane !== el ? ` in .${String(pane.className).trim().split(/\s+/)[0]}` : '';
  return `${el.tagName.toLowerCase()}${id}${classes}${label ? `[${label}]` : ''}${where}`;
}

const isVisible = (el: HTMLElement) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0);

export function watchChatFocus({
  report,
  now = () => performance.now(),
  hasFocus = () => document.hasFocus(),
  later = (run) => setTimeout(run, 0),
}: Options): () => void {
  let pointer: { at: number; target: string } | null = null;
  let key: (Omit<NonNullable<FocusLostReport['lastKey']>, 'msAgo'> & { at: number; inInput: boolean; composing: boolean }) | null = null;
  let composing = false;
  // 変換が終わった時刻。Chromium は、フォーカスが移るときに、focusout より先に変換を終わらせる（compositionend）ので、その直前まで変換中だったかをこれで見る
  let composedAt = Number.NEGATIVE_INFINITY;
  // フォーカスのある入力欄（外れたら null）
  let input: HTMLTextAreaElement | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;

  const human = (at: number) =>
    (pointer !== null && at - pointer.at < HUMAN_MS) || (key !== null && key.inInput && !key.composing && at - key.at < HUMAN_MS);

  const send = (reason: FocusLostReport['reason'], el: HTMLTextAreaElement, to: Element | null, stack: string | null, wasComposing: boolean) => {
    const at = now();
    if (human(at) || at - sentAt < MIN_INTERVAL_MS) return;
    sentAt = at;
    report({
      reason,
      to: describeElement(to),
      lastPointer: pointer && { msAgo: Math.round(at - pointer.at), target: pointer.target },
      lastKey: key && {
        msAgo: Math.round(at - key.at),
        key: key.key,
        code: key.code,
        keyCode: key.keyCode,
        isComposing: key.isComposing,
        modifiers: key.modifiers,
      },
      composing: wasComposing,
      input: { connected: el.isConnected, disabled: el.disabled, readOnly: el.readOnly, visible: el.isConnected && isVisible(el) },
      visibility: document.visibilityState,
      stack: stack && stack.slice(0, MAX_STACK),
    });
  };

  const onPointerDown = (e: PointerEvent) => {
    pointer = { at: now(), target: describeElement(e.target instanceof Element ? e.target : null) };
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const modifiers = [e.metaKey && '⌘', e.ctrlKey && '⌃', e.altKey && '⌥', e.shiftKey && '⇧'].filter(Boolean).join('');
    const isComposing = e.isComposing || e.keyCode === 229;
    key = { at: now(), key: e.key, code: e.code, keyCode: e.keyCode, isComposing, modifiers, inInput: e.target === input, composing: isComposing || composing };
    // 外れた知らせが無いまま、キーが入力欄の外（body）に届いた: 入力欄が消えた・押せなくなった・隠れた
    if (input && document.activeElement !== input && (e.target === document.body || e.target === document.documentElement)) {
      const el = input;
      input = null;
      const reason = !el.isConnected ? 'removed' : el.disabled ? 'disabled' : !isVisible(el) ? 'hidden' : 'unknown';
      send(reason, el, document.activeElement, null, composing);
    }
  };
  const onCompositionStart = (e: CompositionEvent) => {
    if (e.target instanceof Element && e.target.matches(INPUT)) composing = true;
  };
  const onCompositionEnd = () => {
    if (composing) composedAt = now();
    composing = false;
  };
  const onFocusIn = (e: FocusEvent) => {
    if (e.target instanceof HTMLTextAreaElement && e.target.matches(INPUT)) input = e.target;
  };
  const onFocusOut = (e: FocusEvent) => {
    if (!input || e.target !== input) return;
    const el = input;
    input = null;
    // 外した処理は、focusout を出させたもの（focus()・blur() の呼び出し）の中にいる。今ここで取る
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = STACK_FRAMES;
    const stack = new Error().stack ?? null;
    Error.stackTraceLimit = limit;
    const related = e.relatedTarget instanceof Element ? e.relatedTarget : null;
    const wasComposing = composing || now() - composedAt < COMPOSED_MS;
    composing = false;
    later(() => {
      if (!hasFocus()) return;
      send(el.isConnected ? 'focusout' : 'removed', el, document.activeElement && document.activeElement !== document.body ? document.activeElement : related ?? document.activeElement, stack, wasComposing);
    });
  };

  const listeners: [string, EventListener][] = [
    ['pointerdown', onPointerDown as EventListener],
    ['keydown', onKeyDown as EventListener],
    ['compositionstart', onCompositionStart as EventListener],
    ['compositionend', onCompositionEnd],
    ['focusin', onFocusIn as EventListener],
    ['focusout', onFocusOut as EventListener],
  ];
  for (const [type, listener] of listeners) document.addEventListener(type, listener, { capture: true, passive: true });
  // 起動したときに、もう入力欄にフォーカスがある（autoFocus）
  if (document.activeElement instanceof HTMLTextAreaElement && document.activeElement.matches(INPUT)) input = document.activeElement;
  return () => {
    for (const [type, listener] of listeners) document.removeEventListener(type, listener, { capture: true });
  };
}
