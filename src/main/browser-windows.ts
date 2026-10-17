import type { BrowserWindow, BrowserWindowConstructorOptions, HandlerDetails, Rectangle, Session, WebContents, WindowOpenHandlerResponse } from 'electron';
import type { BrowserControl } from './browser-control';

// アプリ内ブラウザ（プレビューのパーティションの webview のタブ）のページが、移る・新しいウインドウを開くときの守り。
// - 移る先: トップのフレームは http(s) と about:blank だけ。中のフレームだけ about:srcdoc・blob:・data: も（isPreviewDestination）。
//   Claude の操作の間は、許した先へしか移らせない（BrowserControl.blocksNavigation）
// - 新しいウインドウ: リンクの「新しいタブで開く」・features の無い window.open などは、アプリ内ブラウザの新しいタブで開く（openFromPage）。
//   ポップアップ（disposition が new-window。window.open に features を付けたものなど）は、アプリ内ブラウザの外の別ウインドウで開き、
//   開いたページ（window.opener）とつなぐ（OAuth のログインの窓のため）。別ウインドウは Claude の操作の対象にしない（ログインは人がする）
// 別ウインドウにも、タブと同じ守りを付ける。Electron は、ポップアップの中身を、開いたページと同じセッション（プレビューのもの。どの権限も断り、
// ダウンロードを止める）で作る。webPreferences の守りの値はここで決め、ページが window.open の features に書いた値（nodeIntegration=yes など）は効かない。
// 見張り（移る先・新しいウインドウの扱い）は、中身ができたとき（web-contents-created）に付ける。ポップアップの最初の読み込みとページのスクリプトより前

// アプリ内ブラウザの操作のうち、ここで使うもの
export type PreviewBrowser = Pick<BrowserControl, 'track' | 'openFromPage' | 'isOperating' | 'blocksNavigation' | 'allowsPopup'>;

// ポップアップを置く画面。workArea: tanacode のウインドウ（タブはいつもこのウインドウの中）がある画面の、メニューバーと Dock を除いた範囲 /
// around: tanacode のウインドウ（位置の指定が無いポップアップは、この真ん中に出す）
export type PopupScreen = { workArea: Rectangle; around: Rectangle };

type Deps = {
  // 開いているプロファイルのアプリ内ブラウザ（どのタブのものかは、それぞれが見分ける）
  browsers: () => PreviewBrowser[];
  // 裏で起動している（TANACODE_BACKGROUND=1）。別ウインドウも画面に出さない
  background: boolean;
  // ふだんのブラウザで開く
  openExternal: (url: string) => void;
  // ポップアップを置く画面（ウインドウが無いなど、分からなければ null。位置と大きさは Electron の既定のまま）
  screen: () => PopupScreen | null;
};

// 1 つのタブから開いておけるポップアップの数（ページが window.open を繰り返しても、ウインドウで埋まらないように）
export const MAX_POPUPS = 5;
// ポップアップの大きさ。指定が無いときは Electron の既定と同じ 800×600。小さすぎる指定は、読めて押せる大きさまで広げる（画面がそれより小さければ画面の大きさ）
const DEFAULT_POPUP = { width: 800, height: 600 };
const MIN_POPUP = { width: 320, height: 240 };

const DENY: WindowOpenHandlerResponse = { action: 'deny' };

// プレビューのセッション（restrictPreviewSession を通したもの）。ポップアップの中身は、これで見分ける
// （アプリの画面は、既定のセッションか、足したプロファイルのセッションを使う）
const previewSessions = new WeakSet<Session>();

// プレビューのセッションには、どの権限も与えず、ダウンロードも止める（Claude が操作したページが、勝手にファイルを保存させないように）
export function restrictPreviewSession(preview: Session): void {
  preview.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  preview.setPermissionCheckHandler(() => false);
  preview.on('will-download', (event) => event.preventDefault());
  previewSessions.add(preview);
}

