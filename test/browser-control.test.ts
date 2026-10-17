import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { BROWSER_ASK_TOOL, browserToolId } from '../src/shared/browser-tools';
import { IpcChannel, type BrowserAskChange } from '../src/shared/ipc';
import { BROWSER_GATE_REQUEST } from '../src/main/browser-bridge';
import { gateOutput, readAnswer } from '../src/main/browser-gate';
import { setLanguage } from '../src/shared/i18n';
import { textResult } from '../src/main/mcp-bridge';
import { FakeContents, HOST } from './helpers/fake-electron';
import { finish, flush, logConsole, setup, textOf, type Tab } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// アプリ内ブラウザの操作（src/main/browser-control.ts）のうち、呼び出しの受け付け・「操作中」の帯・ユーザーに頼む・
// webview の受け付け・コンソールと通信の記録・開く・タブ・Claude の操作の間だけ外へ移らせないこと。
// webview の中身と CDP は作り物（test/helpers/fake-electron.ts）。ページの中を読む・動かすツールは browser-control-page.test.ts

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const asWebContents = (page: FakeContents) => page as unknown as WebContents;

describe('呼び出しの受け付け', () => {
  it('知らないツール・メニューでオフ・無いセッションは、ページに触れずに理由を返す', async () => {
    const { call, state, open, activities } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('rm')).toEqual(textResult('Unknown tool: rm', true));
    state.enabled = false;
    const off = await call('get_text');
    expect(off.isError).toBe(true);
    expect(textOf(off)).toBe('The user has turned off "Claude にアプリ内ブラウザを操作させる" in the tanacode menu.');
    // メニューの項目の名前は、画面の言語で伝える（Claude が利用者に正しい名前を言えるように）
    setLanguage('en');
    try {
      expect(textOf(await call('get_text'))).toBe('The user has turned off "Let Claude Control the In-App Browser" in the tanacode menu.');
    } finally {
      setLanguage('ja');
    }
    state.enabled = true;
    expect(await call('get_text', {}, 'NOPE')).toEqual(textResult('This session is not in tanacode.', true));
    expect(page.scripts).toEqual([]);
    // 「操作中」の帯も出さない
    expect(activities()).toEqual([]);
  });

  it('動いている間は「Claude が操作中」の帯を出し、終わったら残して、8 秒たったら下ろす', async () => {
    const { call, open, activities } = setup();
    open('http://localhost:3000/');
    await call('get_console_logs');
    expect(activities()).toEqual([
      { sessionId: 'S1', active: true, label: 'コンソール', box: null },
      { sessionId: 'S1', active: true, label: null, box: null },
    ]);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(activities()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(activities().at(-1)).toEqual({ sessionId: 'S1', active: false, label: null, box: null });
  });

  it('続けて呼ぶと、下ろす予定を取り消す（帯が途中で消えない）', async () => {
    const { call, open, activities } = setup();
    open('http://localhost:3000/');
    await call('get_console_logs');
    await vi.advanceTimersByTimeAsync(5_000);
    await call('get_failed_requests');
    // 1 回目の終わりから 8 秒たっても、下ろさない
    await vi.advanceTimersByTimeAsync(4_000);
    expect(activities().filter((a) => !a.active)).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(activities().filter((a) => !a.active)).toHaveLength(1);
  });

  it('ほかの呼び出しが動いている間は、1 つ終わっても枠を消さない（最後の 1 つが終わってから）', async () => {
    const { control, call, open, activities } = setup();
    const page = open('http://localhost:3000/');
    let ready = false;
    page.page.wait = () => ready;
    const waiting = control.handle('S1', 'wait_for', { selector: '#done' });
    await flush();
    await call('get_console_logs');
    expect(activities()).toEqual([
      { sessionId: 'S1', active: true, label: '待つ', box: null },
      { sessionId: 'S1', active: true, label: 'コンソール', box: null },
    ]);
    ready = true;
    expect(textOf(await finish(waiting))).toMatch(/^"#done" appeared/);
    expect(activities().at(-1)).toEqual({ sessionId: 'S1', active: true, label: null, box: null });
  });

  it('60 秒たっても終わらない操作は、時間切れを返す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.evaluate = () => new Promise(() => {});
    const started = Date.now();
    expect(await call('evaluate', { expression: 'new Promise(() => {})' })).toEqual(textResult('Did not finish within 60 seconds.', true));
    expect(Date.now() - started).toBeGreaterThanOrEqual(60_000);
    expect(Date.now() - started).toBeLessThan(61_000);
  });

  it('操作の途中の失敗は、エラーの中身を返す（Error でないものも）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.debugger.handler = (method) => {
      if (method === 'Page.getFrameTree') throw 'CDP が応えません';
      return {};
    };
    expect(await call('get_accessibility_tree')).toEqual(textResult('CDP が応えません', true));
    page.page.text = () => {
      throw new Error('Script failed to execute');
    };
    expect(await call('get_text')).toEqual(textResult('Script failed to execute', true));
  });
});

describe('JavaScript の実行の確認のフックへの答え', () => {
  const gate = async (control: ReturnType<typeof setup>['control'], sessionId = 'S1') =>
    JSON.parse(textOf(await control.handle(sessionId, BROWSER_GATE_REQUEST, {}))) as { local: boolean; url: string };

  it('今のタブが localhost のページなら local。ほかのページ・タブが無い・壊れたタブは確認を出させる側', async () => {
    const { control, open } = setup();
    expect(await gate(control)).toEqual({ local: false, url: '' });
    const page = open('http://localhost:3000/a');
    expect(await gate(control)).toEqual({ local: true, url: 'http://localhost:3000/a' });
    page.url = 'http://myapp.local/';
    expect(await gate(control)).toEqual({ local: false, url: 'http://myapp.local/' });
    page.destroyed = true;
    expect(await gate(control)).toEqual({ local: false, url: '' });
    // ほかのセッションのタブは見ない
    open('http://localhost:4000/', { sessionId: 'S2' });
    expect(await gate(control, 'S2')).toEqual({ local: true, url: 'http://localhost:4000/' });
    expect(await gate(control)).toEqual({ local: false, url: '' });
  });

  it('今のタブを切り替えたら、切り替えた先のページで答える', async () => {
    const { control, open } = setup();
    open('http://localhost:3000/');
    const remote = open('https://staging.example.test/', { activate: false });
    control.activate('S1', remote.tabId);
    expect(await gate(control)).toEqual({ local: false, url: 'https://staging.example.test' });
    control.activate('S1', null);
    expect(await gate(control)).toEqual({ local: false, url: '' });
  });
});

describe('JavaScript の実行の確認のフックへの答えに出すページ', () => {
  const answer = (control: ReturnType<typeof setup>['control'], sessionId = 'S1') =>
    control.handle(sessionId, BROWSER_GATE_REQUEST, { tool: browserToolId('evaluate'), input: { expression: 'document.title' } });

  it('許していない先のページは、オリジンだけを答える（確認の理由に出て、親のセッションにも届くので、パス・クエリを入れない）', async () => {
    const { control, open, state } = setup();
    const page = open('https://accounts.example.com/oauth/callback?code=secret&state=x');
    const result = await answer(control);
    expect(JSON.parse(textOf(result))).toEqual({ local: false, url: 'https://accounts.example.com' });
    const reason = gateOutput(readAnswer(result));
    expect(reason).toContain('https://accounts.example.com');
    expect(reason).not.toContain('oauth');
    expect(reason).not.toContain('secret');
    // 許す先（足した先も）のページは、URL のまま
    state.hosts = ['accounts.example.com'];
    expect(JSON.parse(textOf(await answer(control)))).toEqual({ local: false, url: 'https://accounts.example.com/oauth/callback?code=secret&state=x' });
    // 空のタブ
    state.hosts = [];
    page.url = 'about:blank';
    expect(JSON.parse(textOf(await answer(control)))).toEqual({ local: false, url: 'about:blank' });
  });

  it('メニューでオフのとき・知らないセッションには答えない（フックは確認を出させる側に倒す）', async () => {
    const { control, open, state } = setup();
    open('http://localhost:3000/');
    state.enabled = false;
    let result = await answer(control);
    expect(result.isError).toBe(true);
    expect(readAnswer(result)).toBeNull();
    state.enabled = true;
    result = await answer(control, 'NOPE');
    expect(result.isError).toBe(true);
    expect(readAnswer(result)).toBeNull();
  });
});

