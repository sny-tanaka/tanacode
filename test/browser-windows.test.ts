import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { isPreviewDestination, MAX_POPUPS, popupBounds, PreviewWindows, restrictPreviewSession, type PopupScreen, type PreviewBrowser } from '../src/main/browser-windows';

// アプリ内ブラウザのページが移る・新しいウインドウを開くときの守り（src/main/browser-windows.ts）。
// Electron の中身（webContents・BrowserWindow・Session）は、ここで作る小さな作り物。本物での動き（opener がつながる・features の守りの値が効かない・
// 別ウインドウのセッション）は test/e2e/browser-popup.test.ts

type Handler = (details: { url: string; disposition: string; features?: string; frameName?: string }) => unknown;

class FakeSession extends EventEmitter {
  request: ((contents: unknown, permission: string, callback: (ok: boolean) => void) => void) | null = null;
  check: (() => boolean) | null = null;
  setPermissionRequestHandler(handler: FakeSession['request']): void {
    this.request = handler;
  }
  setPermissionCheckHandler(handler: FakeSession['check']): void {
    this.check = handler;
  }
}

class FakeContents extends EventEmitter {
  handler: Handler | null = null;
  url = 'about:blank';
  title = '';
  constructor(
    readonly type: string,
    readonly session: FakeSession,
  ) {
    super();
  }
  getType(): string {
    return this.type;
  }
  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title || this.url;
  }
  setWindowOpenHandler(handler: Handler): void {
    this.handler = handler;
  }
  // features の既定は、大きさを指定したポップアップ（window.open の 3 つめの引数）
  open(url: string, disposition = 'new-window', features = 'width=480,height=640'): unknown {
    return this.handler!({ url, disposition, features, frameName: '' });
  }
  // ページのトップのフレーム（か中のフレーム）が移ろうとした。止めたら true
  go(url: string, isMainFrame = true, event = 'will-frame-navigate'): boolean {
    const e = { url, isMainFrame, preventDefault: vi.fn() };
    this.emit(event, e);
    return e.preventDefault.mock.calls.length > 0;
  }
}

// アプリが作った別ウインドウ（options: 作るときに渡したもの / webContents: Electron が作った中身）
class FakeWindow extends EventEmitter {
  destroyed = false;
  title = '';
  readonly loaded: string[] = [];
  // 出し方（show: 前に出してフォーカスも移す / showInactive: フォーカスは移さない）
  readonly shown: string[] = [];
  show(): void {
    this.shown.push('show');
  }
  showInactive(): void {
    this.shown.push('showInactive');
  }
  constructor(
    readonly options: Record<string, unknown>,
    readonly webContents: FakeContents,
  ) {
    super();
  }
  loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    return Promise.resolve();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('closed');
  }
  setTitle(title: string): void {
    this.title = title;
  }
  bounds: { x: number; y: number; width: number; height: number } | null = null;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
  }
}

// 中身の守りの値（Electron が中身を作るときに使う）
const SECURE = { nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webviewTag: false };
// ページが features に書いた、見た目を偽れる指定（Electron が createWindow に渡してくる。使ってはいけない）
const FROM_PAGE = { closable: false, focusable: false, opacity: 0, alwaysOnTop: true, frame: false, visibleOnAllWorkspaces: true, type: 'panel', movable: false, minimizable: false, hasShadow: false, show: true, x: -10000, y: -10000, width: 99999, height: 1 };

// tanacode のウインドウがある画面（メニューバーと Dock を除いた範囲）と、tanacode のウインドウ
const SCREEN: PopupScreen = { workArea: { x: 0, y: 25, width: 1440, height: 875 }, around: { x: 100, y: 50, width: 1200, height: 800 } };

const asContents = (c: FakeContents) => c as unknown as WebContents;
const asSession = (s: FakeSession) => s as unknown as Session;

