import { EventEmitter } from 'node:events';

// アプリ内ブラウザの操作（src/main/browser-control.ts）のテストで使う、Electron の作り物。
// テストのファイルで vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule)) と差し替える。
// webview の中身（webContents）・CDP（debugger）・撮った画像（nativeImage）は、テストが決めた答えを返し、受けたものを控える

// 撮った画像（NativeImage の代わり）。中身は持たず、大きさと名前だけ
export class FakeImage {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly name = 'shot',
    // どの点も同じ色（BGRA）。見比べるテスト（looksSame）で、違う絵を作るときに変える
    readonly color: readonly number[] = [255, 255, 255, 255],
  ) {}

  toBitmap(): Buffer {
    return Buffer.from(Array.from({ length: this.width * this.height }, () => this.color).flat());
  }

  isEmpty(): boolean {
    return this.width === 0 || this.height === 0;
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  resize(size: { width: number; height: number; quality?: string }): FakeImage {
    return new FakeImage(size.width, size.height, `${this.name}（縮めた）`, this.color);
  }

  // 切り出した範囲を控える（名前に入れる）
  crop(rect: { x: number; y: number; width: number; height: number }): FakeImage {
    return new FakeImage(rect.width, rect.height, `${this.name}（${rect.x},${rect.y} を切り出した）`, this.color);
  }

  toPNG(): Buffer {
    return Buffer.from(`${this.name}:${this.width}x${this.height}`);
  }
}

// CDP の命令 1 つ（child: 別プロセスの iframe のセッション）
export type CdpCommand = { method: string; params?: Record<string, unknown>; child?: string };

// webContents.debugger の代わり。命令は handler が答える（決めていない命令は {} を返す）
export class FakeDebugger extends EventEmitter {
  attached = false;
  attachCount = 0;
  // attach に渡された CDP の版
  readonly versions: string[] = [];
  // attach で投げるもの（ほかの DevTools がつないでいる、など）。null なら投げない
  attachError: unknown = null;
  readonly commands: CdpCommand[] = [];
  handler: (method: string, params: Record<string, unknown> | undefined, child: string | undefined) => unknown = () => ({});

  isAttached(): boolean {
    return this.attached;
  }

  attach(version: string): void {
    this.attachCount++;
    this.versions.push(version);
    if (this.attachError !== null) throw this.attachError;
    this.attached = true;
  }

  async sendCommand(method: string, params?: Record<string, unknown>, child?: string): Promise<unknown> {
    this.commands.push({ method, params, child });
    return this.handler(method, params, child);
  }

  // 送った命令のうち、名前が method のもの（Target.setAutoAttach などの準備を除いて確かめる）
  sent(method: string): CdpCommand[] {
    return this.commands.filter((c) => c.method === method);
  }

  // DevTools を開くなどで、つないでいた CDP が外れた
  detachNow(): void {
    this.attached = false;
    this.emit('detach', {}, 'target closed');
  }

  // 別プロセスの iframe につながった・外れた（Target.setAutoAttach で届く知らせ）
  message(method: string, params: Record<string, unknown>): void {
    this.emit('message', {}, method, params);
  }
}

// ページの中で動かすスクリプト（executeJavaScriptInIsolatedWorld）の種類。スクリプトの中の目印で見分ける
export type PageScript = 'viewport' | 'size' | 'locate' | 'point' | 'focus' | 'text' | 'inspect' | 'scroll' | 'wait' | 'clear' | 'frames';
const SCRIPT_MARKS: [PageScript, string][] = [
  ['viewport', 'dpr: devicePixelRatio'],
  ['size', 'laidOutWidth: innerWidth'],
  ['locate', "error: 'hidden'"],
  ['point', "error: 'outside'"],
  ['focus', 'return el.src || null'],
  ['text', 'const textOf ='],
  ['inspect', 'const props ='],
  ['scroll', 'scrollBy('],
  ['wait', 'const state ='],
  ['clear', 'selectAllChildren(el)'],
  ['frames', 'requestAnimationFrame(() => requestAnimationFrame('],
];

export function scriptKind(code: string): PageScript | null {
  return SCRIPT_MARKS.find(([, mark]) => code.includes(mark))?.[0] ?? null;
}

export type PageHandlers = Partial<Record<PageScript, (code: string) => unknown>>;

// 作った webContents（webContents.fromId で引く）
export const registry = new Map<number, FakeContents>();
let nextId = 100;

// webview の中身（WebContents の代わり）
export class FakeContents extends EventEmitter {
  readonly id = nextId++;
  type = 'webview';
  hostWebContents: unknown;
  url: string;
  title: string;
  destroyed = false;
  loading = false;
  // isLoading が、あと何回 true を返すか（読み込み中を少しの間だけ続ける）
  loadingPolls = 0;
  readonly debugger = new FakeDebugger();
  // ページの中のスクリプトへの答え（種類ごと）。決めていない種類は、見えている範囲（viewport）・タブの大きさ（size）・フォーカス（focus）・描かれるのを待つ（frames）以外はエラー
  page: PageHandlers = {};
  readonly scripts: { world: number; kind: PageScript | null; code: string }[] = [];
  // evaluate（executeJavaScript）への答え
  evaluate: (expression: string) => unknown = () => undefined;
  readonly evaluated: string[] = [];
  // capturePage が返す画像と、受けた範囲
  shot: FakeImage = new FakeImage(800, 600);
  readonly captures: ({ x: number; y: number; width: number; height: number } | undefined)[] = [];
  // capturePage の振る舞い（既定は、すぐ shot を返す）
  capture: () => Promise<FakeImage> = async () => this.shot;
  // 見ていない間も描かせるか（backgroundThrottling）と、切り替えの記録
  backgroundThrottling = true;
  readonly throttling: boolean[] = [];
  // loadURL の振る舞い（既定は、その URL に移って終わる）
  load: (url: string) => Promise<void> = async (url) => {
    this.url = url;
  };
  readonly calls: string[] = [];
  history: { entries: string[]; index: number };
  readonly navigationHistory = {
    getActiveIndex: () => this.history.index,
    length: () => this.history.entries.length,
    getEntryAtIndex: (index: number) => ({ url: this.history.entries[index], title: '' }),
    goBack: () => {
      this.calls.push('goBack');
      this.history.index--;
      this.url = this.history.entries[this.history.index];
    },
    goForward: () => {
      this.calls.push('goForward');
      this.history.index++;
      this.url = this.history.entries[this.history.index];
    },
  };

