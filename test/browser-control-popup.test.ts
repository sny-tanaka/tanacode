import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { browserToolId } from '../src/shared/browser-tools';
import { IpcChannel } from '../src/shared/ipc';
import { BROWSER_GATE_REQUEST } from '../src/main/browser-bridge';
import { MAX_POPUPS } from '../src/main/browser-windows';
import type { PopupView } from '../src/main/browser-popup-view';
import { textResult } from '../src/main/mcp-bridge';
import { FakeContents } from './helpers/fake-electron';
import { flush, finish, setup, textOf, type Tab } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// アプリ内ブラウザの操作（src/main/browser-control.ts）のうち、ページが開いたポップアップの別ウインドウ（attachPopup）を、
// タブの一覧に入れて選んで操作すること・開かなかったものを伝えること（notOpened）。別ウインドウを作る側は test/browser-windows.test.ts

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const asWebContents = (page: FakeContents) => page as unknown as WebContents;

// opener が開いたポップアップの別ウインドウ（browser-windows.ts の adopt が知らせる）。中身は webview でなく、アプリの画面の中にも無い
function popupOf(ctx: ReturnType<typeof setup>, opener: FakeContents, url: string, title = 'ログイン') {
  const contents = new FakeContents({ url, title, type: 'window' });
  contents.hostWebContents = undefined;
  // view: 絵をタブに映すもの（browser-popup-view.ts。ここでは呼ばれたものだけを見る）
  const view = { watch: vi.fn(), done: vi.fn(), input: vi.fn(), reveal: vi.fn(), revealed: false };
  const window = {
    closed: 0,
    close: () => {
      window.closed++;
      contents.emit('destroyed');
    },
    size: () => ({ width: 480, height: 640 }),
    view: view as unknown as PopupView,
  };
  ctx.control.attachPopup(asWebContents(opener), asWebContents(contents), window);
  return Object.assign(contents, { window, view });
}

// Claude がページのボタンを押す。押したときにページがすること（onRelease）を起こす
function clickOpening(ctx: ReturnType<typeof setup>, page: Tab, onRelease: () => void) {
  page.page.locate = () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 800, height: 600 }, description: 'button#login', covered: null });
  page.debugger.handler = (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') onRelease();
    return {};
  };
  return ctx.call('click', { selector: '#login' });
}

describe('ポップアップの別ウインドウを、タブの一覧に入れる', () => {
  it('list_tabs: タブのあとに、開いたタブを添えて出す。あとで開いたタブも、ポップアップより前に並ぶ', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    popupOf(ctx, page, 'http://localhost:3000/login?state=1');
    popupOf(ctx, page, 'about:blank', '');
    ctx.open('http://localhost:3000/b', { title: '二', activate: false });
    expect(textOf(await ctx.call('list_tabs'))).toBe(
      [
        'Tabs (* marks the current tab):',
        '* 1. トップ — http://localhost:3000/',
        '  2. 二 — http://localhost:3000/b',
        '  3. [popup window opened by tab 1] ログイン — http://localhost:3000/login?state=1',
        '  4. [popup window opened by tab 1] (untitled) — (empty page)',
      ].join('\n'),
    );
  });

  it('知らないタブから開いたもの・ポップアップから開いたものを、ポップアップとしては受け付けない（ポップアップから開いたものは、browser-windows.ts がもとのタブで知らせる）', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    popupOf(ctx, new FakeContents({ url: 'http://localhost:3000/' }), 'http://localhost:3000/a');
    const popup = popupOf(ctx, page, 'http://localhost:3000/b');
    popupOf(ctx, popup, 'http://localhost:3000/c');
    // 同じ中身を 2 回知らせても、1 つ
    ctx.control.attachPopup(asWebContents(page), asWebContents(popup), popup.window);
    expect(textOf(await ctx.call('list_tabs')).split('\n')).toHaveLength(3);
  });

  it('許していない先のページは、タブと同じく、題も URL の道筋も伏せる。開いたタブで人が許したオリジンは、ポップアップでも読める', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    const popup = popupOf(ctx, page, 'https://login.example.com/auth?state=secret', '外のログイン');
    expect(textOf(await ctx.call('list_tabs')).split('\n')[2]).toBe('  2. [popup window opened by tab 1] (not allowed for Claude) — https://login.example.com');
    // 開いたタブで、人が login.example.com を許した（navigate で開く確認に答えた）
    const gate = await ctx.control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('navigate'), input: { url: 'https://login.example.com/' } });
    expect(JSON.parse(textOf(gate))).toEqual({ outside: 'https://login.example.com' });
    await ctx.call('navigate', { url: 'https://login.example.com/' });
    expect(textOf(await ctx.call('list_tabs')).split('\n')[2]).toBe('  2. [popup window opened by tab 1] 外のログイン — https://login.example.com/auth?state=secret');
    expect(popup.destroyed).toBe(false);
  });
});