describe('ユーザーに操作を頼む（ask_user_to_act）', () => {
  it('帯を出して返事を待つ。待っている間はほかのツールを断り、返事に今のページを添える', async () => {
    const { control, call, asked, sentOn, open } = setup();
    const page = open('http://localhost:3000/login', { title: 'ログイン' });
    const pending = control.handle('S1', BROWSER_ASK_TOOL, { message: 'テスト用のアカウントでログインしてください' });
    await flush();
    const [change] = sentOn<BrowserAskChange>(IpcChannel.BrowserAsk);
    expect(change).toEqual({ sessionId: 'S1', ask: { id: expect.any(String), message: 'テスト用のアカウントでログインしてください' } });
    expect(asked).toEqual([['S1', change.ask]]);
    expect(control.isAsking('S1')).toBe(true);
    expect(control.isAsking('S2')).toBe(false);
    expect(control.pendingAsks()).toEqual([change]);

    const refused = await call('get_text');
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^You have asked the user to act in the browser\. The browser cannot be used until the user presses "終わった" or "できない" in the banner\./);
    expect(page.scripts).toEqual([]);

    // 前の頼みへの返事は捨てる
    control.answerAsk('S1', 'old', { done: true, reason: '' });
    expect(control.isAsking('S1')).toBe(true);
    control.answerAsk('S1', change.ask!.id, { done: true, reason: '' });
    expect(await pending).toEqual(textResult('The user pressed "終わった".\nCurrent page: ログイン\nURL: http://localhost:3000/login'));
    expect(asked.at(-1)).toEqual(['S1', null]);
    expect(sentOn<BrowserAskChange>(IpcChannel.BrowserAsk).at(-1)).toEqual({ sessionId: 'S1', ask: null });
    expect(control.isAsking('S1')).toBe(false);
    expect(control.pendingAsks()).toEqual([]);
  });

  it('返事に添える今のページ: 開いていない・空のタブ・許していない先（オリジンだけ）・タイトルなし', async () => {
    const answerWith = async (prepare: (ctx: ReturnType<typeof setup>) => void) => {
      const ctx = setup();
      prepare(ctx);
      const pending = ctx.control.handle('S1', BROWSER_ASK_TOOL, { message: 'ログインして' });
      await flush();
      const ask = ctx.control.pendingAsks()[0].ask!;
      ctx.control.answerAsk('S1', ask.id, { done: false, reason: 'できません' });
      return textOf(await pending);
    };
    expect(await answerWith(() => {})).toBe('The user pressed "できない". Reason: できません\nCurrent tab: (no page open)');
    expect(await answerWith(({ open }) => open('about:blank'))).toContain('\nCurrent tab: (no page open)');
    const external = await answerWith(({ open }) => open('https://accounts.example.com/o/oauth2/auth?state=secret', { title: '外の認証' }));
    expect(external).toContain('\nThe current page is not allowed for Claude (https://accounts.example.com). It can be neither read nor operated any further.');
    expect(external).not.toContain('secret');
    expect(external).not.toContain('外の認証');
    expect(await answerWith(({ open }) => open('http://localhost:3000/', { title: '' }))).toContain('\nCurrent page: (untitled)\nURL: http://localhost:3000/');
    expect(await answerWith(({ open }) => open('読めない'))).toContain('\nThe current page is not allowed for Claude (invalid URL).');
    expect(
      await answerWith(({ open }) => {
        open('http://localhost:3000/').destroyed = true;
      }),
    ).toContain('\nCurrent tab: (no page open)');
  });

  it('頼む前に「操作中」の帯を下ろし、Claude の操作として扱うのをやめる（ユーザーが外の認証のページへ移れる）', async () => {
    const { control, call, open, activities } = setup();
    const page = open('http://localhost:3000/login');
    await call('get_console_logs');
    // 終わってすぐは、Claude の操作として扱う
    expect(control.isOperating(asWebContents(page))).toBe(true);
    const pending = control.handle('S1', BROWSER_ASK_TOOL, { message: 'ログインして' });
    await flush();
    expect(activities().at(-1)).toEqual({ sessionId: 'S1', active: false, label: null, box: null });
    expect(control.isOperating(asWebContents(page))).toBe(false);
    expect(control.blocksNavigation(asWebContents(page), 'https://accounts.example.com/login')).toBe(false);
    // 下ろす予定は取り消している（あとから帯を下ろし直さない）
    const count = activities().length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(activities()).toHaveLength(count);
    control.turnOff();
    expect(await pending).toEqual(textResult('The request was withdrawn because the user turned off "Claude にアプリ内ブラウザを操作させる" in the tanacode menu.', true));
  });

  it('ほかの呼び出しが動いている途中に頼んだら、帯はその呼び出しが終わるのに任せる。頼んでいる間は外へ移るのを止めない', async () => {
    const { control, open, activities } = setup();
    const page = open('http://localhost:3000/');
    let ready = false;
    page.page.wait = () => ready;
    const waiting = control.handle('S1', 'wait_for', { selector: '#done' });
    await flush();
    expect(control.blocksNavigation(asWebContents(page), 'https://accounts.example.com/')).toBe(true);
    const pending = control.handle('S1', BROWSER_ASK_TOOL, { message: 'ログインして' });
    await flush();
    expect(activities().filter((a) => !a.active)).toEqual([]);
    expect(control.isOperating(asWebContents(page))).toBe(false);
    expect(control.blocksNavigation(asWebContents(page), 'https://accounts.example.com/')).toBe(false);
    ready = true;
    await finish(waiting);
    control.forget('S1');
    expect(await pending).toEqual(textResult('The request was withdrawn because the session was closed.', true));
  });

  it('Claude Code が取り消したら、帯を消してやめる', async () => {
    const { control, asked, open } = setup();
    open('http://localhost:3000/');
    const cancel = new AbortController();
    const pending = control.handle('S1', BROWSER_ASK_TOOL, { message: 'ログインして' }, cancel.signal);
    await flush();
    cancel.abort();
    expect(await pending).toEqual(textResult('Canceled.', true));
    expect(asked.at(-1)).toEqual(['S1', null]);
  });
});

describe('セッションを忘れる（forget）', () => {
  it('頼みをやめ、タブを忘れ、帯を下ろす予定も消す', async () => {
    const { control, call, open, activities } = setup();
    open('http://localhost:3000/');
    await call('get_console_logs');
    const count = activities().length;
    control.forget('S1');
    await vi.advanceTimersByTimeAsync(10_000);
    // 帯を下ろす知らせは送らない（もう無いセッション）
    expect(activities()).toHaveLength(count);
    expect(textOf(await call('list_tabs'))).toBe('There are no tabs (open one with navigate).');
  });

  it('動いている途中に忘れても、その呼び出しは終わりまで動いて返し、帯を下ろす', async () => {
    const { control, open, activities } = setup();
    const page = open('http://localhost:3000/');
    let ready = false;
    page.page.wait = () => ready;
    const pending = control.handle('S1', 'wait_for', { selector: '#done' });
    await flush();
    control.forget('S1');
    ready = true;
    expect(textOf(await finish(pending))).toMatch(/^"#done" appeared/);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(activities().at(-1)).toEqual({ sessionId: 'S1', active: false, label: null, box: null });
    expect(control.isOperating(asWebContents(page))).toBe(false);
  });
});

describe('読み込みを待つ', () => {
  // 押したらページが読み込み中になるリンク
  const loadingLink = (ctx: ReturnType<typeof setup>) => {
    const page = ctx.open('http://localhost:3000/');
    page.page.locate = () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 800, height: 600 }, description: 'a#slow', covered: null });
    page.debugger.handler = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') page.loading = true;
      return {};
    };
    return page;
  };

  it('読み込みが 30 秒たっても終わらなければ、待つのをやめて返す', async () => {
    const ctx = setup();
    loadingLink(ctx);
    const started = Date.now();
    expect(await ctx.call('click', { selector: '#slow' })).toEqual(textResult('Clicked: a#slow'));
    const ms = Date.now() - started;
    expect(ms).toBeGreaterThan(30_000);
    expect(ms).toBeLessThan(31_000);
  });

  it('読み込みの途中で webview が無くなったら、待つのをやめる', async () => {
    const ctx = setup();
    const page = loadingLink(ctx);
    const pending = ctx.control.handle('S1', 'click', { selector: '#slow' });
    // 押して（枠を出して 400ms）、落ち着くのを待ち始めたころ
    await vi.advanceTimersByTimeAsync(1_000);
    page.destroyed = true;
    const started = Date.now();
    expect(await finish(pending)).toEqual(textResult('Clicked: a#slow'));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('webview の受け付け（attach）', () => {
  it('アプリの画面の中の webview だけを受け付ける', async () => {
    const { control, call, state } = setup();
    const accept = (page: FakeContents, tabId: string) => control.attach('S1', tabId, page.id);
    control.attach('S1', 'tab-1', 99_999);
    accept(new FakeContents({ url: 'http://localhost:3000/', type: 'window' }), 'tab-2');
    accept(new FakeContents({ url: 'http://localhost:3000/', host: { id: 2 } }), 'tab-3');
    state.host = null;
    accept(new FakeContents({ url: 'http://localhost:3000/' }), 'tab-4');
    expect(textOf(await call('list_tabs'))).toBe('There are no tabs (open one with navigate).');
    state.host = HOST;
    accept(new FakeContents({ url: 'http://localhost:3000/', title: 'よい' }), 'tab-5');
    expect(textOf(await call('list_tabs'))).toBe('Tabs (* marks the current tab):\n  1. よい — http://localhost:3000/');
  });

  it('同じ中身を知らせ直しても、タブも受け手も増やさない。タブは画面が作った順（番号）に並ぶ', async () => {
    const { control, call } = setup();
    const ten = new FakeContents({ url: 'http://localhost:3000/10', title: '十' });
    const two = new FakeContents({ url: 'http://localhost:3000/2', title: '二' });
    const odd = new FakeContents({ url: 'http://localhost:3000/x', title: '番号なし' });
    control.attach('S1', 'tab-10', ten.id);
    control.attach('S1', 'tab-2', two.id);
    control.attach('S1', 'tab-2', two.id);
    control.attach('S1', 'new', odd.id);
    expect(two.debugger.listenerCount('message')).toBe(1);
    expect(two.listenerCount('destroyed')).toBe(2);
    expect(textOf(await call('list_tabs'))).toBe(
      ['Tabs (* marks the current tab):', '  1. 番号なし — http://localhost:3000/x', '  2. 二 — http://localhost:3000/2', '  3. 十 — http://localhost:3000/10'].join('\n'),
    );
  });

  it('webview が無くなったらタブを外す。同じタブを作り直していたら、新しいほうは残す', async () => {
    const { control, call } = setup();
    const first = new FakeContents({ url: 'http://localhost:3000/', title: '前' });
    const second = new FakeContents({ url: 'http://localhost:3000/', title: '後' });
    const other = new FakeContents({ url: 'http://localhost:3000/o', title: 'ほか' });
    control.attach('S1', 'tab-1', first.id);
    control.attach('S1', 'tab-2', other.id);
    control.attach('S1', 'tab-1', second.id);
    first.destroy();
    expect(textOf(await call('list_tabs'))).toBe('Tabs (* marks the current tab):\n  1. 後 — http://localhost:3000/\n  2. ほか — http://localhost:3000/o');
    other.destroy();
    expect(textOf(await call('list_tabs'))).toBe('Tabs (* marks the current tab):\n  1. 後 — http://localhost:3000/');
    // セッションを忘れたあとに無くなっても、何も起きない
    control.forget('S1');
    second.destroy();
    expect(textOf(await call('list_tabs'))).toBe('There are no tabs (open one with navigate).');
  });

  it('待っている navigate に、知らせてきた webview を渡す', async () => {
    const { control, state, created } = setup();
    state.renderer = false;
    const pending = control.handle('S1', 'navigate', { url: 'http://localhost:3000/' });
    await vi.advanceTimersByTimeAsync(1_000);
    const page = new FakeContents({ url: 'http://localhost:3000/', title: '開いた' });
    control.attach('S1', 'tab-1', page.id);
    control.activate('S1', 'tab-1');
    expect(textOf(await finish(pending))).toBe('Opened: 開いた\nURL: http://localhost:3000/');
    expect(created).toEqual([]);
  });
});

describe('コンソールの記録のうち、許していない先の文', () => {
  const iframe = (origin: string) => ({ origin, url: `${origin}/frame?token=secret`, parent: {} });

  it('get_console_logs は、許していない先のフレーム（別オリジンの iframe・移る途中の前のページ）の文を返さず、除いた数だけを伝える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    logConsole(page, 'error', 'トップの文');
    logConsole(page, 'error', '許す先の iframe の文', '', 0, iframe('http://localhost:4000'));
    logConsole(page, 'error', '外の iframe の秘密の文', '', 0, iframe('https://ads.example.com'));
    // 移り始めたあとに、前のページ（許していない先）が出した文
    logConsole(page, 'warning', '前のページの秘密の文', '', 0, { origin: 'https://evil.example', url: 'https://evil.example/', parent: null });
    // 出したフレームが分からない
    logConsole(page, 'error', 'フレームの分からない文', '', 0, null);
    const text = textOf(await call('get_console_logs'));
    expect(text).toBe('[error] トップの文\n[error] 許す先の iframe の文\n(3 more messages from pages or frames not allowed for Claude are not shown.)');
    // ページの様子に添える「エラー N 件」も、見せるものだけを数える（隠したエラーは 2 件）
    expect(textOf(await call('navigate', { action: 'reload' }))).toContain('The console has 2 errors (read them with get_console_logs).');
  });

  it('トップと同じオリジンの iframe は、トップが人の許したオリジンなら返す。別オリジンの iframe には、タブの許可は効かない', async () => {
    const { call, control, open } = setup();
    const page = open('http://localhost:3000/');
    await control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('navigate'), input: { url: 'https://app.example.com/' } });
    await call('navigate', { url: 'https://app.example.com/' });
    logConsole(page, 'error', '許したページの文');
    logConsole(page, 'error', '同じオリジンの iframe の文', '', 0, iframe('https://app.example.com'));
    logConsole(page, 'error', '別オリジンの iframe の文', '', 0, iframe('https://pay.example.com'));
    expect(textOf(await call('get_console_logs'))).toBe(
      '[error] 許したページの文\n[error] 同じオリジンの iframe の文\n(1 more message from pages or frames not allowed for Claude is not shown.)',
    );
  });

  it('evaluate が失敗したときも、許していない先のフレームの文は返さない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.evaluate = () => {
      logConsole(page, 'error', '外の iframe の秘密の文', '', 0, iframe('https://ads.example.com'));
      logConsole(page, 'error', 'Uncaught Error: 式のエラー');
      throw new Error('Script failed to execute');
    };
    expect(await call('evaluate', { expression: 'x' })).toEqual(textResult('Execution failed: Uncaught Error: 式のエラー', true));
  });
});

