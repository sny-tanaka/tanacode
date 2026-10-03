// ツアーの再生中は、見ている人のマウス・キーボードの操作をアプリに届けない（台本の操作とぶつからないように）。
// 台本の操作（Director が起こす出来事）は isTrusted が false なので通す。上の帯と機能一覧（.demo-ui の中）は触れる。
// アプリの部品より先に受け取れるよう、アプリを描く前に window の捕捉の段で待つ

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

// 操作を止めたことを知らせる出来事（window に送る。帯に「再生中は操作できません」と出す）
export const INPUT_BLOCKED = 'demo:input-blocked';

let active = false;

export function installInputGuard(): void {
  const stop = (e: Event) => {
    if (!active || !e.isTrusted) return;
    if (e.target instanceof Element && e.target.closest('.demo-ui')) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type === 'pointerdown' || e.type === 'keydown') window.dispatchEvent(new Event(INPUT_BLOCKED));
  };
  for (const type of EVENTS) window.addEventListener(type, stop, true);
}

export function setInputBlocked(value: boolean): void {
  active = value;
}