  constructor(options: { url?: string; title?: string; host?: unknown; type?: string } = {}) {
    super();
    this.url = options.url ?? '';
    this.title = options.title ?? '';
    this.hostWebContents = options.host ?? HOST;
    if (options.type) this.type = options.type;
    this.history = { entries: this.url ? [this.url] : [], index: this.url ? 0 : -1 };
    registry.set(this.id, this);
  }

  getType(): string {
    return this.type;
  }

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return this.title;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isLoading(): boolean {
    if (this.loadingPolls > 0) {
      this.loadingPolls--;
      return true;
    }
    return this.loading;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }

  reload(): void {
    this.calls.push('reload');
  }

  loadURL(url: string): Promise<void> {
    this.calls.push(`loadURL ${url}`);
    return this.load(url);
  }

  async executeJavaScript(expression: string): Promise<unknown> {
    this.evaluated.push(expression);
    return this.evaluate(expression);
  }

  async executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[]): Promise<unknown> {
    const code = scripts[0].code;
    const kind = scriptKind(code);
    this.scripts.push({ world, kind, code });
    const handler = kind ? this.page[kind] : undefined;
    if (handler) return handler(code);
    if (kind === 'viewport') return { width: 800, height: 600, dpr: 1 };
    if (kind === 'frames') return true;
    if (kind === 'size') return { laidOutWidth: 800, laidOutHeight: 600 };
    if (kind === 'focus') return null;
    throw new Error(`テストが答えを決めていないスクリプトです（${kind ?? '不明'}）`);
  }

  async capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<FakeImage> {
    this.captures.push(rect);
    return this.capture();
  }

  getBackgroundThrottling(): boolean {
    return this.backgroundThrottling;
  }

  setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottling = allowed;
    this.throttling.push(allowed);
  }

  // 送ったスクリプトのうち、種類が kind のもの
  scriptsOf(kind: PageScript): string[] {
    return this.scripts.filter((s) => s.kind === kind).map((s) => s.code);
  }
}

// アプリの画面（webview を持っている webContents）
// アプリの画面（webview を持つ側の webContents）。backgroundThrottling の切り替えだけを記録する
export const HOST = {
  id: 1,
  name: 'アプリの画面',
  backgroundThrottling: true,
  throttling: [] as boolean[],
  isDestroyed: () => false,
  getBackgroundThrottling(): boolean {
    return this.backgroundThrottling;
  },
  setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottling = allowed;
    this.throttling.push(allowed);
  },
  // 画面の中のタブの webview の左上（executeJavaScript の答え。null は見つからない）と、画面の拡大の倍率と、受けたスクリプト
  webviewAt: { x: 0, y: 0 } as { x: number; y: number } | null,
  zoom: 1,
  scripts: [] as string[],
  async executeJavaScript(code: string): Promise<unknown> {
    this.scripts.push(code);
    return this.webviewAt;
  },
  getZoomFactor(): number {
    return this.zoom;
  },
};

// nativeImage.createFromBuffer に渡されたもの（fullPage のスクリーンショット）と、返す画像
export const images = { buffers: [] as Buffer[], fromBuffer: new FakeImage(800, 2000, 'fullPage') };

export const electronModule = {
  webContents: { fromId: (id: number) => registry.get(id) },
  nativeImage: {
    createFromBuffer: (buffer: Buffer) => {
      images.buffers.push(buffer);
      return images.fromBuffer;
    },
  },
};

// 通信の結果のうち、どのページの通信かを表すもの。initiatorOrigin: 通信を出したオリジン（ブラウザが自分で始めたものは無い）/
// frame: 通信を出したフレーム（Electron の WebFrameMain のうち、使うもの。parent が null ならトップ。移った・無くなったら無い）
export type RequestSender = { webContentsId?: number; initiatorOrigin?: string; frame?: { origin: string; url: string; parent: unknown } | null };

// プレビューの webview が使うセッション（Session の代わり）。webRequest の受け手を控え、テストから通信の結果を送る
export class FakeSession {
  readonly filters: unknown[] = [];
  completed: ((details: { statusCode: number; method: string; url: string; resourceType: string } & RequestSender) => void) | null = null;
  errored: ((details: { error: string; method: string; url: string; resourceType: string } & RequestSender) => void) | null = null;
  readonly webRequest = {
    onCompleted: (filter: unknown, listener: NonNullable<FakeSession['completed']>) => {
      this.filters.push(filter);
      this.completed = listener;
    },
    onErrorOccurred: (filter: unknown, listener: NonNullable<FakeSession['errored']>) => {
      this.filters.push(filter);
      this.errored = listener;
    },
  };
}