describe('コンソールと失敗した通信の記録', () => {
  it('コンソール: 出た場所を添えて集め、レベルで選んで読む。clear で消す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    logConsole(page, 'info', 'はじまり');
    logConsole(page, 'warning', '古い API', 'http://localhost:3000/app.js');
    logConsole(page, 'error', 'こわれた', 'http://localhost:3000/app.js', 12);
    expect(textOf(await call('get_console_logs'))).toBe(
      ['[info] はじまり', '[warning] 古い API (http://localhost:3000/app.js)', '[error] こわれた (http://localhost:3000/app.js:12)'].join('\n'),
    );
    expect(textOf(await call('get_console_logs', { level: 'error' }))).toBe('[error] こわれた (http://localhost:3000/app.js:12)');
    expect(textOf(await call('get_console_logs', { level: 'warning' }))).toBe(
      '[warning] 古い API (http://localhost:3000/app.js)\n[error] こわれた (http://localhost:3000/app.js:12)',
    );
    // 知らないレベルは、すべて
    expect(textOf(await call('get_console_logs', { level: 'verbose' })).split('\n')).toHaveLength(3);
    expect(textOf(await call('get_console_logs', { clear: true })).split('\n')).toHaveLength(3);
    expect(textOf(await call('get_console_logs'))).toBe('No console messages.');
  });

  it('コンソールは新しい 200 件まで。長いものは 20000 文字で切る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    for (let i = 0; i < 205; i++) logConsole(page, 'info', `m${i}`);
    const lines = textOf(await call('get_console_logs')).split('\n');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('[info] m5');
    expect(lines.at(-1)).toBe('[info] m204');
    logConsole(page, 'error', 'x'.repeat(30_000));
    const long = textOf(await call('get_console_logs', { level: 'error' }));
    expect(long).toBe(`[error] ${'x'.repeat(19_992)}\n…(${30_008 - 20_000} more characters omitted)`);
    // ちょうど 20000 文字なら切らない
    await call('get_console_logs', { clear: true });
    logConsole(page, 'info', 'y'.repeat(19_993));
    expect(textOf(await call('get_console_logs'))).toBe(`[info] ${'y'.repeat(19_993)}`);
  });

  it('新しいページを開いたら（トップのフレームで、別の文書へ）、コンソールと失敗した通信を空にする', async () => {
    const { call, open, network } = setup();
    const page = open('http://localhost:3000/');
    const keep = () => {
      logConsole(page, 'error', 'こわれた');
      network.completed!({ statusCode: 500, method: 'GET', url: 'http://localhost:3000/api', resourceType: 'xhr', webContentsId: page.id });
    };
    keep();
    page.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(textOf(await call('get_console_logs'))).toBe('[error] こわれた');
    expect(textOf(await call('get_failed_requests'))).toBe('500 GET http://localhost:3000/api (xhr)');
    page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(textOf(await call('get_console_logs'))).toBe('No console messages.');
    expect(textOf(await call('get_failed_requests'))).toBe('No failed requests.');
  });

  it('失敗した通信: 4xx・5xx とつながらなかったものを集める。移ったための中断・知らない webview のものは数えない', async () => {
    const { control, call, open, network } = setup();
    const page = open('http://localhost:3000/');
    expect(network.filters).toEqual([{ urls: ['http://*/*', 'https://*/*'] }, { urls: ['http://*/*', 'https://*/*'] }]);
    const base = { method: 'GET', resourceType: 'script', webContentsId: page.id };
    network.completed!({ ...base, statusCode: 200, url: 'http://localhost:3000/ok.js' });
    network.completed!({ ...base, statusCode: 399, url: 'http://localhost:3000/redirect.js' });
    network.completed!({ ...base, statusCode: 400, url: 'http://localhost:3000/bad.js' });
    network.completed!({ ...base, statusCode: 404, url: 'http://localhost:3000/missing.js' });
    network.errored!({ ...base, error: 'net::ERR_ABORTED', url: 'http://localhost:3000/moved.js' });
    network.errored!({ ...base, method: 'POST', resourceType: 'xhr', error: 'net::ERR_CONNECTION_REFUSED', url: 'http://localhost:9999/api' });
    network.completed!({ ...base, statusCode: 500, url: 'http://localhost:3000/other.js', webContentsId: 12_345 });
    network.errored!({ ...base, error: 'net::ERR_FAILED', url: 'http://localhost:3000/none.js', webContentsId: undefined });
    expect(textOf(await call('get_failed_requests'))).toBe(
      [
        '400 GET http://localhost:3000/bad.js (script)',
        '404 GET http://localhost:3000/missing.js (script)',
        'net::ERR_CONNECTION_REFUSED POST http://localhost:9999/api (xhr)',
      ].join('\n'),
    );
    // 開いたあとの様子にも件数を出す
    expect(textOf(await call('select_tab', { index: 1 }))).toContain('3 requests failed (read them with get_failed_requests).');
    expect(textOf(await call('get_failed_requests', { clear: true })).split('\n')).toHaveLength(3);
    expect(textOf(await call('get_failed_requests'))).toBe('No failed requests.');
    // 新しい 100 件まで
    for (let i = 0; i < 105; i++) network.completed!({ ...base, statusCode: 503, url: `http://localhost:3000/${i}` });
    const lines = textOf(await call('get_failed_requests')).split('\n');
    expect(lines).toHaveLength(100);
    expect(lines[0]).toBe('503 GET http://localhost:3000/5 (script)');
    // 記録は webview ごと（track は同じ中身なら同じものを返す）
    expect(control.track(asWebContents(page))).toBe(control.track(asWebContents(page)));
  });

  it('webview が無くなったら記録を捨てる（同じ ID で数え直さない）', () => {
    const { control, network } = setup();
    const page = new FakeContents({ url: 'http://localhost:3000/' });
    const logs = control.track(asWebContents(page));
    expect(control.track(asWebContents(page))).toBe(logs);
    network.completed!({ statusCode: 500, method: 'GET', url: 'http://localhost:3000/a', resourceType: 'xhr', webContentsId: page.id });
    expect(logs.failed).toEqual(['500 GET http://localhost:3000/a (xhr)']);
    page.destroy();
    network.completed!({ statusCode: 500, method: 'GET', url: 'http://localhost:3000/b', resourceType: 'xhr', webContentsId: page.id });
    expect(logs.failed).toHaveLength(1);
    const again = control.track(asWebContents(page));
    expect(again).not.toBe(logs);
    expect(again).toEqual({ console: [], failed: [], seq: 0 });
  });
});

