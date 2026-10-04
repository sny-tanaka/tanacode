// デモ動画とデモのサイトの操作係。画面の上に作り物のマウスカーソルを描いて動かし、ホバー・クリック・文字入力をする。
// 録画は画面の外で描いたコマを撮るので OS のカーソルは映らない。代わりにこのカーソルを映す

// デモのサイトの一時停止。止めている間は、台本の待ち時間を進めない
let paused = false;
let resume: () => void = () => {};
let resumed = Promise.resolve();

export function setPaused(value: boolean): void {
  if (value === paused) return;
  paused = value;
  if (value) resumed = new Promise<void>((r) => (resume = r));
  else resume();
}

// デモのサイトの早送り。目次から途中の章へ飛ぶとき・「次の章へ」を押したときに、それまでの台本を手早く流す。
// 待ち時間を短く切り詰め（画面が描き直す間だけ待つ）、カーソルは飛ばして動かし、文字は一度に入れる
let fast = false;
const FAST_STEP_MS = 30;

export function setFastForward(value: boolean): void {
  fast = value;
}

export function isFastForward(): boolean {
  return fast;
}

// 台本の待ち時間。止められるよう、100ms ずつ進める。早送りの間は、1 回だけ短く待って終える
export async function sleep(ms: number): Promise<void> {
  let left = ms;
  for (;;) {
    while (paused) await resumed;
    if (left <= 0) return;
    const step = Math.min(left, fast ? FAST_STEP_MS : 100);
    await new Promise<void>((r) => setTimeout(r, step));
    left = fast ? 0 : left - step;
  }
}

type Target = string | Element | (() => Element | null | undefined);

const CURSOR_SVG = `
<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 2.5 L4 18 L8.2 14 L11 20.2 L13.6 19 L10.9 12.9 L16.6 12.9 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
</svg>`;

export class Director {
  private readonly cursor: HTMLDivElement;
  private x = 0;
  private y = 0;
  private hovered: Element | null = null;
  // デモのサイトで、いま見せている操作の説明を出す（動画では何も出さない）
  onCaption: (text: string) => void = () => {};

