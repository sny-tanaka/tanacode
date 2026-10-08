// デモのサイトの操作係。画面の上に作り物のマウスカーソルを描いて動かし、ホバー・クリック・文字入力をする。
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

// 待ち時間の倍率（環境変数 VITE_DEMO_WAIT。ビルドや開発サーバーの起動のときに渡す）。台本の待ち時間・カーソルの移動・説明を読む間にかける。
// 1 がふだん（既定）、0.5 で半分。0 なら待たずに、ずっと早送りと同じ速さで流す（CI でツアーが最後まで流れるかを確かめるとき）
const WAIT = waitScale(import.meta.env.VITE_DEMO_WAIT);

function waitScale(value: unknown): number {
  const n = Number(value ?? 1);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

// 待たずに流すか（早送りの間か、倍率が 0）。待ち時間は飛ばしても、画面が描き直す間だけは待つ
function quick(): boolean {
  return fast || WAIT === 0;
}

// 台本の待ち時間。止められるよう、100ms ずつ進める。早送りの間は、1 回だけ短く待って終える
export async function sleep(ms: number): Promise<void> {
  let left = quick() ? ms : ms * WAIT;
  for (;;) {
    while (paused) await resumed;
    if (left <= 0) return;
    const q = quick();
    const step = Math.min(left, q ? FAST_STEP_MS : 100);
    await new Promise<void>((r) => setTimeout(r, step));
    left = q ? 0 : left - step;
  }
}

export type Target = string | Element | (() => Element | null | undefined);

// 操作の説明が指す場所（アプリの画面の座標。null は、場所を指さない説明）
export type CaptionBox = { x: number; y: number; width: number; height: number };

// 説明を読む間。次の操作（カーソルを動かす・押す・打つ）は、説明を出してからこの時間が経つまで待つ
function readingMs(text: string): number {
  return Math.min(4500, Math.max(1500, 700 + text.length * 40));
}

const CURSOR_SVG = `
<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 2.5 L4 18 L8.2 14 L11 20.2 L13.6 19 L10.9 12.9 L16.6 12.9 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
</svg>`;

export class Director {
  private readonly cursor: HTMLDivElement;
  private x = 0;
  private y = 0;
  private hovered: Element | null = null;
  // デモのサイトで、いま見せている操作の説明を出す（box は説明が指す場所。場所が動いたら、そのたびに知らせる）
  onCaption: (text: string, box: CaptionBox | null) => void = () => {};
  // いまの説明と、その場所を照らす枠
  private captionText = '';
  private captionTarget: Target | null = null;
  private captionBox: CaptionBox | null = null;
  private readUntil = 0;
  private readonly spotlight: HTMLDivElement;
  private readonly dim: HTMLDivElement;
  private tracking = 0;

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
    // 説明が指す場所を照らす枠と、まわりを少し暗くする幕（場所の形に穴を開けて、場所だけを明るく残す）。カーソルより下に出す。
    // 暗くするのに枠の影（box-shadow の 100vmax など）は使わない。影の分だけ画面の何倍もの大きさの層になり、
    // 枠が動く間は iPhone の Safari がそれを端末の解像度で描き直すので、メモリを食ってページが落ちる。幕は画面と同じ大きさで済む
    const dim = document.createElement('div');
    dim.className = 'demo-spotlight-dim';
    Object.assign(dim.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '9997',
      pointerEvents: 'none',
      background: 'rgba(0,0,0,0.32)',
      opacity: '0',
      transition: 'opacity 0.25s ease-out, clip-path 0.3s ease-out',
    });
    document.body.appendChild(dim);
    this.dim = dim;
    const spot = document.createElement('div');
    spot.className = 'demo-spotlight';
    Object.assign(spot.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '9998',
      pointerEvents: 'none',
      borderRadius: '8px',
      border: '2px solid #f0a35e',
      boxShadow: '0 0 0 3px rgba(240,163,94,0.35)',
      opacity: '0',
      transition: 'opacity 0.25s ease-out, transform 0.3s ease-out, width 0.3s ease-out, height 0.3s ease-out',
    });
    document.body.appendChild(spot);
    this.spotlight = spot;
  }

  dispose(): void {
    this.clearCaption();
    this.cursor.remove();
    this.spotlight.remove();
    this.dim.remove();
  }

  // 照らす枠と幕を出す・消す
  private light(on: boolean): void {
    this.spotlight.style.opacity = on ? '1' : '0';
    this.dim.style.opacity = on ? '1' : '0';
  }

  // 操作の説明。target を渡すと、その場所を照らし、デモのサイトは説明の吹き出しをそこに向けて出す
  // （まだ無い要素は、出てきたところで照らす）。次の操作は、説明を読む間が経つまで待つ。早送りの間は何もしない
  caption(text: string, target: Target | null = null): void {
    if (fast) return;
    this.captionText = text;
    this.captionTarget = target;
    this.captionBox = null;
    this.readUntil = Date.now() + readingMs(text) * WAIT;
    this.light(false);
    this.onCaption(text, null);
    if (target && !this.tracking) this.tracking = requestAnimationFrame(this.track);
    else if (!target) this.stopTracking();
  }

  // 説明を消す（章の変わり目・ツアーの終わり）
  clearCaption(): void {
    this.captionText = '';
    this.captionTarget = null;
    this.captionBox = null;
    this.readUntil = 0;
    this.light(false);
    this.stopTracking();
  }

  private stopTracking(): void {
    if (this.tracking) cancelAnimationFrame(this.tracking);
    this.tracking = 0;
  }

  // 説明が指す場所を追いかける。動いたり出たり消えたりしたら、枠を動かし、デモのサイトにも知らせる
  private readonly track = () => {
    this.tracking = 0;
    if (!this.captionTarget) return;
    const el = resolve(this.captionTarget);
    const r = el?.isConnected ? el.getBoundingClientRect() : null;
    const box = r && r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
    const prev = this.captionBox;
    const moved = !box !== !prev || (box && prev && (Math.abs(box.x - prev.x) > 1 || Math.abs(box.y - prev.y) > 1 || Math.abs(box.width - prev.width) > 1 || Math.abs(box.height - prev.height) > 1));
    if (moved) {
      this.captionBox = box;
      if (box) {
        const pad = 4;
        Object.assign(this.spotlight.style, {
          transform: `translate(${box.x - pad}px, ${box.y - pad}px)`,
          width: `${box.width + pad * 2}px`,
          height: `${box.height + pad * 2}px`,
        });
        // 幕に、枠の外側の線まで含めた穴を開ける（外から左の辺を通って穴を一周し、外へ戻る）
        const [l, t, r, b] = [box.x - pad, box.y - pad, box.x + box.width + pad, box.y + box.height + pad];
        this.dim.style.clipPath = `polygon(0 0, 0 100%, ${l}px 100%, ${l}px ${t}px, ${r}px ${t}px, ${r}px ${b}px, ${l}px ${b}px, ${l}px 100%, 100% 100%, 100% 0)`;
        this.light(true);
      } else this.light(false);
      this.onCaption(this.captionText, box);
    }
    this.tracking = requestAnimationFrame(this.track);
  };

  // 説明が指す場所の外を操作するときは、照らすのをやめる（吹き出しはそのまま）。暗いところを操作して見えにくくならないように
  private leaveSpotlight(el: Element | null): void {
    if (!this.captionTarget || !el) return;
    const lit = resolve(this.captionTarget);
    // まだ出ていない場所は、出てきたところで照らすので、追いかけ続ける
    if (!lit?.isConnected || lit.contains(el) || el.contains(lit)) return;
    this.light(false);
    this.captionTarget = null;
    this.stopTracking();
  }

  // 説明を読む間が経つまで待つ（操作の前に呼ぶ）
  private async waitReading(): Promise<void> {
    if (quick()) return;
    // readUntil は倍率をかけたあとの時刻なので、sleep がかける倍率の分を戻して待つ
    const left = this.readUntil - Date.now();
    if (left > 0) await sleep(left / WAIT);
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
    await this.waitReading();
    const el = await this.find(target);
    this.leaveSpotlight(el);
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2 + dx;
    const y = r.top + r.height / 2 + dy;
    if (quick()) ms = 0;
    this.place(x, y, ms * WAIT);
    await sleep(ms);
    this.hover(document.elementFromPoint(x, y) ?? el);
    return el;
  }

  async click(target: Target, opts: { ms?: number; dx?: number; dy?: number } = {}): Promise<void> {
    const el = await this.moveTo(target, opts);
    // 押せるようになるまで待つ。無効のボタンを押しても何も起きず、台本は押したあとの知らせ（書き出し・送信など）を待ち続けてしまう。
    // 待ち時間を 0 にして流すときや遅い端末では、ボタンが押せる状態になる前に押しに来ることがある
    if (el.matches(':disabled')) {
      await this.find(() => (el.matches(':disabled') ? null : el)).catch(() => {
        throw new Error(`demo: 押せるようになりません: ${String(target)}`);
      });
    }
    await sleep(120);
    const at = document.elementFromPoint(this.x, this.y);
    this.pressAt(at && el.contains(at) ? at : el);
    await sleep(250);
  }

  // 画面の座標へ動かす（Monaco の行番号の横など、要素の中心ではないところ）
  async moveToPoint(x: number, y: number, ms = 700): Promise<void> {
    await this.waitReading();
    this.leaveSpotlight(document.elementFromPoint(x, y));
    if (quick()) ms = 0;
    this.place(x, y, ms * WAIT);
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
    await this.waitReading();
    const el = (await this.find(target)) as HTMLTextAreaElement | HTMLInputElement;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    if (quick()) {
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