describe('ポップアップを選んで操作する', () => {
  it('select_tab: 今のタブにして、ページを返す。画面もそのポップアップのタブにする。このあとの操作はポップアップに', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    const popup = popupOf(ctx, page, 'http://localhost:3000/login');
    expect(textOf(await ctx.call('select_tab', { index: 2 }))).toBe('Switched to tab 2, a popup window opened by tab 1: ログイン\nURL: http://localhost:3000/login');
    expect(ctx.sentOn(IpcChannel.BrowserSelectTab)).toEqual([{ sessionId: 'S1', tabId: `popup-${popup.id}` }]);
    expect(JSON.parse(textOf(await ctx.control.handle('S1', BROWSER_GATE_REQUEST, {}))).url).toBe('http://localhost:3000/login');
    popup.page.text = () => ({ title: 'ログイン', url: 'http://localhost:3000/login', parts: [{ frame: null, text: 'ポップアップの中身' }] });
    page.page.text = () => ({ title: 'トップ', url: 'http://localhost:3000/', parts: [{ frame: null, text: 'タブの中身' }] });
    expect(textOf(await ctx.call('get_text'))).toContain('ポップアップの中身');
    expect(textOf(await ctx.call('list_tabs')).split('\n').slice(1)).toEqual([
      '  1. トップ — http://localhost:3000/',
      '* 2. [popup window opened by tab 1] ログイン — http://localhost:3000/login',
    ]);
  });

  it('click: ポップアップの中を押す。押す枠は、アプリの画面のタブの上に出さない（別ウインドウの中ではないため）', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    const popup = popupOf(ctx, page, 'http://localhost:3000/login');
    await ctx.call('select_tab', { index: 2 });
    popup.page.locate = () => ({ rect: { x: 5, y: 6, width: 10, height: 10 }, viewport: { width: 480, height: 640 }, description: 'button#ok', covered: null });
    expect(textOf(await ctx.call('click', { selector: '#ok' }))).toBe('Clicked: button#ok');
    expect(popup.scriptsOf('press')).toHaveLength(1);
    expect(page.scriptsOf('press')).toHaveLength(0);
    expect(ctx.activities().every((a) => a.box === null && !a.touches)).toBe(true);
    // 本物の押下も、アプリの画面のフォーカスを見ずに送る（別ウインドウは webview ではない）
    expect(textOf(await ctx.call('click', { selector: '#ok', real: true }))).toBe('Clicked: button#ok (with a real mouse press, as requested)');
    expect(popup.debugger.sent('Input.dispatchMouseEvent').map((c) => c.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('touch: 別ウインドウの中身の大きさの中なら送る（アプリの画面の webview を探さない）', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    const popup = popupOf(ctx, page, 'http://localhost:3000/login');
    await ctx.call('select_tab', { index: 2 });
    popup.page.point = () => ({ rect: { x: 100, y: 100, width: 1, height: 1 }, viewport: { width: 480, height: 640 }, description: 'div', covered: null });
    expect(textOf(await ctx.call('touch', { action: 'tap', x: 100, y: 100 }))).toContain('Tapped');
    expect(popup.debugger.sent('Input.dispatchTouchEvent').map((c) => c.params?.type)).toEqual(['touchStart', 'touchEnd']);
    expect(ctx.activities().every((a) => !a.touches)).toBe(true);
  });

  it('許していない先のページのポップアップは、読ませず、人に頼むよう伝える', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    popupOf(ctx, page, 'https://accounts.example.com/signin?state=secret', 'サインイン');
    const selected = textOf(await ctx.call('select_tab', { index: 2 }));
    expect(selected).toBe(
      'Switched to tab 2, a popup window opened by tab 1: (not allowed for Claude)\nURL: https://accounts.example.com\n' +
        'This page is not allowed for Claude, so it can be neither read nor operated any further.\n' +
        'If the user needs to act there (for example, to log in), ask them with ask_user_to_act. The user sees the popup as a tab in the in-app browser.',
    );
    expect(await ctx.call('get_text')).toEqual(
      textResult(
        'The page of the current tab, a popup window (https://accounts.example.com), is not allowed for Claude, so it can be neither read nor operated. ' +
          'If the user needs to act there (for example, to log in), ask them with ask_user_to_act. Otherwise, switch back to a tab with select_tab.',
        true,
      ),
    );
  });

  it('set_viewport・throttle は、ポップアップには当てない', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    const popup = popupOf(ctx, page, 'http://localhost:3000/login');
    await ctx.call('set_viewport', { device: 'iPhone 15' });
    await ctx.call('select_tab', { index: 2 });
    expect((await ctx.call('set_viewport', { width: 'mobile' })).isError).toBe(true);
    expect((await ctx.call('throttle', { cpu: 4 })).isError).toBe(true);
    // 決めた画面の大きさも、ポップアップには当てない
    await ctx.call('get_console_logs');
    expect(popup.debugger.sent('Emulation.setDeviceMetricsOverride')).toEqual([]);
    expect(page.debugger.sent('Emulation.setDeviceMetricsOverride')).toHaveLength(1);
  });

  it('close_tab: 別ウインドウを閉じ、画面の今のタブへ戻す', async () => {
    const ctx = setup();
    ctx.open('http://localhost:3000/', { title: 'トップ' });
    const second = ctx.open('http://localhost:3000/b', { title: '二' });
    const popup = popupOf(ctx, second, 'http://localhost:3000/login');
    await ctx.call('select_tab', { index: 3 });
    expect(await ctx.call('close_tab')).toEqual(textResult('Closed tab 3, a popup window (2 tabs left; the current tab is tab 2)'));
    expect(popup.window.closed).toBe(1);
    expect(ctx.sentOn(IpcChannel.BrowserCloseTab)).toEqual([]);
    expect(textOf(await ctx.call('list_tabs')).split('\n')[2]).toBe('* 2. 二 — http://localhost:3000/b');
  });

  it('今のタブにしていたポップアップが閉じたら、画面の今のタブへ戻し、次の呼び出しで伝える', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    const popup = popupOf(ctx, page, 'http://localhost:3000/login');
    await ctx.call('select_tab', { index: 2 });
    // ログインを終えたページが、自分で閉じた（window.close）
    popup.destroy();
    expect(textOf(await ctx.call('list_tabs'))).toBe(
      'Tabs (* marks the current tab):\n* 1. トップ — http://localhost:3000/\n' +
        'The popup window that was the current tab (tab 2) has closed. The current tab is now tab 1. Check the tabs with list_tabs.',
    );
    // 一度だけ
    expect(textOf(await ctx.call('list_tabs'))).toBe('Tabs (* marks the current tab):\n* 1. トップ — http://localhost:3000/');
  });

  it('今のタブでないポップアップが閉じても、今のタブは替えず、何も伝えない', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    popupOf(ctx, page, 'http://localhost:3000/login').destroy();
    expect(textOf(await ctx.call('list_tabs'))).toBe('Tabs (* marks the current tab):\n* 1. トップ — http://localhost:3000/');
  });

  it('ポップアップを選んでいても、人が画面のタブを替えたら、そのタブが今のタブになる', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    popupOf(ctx, page, 'http://localhost:3000/login');
    await ctx.call('select_tab', { index: 2 });
    ctx.control.activate('S1', page.tabId);
    expect(textOf(await ctx.call('list_tabs')).split('\n')[1]).toBe('* 1. トップ — http://localhost:3000/');
  });

  it('ポップアップのタブは、セッションのタブの数（20 個）に入れない', async () => {
    const ctx = setup();
    let page = ctx.open('http://localhost:3000/');
    for (let i = 0; i < MAX_POPUPS; i++) popupOf(ctx, page, `http://localhost:3000/p${i}`);
    for (let i = 1; i < 19; i++) page = ctx.open(`http://localhost:3000/${i}`);
    expect(ctx.control.openFromPage(asWebContents(page), 'http://localhost:3000/more', 'foreground-tab')).toBe(true);
    expect(ctx.sentOn(IpcChannel.BrowserNewTab)).toHaveLength(1);
  });
});