describe('開く（navigate）', () => {
  it('url も action も無ければ断る', async () => {
    const { call } = setup();
    expect(await call('navigate', {})).toEqual(textResult('Provide url or action.', true));
    expect(await call('navigate', { url: '  ' })).toEqual(textResult('Provide url or action.', true));
  });

  it('許す先の外は、人に確認した印が無ければ開かない（フックが動かなかったとき。URL はオリジンだけ伝える）。ユーザーが足した先なら開ける', async () => {
    const { call, state, sent } = setup();
    const refused = await call('navigate', { url: 'https://example.com/path?token=secret' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      'The URL to open (https://example.com) is outside the hosts the user allowed for Claude (localhost, 127.0.0.1, *.local and the hosts added with "アプリ内ブラウザで Claude に許す先…" in the tanacode menu), ' +
        'so opening it needs the permission of the user every time, and tanacode has no permission from the user for this. Call navigate again to ask the user. ' +
        'If the user is not asked, this session started before tanacode added this check: ask the user to restart Claude Code in this session.',
    );
    expect(textOf(refused)).not.toContain('secret');
    expect(sent.filter((s) => s.channel === IpcChannel.BrowserOpen)).toEqual([]);
    state.hosts = ['example.com'];
    expect(textOf(await call('navigate', { url: 'https://example.com/path' }))).toBe('Opened: https://example.com/path のタイトル\nURL: https://example.com/path');
  });

  it('URL として読めないものは開かない', async () => {
    const { call, sentOn } = setup();
    const refused = await call('navigate', { url: 'http://exa mple.com/' });
    expect(textOf(refused)).toMatch(/^The URL to open \(invalid URL\) is not allowed for Claude\./);
    expect(sentOn(IpcChannel.BrowserOpen)).toEqual([]);
  });

  it('まだブラウザを開いていないセッションは、画面に開かせて読み込みを待つ。スキームが無ければ http:// を付ける', async () => {
    const { call, sentOn, created } = setup();
    expect(textOf(await call('navigate', { url: ' localhost:3000/app ' }))).toBe('Opened: http://localhost:3000/app のタイトル\nURL: http://localhost:3000/app');
    expect(sentOn(IpcChannel.BrowserOpen)).toEqual([{ sessionId: 'S1', url: 'http://localhost:3000/app' }]);
    expect(sentOn(IpcChannel.BrowserNewTab)).toEqual([]);
    expect(created.map((p) => p.url)).toEqual(['http://localhost:3000/app']);
    // 開いたタブが今のタブになる
    expect(textOf(await call('list_tabs'))).toBe('Tabs (* marks the current tab):\n* 1. http://localhost:3000/app のタイトル — http://localhost:3000/app');
  });

  it('スキームの無い URL は、クエリに URL が入っていても http:// を付ける', async () => {
    const { call, sentOn } = setup();
    await call('navigate', { url: 'localhost:3000/login?next=http://localhost:3000/home' });
    expect(sentOn(IpcChannel.BrowserOpen)).toEqual([{ sessionId: 'S1', url: 'http://localhost:3000/login?next=http://localhost:3000/home' }]);
  });

  it('知らせてきたタブがまだ空（about:blank）の間は、ページへ移って読み込み終わるまで待つ', async () => {
    const { control, state } = setup();
    state.renderer = false;
    const pending = control.handle('S1', 'navigate', { url: 'http://localhost:3000/' });
    await flush();
    const page = new FakeContents({ url: 'about:blank', title: '' });
    control.attach('S1', 'tab-1', page.id);
    control.activate('S1', 'tab-1');
    const started = Date.now();
    setTimeout(() => {
      page.url = 'http://localhost:3000/';
      page.title = 'トップ';
    }, 500);
    expect(textOf(await finish(pending))).toBe('Opened: トップ\nURL: http://localhost:3000/');
    // 移ったら、すぐ返す
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('画面が webview を知らせてこなければ、10 秒で諦める', async () => {
    const { call, state } = setup();
    state.renderer = false;
    const started = Date.now();
    expect(await call('navigate', { url: 'http://localhost:3000/' })).toEqual(textResult('Could not open the in-app browser (the tanacode window did not respond).', true));
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
  });

  it('newTab: 今のタブから新しいタブを開き、番号を返す。このあとの操作は新しいタブに', async () => {
    const { control, call, open, sentOn } = setup();
    const first = open('http://localhost:3000/', { title: 'トップ' });
    expect(textOf(await call('navigate', { url: 'http://localhost:3000/b', newTab: true }))).toBe(
      'Opened in a new tab (tab 2): http://localhost:3000/b のタイトル\nURL: http://localhost:3000/b',
    );
    expect(sentOn(IpcChannel.BrowserNewTab)).toEqual([{ sessionId: 'S1', url: 'http://localhost:3000/b', background: false, openerTabId: first.tabId }]);
    expect(first.calls).toEqual([]);
    expect(JSON.parse(textOf(await control.handle('S1', BROWSER_GATE_REQUEST, {})))).toEqual({ local: true, url: 'http://localhost:3000/b' });
  });

  it('新しく開いたページが、読み込みの途中で許していない先へ移ろうとしたら、止めたことを返す（URL はオリジンだけ）', async () => {
    const { control, call, state } = setup();
    state.afterAttach = (page) => {
      expect(control.blocksNavigation(asWebContents(page), 'https://login.example.com/auth?state=secret')).toBe(true);
    };
    const result = await call('navigate', { url: 'http://localhost:3000/' });
    expect(result).toEqual(textResult('Stopped http://localhost:3000/ because it tried to navigate to a page not allowed for Claude (https://login.example.com). To open it, call navigate with action "continue" (tanacode asks the user for permission).', true));
  });

  it('今のタブで開く: 読み込みを待ち、ページの様子（コンソールのエラー・失敗した通信の件数）を返す', async () => {
    const { call, open, network } = setup();
    const page = open('http://localhost:3000/', { title: 'トップ' });
    page.load = async (url) => {
      page.url = url;
      page.title = '';
      logConsole(page, 'error', 'a');
      logConsole(page, 'warning', 'b');
      logConsole(page, 'error', 'c');
      network.completed!({ statusCode: 404, method: 'GET', url: 'http://localhost:3000/x.png', resourceType: 'image', webContentsId: page.id });
    };
    expect(textOf(await call('navigate', { url: 'http://localhost:3000/next' }))).toBe(
      [
        'Opened: (untitled)',
        'URL: http://localhost:3000/next',
        'The console has 2 errors (read them with get_console_logs).',
        '1 request failed (read them with get_failed_requests).',
      ].join('\n'),
    );
    expect(page.calls).toEqual(['loadURL http://localhost:3000/next']);
  });

  it('リダイレクトなどで移ったための中断は失敗にしない。ほかの失敗は理由を添えて返す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.load = async () => {
      throw new Error("ERR_ABORTED (-3) loading 'http://localhost:3000/old'");
    };
    expect(textOf(await call('navigate', { url: 'http://localhost:3000/old' }))).toBe('Opened: ページ\nURL: http://localhost:3000/');
    page.load = async () => {
      throw new Error("ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:9/'");
    };
    expect(await call('navigate', { url: 'http://localhost:9/' })).toEqual(
      textResult("Could not open http://localhost:9/ (ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:9/').", true),
    );
    page.load = () => Promise.reject('こわれた');
    expect(await call('navigate', { url: 'http://localhost:9/' })).toEqual(textResult('Could not open http://localhost:9/ (こわれた).', true));
  });

  it('今のタブで開いて、許していない先へのリダイレクトを止めたら、止めたことを返す', async () => {
    const { control, call, open } = setup();
    const page = open('http://localhost:3000/');
    page.load = async () => {
      expect(control.blocksNavigation(asWebContents(page), 'https://login.example.com/auth?state=secret')).toBe(true);
      throw new Error('ERR_ABORTED (-3)');
    };
    expect(await call('navigate', { url: 'http://localhost:3000/login' })).toEqual(
      textResult('Stopped http://localhost:3000/login because it tried to navigate to a page not allowed for Claude (https://login.example.com). To open it, call navigate with action "continue" (tanacode asks the user for permission).', true),
    );
    // 開けたあとで、ページの中から許していない先へ移ろうとして止めたときは、結果に添える
    page.load = async (url) => {
      page.url = url;
      expect(control.blocksNavigation(asWebContents(page), 'https://ads.example.com/track?id=1')).toBe(true);
    };
    expect(textOf(await call('navigate', { url: 'http://localhost:3000/home' }))).toBe(
      'Opened: ページ\nURL: http://localhost:3000/home\nBlocked an attempt to navigate to (or open) a page not allowed for Claude (https://ads.example.com). To open it, call navigate with action "continue" (tanacode asks the user for permission).',
    );
    // 次の呼び出しには持ち越さない
    expect(textOf(await call('get_failed_requests'))).toBe('No failed requests.');
  });

  it('action: 戻る・進む・読み込み直す。戻る先・進む先が無ければ断り、許していない先へは戻らない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/a', { title: 'A' });
    page.history = { entries: ['https://login.example.com/cb?code=secret', 'http://localhost:3000/a', 'http://localhost:3000/b'], index: 1 };
    expect(textOf(await call('navigate', { action: 'reload' }))).toBe('Reloaded: A\nURL: http://localhost:3000/a');
    expect(textOf(await call('navigate', { action: 'forward' }))).toBe('Went forward: A\nURL: http://localhost:3000/b');
    expect(await call('navigate', { action: 'forward' })).toEqual(textResult('There is no page to go forward to.', true));
    expect(textOf(await call('navigate', { action: 'back' }))).toBe('Went back: A\nURL: http://localhost:3000/a');
    const refused = await call('navigate', { action: 'back' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^The destination \(https:\/\/login\.example\.com\) is outside the hosts the user allowed for Claude /);
    expect(page.calls).toEqual(['reload', 'goForward', 'goBack']);
    page.history = { entries: ['http://localhost:3000/a'], index: 0 };
    expect(await call('navigate', { action: 'back' })).toEqual(textResult('There is no page to go back to.', true));
  });

  it('action は、今のタブが空・許していない先なら断る（url があっても action を先に見る）', async () => {
    const { call, open } = setup();
    expect(textOf(await call('navigate', { action: 'reload' }))).toBe('No page has been opened in the in-app browser for this session yet. Open one with navigate.');
    const page = open('about:blank');
    expect(await call('navigate', { action: 'reload', url: 'http://localhost:3000/' })).toEqual(textResult('The current tab is empty. Open a page with navigate.', true));
    page.url = 'https://accounts.example.com/signin?continue=secret';
    const refused = textOf(await call('navigate', { action: 'reload' }));
    expect(refused).toMatch(/^The current page \(https:\/\/accounts\.example\.com\) is not allowed for Claude: /);
    expect(page.calls).toEqual([]);
  });

  it('開いた先が許していない先だったら、タイトルと URL の道筋を伏せて、そう伝える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/', { title: 'トップ' });
    page.load = async () => {
      page.url = 'https://login.example.com/auth?state=secret';
      page.title = '外のログイン';
    };
    const result = textOf(await call('navigate', { url: 'http://localhost:3000/login' }));
    expect(result).toBe(
      ['Opened: (not allowed for Claude)', 'URL: https://login.example.com', 'This page is not allowed for Claude, so it can be neither read nor operated any further.'].join('\n'),
    );
  });
});

