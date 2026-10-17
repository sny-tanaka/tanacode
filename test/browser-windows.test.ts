import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { isPreviewDestination, MAX_POPUPS, PreviewWindows, restrictPreviewSession, type PreviewBrowser } from '../src/main/browser-windows';

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
  open(url: string, disposition = 'new-window'): unknown {
    return this.handler!({ url, disposition, features: '', frameName: '' });
  }
  // ページのトップのフレーム（か中のフレーム）が移ろうとした。止めたら true
  go(url: string, isMainFrame = true, event = 'will-frame-navigate'): boolean {
    const e = { url, isMainFrame, preventDefault: vi.fn() };
    this.emit(event, e);
    return e.preventDefault.mock.calls.length > 0;
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  title = '';
  readonly webContents: FakeContents;
  constructor(session: FakeSession) {
    super();
    this.webContents = new FakeContents('window', session);
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
}

const asContents = (c: FakeContents) => c as unknown as WebContents;
const asSession = (s: FakeSession) => s as unknown as Session;

function setup(options: { background?: boolean } = {}) {
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
  const windows = new PreviewWindows({
    browsers: () => [browser as unknown as PreviewBrowser],
    background: options.background ?? false,
    openExternal: (url) => opened.push(url),
  });
  // 画面が webview のタブを作った（web-contents-created と did-attach-webview）
  const tab = () => {
    const guest = new FakeContents('webview', preview);
    windows.watch(asContents(guest));
    windows.attach(asContents(guest), browser as unknown as PreviewBrowser);
    return guest;
  };
  // source がポップアップを開いた（Electron が中身を作り、web-contents-created のあとに did-create-window）
  const popup = (source: FakeContents, session = preview) => {
    const win = new FakeWindow(session);
    windows.watch(asContents(win.webContents));
    source.emit('did-create-window', win as unknown as BrowserWindow, { url: '' });
    return win;
  };
  return { preview, browser, opened, windows, tab, popup };
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

describe('新しいウインドウ', () => {
  it('タブを付けたら、コンソールと通信を集め始める', () => {
    const { browser, tab } = setup();
    const guest = tab();
    expect(browser.track).toHaveBeenCalledWith(guest);
  });

  it('ポップアップ（new-window）は、守りの値を決めた別ウインドウで開く。ページの features では変えられない', () => {
    const { tab } = setup();
    const guest = tab();
    expect(guest.open('https://login.example.test/authorize?state=x')).toEqual({
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: {
        show: true,
        frame: true,
        titleBarStyle: 'default',
        transparent: false,
        alwaysOnTop: false,
        fullscreen: false,
        kiosk: false,
        skipTaskbar: false,
        backgroundColor: '#ffffff',
        webPreferences: { nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webviewTag: false },
      },
    });
  });

  it('裏で起動しているときは、別ウインドウを画面に出さない', () => {
    const { tab } = setup({ background: true });
    expect((tab().open('https://login.example.test/') as { overrideBrowserWindowOptions: { show: boolean } }).overrideBrowserWindowOptions.show).toBe(false);
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
});