// プレビューのページの中で移ってよい先。トップのフレームは http(s) のページと about:blank だけ（file: や
// mailto: などの外部プロトコルへは移らない。外部プロトコルのアプリも起こさない）。
// 中のフレーム（iframe）は、ページが自分で作る about:srcdoc・blob:・data: も通す（ページの開発で使うため。どれもページの外には出られない）
export function isPreviewDestination(url: string, isMainFrame: boolean): boolean {
  if (/^https?:\/\//i.test(url) || url === 'about:blank') return true;
  return !isMainFrame && (url === 'about:srcdoc' || /^(blob|data):/i.test(url));
}

export class PreviewWindows {
  // ポップアップの中身 → それを開いたタブ（webview のゲスト。ポップアップから開いたポップアップも、もとのタブ）
  private readonly roots = new WeakMap<WebContents, WebContents>();
  // タブ → そのタブから開いたポップアップ
  private readonly popups = new Map<WebContents, Set<BrowserWindow>>();
  // タブ → そのタブのプロファイルのアプリ内ブラウザ
  private readonly owners = new WeakMap<WebContents, PreviewBrowser>();

  constructor(private readonly deps: Deps) {}

  // 中身ができた（web-contents-created）。webview のタブと、プレビューのセッションのウインドウ（ポップアップ）に見張りを付ける。
  // ポップアップには、新しいウインドウの扱いもここで付ける（付けないと、Electron がそのままウインドウを作らせてしまう）
  watch(contents: WebContents): void {
    const popup = contents.getType() === 'window' && previewSessions.has(contents.session);
    if (contents.getType() !== 'webview' && !popup) return;
    const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
      if (!isPreviewDestination(event.url, event.isMainFrame)) event.preventDefault();
      else if (event.isMainFrame && this.blocks(contents, event.url)) event.preventDefault();
    };
    contents.on('will-navigate', guard);
    contents.on('will-frame-navigate', guard);
    contents.on('will-redirect', guard);
    if (!popup) return;
    contents.setWindowOpenHandler((details) => this.open(contents, details));
    contents.on('did-create-window', (win) => this.adopt(contents, win));
  }

  // webview のタブが付いた（did-attach-webview）。browser: そのタブのプロファイルのアプリ内ブラウザ
  attach(guest: WebContents, browser: PreviewBrowser | undefined): void {
    if (browser) this.owners.set(guest, browser);
    // コンソールと失敗した通信は、ページの最初のスクリプトから集める（Claude が読む）
    browser?.track(guest);
    guest.setWindowOpenHandler((details) => this.open(guest, details));
    guest.on('did-create-window', (win) => this.adopt(guest, win));
    // タブを閉じたら、そのタブから開いたポップアップも閉じる（ページが閉じるのを止めていても）
    guest.once('destroyed', () => {
      for (const win of this.popups.get(guest) ?? []) if (!win.isDestroyed()) win.destroy();
      this.popups.delete(guest);
    });
  }

  // タブ（webview）か、そのタブから開いたポップアップのトップのフレームが、Claude の操作で許していない先へ移ろうとしているか
  private blocks(contents: WebContents, url: string): boolean {
    const root = this.roots.get(contents);
    // ポップアップは、開いたタブで Claude に許した先かを見る（どのプロファイルのタブかは、それぞれのアプリ内ブラウザが見分ける）
    if (root) return this.deps.browsers().some((browser) => browser.blocksNavigation(root, url, true));
    return this.deps.browsers().some((browser) => browser.blocksNavigation(contents, url));
  }

  // ページが新しいウインドウで開こうとした。source: 開こうとしたタブかポップアップ
  private open(source: WebContents, { url, disposition, features }: HandlerDetails): WindowOpenHandlerResponse {
    // http(s) でないもの（file:・mailto: など）は開かない
    if (!/^https?:\/\//.test(url)) return DENY;
    const root = this.roots.get(source) ?? source;
    const browser = this.owners.get(root);
    if (disposition === 'new-window') {
      if ((this.popups.get(root)?.size ?? 0) >= MAX_POPUPS) return DENY;
      // Claude の操作で、許していない先を開こうとしたものは開かない（開こうとしたタブに控える）
      if (browser && !browser.allowsPopup(root, url)) return DENY;
      // 開いたタブを閉じるときは、attach の destroyed で閉じる（Electron の決まりでは、開いたページが別のサイトへ移っただけで閉じてしまう）
      const screen = this.deps.screen();
      return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: popupOptions(this.deps.background, screen && popupBounds(features ?? '', screen)) };
    }
    // アプリ内ブラウザの新しいタブで開く。開けず、Claude の操作中でもなければ、ふだんのブラウザで開く
    if (!browser?.openFromPage(root, url, disposition) && !browser?.isOperating(root)) this.deps.openExternal(url);
    return DENY;
  }

  // ポップアップの別ウインドウができた（did-create-window）。開いたページと違うセッションなら（プレビューの守りが効かない）、閉じる
  private adopt(source: WebContents, win: BrowserWindow): void {
    if (win.webContents.session !== source.session) {
      win.destroy();
      return;
    }
    const root = this.roots.get(source) ?? source;
    this.roots.set(win.webContents, root);
    const list = this.popups.get(root) ?? new Set<BrowserWindow>();
    list.add(win);
    this.popups.set(root, list);
    win.on('closed', () => list.delete(win));
    showOrigin(win);
    // 開いたあとにページが動かす・大きさを変えるとき（window.moveTo・resizeTo など）も、画面の中に詰める
    win.webContents.on('content-bounds-updated', (event, bounds) => {
      event.preventDefault();
      const screen = this.deps.screen();
      if (screen && !win.isDestroyed()) win.setBounds(fitIn(bounds, screen.workArea));
    });
  }
}