describe('タブ', () => {
  it('list_tabs: 今のタブに * を付け、許していない先はタイトルと URL の道筋を伏せる。無くなったタブは数えない', async () => {
    const { control, call, open } = setup();
    open('http://localhost:3000/', { title: 'トップ' });
    const second = open('http://localhost:3000/b', { title: '' });
    open('https://login.example.com/auth?state=secret', { title: '外のログイン' });
    const gone = open('http://localhost:3000/gone');
    open('about:blank', { title: '' });
    gone.destroyed = true;
    control.activate('S1', second.tabId);
    const lines = textOf(await call('list_tabs')).split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'Tabs (* marks the current tab):',
      '  1. トップ — http://localhost:3000/',
      '* 2. (untitled) — http://localhost:3000/b',
      '  3. (not allowed for Claude) — https://login.example.com',
    ]);
    expect(lines[4]).toMatch(/^ {2}4\. .* — \(empty tab\)$/);
    expect(lines).toHaveLength(5);
  });

  it('空のタブ（「＋」で開いたもの）を、許していない先とは伝えない（list_tabs・select_tab）', async () => {
    const { call, open } = setup();
    open('http://localhost:3000/', { title: 'トップ' });
    open('about:blank', { title: '', activate: false });
    const line = textOf(await call('list_tabs')).split('\n')[2];
    expect(line).toContain('(empty tab)');
    expect(line).not.toContain('not allowed');
    const selected = textOf(await call('select_tab', { index: 2 }));
    expect(selected).toContain('empty tab');
    expect(selected).not.toContain('not allowed');
    expect(selected).not.toContain('invalid URL');
  });

  it('select_tab: 画面のタブを切り替え、そのタブのページを返す。このあとの操作はそのタブに', async () => {
    const { control, call, open, sentOn } = setup();
    open('http://localhost:3000/', { title: 'トップ' });
    const second = open('http://localhost:3001/', { title: '別のアプリ' });
    expect(textOf(await call('select_tab', { index: 1 }))).toBe('Switched to tab 1: トップ\nURL: http://localhost:3000/');
    expect(sentOn(IpcChannel.BrowserSelectTab)).toEqual([{ sessionId: 'S1', tabId: 'tab-1' }]);
    expect(JSON.parse(textOf(await control.handle('S1', BROWSER_GATE_REQUEST, {}))).url).toBe('http://localhost:3000/');
    await call('select_tab', { index: 2 });
    expect(sentOn(IpcChannel.BrowserSelectTab).at(-1)).toEqual({ sessionId: 'S1', tabId: second.tabId });
    expect(JSON.parse(textOf(await control.handle('S1', BROWSER_GATE_REQUEST, {}))).url).toBe('http://localhost:3001/');
  });

  it('select_tab・close_tab: 無い番号・整数でない番号は断り、タブの数を伝える', async () => {
    const { call, open, sentOn } = setup();
    open('http://localhost:3000/');
    open('http://localhost:3001/');
    for (const index of [0, 3, 1.5, '1', null]) {
      expect(await call('select_tab', { index })).toEqual(textResult(`There is no tab ${String(index)} (2 tabs open; check with list_tabs).`, true));
    }
    expect(await call('close_tab', { index: 5 })).toEqual(textResult('There is no tab 5 (2 tabs open; check with list_tabs).', true));
    expect(sentOn(IpcChannel.BrowserSelectTab)).toEqual([]);
    expect(sentOn(IpcChannel.BrowserCloseTab)).toEqual([]);
  });

  it('close_tab: 番号を省くと今のタブを閉じる。残りのタブの数を返す', async () => {
    const { call, open, sentOn } = setup();
    const first = open('http://localhost:3000/', { title: '一' });
    const second = open('http://localhost:3000/2', { title: '二' });
    open('http://localhost:3000/3', { title: '三' });
    expect(await call('close_tab', { index: 1 })).toEqual(textResult('Closed tab 1 (2 tabs left)'));
    expect(sentOn(IpcChannel.BrowserCloseTab)).toEqual([{ sessionId: 'S1', tabId: first.tabId }]);
    // 今のタブ（3 つ目）は、残りの 2 つ目
    expect(await call('close_tab')).toEqual(textResult('Closed tab 2 (1 tab left)'));
    expect(sentOn(IpcChannel.BrowserCloseTab).at(-1)).toEqual({ sessionId: 'S1', tabId: 'tab-3' });
    expect(textOf(await call('list_tabs'))).toBe(`Tabs (* marks the current tab):\n  1. 二 — http://localhost:3000/2`);
    expect(second.destroyed).toBe(false);
  });

  it('close_tab: タブが無ければ、まだ開いていないと返す', async () => {
    const { call } = setup();
    expect(await call('close_tab')).toEqual(textResult('No page has been opened in the in-app browser for this session yet. Open one with navigate.', true));
  });
});

