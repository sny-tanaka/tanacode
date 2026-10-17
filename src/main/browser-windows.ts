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
// ウインドウは、Electron に作らせず、ここで作る（createWindow）。ページの features（closable=no・opacity=0・type=panel など）は使わず、
// 許すもの（画面の中に詰めた位置と大きさ）だけを渡す。ページの beforeunload で、閉じるのを止めさせない。
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
  // 別ウインドウを作る（new BrowserWindow）
  makeWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  // tanacode のウインドウにフォーカスがあるか（tanacode を使っているか）と、フォーカスが来たら一度だけ呼ぶ
  focused: () => boolean;
  whenFocused: (callback: () => void) => void;
};

// 別ウインドウの題に出す、ページが書いた題の長さ（文字の数）
const MAX_PAGE_TITLE = 80;

// 1 つのタブから開いておけるポップアップの数（ページが window.open を繰り返しても、ウインドウで埋まらないように）
export const MAX_POPUPS = 5;
// ポップアップの大きさ。指定が無いときは Electron の既定と同じ 800×600。小さすぎる指定は、読めて押せる大きさまで広げる（画面がそれより小さければ画面の大きさ）
const DEFAULT_POPUP = { width: 800, height: 600 };
const MIN_POPUP = { width: 320, height: 240 };

const DENY: WindowOpenHandlerResponse = { action: 'deny' };

