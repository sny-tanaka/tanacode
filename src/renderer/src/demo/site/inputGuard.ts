import type { StageMessage } from './messages';

// ツアーの再生中は、見ている人のマウス・キーボードの操作をアプリに届けない（台本の操作とぶつからないように）。
// 台本の操作（Director が起こす出来事）は isTrusted が false なので通す。
// iframe の中のアプリの画面で動かす。アプリの部品より先に受け取れるよう、アプリを描く前に window の捕捉の段で待つ

const EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'pointermove',
  'mousemove',
  'pointerover',
  'mouseover',
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'paste',
  'dragstart',
  'drop',
];

let active = false;

export function installInputGuard(): void {
  const stop = (e: Event) => {
    if (!active || !e.isTrusted) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    // 知らせはクリック（タップ）とキーで、親のページに出してもらう。スマホでスクロールやピンチをしただけでは出さない（click が起きない）
    if (e.type === 'click' || e.type === 'keydown') window.parent.postMessage({ type: 'demo:blocked' } satisfies StageMessage, '*');
  };
  for (const type of EVENTS) window.addEventListener(type, stop, true);
}

export function setInputBlocked(value: boolean): void {
  active = value;
}