describe('今のタブ', () => {
  it('画面が今のタブにしたのに webview の知らせがまだなら、3 秒まで待つ', async () => {
    const { control, call } = setup();
    control.activate('S1', 'tab-7');
    const pending = control.handle('S1', 'get_console_logs', {});
    await vi.advanceTimersByTimeAsync(1_000);
    const page = new FakeContents({ url: 'http://localhost:3000/' });
    control.attach('S1', 'tab-7', page.id);
    expect(textOf(await finish(pending))).toBe('No console messages.');
    // 来なければ断る
    control.activate('S1', 'tab-8');
    const started = Date.now();
    expect(await call('get_console_logs')).toEqual(textResult('No page has been opened in the in-app browser for this session yet. Open one with navigate.', true));
    expect(Date.now() - started).toBeGreaterThan(3_000);
  });

  it('webview の知らせを待っている途中でセッションを忘れたら、まだ開いていないと返す', async () => {
    const { control } = setup();
    control.activate('S1', 'tab-7');
    const pending = control.handle('S1', 'get_console_logs', {});
    await vi.advanceTimersByTimeAsync(1_000);
    control.forget('S1');
    expect(await finish(pending)).toEqual(textResult('No page has been opened in the in-app browser for this session yet. Open one with navigate.', true));
  });

  it('今のタブの webview が壊れていたら、待ってから断る。今のタブが無ければすぐ断る', async () => {
    const { control, call, open } = setup();
    const page = open('http://localhost:3000/');
    page.destroyed = true;
    let started = Date.now();
    expect((await call('get_console_logs')).isError).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(3_000);
    control.activate('S1', null);
    started = Date.now();
    expect((await call('get_console_logs')).isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('Claude の操作の間だけ、許していない先へ移らせない・開かせない', () => {
  // 終わらない wait_for で、Claude の操作の途中にする
  const operating = async (ctx: ReturnType<typeof setup>, page: Tab) => {
    let ready = false;
    page.page.wait = () => ready;
    const pending = ctx.control.handle('S1', 'wait_for', { selector: '#done' });
    await flush();
    return async () => {
      ready = true;
      return finish(pending);
    };
  };

  it('isOperating: 動いている間と、終わってから 2 秒の間だけ。知らない webview は false', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/');
    expect(ctx.control.isOperating(asWebContents(page))).toBe(false);
    expect(ctx.control.isOperating(asWebContents(new FakeContents()))).toBe(false);
    const done = await operating(ctx, page);
    expect(ctx.control.isOperating(asWebContents(page))).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctx.control.isOperating(asWebContents(page))).toBe(true);
    await done();
    expect(ctx.control.isOperating(asWebContents(page))).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ctx.control.isOperating(asWebContents(page))).toBe(false);
    // ほかのセッションの操作は関係ない
    const other = ctx.open('http://localhost:4000/', { sessionId: 'S2' });
    await operating(ctx, page);
    expect(ctx.control.isOperating(asWebContents(other))).toBe(false);
  });

  it('blocksNavigation: ユーザーの操作は止めない。Claude の操作の間は、許していない先だけ止める', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/');
    expect(ctx.control.blocksNavigation(asWebContents(page), 'https://example.com/')).toBe(false);
    await operating(ctx, page);
    expect(ctx.control.blocksNavigation(asWebContents(page), 'http://localhost:3000/next')).toBe(false);
    expect(ctx.control.blocksNavigation(asWebContents(page), 'https://example.com/')).toBe(true);
    expect(ctx.control.blocksNavigation(asWebContents(new FakeContents()), 'https://example.com/')).toBe(false);
    ctx.state.hosts = ['example.com'];
    expect(ctx.control.blocksNavigation(asWebContents(page), 'https://example.com/')).toBe(false);
  });

  it('openFromPage: 知らない webview は扱わない（false）', () => {
    const { control } = setup();
    expect(control.openFromPage(asWebContents(new FakeContents()), 'http://localhost:3000/', 'foreground-tab')).toBe(false);
  });

  it('ユーザーの操作で開いたもの（target=_blank など）は、同じセッションの新しいタブで開く。⌘ クリックは裏で', () => {
    const { control, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    expect(control.openFromPage(asWebContents(page), 'https://example.com/docs', 'background-tab')).toBe(true);
    expect(control.openFromPage(asWebContents(page), 'https://example.com/help', 'foreground-tab')).toBe(true);
    expect(sentOn(IpcChannel.BrowserNewTab)).toEqual([
      { sessionId: 'S1', url: 'https://example.com/docs', background: true, openerTabId: page.tabId },
      { sessionId: 'S1', url: 'https://example.com/help', background: false, openerTabId: page.tabId },
    ]);
  });

  it('タブが 20 個あれば、それ以上は開かない', () => {
    const { control, open, sentOn } = setup();
    let page = open('http://localhost:3000/');
    for (let i = 1; i < 20; i++) page = open(`http://localhost:3000/${i}`);
    expect(control.openFromPage(asWebContents(page), 'http://localhost:3000/more', 'foreground-tab')).toBe(true);
    expect(sentOn(IpcChannel.BrowserNewTab)).toEqual([]);
  });

  it('Claude の操作で開いたものは前に出し、新しいタブができて読み込み終わるのを待って、番号を返す（⌘ クリック扱いでも）', async () => {
    const { control, call, open, sentOn, created, state } = setup();
    // 新しいタブは、知らせてきたあともしばらく読み込み中
    state.afterAttach = (tab) => {
      tab.loadingPolls = 5;
    };
    const page = open('http://localhost:3000/', { title: 'トップ' });
    page.page.locate = () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 800, height: 600 }, description: 'a#popup', covered: null });
    page.debugger.handler = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        expect(control.openFromPage(asWebContents(page), 'http://localhost:3000/popup', 'background-tab')).toBe(true);
      }
      return {};
    };
    const result = textOf(await call('click', { selector: '#popup' }));
    expect(result).toBe(
      'Clicked: a#popup\nOpened in a new tab (tab 2): http://localhost:3000/popup. Further actions apply to this tab (switch tabs with list_tabs and select_tab).',
    );
    expect(sentOn(IpcChannel.BrowserNewTab)).toEqual([{ sessionId: 'S1', url: 'http://localhost:3000/popup', background: false, openerTabId: page.tabId }]);
    expect(created).toHaveLength(1);
    expect(created[0].loadingPolls).toBe(0);
  });

  // Claude がページのボタンを押して、ページがポップアップを開こうとする（押したときに、別ウインドウの扱いが聞いてくる）
  const clickOpening = (ctx: ReturnType<typeof setup>, page: Tab, onRelease: () => void) => {
    page.page.locate = () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 800, height: 600 }, description: 'button#login', covered: null });
    page.debugger.handler = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') onRelease();
      return {};
    };
    return ctx.call('click', { selector: '#login' });
  };

  it('allowsPopup: ユーザーの操作のポップアップは開いてよい（知らない webview も）。Claude の操作の間は、許した先だけ開き、別ウインドウで開いたことをオリジンで伝える', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/');
    expect(ctx.control.allowsPopup(asWebContents(page), 'https://example.com/login')).toBe(true);
    expect(ctx.control.allowsPopup(asWebContents(new FakeContents()), 'https://example.com/login')).toBe(true);
    const result = textOf(
      await clickOpening(ctx, page, () => {
        expect(ctx.control.allowsPopup(asWebContents(page), 'http://localhost:3000/login?state=secret')).toBe(true);
        expect(ctx.control.allowsPopup(asWebContents(page), 'http://localhost:3000/again')).toBe(true);
      }),
    );
    expect(result).toBe(
      'Clicked: button#login\n' +
        'Opened a popup window outside the in-app browser (http://localhost:3000). You can neither read nor operate it (it is not a tab). If the user needs to act there (for example, to log in), ask them with ask_user_to_act.',
    );
    // 次の呼び出しには残らない
    expect(textOf(await ctx.call('get_console_logs'))).toBe('No console messages.');
  });

  it('allowsPopup: 空のページ（about:blank）のポップアップは、Claude の操作の間も開く（中身は開いたページが書き、移るときに確かめる）', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/');
    const result = textOf(await clickOpening(ctx, page, () => expect(ctx.control.allowsPopup(asWebContents(page), 'about:blank')).toBe(true)));
    expect(result).toBe(
      'Clicked: button#login\n' +
        'Opened a popup window outside the in-app browser (about:blank). You can neither read nor operate it (it is not a tab). If the user needs to act there (for example, to log in), ask them with ask_user_to_act.',
    );
  });

  it('allowsPopup: Claude の操作で、許していない先のポップアップは開かず、止めたことを伝える（continue では新しいタブに開く）', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/');
    const result = textOf(await clickOpening(ctx, page, () => expect(ctx.control.allowsPopup(asWebContents(page), 'https://example.com/login?state=secret')).toBe(false)));
    expect(result).toBe(
      'Clicked: button#login\nBlocked an attempt to navigate to (or open) a page not allowed for Claude (https://example.com). To open it, call navigate with action "continue" (tanacode asks the user for permission).',
    );
    const gate = JSON.parse(textOf(await ctx.control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('navigate'), input: { action: 'continue' } }))) as { outside: string | null };
    expect(gate).toEqual({ outside: 'https://example.com' });
    await ctx.call('navigate', { action: 'continue' });
    expect(ctx.sentOn(IpcChannel.BrowserNewTab)).toEqual([{ sessionId: 'S1', url: 'https://example.com/login?state=secret', background: false, openerTabId: page.tabId }]);
  });

  it('blocksNavigation（ポップアップ）: Claude の操作の間は、開いたタブで許していない先への移動だけ止めて伝える。continue の先には控えない', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/');
    expect(ctx.control.blocksNavigation(asWebContents(page), 'https://example.com/', true)).toBe(false);
    const result = textOf(
      await clickOpening(ctx, page, () => {
        expect(ctx.control.blocksNavigation(asWebContents(page), 'http://localhost:3000/next', true)).toBe(false);
        expect(ctx.control.blocksNavigation(asWebContents(page), 'https://example.com/callback?code=secret', true)).toBe(true);
      }),
    );
    expect(result).toBe('Clicked: button#login\nBlocked an attempt to move a popup window opened by the page to a page not allowed for Claude (https://example.com).');
    expect(textOf(await ctx.call('navigate', { action: 'continue' }))).toBe('Nothing was stopped in the current tab, so there is nothing to continue. To open a page, pass url.');
  });

  it('1 回の操作で新しいタブがいくつも開いたら、開いた先をすべて伝え、最後に開いたタブの番号を返す', async () => {
    const { control, call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 800, height: 600 }, description: 'a#both', covered: null });
    page.debugger.handler = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        control.openFromPage(asWebContents(page), 'http://localhost:3000/a', 'foreground-tab');
        control.openFromPage(asWebContents(page), 'http://localhost:3000/b', 'foreground-tab');
      }
      return {};
    };
    expect(textOf(await call('click', { selector: '#both' }))).toBe(
      'Clicked: a#both\nOpened in a new tab (tab 3): http://localhost:3000/a, http://localhost:3000/b. Further actions apply to this tab (switch tabs with list_tabs and select_tab).',
    );
  });

  it('Claude の操作で、許していない先を開こうとしたら開かず、止めたことを返す', async () => {
    const { control, call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 800, height: 600 }, description: 'a#out', covered: null });
    page.debugger.handler = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        expect(control.openFromPage(asWebContents(page), 'https://evil.example.com/?leak=secret', 'foreground-tab')).toBe(true);
      }
      return {};
    };
    const result = textOf(await call('click', { selector: '#out' }));
    expect(result).toBe('Clicked: a#out\nBlocked an attempt to navigate to (or open) a page not allowed for Claude (https://evil.example.com). To open it, call navigate with action "continue" (tanacode asks the user for permission).');
    expect(sentOn(IpcChannel.BrowserNewTab)).toEqual([]);
  });

  it('新しいタブで開いたあと、今のタブが無くなっていたら、番号なしで開いたことだけ返す', async () => {
    const { control, call, open, state } = setup();
    state.renderer = false;
    const page = open('http://localhost:3000/');
    page.page.locate = () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 800, height: 600 }, description: 'a#popup', covered: null });
    page.debugger.handler = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        control.openFromPage(asWebContents(page), 'http://localhost:3000/popup', 'foreground-tab');
        // ページが自分で閉じた（window.close）
        page.destroyed = true;
      }
      return {};
    };
    expect(textOf(await call('click', { selector: '#popup' }))).toBe(
      'Clicked: a#popup\nOpened in a new tab: http://localhost:3000/popup. Further actions apply to this tab (switch tabs with list_tabs and select_tab).',
    );
  });
});

