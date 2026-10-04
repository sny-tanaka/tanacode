// デモ用の、Electron の <webview> の代わり。Storybook（ふつうのブラウザ）では webview が動かないので、
// PreviewPane が document.createElement('webview') で作る要素を、iframe で作り物のページを出すこの要素に差し替える。
// PreviewPane が使うメソッド（getURL・executeJavaScript・capturePage など）と出来事（did-start-loading など）だけを持つ

export type DemoPage = { title: string; css: string; body: string };

const TAG = 'demo-webview';
let pageFor: (url: string) => DemoPage | null = () => null;
const views = new Set<DemoWebview>();

class DemoWebview extends HTMLElement {
  private readonly frame = document.createElement('iframe');
  private url = '';

  constructor() {
    super();
    Object.assign(this.frame.style, { width: '100%', height: '100%', border: '0', display: 'block', background: '#fff' });
  }

  connectedCallback(): void {
    this.style.display = this.style.display === 'none' ? 'none' : 'block';
    if (!this.frame.isConnected) this.appendChild(this.frame);
    views.add(this);
    if (this.url) this.load(true);
  }

  disconnectedCallback(): void {
    views.delete(this);
  }

  get src(): string {
    return this.url;
  }

  set src(url: string) {
    this.url = url;
    if (this.isConnected) this.load(true);
  }

  // 開発サーバーのホットリロードのように、読み込み中の表示を出さずに描き直す
  refresh(): void {
    this.load(false);
  }

  private load(withEvents: boolean): void {
    const page = pageFor(this.url);
    if (withEvents) this.dispatchEvent(new Event('did-start-loading'));
    this.frame.onload = () => {
      if (!withEvents) return;
      this.dispatchEvent(new Event('did-navigate'));
      this.dispatchEvent(new Event('did-stop-loading'));
    };
    this.frame.srcdoc = page
      ? `<!doctype html><html><head><meta charset="utf-8"><title>${page.title}</title><style>html,body{margin:0}${page.css}</style></head><body>${page.body}</body></html>`
      : '<!doctype html><p style="font:14px sans-serif;padding:24px">このページは開けません</p>';
  }

  getURL(): string {
    return this.url;
  }
  canGoBack(): boolean {
    return false;
  }
  canGoForward(): boolean {
    return false;
  }
  goBack(): void {}
  goForward(): void {}
  reload(): void {
    this.load(true);
  }
  stop(): void {}
  openDevTools(): void {}
  focus(): void {
    this.frame.focus();
  }

  // ページの中でスクリプトを動かす（要素選びのスクリプトは Promise を返す）
  executeJavaScript<T>(code: string): Promise<T> {
    const win = this.frame.contentWindow as (Window & { eval: (code: string) => unknown }) | null;
    if (!win) return Promise.reject(new Error('demo: ページがありません'));
    // 作り物のページの location は about:srcdoc なので、開いている URL に読み替える
    return Promise.resolve(win.eval(code.replaceAll('location.href', JSON.stringify(this.url))) as T);
  }

  // ページの一部を画像にする（ページの中身を SVG の foreignObject に写して描く）
  async capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<{ isEmpty(): boolean; toDataURL(): string }> {
    const doc = this.frame.contentDocument!;
    const width = doc.documentElement.clientWidth;
    const height = doc.documentElement.clientHeight;
    const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    const body = new XMLSerializer().serializeToString(doc.body).replace(/^<body/, '<div class="demo-body"').replace(/<\/body>$/, '</div>');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px"><style>${css.replace(/\bbody\b/g, '.demo-body')}</style>${body}</div></foreignObject></svg>`;
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    const r = rect ?? { x: 0, y: 0, width, height };
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = r.width * scale;
    canvas.height = r.height * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.drawImage(image, -r.x, -r.y, width, height);
    const url = canvas.toDataURL('image/png');
    return { isEmpty: () => false, toDataURL: () => url };
  }

  // ページの中の要素（台本がマウスを動かす先）と、その画面上の位置
  pageElement(selector: string): { el: Element; x: number; y: number } | null {
    const el = this.frame.contentDocument?.querySelector(selector);
    if (!el) return null;
    const frame = this.frame.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { el, x: frame.left + r.left + r.width / 2, y: frame.top + r.top + r.height / 2 };
  }

  // ページの中にマウスの出来事を送る（x, y は画面上の位置）
  dispatchMouse(type: 'mousemove' | 'click', x: number, y: number): void {
    const doc = this.frame.contentDocument;
    const win = this.frame.contentWindow as (Window & typeof globalThis) | null;
    if (!doc || !win) return;
    const frame = this.frame.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, clientX: x - frame.left, clientY: y - frame.top, view: win };
    const target = doc.elementFromPoint(init.clientX, init.clientY) ?? doc.body;
    target.dispatchEvent(new win.MouseEvent(type, init));
  }
}

// PreviewPane が webview を作るとき、代わりにこの要素を作らせる
export function installDemoWebview(pages: (url: string) => DemoPage | null): void {
  pageFor = pages;
  if (!customElements.get(TAG)) customElements.define(TAG, DemoWebview);
  const doc = document as Document & { __demoWebview?: boolean };
  if (doc.__demoWebview) return;
  doc.__demoWebview = true;
  const create = document.createElement.bind(document);
  document.createElement = ((tag: string, options?: ElementCreationOptions) =>
    create(tag.toLowerCase() === 'webview' ? TAG : tag, options)) as typeof document.createElement;
}

export function demoWebview(): DemoWebview | null {
  return [...views].find((v) => v.isConnected && v.style.display !== 'none') ?? null;
}

// 開いているページを描き直す（開発サーバーのホットリロード）
export function refreshDemoWebviews(): void {
  views.forEach((v) => v.refresh());
}
