import type { BrowserWindow, BrowserWindowConstructorOptions, HandlerDetails, Session, WebContents, WindowOpenHandlerResponse } from 'electron';
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

type Deps = {
  // 開いているプロファイルのアプリ内ブラウザ（どのタブのものかは、それぞれが見分ける）
  browsers: () => PreviewBrowser[];
  // 裏で起動している（TANACODE_BACKGROUND=1）。別ウインドウも画面に出さない
  background: boolean;
  // ふだんのブラウザで開く
  openExternal: (url: string) => void;
};

// 1 つのタブから開いておけるポップアップの数（ページが window.open を繰り返しても、ウインドウで埋まらないように）
export const MAX_POPUPS = 5;

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
  private open(source: WebContents, { url, disposition }: HandlerDetails): WindowOpenHandlerResponse {
    // http(s) でないもの（file:・mailto: など）は開かない
    if (!/^https?:\/\//.test(url)) return DENY;
    const root = this.roots.get(source) ?? source;
    const browser = this.owners.get(root);
    if (disposition === 'new-window') {
      if ((this.popups.get(root)?.size ?? 0) >= MAX_POPUPS) return DENY;
      // Claude の操作で、許していない先を開こうとしたものは開かない（開こうとしたタブに控える）
      if (browser && !browser.allowsPopup(root, url)) return DENY;
      // 開いたタブを閉じるときは、attach の destroyed で閉じる（Electron の決まりでは、開いたページが別のサイトへ移っただけで閉じてしまう）
      return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: popupOptions(this.deps.background) };
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
  }
}

// 別ウインドウの作り方。守りの値は、ページが features に書いた値より強い（Electron は、この値をページの値の上に重ねる）。
// 枠・最前面・全画面など、見た目を偽れる指定も、ページには決めさせない。大きさと位置は、ページの指定のまま
function popupOptions(background: boolean): BrowserWindowConstructorOptions {
  return {
    show: !background,
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