describe('Claude の操作で開いた・止めた・開かなかったポップアップを伝える', () => {
  it('Claude が押して開いたポップアップは、一覧の番号を添えて伝える。今のタブは替えない', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    const result = textOf(
      await clickOpening(ctx, page, () => {
        expect(ctx.control.allowsPopup(asWebContents(page), 'http://localhost:3000/login?state=secret')).toBe(true);
        popupOf(ctx, page, 'http://localhost:3000/login?state=secret');
      }),
    );
    expect(result).toBe(
      'Clicked: button#login\n' +
        'Opened a popup window (http://localhost:3000): tab 2 in list_tabs (the user sees it as a popup tab in the in-app browser). The current tab did not change. To read or operate the popup, switch to it with select_tab. ' +
        'If it shows a page that is not allowed for Claude (such as a login page of another site), ask the user to act there with ask_user_to_act.',
    );
    expect(textOf(await ctx.call('list_tabs')).split('\n')[1]).toBe('* 1. トップ — http://localhost:3000/');
  });

  it('人の操作で開いたポップアップは、開いたとは伝えない（一覧には入る）', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    popupOf(ctx, page, 'http://localhost:3000/login');
    const result = textOf(await ctx.call('list_tabs'));
    expect(result).not.toContain('Opened a popup');
    expect(result).toContain('[popup window opened by tab 1]');
  });

  it('一覧に入れたポップアップの、許していない先への移動を Claude の操作の間に止めたら、そのポップアップに控え、選んで continue で進める', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    const popup = popupOf(ctx, page, 'about:blank', '');
    // ユーザーの操作は止めない
    expect(ctx.control.blocksNavigation(asWebContents(popup), 'https://example.com/', asWebContents(page))).toBe(false);
    const result = textOf(
      await clickOpening(ctx, page, () => {
        expect(ctx.control.blocksNavigation(asWebContents(popup), 'http://localhost:3000/ok', asWebContents(page))).toBe(false);
        expect(ctx.control.blocksNavigation(asWebContents(popup), 'https://example.com/callback?code=secret', asWebContents(page))).toBe(true);
      }),
    );
    expect(result).toBe(
      'Clicked: button#login\n' +
        'Blocked an attempt to move the popup window (tab 2) to a page not allowed for Claude (https://example.com). ' +
        'To open it there, switch to the popup with select_tab and call navigate with action "continue" (tanacode asks the user for permission).',
    );
    // 開いたタブには控えない
    expect(textOf(await ctx.call('navigate', { action: 'continue' }))).toBe('Nothing was stopped in the current tab, so there is nothing to continue. To open a page, pass url.');
    await ctx.call('select_tab', { index: 2 });
    const gate = JSON.parse(textOf(await ctx.control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('navigate'), input: { action: 'continue' } }))) as { outside: string | null };
    expect(gate).toEqual({ outside: 'https://example.com' });
    expect(textOf(await ctx.call('navigate', { action: 'continue' }))).toContain('Opened: ');
    expect(popup.calls).toEqual(['loadURL https://example.com/callback?code=secret']);
    // ポップアップで人が許したオリジンは、開いたタブにも効く（許可を分け合う）
    page.url = 'https://example.com/top';
    expect(textOf(await ctx.call('list_tabs')).split('\n')[1]).toBe('  1. トップ — https://example.com/top');
    expect(ctx.sentOn(IpcChannel.BrowserNewTab)).toEqual([]);
  });

  it('notOpened: Claude の操作の間に開かなかったものを、わけと一緒に伝える。人の操作では伝えない', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    ctx.control.notOpened(asWebContents(page), 'mailto:me@example.com', 'scheme');
    ctx.control.notOpened(asWebContents(new FakeContents()), 'http://localhost:3000/', 'popup-limit');
    const result = textOf(
      await clickOpening(ctx, page, () => {
        ctx.control.notOpened(asWebContents(page), 'https://login.example.com/auth?state=secret', 'popup-limit');
        ctx.control.notOpened(asWebContents(page), 'https://login.example.com/auth?state=again', 'popup-limit');
        ctx.control.notOpened(asWebContents(page), 'file:///etc/hosts', 'scheme');
        ctx.control.notOpened(asWebContents(page), '', 'scheme');
      }),
    );
    expect(result).toBe(
      [
        'Clicked: button#login',
        `The page tried to open a popup window (https://login.example.com), but it was not opened: the tab that opened it already has ${MAX_POPUPS} popup windows open, the limit for a tab. Close the ones you do not need with close_tab (list_tabs shows them), then try again.`,
        'The page tried to open a file: URL in a new window, but it was not opened: the in-app browser opens only http and https pages in new windows.',
        'The page tried to open an empty URL in a new window, but it was not opened: the in-app browser opens only http and https pages in new windows.',
      ].join('\n'),
    );
    // 次の呼び出しには残らない
    expect(textOf(await ctx.call('get_console_logs'))).toBe('No console messages.');
  });

  it('タブが 20 個のときに Claude の操作で開こうとした新しいタブは、開かず、そう伝える', async () => {
    const ctx = setup();
    let page = ctx.open('http://localhost:3000/');
    for (let i = 1; i < 20; i++) page = ctx.open(`http://localhost:3000/${i}`);
    const result = textOf(await clickOpening(ctx, page, () => expect(ctx.control.openFromPage(asWebContents(page), 'http://localhost:3000/more', 'foreground-tab')).toBe(true)));
    expect(result).toBe(
      'Clicked: button#login\n' +
        'The page tried to open http://localhost:3000/more in a new tab, but it was not opened: this session already has 20 tabs open, the limit. Close the tabs you do not need with close_tab, then try again.',
    );
    expect(ctx.sentOn(IpcChannel.BrowserNewTab)).toEqual([]);
  });

  it('呼び出しの途中で閉じた今のポップアップのことも、その呼び出しの答えで伝える', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    const popup = popupOf(ctx, page, 'http://localhost:3000/login');
    await ctx.call('select_tab', { index: 2 });
    popup.page.locate = () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 480, height: 640 }, description: 'button#done', covered: null });
    popup.debugger.handler = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') popup.destroy();
      return {};
    };
    const pending = ctx.control.handle('S1', 'click', { selector: '#done' });
    await flush();
    expect(textOf(await finish(pending))).toContain('The popup window that was the current tab (tab 2) has closed. The current tab is now tab 1.');
  });
});