describe('許す先の外を開く（開くたびに人の許可）', () => {
  const OUT = 'https://example.com/a?token=secret';
  const HINT = ' To open it, call navigate with action "continue" (tanacode asks the user for permission).';
  // 開く確認のフック（browser-gate.ts）が、navigate の入力を渡して聞く
  const gateOpen = async (control: ReturnType<typeof setup>['control'], input: Record<string, unknown>, sessionId = 'S1') =>
    JSON.parse(textOf(await control.handle(sessionId, BROWSER_GATE_REQUEST, { tool: browserToolId('navigate'), input }))) as { outside: string | null };
  const request = (input: Record<string, unknown>, tool = 'navigate') => ({ seq: 1, at: 0, tool: browserToolId(tool), input, agent: null });
  // 終わらない wait_for で、Claude の操作の途中にする
  const operating = async (ctx: ReturnType<typeof setup>, page: Tab) => {
    let ready = false;
    page.page.wait = () => ready;
    const pending = ctx.control.handle('S1', 'wait_for', { selector: '#done' });
    await flush();
    return async () => {
      ready = true;
      return finish(pending);
    };
  };

  it('確認のフックへの答え: 許す先の外だけ、オリジンを返して人に確認させる。許す先・開けないもの・読み込み直す・オフ・知らないセッションは何も決めない', async () => {
    const { control, state, open } = setup();
    // まだタブが無ければ、戻る・進む先も無い。入力の無い聞き方にも答える
    expect(await gateOpen(control, { action: 'back' })).toEqual({ outside: null });
    expect(JSON.parse(textOf(await control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('navigate') })))).toEqual({ outside: null });
    const page = open('http://localhost:3000/');
    page.history = { entries: ['http://localhost:3000/', 'https://example.org/next'], index: 0 };
    expect(await gateOpen(control, { action: 'forward' })).toEqual({ outside: 'https://example.org' });
    expect(await gateOpen(control, { url: OUT })).toEqual({ outside: 'https://example.com' });
    expect(await gateOpen(control, { url: 'example.com/b' })).toEqual({ outside: 'http://example.com' });
    expect(await gateOpen(control, { url: 'http://localhost:3000/b' })).toEqual({ outside: null });
    expect(await gateOpen(control, { url: 'localhost:4000' })).toEqual({ outside: null });
    // 開けないもの（navigate が断る）
    for (const url of ['file:///etc/passwd', 'http://exa mple.com/', '  ']) expect(await gateOpen(control, { url })).toEqual({ outside: null });
    expect(await gateOpen(control, {})).toEqual({ outside: null });
    expect(await gateOpen(control, { action: 'reload', url: OUT })).toEqual({ outside: null });
    // 止めたものが無ければ、続ける先も無い
    expect(await gateOpen(control, { action: 'continue' })).toEqual({ outside: null });
    // 戻る先が無い
    expect(await gateOpen(control, { action: 'back' })).toEqual({ outside: null });
    state.hosts = ['example.com'];
    expect(await gateOpen(control, { url: OUT })).toEqual({ outside: null });
    state.hosts = [];
    state.enabled = false;
    expect(await gateOpen(control, { url: OUT })).toEqual({ outside: null });
    state.enabled = true;
    expect(await gateOpen(control, { url: OUT }, 'NOPE')).toEqual({ outside: null });
    // JavaScript の実行の答えは、今までどおり
    expect(JSON.parse(textOf(await control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('evaluate'), input: { expression: '1' } })))).toEqual({
      local: true,
      url: 'http://localhost:3000/',
    });
  });

  it('人に確認した印があれば、今のタブで開いて、そのタブでそのオリジンを許す。許したオリジンの中は、確認なしで読んで・操作して・移れる', async () => {
    const { control, call, open } = setup();
    const page = open('http://localhost:3000/', { title: 'トップ' });
    page.load = async (url) => {
      page.url = url;
      page.title = '外のページ';
    };
    expect(await gateOpen(control, { url: OUT })).toEqual({ outside: 'https://example.com' });
    // タイトルも URL の全体も伝える（読んでよいページになった）
    expect(textOf(await call('navigate', { url: OUT }))).toBe(`Opened: 外のページ\nURL: ${OUT}`);
    expect(page.calls).toEqual([`loadURL ${OUT}`]);
    expect(textOf(await call('get_console_logs'))).toBe('No console messages.');
    expect(textOf(await call('list_tabs'))).toBe(`Tabs (* marks the current tab):\n* 1. 外のページ — ${OUT}`);
    // 同じオリジンの中は、確認なしで移れる（フックは何も決めない）
    expect(await gateOpen(control, { url: 'https://example.com/b' })).toEqual({ outside: null });
    expect(textOf(await call('navigate', { url: 'https://example.com/b' }))).toBe('Opened: 外のページ\nURL: https://example.com/b');
    // ユーザーに頼んだ返事にも、ページを添える
    const pending = control.handle('S1', BROWSER_ASK_TOOL, { message: '見てください' });
    await flush();
    control.answerAsk('S1', control.pendingAsks()[0].ask!.id, { done: true, reason: '' });
    expect(textOf(await pending)).toBe('The user pressed "終わった".\nCurrent page: 外のページ\nURL: https://example.com/b');
    // ほかのオリジンは、まだ許していない（example.com と www.example.com は別）
    expect(await gateOpen(control, { url: 'https://www.example.com/' })).toEqual({ outside: 'https://www.example.com' });
  });

  it('印は 1 回だけ、確認したときと同じ開き方（同じ URL・同じ今のタブ・新しいタブか）で使え、15 分で使えなくなる', async () => {
    const { control, call, open } = setup();
    const first = open('http://localhost:3000/');
    const second = open('http://localhost:3001/', { activate: false });
    await gateOpen(control, { url: OUT });
    const refused = (result: { isError?: boolean }) => expect(result.isError).toBe(true);
    // 確認したあとで、今のタブが変わった
    control.activate('S1', second.tabId);
    refused(await call('navigate', { url: OUT }));
    control.activate('S1', first.tabId);
    refused(await call('navigate', { url: OUT, newTab: true }));
    refused(await call('navigate', { url: 'https://example.com/other' }));
    expect(second.calls).toEqual([]);
    // 確認したのと同じ開き方なら開ける。2 回目は使えない
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1_000);
    expect(textOf(await call('navigate', { url: OUT }))).toMatch(/^Opened: /);
    refused(await call('navigate', { url: OUT, newTab: true }));
    // 15 分たったら使えない
    await gateOpen(control, { url: 'https://other.example.com/', newTab: true });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    refused(await call('navigate', { url: 'https://other.example.com/', newTab: true }));
  });

  it('まだブラウザを開いていないセッション・新しいタブに開くと、できたタブに許可を渡す。開いたもとのタブには渡さない', async () => {
    const { control, call, sentOn } = setup();
    expect(await gateOpen(control, { url: OUT })).toEqual({ outside: 'https://example.com' });
    expect(textOf(await call('navigate', { url: OUT }))).toBe(`Opened: ${OUT} のタイトル\nURL: ${OUT}`);
    expect(sentOn(IpcChannel.BrowserOpen)).toEqual([{ sessionId: 'S1', url: OUT }]);
    // 新しいタブ: 今のタブで許したオリジンでも、新しいタブには人に確認する
    expect(await gateOpen(control, { url: 'https://example.com/b', newTab: true })).toEqual({ outside: 'https://example.com' });
    const other = 'https://other.example.org/';
    expect(await gateOpen(control, { url: other, newTab: true })).toEqual({ outside: 'https://other.example.org' });
    expect(textOf(await call('navigate', { url: other, newTab: true }))).toBe(`Opened in a new tab (tab 2): ${other} のタイトル\nURL: ${other}`);
    expect(textOf(await call('list_tabs'))).toBe(`Tabs (* marks the current tab):\n  1. ${OUT} のタイトル — ${OUT}\n* 2. ${other} のタイトル — ${other}`);
    // もとのタブでは、other.example.org を許していない
    await call('select_tab', { index: 1 });
    expect(await gateOpen(control, { url: other })).toEqual({ outside: 'https://other.example.org' });
  });

  it('新しいタブができなかったときの許可は、あとでユーザーが開いたタブには渡さない', async () => {
    const { control, call, state, open } = setup();
    state.renderer = false;
    await gateOpen(control, { url: OUT });
    expect((await call('navigate', { url: OUT })).isError).toBe(true);
    open(OUT, { title: 'ユーザーが開いた' });
    expect(textOf(await call('list_tabs'))).toBe('Tabs (* marks the current tab):\n* 1. (not allowed for Claude) — https://example.com');
  });

  it('許したタブでも、Claude の操作で別のオリジンへ移ろうとしたら止める。continue で、また人に確認してから開く', async () => {
    const { control, call, open } = setup();
    const page = open('http://localhost:3000/');
    await gateOpen(control, { url: OUT });
    await call('navigate', { url: OUT });
    page.load = async (url) => {
      page.url = url;
      // 同じオリジンへのリダイレクトは止めない。別のオリジン（www 付き）は止める
      expect(control.blocksNavigation(asWebContents(page), 'https://example.com/home')).toBe(false);
      expect(control.blocksNavigation(asWebContents(page), 'https://www.example.com/next?state=secret')).toBe(true);
    };
    const stopped = textOf(await call('navigate', { url: 'https://example.com/login' }));
    expect(stopped).toBe(`Opened: ページ\nURL: https://example.com/login\nBlocked an attempt to navigate to (or open) a page not allowed for Claude (https://www.example.com).${HINT}`);
    // 印が無ければ続けない
    expect((await call('navigate', { action: 'continue' })).isError).toBe(true);
    expect(await gateOpen(control, { action: 'continue' })).toEqual({ outside: 'https://www.example.com' });
    page.load = async (url) => {
      page.url = url;
    };
    expect(textOf(await call('navigate', { action: 'continue' }))).toBe('Opened: ページ\nURL: https://www.example.com/next?state=secret');
    expect(page.calls.at(-1)).toBe('loadURL https://www.example.com/next?state=secret');
    // 続けたら、止めた先は残さない
    expect(await call('navigate', { action: 'continue' })).toEqual(
      textResult('Nothing was stopped in the current tab, so there is nothing to continue. To open a page, pass url.', true),
    );
  });

  it('止めた先は、止めたタブに控える。続けるのは今のタブで止めたもの', async () => {
    const ctx = setup();
    const first = ctx.open('http://localhost:3000/');
    const second = ctx.open('http://localhost:3001/', { activate: false });
    await operating(ctx, first);
    expect(ctx.control.blocksNavigation(asWebContents(first), 'https://example.com/x')).toBe(true);
    expect(ctx.control.blocksNavigation(asWebContents(second), 'https://example.org/y')).toBe(true);
    expect(await gateOpen(ctx.control, { action: 'continue' })).toEqual({ outside: 'https://example.com' });
    ctx.control.activate('S1', second.tabId);
    expect(await gateOpen(ctx.control, { action: 'continue' })).toEqual({ outside: 'https://example.org' });
  });

  it('許したページが新しいウインドウで開くもの: 同じオリジンは新しいタブに許可を渡し、別のオリジンは止めて、continue で新しいタブに開く', async () => {
    const { control, call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    await gateOpen(control, { url: OUT });
    await call('navigate', { url: OUT });
    page.page.locate = () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 800, height: 600 }, description: 'a#popup', covered: null });
    let popup = 'https://example.com/popup';
    page.debugger.handler = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') expect(control.openFromPage(asWebContents(page), popup, 'foreground-tab')).toBe(true);
      return {};
    };
    expect(textOf(await call('click', { selector: '#popup' }))).toBe(
      `Clicked: a#popup\nOpened in a new tab (tab 2): ${popup}. Further actions apply to this tab (switch tabs with list_tabs and select_tab).`,
    );
    expect(textOf(await call('list_tabs')).split('\n')[2]).toBe(`* 2. ${popup} のタイトル — ${popup}`);
    await call('select_tab', { index: 1 });
    popup = 'https://other.example.org/?leak=secret';
    expect(textOf(await call('click', { selector: '#popup' }))).toBe(`Clicked: a#popup\nBlocked an attempt to navigate to (or open) a page not allowed for Claude (https://other.example.org).${HINT}`);
    expect(sentOn(IpcChannel.BrowserNewTab)).toHaveLength(1);
    expect(await gateOpen(control, { action: 'continue' })).toEqual({ outside: 'https://other.example.org' });
    expect(textOf(await call('navigate', { action: 'continue' }))).toBe(`Opened in a new tab (tab 3): ${popup} のタイトル\nURL: ${popup}`);
    expect(sentOn(IpcChannel.BrowserNewTab).at(-1)).toEqual({ sessionId: 'S1', url: popup, background: false, openerTabId: page.tabId });
  });

  it('ユーザーの操作で移ったページは止めない。許していないオリジンなら読ませない。戻る・進む先も、タブで許したかで決める', async () => {
    const { control, call, open } = setup();
    const page = open('http://localhost:3000/');
    await gateOpen(control, { url: OUT });
    await call('navigate', { url: OUT });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(control.blocksNavigation(asWebContents(page), 'https://www.example.com/')).toBe(false);
    page.url = 'https://www.example.com/';
    expect(textOf(await call('get_console_logs'))).toMatch(/^The current page \(https:\/\/www\.example\.com\) is not allowed for Claude: /);
    // 戻る先が、このタブで許したオリジンなら、確認なしで戻れる
    page.url = 'http://localhost:3000/';
    page.history = { entries: [OUT, 'http://localhost:3000/'], index: 1 };
    expect(await gateOpen(control, { action: 'back' })).toEqual({ outside: null });
    page.history = { entries: ['https://www.example.com/', 'http://localhost:3000/'], index: 1 };
    expect(await gateOpen(control, { action: 'back' })).toEqual({ outside: 'https://www.example.com' });
    expect(textOf(await call('navigate', { action: 'back' }))).toBe('Went back: ページ\nURL: https://www.example.com/');
  });

  it('タブを閉じる・メニューでオフにする・セッションを忘れると、許可と印を捨てる。画面が同じタブを作り直したときは引き継ぐ', async () => {
    const { control, call, open } = setup();
    const page = open('http://localhost:3000/');
    await gateOpen(control, { url: OUT });
    await call('navigate', { url: OUT });
    // 画面が同じタブの webview を作り直したら、許可を引き継ぐ。別のタブには渡さない
    const again = Object.assign(new FakeContents({ url: OUT }), { tabId: page.tabId });
    control.attach('S1', page.tabId, again.id);
    expect(textOf(await call('get_console_logs'))).toBe('No console messages.');
    const other = new FakeContents({ url: OUT });
    control.attach('S1', 'tab-9', other.id);
    control.activate('S1', 'tab-9');
    expect((await call('get_console_logs')).isError).toBe(true);
    // 閉じたタブの許可は、タブと一緒に無くなる
    expect(textOf(await call('close_tab', { index: 1 }))).toBe('Closed tab 1 (1 tab left)');
    control.attach('S1', page.tabId, again.id);
    control.activate('S1', page.tabId);
    expect((await call('get_console_logs')).isError).toBe(true);
    // メニューでオフにした
    await gateOpen(control, { url: OUT });
    await call('navigate', { url: OUT });
    expect(textOf(await call('get_console_logs'))).toBe('No console messages.');
    await gateOpen(control, { url: 'https://example.org/' });
    control.turnOff();
    expect((await call('get_console_logs')).isError).toBe(true);
    expect(control.humanOnly('S1', request({ url: 'https://example.org/' }))).toBeNull();
    expect((await call('navigate', { url: 'https://example.org/' })).isError).toBe(true);
    // セッションを忘れたら、印も捨てる
    await gateOpen(control, { url: OUT });
    expect(control.humanOnly('S1', request({ url: OUT }))).not.toBeNull();
    control.forget('S1');
    expect(control.humanOnly('S1', request({ url: OUT }))).toBeNull();
  });

  it('子の許可の確認のうち、外を開く印がある間の navigate は、人だけが答えられる（親に許させない）', async () => {
    const { control, call, open } = setup();
    open('http://localhost:3000/');
    expect(control.humanOnly('S1', request({ url: OUT }))).toBeNull();
    await gateOpen(control, { url: 'http://localhost:3000/b' });
    expect(control.humanOnly('S1', request({ url: 'http://localhost:3000/b' }))).toBeNull();
    await gateOpen(control, { url: OUT });
    expect(control.humanOnly('S1', request({ url: OUT }))).toBe(
      'it asks to open a page outside the hosts the user allowed for Claude in the in-app browser, and only the user can answer such a prompt.',
    );
    expect(control.humanOnly('S1', request({ selector: '#a' }, 'click'))).toBeNull();
    expect(control.humanOnly('S2', request({ url: OUT }))).toBeNull();
    // 印を使ったら、もう当たらない
    await call('navigate', { url: OUT });
    expect(control.humanOnly('S1', request({ url: OUT }))).toBeNull();
    // 15 分たった印も当たらない
    await gateOpen(control, { url: 'https://example.org/' });
    expect(control.humanOnly('S1', request({ url: 'https://example.org/' }))).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(control.humanOnly('S1', request({ url: 'https://example.org/' }))).toBeNull();
  });

  it('子の JavaScript の実行の確認は、今のタブが許す先か、そのタブで人が許したオリジンのときだけ、親も答えられる。ほかは人だけ', async () => {
    const { control, state, call, open } = setup();
    const evaluate = (sessionId = 'S1') => control.humanOnly(sessionId, request({ expression: 'document.title' }, 'evaluate'));
    const HUMAN_ONLY =
      'it asks to run JavaScript on a page that the user has not allowed for Claude in the in-app browser (neither a host the user allowed in tanacode nor a site the user permitted in that tab), and only the user can answer such a prompt.';
    // タブが無い（今のページを確かめられない）
    expect(evaluate()).toBe(HUMAN_ONLY);
    // 許す先（既定の localhost・*.local と、ユーザーが足した先）
    const page = open('http://localhost:3000/');
    expect(evaluate()).toBeNull();
    page.url = 'http://myapp.local/';
    expect(evaluate()).toBeNull();
    page.url = 'https://staging.example.test/';
    expect(evaluate()).toBe(HUMAN_ONLY);
    state.hosts = ['staging.example.test'];
    expect(evaluate()).toBeNull();
    // まだ人が許していないサイト
    page.url = OUT;
    expect(evaluate()).toBe(HUMAN_ONLY);
    // 人がこのタブで開くのを許したら、親も答えられる
    page.url = 'http://localhost:3000/';
    await gateOpen(control, { url: OUT });
    await call('navigate', { url: OUT });
    expect(evaluate()).toBeNull();
    // 許したあとに別のサイトへ移った
    page.url = 'https://other.example/';
    expect(evaluate()).toBe(HUMAN_ONLY);
    page.url = OUT;
    expect(evaluate()).toBeNull();
    // 許したのは、そのタブだけ（同じオリジンでも、別のタブは人だけ）
    const other = open(OUT, { activate: true });
    expect(evaluate()).toBe(HUMAN_ONLY);
    control.activate('S1', page.tabId);
    expect(evaluate()).toBeNull();
    // ほかのセッションのタブの許可は使わない
    open(OUT, { sessionId: 'S2' });
    expect(evaluate('S2')).toBe(HUMAN_ONLY);
    // 空のタブ・壊れたタブ
    control.activate('S1', other.tabId);
    other.url = 'about:blank';
    expect(evaluate()).toBe(HUMAN_ONLY);
    control.activate('S1', page.tabId);
    // メニューでオフにすると、人が許したオリジンも捨てる
    control.turnOff();
    expect(evaluate()).toBe(HUMAN_ONLY);
    page.url = 'http://localhost:3000/';
    expect(evaluate()).toBeNull();
    page.destroyed = true;
    expect(evaluate()).toBe(HUMAN_ONLY);
  });
});