  constructor(start: { x: number; y: number } = { x: window.innerWidth * 0.6, y: window.innerHeight * 0.7 }) {
    const el = document.createElement('div');
    el.className = 'demo-cursor';
    el.innerHTML = CURSOR_SVG;
    Object.assign(el.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '10000',
      pointerEvents: 'none',
      willChange: 'transform',
      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))',
    });
    document.body.appendChild(el);
    this.cursor = el;
    this.place(start.x, start.y, 0);
  }

  dispose(): void {
    this.cursor.remove();
  }

  // 操作の説明（デモのサイトの上の帯に出す）
  caption(text: string): void {
    this.onCaption(text);
  }

  // 要素が出るまで待つ（最大 timeout ms。一時停止している間は数えない）
  async find(target: Target, timeout = 8000): Promise<Element> {
    for (let waited = 0; ; waited += 50) {
      const el = resolve(target);
      if (el) return el;
      if (waited > timeout) throw new Error(`demo: 要素が見つかりません: ${String(target)}`);
      await sleep(50);
    }
  }

  // 文字を含む要素（selector に当たるもののうち、text を含む最初のもの）
  byText(selector: string, text: string): () => Element | null {
    return () => [...document.querySelectorAll(selector)].find((e) => e.textContent?.includes(text)) ?? null;
  }

  // 要素の上（中心から dx, dy ずらした位置）へ、なめらかに動かす。ホバーの出来事も起こす
  async moveTo(target: Target, { ms = 700, dx = 0, dy = 0 }: { ms?: number; dx?: number; dy?: number } = {}): Promise<Element> {
    const el = await this.find(target);
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2 + dx;
    const y = r.top + r.height / 2 + dy;
    if (fast) ms = 0;
    this.place(x, y, ms);
    await sleep(ms);
    this.hover(document.elementFromPoint(x, y) ?? el);
    return el;
  }

  async click(target: Target, opts: { ms?: number; dx?: number; dy?: number } = {}): Promise<void> {
    const el = await this.moveTo(target, opts);
    await sleep(120);
    const at = document.elementFromPoint(this.x, this.y);
    this.pressAt(at && el.contains(at) ? at : el);
    await sleep(250);
  }

  // 画面の座標へ動かす（Monaco の行番号の横など、要素の中心ではないところ）
  async moveToPoint(x: number, y: number, ms = 700): Promise<void> {
    if (fast) ms = 0;
    this.place(x, y, ms);
    await sleep(ms);
    const el = document.elementFromPoint(x, y);
    if (el) this.hover(el);
  }

  async clickPoint(x: number, y: number, ms = 700): Promise<void> {
    await this.moveToPoint(x, y, ms);
    await sleep(120);
    const el = document.elementFromPoint(x, y);
    if (el) this.pressAt(el);
    await sleep(250);
  }

  private pressAt(hit: Element): void {
    this.press();
    const init = { bubbles: true, cancelable: true, clientX: this.x, clientY: this.y, view: window, button: 0 };
    hit.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    hit.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
    hit.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    hit.dispatchEvent(new MouseEvent('mouseup', init));
    // ボタンの中のアイコン（SVG の線）に当たったときは click() が無いので、出来事を送って親のボタンまで届ける
    if (hit instanceof HTMLElement) hit.click();
    else hit.dispatchEvent(new MouseEvent('click', init));
  }

  // 入力欄に 1 文字ずつ打つ（React の onChange が動くよう、値を差し替えて input の出来事を起こす）
  async type(target: Target, text: string, perChar = 45): Promise<void> {
    const el = (await this.find(target)) as HTMLTextAreaElement | HTMLInputElement;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    if (fast) {
      setter.call(el, el.value + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(1);
      return;
    }
    for (const ch of text) {
      setter.call(el, el.value + ch);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(perChar + (/[、。！？\s]/.test(ch) ? perChar * 2 : 0));
    }
  }

  private place(x: number, y: number, ms: number): void {
    this.x = x;
    this.y = y;
    this.cursor.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.45, 0, 0.25, 1)` : 'none';
    // カーソルの先（SVG の左上の少し内側）を座標に合わせる
    this.cursor.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
  }

  private hover(el: Element): void {
    const init = { bubbles: true, clientX: this.x, clientY: this.y, view: window };
    // Monaco などは、要素に入ったことではなく、動いた位置を見る
    el.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousemove', init));
    if (el === this.hovered) return;
    if (this.hovered) {
      this.hovered.dispatchEvent(new MouseEvent('mouseout', { ...init, relatedTarget: el }));
      this.hovered.dispatchEvent(new PointerEvent('pointerout', { ...init, relatedTarget: el }));
    }
    el.dispatchEvent(new MouseEvent('mouseover', { ...init, relatedTarget: this.hovered }));
    el.dispatchEvent(new PointerEvent('pointerover', { ...init, relatedTarget: this.hovered }));
    this.hovered = el;
  }

  // クリックしたところに、広がって消える輪を出す
  press(): void {
    const ring = document.createElement('div');
    Object.assign(ring.style, {
      position: 'fixed',
      left: `${this.x - 14}px`,
      top: `${this.y - 14}px`,
      width: '28px',
      height: '28px',
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.8)',
      zIndex: '9999',
      pointerEvents: 'none',
      transition: 'transform 0.35s ease-out, opacity 0.35s ease-out',
      transform: 'scale(0.4)',
      opacity: '1',
    });
    document.body.appendChild(ring);
    requestAnimationFrame(() => {
      ring.style.transform = 'scale(1.3)';
      ring.style.opacity = '0';
    });
    setTimeout(() => ring.remove(), 450);
  }
}

function resolve(target: Target): Element | null {
  if (typeof target === 'string') return document.querySelector(target);
  if (typeof target === 'function') return target() ?? null;
  return target;
}