// 別ウインドウの中身の守りの値（Electron が中身を作るときに使う。ページが features に書いた値より強い）
const POPUP_PREFERENCES = {
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webviewTag: false,
  // ページの alert・confirm は出さない（すぐに返る。confirm は false。prompt は Electron がもともと出さない）。出すのを待っている（tanacode にフォーカスが来るまで出さない）・
  // 裏で起動している別ウインドウのダイアログは、ウインドウに付かず、ほかのアプリの前に出うるため。safeDialogs では、1 回目は出てしまう
  disableDialogs: true,
} as const;

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
  // tanacode にフォーカスが来るまで出さずに待っている別ウインドウ（閉じたら外す）と、フォーカスを待っているか（待つのは、いつも 1 つだけ。
  // tanacode を使っていない間に、ページが開いて閉じるのを繰り返しても、待ちが増えないように）
  private readonly waiting = new Set<BrowserWindow>();
  private waitingFocus = false;

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
  }

  // webview のタブが付いた（did-attach-webview）。browser: そのタブのプロファイルのアプリ内ブラウザ
  attach(guest: WebContents, browser: PreviewBrowser | undefined): void {
    if (browser) this.owners.set(guest, browser);
    // コンソールと失敗した通信は、ページの最初のスクリプトから集める（Claude が読む）
    browser?.track(guest);
    guest.setWindowOpenHandler((details) => this.open(guest, details));
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
  private open(source: WebContents, { url: asked, disposition, features }: HandlerDetails): WindowOpenHandlerResponse {
    // ポップアップは、features を付けた window.open だけ（Chromium は、features が空・noopener・noreferrer・popup=0 だけのもの以外を new-window にする）。
    // features の無い new-window（Shift+クリックなど）は、タブで開く
    const popup = disposition === 'new-window' && (features ?? '').trim() !== '';
    // 空のページ（window.open('')・about:blank）は、ポップアップでだけ開く（開いてから location を移す OAuth のため。中身は開いたページが書き、
    // 移るときは見張りが確かめる）
    const url = popup && (asked === '' || asked === 'about:blank') ? 'about:blank' : asked;
    // ほかの http(s) でないもの（file:・mailto: など）は開かない
    if (!/^https?:\/\//.test(url) && !(popup && url === 'about:blank')) return DENY;
    const root = this.roots.get(source) ?? source;
    const browser = this.owners.get(root);
    if (popup) {
      if ((this.popups.get(root)?.size ?? 0) >= MAX_POPUPS) return DENY;
      // Claude の操作で、許していない先を開こうとしたものは開かない（開こうとしたタブに控える）
      if (browser && !browser.allowsPopup(root, url)) return DENY;
      const screen = this.deps.screen();
      const bounds = screen && popupBounds(features ?? '', screen);
      return {
        action: 'allow',
        // 開いたタブを閉じるときは、attach の destroyed で閉じる（Electron の決まりでは、開いたページが別のサイトへ移っただけで閉じてしまう）
        outlivesOpener: true,
        // 中身の守りの値。ほかのもの（ページの features を混ぜた options）は、createWindow で使わない
        overrideBrowserWindowOptions: { webPreferences: POPUP_PREFERENCES },
        createWindow: (options) => this.create(source, url, (options as { webContents?: WebContents }).webContents, bounds),
      };
    }
    // アプリ内ブラウザの新しいタブで開く。開けず、Claude の操作中でもなければ、ふだんのブラウザで開く
    if (!browser?.openFromPage(root, url, disposition) && !browser?.isOperating(root)) this.deps.openExternal(url);
    return DENY;
  }

  // ポップアップの別ウインドウを作る（createWindow）。contents: Electron が作った中身（開いたページとつながっている）。
  // Electron が作らなかったときは、作ったウインドウで url を読み込む。返すのは、ウインドウの中身（Electron は contents と同じものを求める）
  private create(source: WebContents, url: string, contents: WebContents | undefined, bounds: Rectangle | null): WebContents {
    const options = windowOptions(bounds);
    // Electron が中身を作らなかったときは、開いたページと同じセッション（プレビューのもの）で作り、確かめて（adopt）から読み込む
    // （セッションを渡さないと、アプリの既定のセッションで作られ、確かめる前に通信を始めてしまう）
    const win = this.deps.makeWindow(
      contents
        ? ({ webContents: contents, ...options } as BrowserWindowConstructorOptions)
        : { ...options, webPreferences: { ...POPUP_PREFERENCES, session: source.session } },
    );
    this.adopt(source, win);
    if (!contents && !win.isDestroyed()) void win.loadURL(url);
    // フォーカスを移さずに出す（ページの操作だけで、アプリが前に出て入力を奪わないように。人は、押してから入力する）。
    // tanacode を使っていない（ほかのアプリにフォーカスがある）ときは、tanacode に戻るまで出さない（ほかのアプリの前に出さない）
    if (!this.deps.background && !win.isDestroyed()) {
      if (this.deps.focused()) win.showInactive();
      else this.showWhenFocused(win);
    }
    return win.webContents;
  }

  // tanacode にフォーカスが来たら出す。待っているものは、フォーカスが来たときにまとめて出す
  private showWhenFocused(win: BrowserWindow): void {
    this.waiting.add(win);
    win.once('closed', () => this.waiting.delete(win));
    if (this.waitingFocus) return;
    this.waitingFocus = true;
    this.deps.whenFocused(() => {
      this.waitingFocus = false;
      const shown = [...this.waiting];
      this.waiting.clear();
      for (const waiting of shown) if (!waiting.isDestroyed()) waiting.showInactive();
    });
  }

  // ポップアップの別ウインドウができた。開いたページと違うセッションなら（プレビューの守りが効かない）、閉じる
  private adopt(source: WebContents, win: BrowserWindow): void {
    if (win.webContents.session !== source.session) {
      win.destroy();
      return;
    }
    // ページの beforeunload で、閉じるのを止めさせない（閉じるボタンが効かなくなる。Electron は確認も出さない）
    win.webContents.on('will-prevent-unload', (event) => event.preventDefault());
    const root = this.roots.get(source) ?? source;
    this.roots.set(win.webContents, root);
    const list = this.popups.get(root) ?? new Set<BrowserWindow>();
    list.add(win);
    this.popups.set(root, list);
    win.on('closed', () => list.delete(win));
    showOrigin(win);
    // 開いたあとにページが動かす・大きさを変えるとき（window.moveTo・resizeTo など）も、画面の中に詰める。
    // bounds は、Electron の説明（content bounds）と違い、枠を含むウインドウの位置と大きさ（ページの outerWidth・screenX と同じ。
    // Electron の既定の動きも setBounds に渡す。44.7 で確かめた）。setContentBounds に渡すと、resizeBy(0, 0) のたびに題の帯の分だけ大きくなる
    win.webContents.on('content-bounds-updated', (event, bounds) => {
      event.preventDefault();
      const screen = this.deps.screen();
      if (screen && !win.isDestroyed()) win.setBounds(fitIn(bounds, screen.workArea));
    });
  }
}

// 別ウインドウの作り方。許すものだけを並べる（ページの features から来たものは、どれも使わない）。
// 位置と大きさは、ページの指定を画面の中に詰めたもの（popupBounds）。ほかは既定のまま（枠あり・閉じられる・最前面にしない など）。
// 作るときは出さない（出すのは create の showInactive）
function windowOptions(bounds: Rectangle | null): BrowserWindowConstructorOptions {
  return { show: false, ...bounds, backgroundColor: '#ffffff', webPreferences: POPUP_PREFERENCES };
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

// 別ウインドウにはアドレス欄が無いので、題に今のページのオリジンを添える（ログインの窓が、どのサイトのものか分かるように）。
// オリジンの無いページ（空のページ about:blank。中身は開いたページが書ける）は、about:blank と、中身を書けるオリジン（メインフレームのオリジン。
// 空のページでは開いたページのもの）を添える。ページが書いた題だけを、サイトの題のように出さない。
// 作った直後（URL も題もまだ空。Electron の既定の題はアプリ名）から付ける。
// 使うのは、読み込みが確定した URL だけ（開く先の URL は使わない）。読み込みが確定しない先（204 の応答・ダウンロード）では、URL は空のままで、
// 中身は開いたページが書ける最初の空の文書のままなので（Electron 44.7 で確かめた）
function showOrigin(win: BrowserWindow): void {
  const where = () => {
    const origin = originOf(win.webContents.getURL());
    if (origin) return origin;
    let writer: string | null = null;
    try {
      writer = originOf(win.webContents.mainFrame.origin);
    } catch {
      writer = null;
    }
    return writer ? `about:blank (${writer})` : 'about:blank';
  };
  // オリジンを先に置く（ページの題を長くしても、題の帯の切り詰めでオリジンを押し出せないように）
  const update = (title: string) => {
    if (win.isDestroyed()) return;
    const now = win.webContents.getURL();
    const shown = where();
    const page = title === now || title === 'about:blank' ? '' : pageTitle(title);
    win.setTitle(page ? `${shown} — ${page}` : shown);
  };
  update('');
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    update(title);
  });
  win.webContents.on('did-navigate', () => update(win.webContents.getTitle()));
}

// ページが書いた題の、別ウインドウの題に出す形。空白（U+3000 なども）は 1 つに詰め、制御文字と、双方向の制御文字・幅の無い文字
// （書式の文字 Cf。U+202E・U+2067・U+200B など。並びを入れ替えたり、見えない文字で埋めたりさせない）を除き、長さを切る
function pageTitle(title: string): string {
  const cleaned = title
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  // サロゲートペアの途中で切らないよう、文字ごとに数える
  const chars = Array.from(cleaned);
  return chars.length > MAX_PAGE_TITLE ? `${chars.slice(0, MAX_PAGE_TITLE).join('')}…` : cleaned;
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}
