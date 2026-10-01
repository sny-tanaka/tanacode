import { token } from '../theme';
import { codeBlock, inlineCode, stripControlChars } from '../chat/sanitize';

// アプリ内ブラウザのページに差し込んで、要素を 1 つ選んでもらうスクリプト。
// マウスを乗せた要素を枠で示し、クリックした要素の情報を返す（Esc で null）。ページのクリック処理は動かさない
export type PickedElement = {
  url: string;
  selector: string;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
};

// 色はアプリのトークンを埋め込む（ページ側ではアプリの CSS を読めない）。
// 枠の中の塗りは、下のページが見えるように ide の色の 15% の半透明にする（アプリの画面ではなくページに重ねるもの）
export function pickerScript(): string {
  const accent = token('ide');
  const onAccent = token('text-on-fill');
  return `(() => new Promise((resolve) => {
  window.__tanacodePickCancel?.();
  const box = document.createElement('div');
  const label = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', border: '1.5px solid ${accent}', background: '${accent}26', borderRadius: '3px', display: 'none' });
  Object.assign(label.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', padding: '2px 6px', borderRadius: '4px', background: '${accent}', color: '${onAccent}', font: '11px/1.5 Menlo, monospace', whiteSpace: 'nowrap', display: 'none' });
  document.documentElement.append(box, label);
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + CSS.escape(el.id);
    const classes = [...el.classList].filter((c) => !/^(css|sc|jsx)-|[0-9a-f]{5,}/i.test(c)).slice(0, 2);
    if (classes.length) s += '.' + classes.map((c) => CSS.escape(c)).join('.');
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    return s;
  };
  const selectorOf = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement && parts.length < 6; e = e.parentElement) {
      parts.unshift(name(e));
      if (e.id || e === document.body) break;
    }
    return parts.join(' > ');
  };
  let current = null;
  const show = (el) => {
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    label.textContent = name(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    Object.assign(label.style, { display: 'block', left: Math.max(0, r.left) + 'px', top: (r.top > 22 ? r.top - 22 : r.bottom + 4) + 'px' });
  };
  const block = (e) => { e.preventDefault(); e.stopPropagation(); };
  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== box && el !== label) show(el);
  };
  const cleanup = () => {
    removeEventListener('mousemove', move, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) removeEventListener(t, block, true);
    removeEventListener('click', click, true);
    removeEventListener('keydown', key, true);
    box.remove();
    label.remove();
    delete window.__tanacodePickCancel;
  };
  const click = (e) => {
    block(e);
    const el = current || e.target;
    cleanup();
    const r = el.getBoundingClientRect();
    resolve({
      url: location.href,
      selector: selectorOf(el),
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      html: el.outerHTML.length > 1500 ? el.outerHTML.slice(0, 1500) + '…' : el.outerHTML,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      viewport: { width: innerWidth, height: innerHeight },
    });
  };
  const key = (e) => {
    if (e.key !== 'Escape') return;
    block(e);
    cleanup();
    resolve(null);
  };
  window.__tanacodePickCancel = () => { cleanup(); resolve(null); };
  addEventListener('mousemove', move, true);
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) addEventListener(t, block, true);
  addEventListener('click', click, true);
  addEventListener('keydown', key, true);
}))()`;
}

export const CANCEL_PICKER_SCRIPT = `window.__tanacodePickCancel?.()`;

// 1 行に収める。値はページの中で作るので（ページのスクリプトが書き換えられる）、改行や制御文字が入りうる
const oneLine = (s: unknown) => stripControlChars(String(s ?? '')).replace(/\s+/g, ' ').trim();

// Claude への指示に添える文章
export function describePicked(p: PickedElement): string {
  const lines = [`アプリ内ブラウザ（${oneLine(p.url)}）で選んだ要素:`, `- セレクタ: ${inlineCode(oneLine(p.selector))}`];
  const text = oneLine(p.text);
  if (text) lines.push(`- テキスト: 「${text}」`);
  // html に ``` が入っていてもフェンスから抜けられないよう、フェンスは中身より長くする
  lines.push(codeBlock(stripControlChars(String(p.html ?? '')), 'html'), '');
  return lines.join('\n');
}