function setup(options: { background?: boolean; screen?: PopupScreen | null } = {}) {
  const preview = new FakeSession();
  restrictPreviewSession(asSession(preview));
  const browser = {
    track: vi.fn(),
    openFromPage: vi.fn(() => true),
    isOperating: vi.fn(() => false),
    blocksNavigation: vi.fn(() => false),
    allowsPopup: vi.fn(() => true),
  };
  const opened: string[] = [];
  // アプリが作った別ウインドウ
  const made: FakeWindow[] = [];
  const windows = new PreviewWindows({
    browsers: () => [browser as unknown as PreviewBrowser],
    background: options.background ?? false,
    openExternal: (url) => opened.push(url),
    screen: () => (options.screen === undefined ? SCREEN : options.screen),
    makeWindow: (windowOptions) => {
      const given = (windowOptions as { webContents?: FakeContents }).webContents;
      const win = new FakeWindow(windowOptions as Record<string, unknown>, given ?? new FakeContents('window', preview));
      made.push(win);
      return win as unknown as BrowserWindow;
    },
  });
  // 画面が webview のタブを作った（web-contents-created と did-attach-webview）
  const tab = () => {
    const guest = new FakeContents('webview', preview);
    windows.watch(asContents(guest));
    windows.attach(asContents(guest), browser as unknown as PreviewBrowser);
    return guest;
  };
  // source がポップアップを開いた（Electron が中身を作って web-contents-created を出し、ページの features を混ぜた options で createWindow を呼ぶ）
  const popup = (source: FakeContents, session = preview, url = 'https://login.example.test/', features = 'width=480,height=640') => {
    const contents = new FakeContents('window', session);
    windows.watch(asContents(contents));
    const result = source.open(url, 'new-window', features) as { action: string; createWindow?: (options: Record<string, unknown>) => unknown };
    if (result.action !== 'allow' || !result.createWindow) throw new Error(`ポップアップを開けませんでした: ${JSON.stringify(result)}`);
    expect(result.createWindow({ ...FROM_PAGE, webContents: contents })).toBe(contents);
    return made.at(-1)!;
  };
  return { preview, browser, opened, windows, tab, popup, made };
}

describe('プレビューのセッション', () => {
  it('どの権限も与えず、ダウンロードも止める', () => {
    const { preview } = setup();
    let answer: boolean | null = null;
    preview.request!(null, 'media', (ok) => (answer = ok));
    expect(answer).toBe(false);
    expect(preview.check!()).toBe(false);
    const download = { preventDefault: vi.fn() };
    preview.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalled();
  });
});

describe('移る先', () => {
  it.each([
    ['https://example.test/', true, true],
    ['about:blank', true, true],
    ['blob:http://localhost/1', true, false],
    ['file:///etc/hosts', true, false],
    ['about:srcdoc', false, true],
    ['data:text/html,x', false, true],
    ['file:///etc/hosts', false, false],
  ])('%s（トップのフレーム: %s）は %s', (url, isMainFrame, expected) => {
    expect(isPreviewDestination(url, isMainFrame)).toBe(expected);
  });

  it('タブとポップアップの両方で、http(s) の外へは移らない。Claude の操作中の移動は、ポップアップなら開いたタブで許した先かを見る', () => {
    const { browser, tab, popup } = setup();
    const guest = tab();
    const win = popup(guest);
    for (const page of [guest, win.webContents]) {
      for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
        expect(page.go('file:///etc/hosts', true, event)).toBe(true);
        expect(page.go('blob:http://localhost/1', true, event)).toBe(true);
        expect(page.go('https://example.test/', true, event)).toBe(false);
      }
      expect(page.go('blob:http://localhost/1', false)).toBe(false);
    }
    browser.blocksNavigation.mockClear();
    browser.blocksNavigation.mockImplementation((...args: unknown[]) => String(args[1]).includes('outside'));
    expect(guest.go('https://outside.test/')).toBe(true);
    expect(win.webContents.go('https://outside.test/')).toBe(true);
    expect(win.webContents.go('https://inside.test/')).toBe(false);
    // 中のフレームは見ない
    expect(win.webContents.go('https://outside.test/', false)).toBe(false);
    expect(browser.blocksNavigation.mock.calls).toEqual([
      [guest, 'https://outside.test/'],
      [guest, 'https://outside.test/', true],
      [guest, 'https://inside.test/', true],
    ]);
  });

  it('アプリの画面（プレビューでないセッションのウインドウ）には、見張りも新しいウインドウの扱いも付けない', () => {
    const { windows } = setup();
    const app = new FakeContents('window', new FakeSession());
    windows.watch(asContents(app));
    expect(app.eventNames()).toEqual([]);
    expect(app.handler).toBeNull();
  });
});