describe('ポップアップを画面のタブに映す', () => {
  type Popups = { sessionId: string; popups: { tabId: string; openerTabId: string; url: string; title: string }[] };

  it('開いた・題が変わった・閉じたときに、画面へポップアップの一覧を送る（今の一覧は pendingPopups でも読める）', () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    const popup = popupOf(ctx, page, 'https://login.example.com/auth', '外のログイン');
    const tabId = `popup-${popup.id}`;
    const entry = { tabId, openerTabId: 'tab-1', url: 'https://login.example.com/auth', title: '外のログイン' };
    expect(ctx.sentOn<Popups>(IpcChannel.BrowserPopups).at(-1)).toEqual({ sessionId: 'S1', popups: [entry] });
    expect(ctx.control.pendingPopups()).toEqual([{ sessionId: 'S1', popups: [entry] }]);
    popup.title = '二段階認証';
    popup.emit('page-title-updated');
    expect(ctx.sentOn<Popups>(IpcChannel.BrowserPopups).at(-1)!.popups[0]!.title).toBe('二段階認証');
    // 人がタブを閉じた
    ctx.control.closePopupTab('S1', tabId);
    expect(popup.window.closed).toBe(1);
    expect(ctx.sentOn<Popups>(IpcChannel.BrowserPopups).at(-1)).toEqual({ sessionId: 'S1', popups: [] });
    expect(ctx.control.pendingPopups()).toEqual([]);
  });

  it('映す場所を受けたら、絵とカーソルの形を画面へ送り始める。場所が null か壊れていれば、やめる', () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/');
    const popup = popupOf(ctx, page, 'http://localhost:3000/login');
    const tabId = `popup-${popup.id}`;
    ctx.control.viewPopup('S1', tabId, { x: 10, y: 20, width: 300, height: 400 });
    const [place, onFrame, onCursor] = popup.view.watch.mock.calls[0] as [unknown, (frame: unknown) => void, (cursor: string) => void];
    expect(place).toEqual({ x: 10, y: 20, width: 300, height: 400 });
    const data = Buffer.from([1, 2, 3, 4]);
    onFrame({ width: 1, height: 1, scale: 2, data });
    onCursor('pointer');
    expect(ctx.sentOn(IpcChannel.BrowserPopupFrame)).toEqual([{ sessionId: 'S1', tabId, width: 1, height: 1, scale: 2, data }]);
    expect(ctx.sentOn(IpcChannel.BrowserPopupCursor)).toEqual([{ sessionId: 'S1', tabId, cursor: 'pointer' }]);
    ctx.control.viewPopup('S1', tabId, null);
    ctx.control.viewPopup('S1', tabId, { x: 0, y: 0, width: -1, height: 'a' });
    expect(popup.view.watch.mock.calls.slice(1)).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
  });

  it('人の操作は、形を確かめてから送る。描き終えた・実物を開くも、そのポップアップへ。知らないタブ・タブ（ポップアップでないもの）には何もしない', () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/');
    const popup = popupOf(ctx, page, 'http://localhost:3000/login');
    const tabId = `popup-${popup.id}`;
    ctx.control.popupInput('S1', tabId, { type: 'mouseDown', x: 5.4, y: 6, button: 'left', clickCount: 1, modifiers: ['shift', 'bogus'] });
    ctx.control.popupInput('S1', tabId, { type: 'eval', code: 'x' });
    ctx.control.popupInput('S1', 'tab-1', { type: 'focus' });
    ctx.control.popupInput('S2', tabId, { type: 'focus' });
    expect(popup.view.input.mock.calls).toEqual([[{ type: 'mouseDown', x: 5, y: 6, button: 'left', clickCount: 1, modifiers: ['shift'] }]]);
    ctx.control.popupFrameDone('S1', tabId);
    ctx.control.revealPopup('S1', tabId);
    ctx.control.revealPopup('S1', 'tab-1');
    expect([popup.view.done.mock.calls.length, popup.view.reveal.mock.calls.length]).toEqual([1, 1]);
  });

  it('画面で見ていたポップアップが閉じたら、画面の今のタブは開いたタブに戻ったものとして扱う（Claude の今のタブも）', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/', { title: 'トップ' });
    ctx.open('http://localhost:3000/b', { title: '二' });
    const popup = popupOf(ctx, page, 'http://localhost:3000/login');
    // 人がポップアップのタブを選んだ（画面が知らせてくる）
    ctx.control.activate('S1', `popup-${popup.id}`);
    popup.destroy();
    expect(textOf(await ctx.call('list_tabs')).split('\n').slice(1)).toEqual([
      '* 1. トップ — http://localhost:3000/',
      '  2. 二 — http://localhost:3000/b',
      'The popup window that was the current tab (tab 3) has closed. The current tab is now tab 1. Check the tabs with list_tabs.',
    ]);
  });
});