// 別ウインドウの作り方。守りの値は、ページが features に書いた値より強い（Electron は、この値をページの値の上に重ねる）。
// 枠・最前面・全画面など、見た目を偽れる指定も、ページには決めさせない。位置と大きさは、ページの指定を画面の中に詰めたもの（popupBounds）
function popupOptions(background: boolean, bounds: Rectangle | null): BrowserWindowConstructorOptions {
  return {
    show: !background,
    ...bounds,
    frame: true,
    titleBarStyle: 'default',
    transparent: false,
    alwaysOnTop: false,
    fullscreen: false,
    kiosk: false,
    skipTaskbar: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  };
}

// ポップアップの位置と大きさ。ページが window.open の features に書いた指定（width・height・left・top と、innerWidth・innerHeight・
// screenX・screenY）を、tanacode のウインドウがある画面の中に詰める（画面の外・大きすぎる・小さすぎる指定も、収まる範囲に丸める）。
// 位置の指定が無ければ、tanacode のウインドウの真ん中。読めない値は、指定が無いものとして扱う
export function popupBounds(features: string, { workArea, around }: PopupScreen): Rectangle {
  const asked: Record<string, number> = {};
  for (const item of features.split(',')) {
    const [key, value] = item.split('=').map((part) => part.trim().toLowerCase());
    // 先頭の数字だけを読む（ブラウザと同じく「480px」は 480）
    const number = value === undefined ? NaN : Number.parseInt(value, 10);
    if (key && Number.isFinite(number)) asked[key] = number;
  }
  // 大きさを先に丸めてから、真ん中に置く位置を決める
  const { width, height } = fitIn(
    { x: workArea.x, y: workArea.y, width: asked.width ?? asked.innerwidth ?? DEFAULT_POPUP.width, height: asked.height ?? asked.innerheight ?? DEFAULT_POPUP.height },
    workArea,
  );
  const x = asked.left ?? asked.screenx ?? around.x + (around.width - width) / 2;
  const y = asked.top ?? asked.screeny ?? around.y + (around.height - height) / 2;
  return fitIn({ x, y, width, height }, workArea);
}

// bounds を area の中に詰める（大きさを先に丸めてから、はみ出さない位置へずらす）
function fitIn(bounds: Rectangle, area: Rectangle): Rectangle {
  const width = Math.round(clamp(bounds.width, Math.min(MIN_POPUP.width, area.width), area.width));
  const height = Math.round(clamp(bounds.height, Math.min(MIN_POPUP.height, area.height), area.height));
  const x = Math.round(clamp(bounds.x, area.x, area.x + area.width - width));
  const y = Math.round(clamp(bounds.y, area.y, area.y + area.height - height));
  return { x, y, width, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// 別ウインドウにはアドレス欄が無いので、題に今のページのオリジンを添える（ログインの窓が、どのサイトのものか分かるように）
function showOrigin(win: BrowserWindow): void {
  const update = (title: string) => {
    if (win.isDestroyed()) return;
    const origin = originOf(win.webContents.getURL());
    win.setTitle(origin && title && title !== win.webContents.getURL() ? `${title} — ${origin}` : (origin ?? title));
  };
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    update(title);
  });
  win.webContents.on('did-navigate', () => update(win.webContents.getTitle()));
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}