describe('ポップアップの位置と大きさ', () => {
  const at = (features: string, screen = SCREEN) => popupBounds(features, screen);

  it('ページの指定が画面に収まれば、そのまま。位置の指定が無ければ、tanacode のウインドウの真ん中', () => {
    expect(at('width=480,height=640,left=200,top=100')).toEqual({ x: 200, y: 100, width: 480, height: 640 });
    expect(at('width=480,height=640')).toEqual({ x: 460, y: 130, width: 480, height: 640 });
    // 大きさの指定も無ければ 800×600
    expect(at('')).toEqual({ x: 300, y: 150, width: 800, height: 600 });
    // 別の書き方（innerWidth・screenX など）と、大文字・空白・単位の付いた値
    expect(at('innerWidth=500, innerHeight=400, screenX=10, screenY=30')).toEqual({ x: 10, y: 30, width: 500, height: 400 });
    expect(at('WIDTH=500px,Height=400,Left=10.7,TOP=30')).toEqual({ x: 10, y: 30, width: 500, height: 400 });
  });

  it('画面の外の位置は、画面の中へ詰める（メニューバーの上にも出さない）', () => {
    expect(at('width=480,height=640,left=-10000,top=-10000')).toEqual({ x: 0, y: 25, width: 480, height: 640 });
    expect(at('width=480,height=640,left=99999,top=99999')).toEqual({ x: 960, y: 260, width: 480, height: 640 });
    expect(at('width=480,height=640,left=1300,top=800')).toEqual({ x: 960, y: 260, width: 480, height: 640 });
  });

  it('大きすぎる指定は画面の大きさに、小さすぎる指定は 320×240 に丸める', () => {
    expect(at('width=99999,height=99999,left=500,top=500')).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
    expect(at('width=1,height=-5')).toEqual({ x: 540, y: 330, width: 320, height: 240 });
    expect(at('width=0,height=0,left=0,top=0')).toEqual({ x: 0, y: 25, width: 320, height: 240 });
    // 画面がそれより小さければ、画面の大きさ
    expect(at('width=1,height=1', { workArea: { x: 0, y: 0, width: 300, height: 200 }, around: { x: 0, y: 0, width: 300, height: 200 } })).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  it('読めない値は、指定が無いものとして扱う', () => {
    expect(at('width=abc,height=,left=NaN,top=Infinity,popup')).toEqual({ x: 300, y: 150, width: 800, height: 600 });
  });

  it('tanacode のウインドウが 2 つめの画面にあれば、その画面に詰める', () => {
    const second: PopupScreen = { workArea: { x: 1440, y: 0, width: 1920, height: 1080 }, around: { x: 1600, y: 100, width: 1400, height: 900 } };
    expect(at('width=480,height=640,left=0,top=0', second)).toEqual({ x: 1440, y: 0, width: 480, height: 640 });
    expect(at('width=480,height=640', second)).toEqual({ x: 2060, y: 230, width: 480, height: 640 });
  });

  it('開くときに、別ウインドウの位置と大きさを決める。画面が分からなければ、決めない（Electron の既定。ページの指定も使わない）', () => {
    const options = (screen?: PopupScreen | null) => {
      const ctx = setup({ screen });
      return ctx.popup(ctx.tab(), undefined, undefined, 'width=480,height=640,left=-10000,top=0').options;
    };
    expect(options()).toMatchObject({ x: 0, y: 25, width: 480, height: 640 });
    expect(options(null)).not.toHaveProperty('x');
    expect(options(null)).not.toHaveProperty('width');
  });

  it('開いたあとにページが動かす・大きさを変える（window.moveTo・resizeTo）ときも、画面の中に詰める', () => {
    const { tab, popup } = setup();
    const win = popup(tab());
    const move = (bounds: { x: number; y: number; width: number; height: number }) => {
      const event = { preventDefault: vi.fn() };
      win.webContents.emit('content-bounds-updated', event, bounds);
      return event.preventDefault.mock.calls.length > 0;
    };
    expect(move({ x: -10000, y: 99999, width: 480, height: 640 })).toBe(true);
    expect(win.bounds).toEqual({ x: 0, y: 260, width: 480, height: 640 });
    expect(move({ x: 10, y: 30, width: 99999, height: 1 })).toBe(true);
    expect(win.bounds).toEqual({ x: 0, y: 30, width: 1440, height: 240 });
  });
});

describe('新しいウインドウ', () => {
  it('タブを付けたら、コンソールと通信を集め始める', () => {
    const { browser, tab } = setup();
    const guest = tab();
    expect(browser.track).toHaveBeenCalledWith(guest);
  });

  it('ポップアップ（new-window）は、アプリが作る別ウインドウで開く。中身の守りの値を決め、ページの features（閉じられない・透明・最前面など）は使わない', () => {
    const { tab, made } = setup();
    const guest = tab();
    const result = guest.open('https://login.example.test/authorize?state=x', 'new-window', 'width=480,height=640,nodeIntegration=yes,frame=no,alwaysOnTop=yes,closable=no,opacity=0') as {
      createWindow: (options: Record<string, unknown>) => unknown;
    };
    expect(result).toEqual({ action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences: SECURE }, createWindow: expect.any(Function) });
    const contents = new FakeContents('window', guest.session);
    expect(result.createWindow({ ...FROM_PAGE, webContents: contents })).toBe(contents);
    // 渡すのは、許すもの（画面に詰めた位置と大きさ・地の色・守りの値）と、Electron が作った中身だけ
    expect(made.map((w) => w.options)).toEqual([{ webContents: contents, show: false, x: 460, y: 130, width: 480, height: 640, backgroundColor: '#ffffff', webPreferences: SECURE }]);
    expect(made[0]!.loaded).toEqual([]);
  });

  it('Electron が中身を作らなかったときは、作ったウインドウで開く先を読み込む', () => {
    const { tab, made } = setup();
    const result = tab().open('https://login.example.test/', 'new-window', 'width=480,height=640') as { createWindow: (options: Record<string, unknown>) => unknown };
    result.createWindow({ ...FROM_PAGE });
    expect(made[0]!.options).not.toHaveProperty('webContents');
    expect(made[0]!.loaded).toEqual(['https://login.example.test/']);
  });

  it('ページの beforeunload で、別ウインドウを閉じるのを止めさせない', () => {
    const { tab, popup } = setup();
    const win = popup(tab());
    const event = { preventDefault: vi.fn() };
    win.webContents.emit('will-prevent-unload', event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('別ウインドウは、フォーカスを移さずに出す（ページの操作だけで、アプリが前に出て入力を奪わないように）', () => {
    const { tab, popup } = setup();
    const win = popup(tab());
    expect(win.options.show).toBe(false);
    expect(win.shown).toEqual(['showInactive']);
  });

  it('裏で起動しているときは、別ウインドウを画面に出さない', () => {
    const { tab, popup } = setup({ background: true });
    const win = popup(tab());
    expect(win.options.show).toBe(false);
    expect(win.shown).toEqual([]);
  });

  it('http(s) でないものは、ポップアップでもタブでも開かない', () => {
    const { tab, browser, opened } = setup();
    const guest = tab();
    for (const url of ['file:///etc/hosts', 'mailto:me@example.test', 'javascript:alert(1)', 'file:///tmp/a.html#https://example.test/']) {
      expect(guest.open(url)).toEqual({ action: 'deny' });
      expect(guest.open(url, 'foreground-tab')).toEqual({ action: 'deny' });
    }
    expect(browser.allowsPopup).not.toHaveBeenCalled();
    expect(browser.openFromPage).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it('Claude の操作で許していない先を開こうとしたポップアップは開かない（アプリ内ブラウザが決める）', () => {
    const { tab, browser } = setup();
    const guest = tab();
    browser.allowsPopup.mockReturnValueOnce(false);
    expect(guest.open('https://outside.test/')).toEqual({ action: 'deny' });
    expect(browser.allowsPopup).toHaveBeenCalledWith(guest, 'https://outside.test/');
  });

  it('新しいタブで開くもの（new-window でないもの）は、アプリ内ブラウザのタブで開く。開けず、Claude の操作中でもなければ、ふだんのブラウザで開く', () => {
    const { tab, browser, opened } = setup();
    const guest = tab();
    expect(guest.open('https://example.test/tab', 'foreground-tab')).toEqual({ action: 'deny' });
    expect(browser.openFromPage).toHaveBeenCalledWith(guest, 'https://example.test/tab', 'foreground-tab');
    expect(opened).toEqual([]);
    browser.openFromPage.mockReturnValue(false);
    browser.isOperating.mockReturnValueOnce(true);
    guest.open('https://example.test/operating', 'background-tab');
    guest.open('https://example.test/outside', 'foreground-tab');
    expect(opened).toEqual(['https://example.test/outside']);
  });

  it('空のページ（window.open の URL が空・about:blank）のポップアップも開く（開いてから location を移す OAuth のため）。タブには開かない', () => {
    const { tab, browser, opened, made } = setup();
    const guest = tab();
    for (const url of ['', 'about:blank']) {
      const result = guest.open(url, 'new-window', 'width=480,height=640') as { action: string; createWindow: (options: Record<string, unknown>) => unknown };
      expect(result.action).toBe('allow');
      // Electron が中身を作らなかったときは、空のページを読み込む
      result.createWindow({ ...FROM_PAGE });
    }
    expect(browser.allowsPopup.mock.calls).toEqual([
      [guest, 'about:blank'],
      [guest, 'about:blank'],
    ]);
    expect(made.map((w) => w.loaded)).toEqual([['about:blank'], ['about:blank']]);
    expect(guest.open('about:blank', 'foreground-tab')).toEqual({ action: 'deny' });
    expect(guest.open('about:blank', 'new-window', '')).toEqual({ action: 'deny' });
    expect(browser.openFromPage).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it('features の無い new-window（Shift+クリックなど）は、別ウインドウではなく、アプリ内ブラウザのタブで開く', () => {
    const { tab, browser } = setup();
    const guest = tab();
    expect(guest.open('https://example.test/shift', 'new-window', '')).toEqual({ action: 'deny' });
    expect(guest.open('https://example.test/space', 'new-window', '  ')).toEqual({ action: 'deny' });
    expect(browser.openFromPage.mock.calls).toEqual([
      [guest, 'https://example.test/shift', 'new-window'],
      [guest, 'https://example.test/space', 'new-window'],
    ]);
    expect(browser.allowsPopup).not.toHaveBeenCalled();
  });

  it(`1 つのタブから開いておけるポップアップは ${MAX_POPUPS} 個まで。閉じたら、また開ける`, () => {
    const { tab, popup } = setup();
    const guest = tab();
    const wins = Array.from({ length: MAX_POPUPS }, () => popup(guest));
    expect(guest.open('https://login.example.test/')).toEqual({ action: 'deny' });
    // ポップアップから開くものも、もとのタブの数に入る
    expect(wins[0]!.webContents.open('https://login.example.test/')).toEqual({ action: 'deny' });
    wins[1]!.emit('closed');
    expect((guest.open('https://login.example.test/') as { action: string }).action).toBe('allow');
    // ほかのタブは、別に数える
    expect((tab().open('https://login.example.test/') as { action: string }).action).toBe('allow');
  });

  it('ポップアップから開くものは、もとのタブのものとして扱う（タブ・ポップアップ・Claude の操作の判断）', () => {
    const { tab, popup, browser } = setup();
    const guest = tab();
    const win = popup(guest);
    const nested = popup(win.webContents);
    nested.webContents.open('https://example.test/tab', 'foreground-tab');
    expect(browser.openFromPage).toHaveBeenCalledWith(guest, 'https://example.test/tab', 'foreground-tab');
    nested.webContents.open('https://login.example.test/');
    expect(browser.allowsPopup).toHaveBeenLastCalledWith(guest, 'https://login.example.test/');
    browser.blocksNavigation.mockClear();
    nested.webContents.go('https://example.test/');
    expect(browser.blocksNavigation.mock.calls).toEqual([[guest, 'https://example.test/', true]]);
  });

  it('開いたページと違うセッションのポップアップ（プレビューの守りが効かないもの）は、閉じる', () => {
    const { tab, popup } = setup();
    const win = popup(tab(), new FakeSession());
    expect(win.destroyed).toBe(true);
  });

  it('タブを閉じたら、そのタブから開いたポップアップも閉じる（ポップアップから開いたものも）', () => {
    const { tab, popup } = setup();
    const guest = tab();
    const other = tab();
    const win = popup(guest);
    const nested = popup(win.webContents);
    const kept = popup(other);
    guest.emit('destroyed');
    expect([win.destroyed, nested.destroyed, kept.destroyed]).toEqual([true, true, false]);
  });

  it('別ウインドウの題には、今のページのオリジンを添える（アドレス欄が無いため）', () => {
    const { tab, popup } = setup();
    const win = popup(tab());
    win.webContents.url = 'https://login.example.test/authorize?state=secret';
    win.webContents.title = 'ログイン';
    win.webContents.emit('did-navigate');
    expect(win.title).toBe('ログイン — https://login.example.test');
    const event = { preventDefault: vi.fn() };
    win.emit('page-title-updated', event, '認証');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(win.title).toBe('認証 — https://login.example.test');
    // 題の無いページは、オリジンだけ
    win.webContents.title = '';
    win.webContents.emit('did-navigate');
    expect(win.title).toBe('https://login.example.test');
  });

  it('空のページ（about:blank）の別ウインドウの題には、about:blank を添える（開いたページが書いた題だけを、サイトの題のように出さない）', () => {
    const { tab, popup } = setup();
    const win = popup(tab(), undefined, 'about:blank');
    win.webContents.url = 'about:blank';
    win.webContents.title = 'Google のログイン';
    win.webContents.emit('did-navigate');
    expect(win.title).toBe('Google のログイン — about:blank');
    win.emit('page-title-updated', { preventDefault: vi.fn() }, '別の題');
    expect(win.title).toBe('別の題 — about:blank');
    win.webContents.title = '';
    win.webContents.emit('did-navigate');
    expect(win.title).toBe('about:blank');
  });
});
