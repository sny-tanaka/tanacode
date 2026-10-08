import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { BROWSER_ASK_TOOL } from '../src/shared/browser-tools';
import { IpcChannel, type BrowserAskChange } from '../src/shared/ipc';
import { BROWSER_GATE_REQUEST } from '../src/main/browser-bridge';
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
    expect(await call('rm')).toEqual(textResult('知らないツールです: rm', true));
    state.enabled = false;
    const off = await call('get_text');
    expect(off.isError).toBe(true);
    expect(textOf(off)).toContain('tanacode → Claude にアプリ内ブラウザを操作させる）でオフになっています');
    state.enabled = true;
    expect(await call('get_text', {}, 'NOPE')).toEqual(textResult('このセッションは tanacode にありません', true));
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
    expect(textOf(await finish(waiting))).toMatch(/^「#done」が出ました/);
    expect(activities().at(-1)).toEqual({ sessionId: 'S1', active: true, label: null, box: null });
  });

  it('60 秒たっても終わらない操作は、時間切れを返す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.evaluate = () => new Promise(() => {});
    const started = Date.now();
    expect(await call('evaluate', { expression: 'new Promise(() => {})' })).toEqual(textResult('60 秒たっても終わりませんでした', true));
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
    expect(await gate(control)).toEqual({ local: false, url: 'https://staging.example.test/' });
    control.activate('S1', null);
    expect(await gate(control)).toEqual({ local: false, url: '' });
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
    expect(textOf(refused)).toMatch(/^ユーザーに操作を頼んでいるところです。ユーザーが帯の「終わった」か「できない」を押すまで、ブラウザは使えません/);
    expect(page.scripts).toEqual([]);

    // 前の頼みへの返事は捨てる
    control.answerAsk('S1', 'old', { done: true, reason: '' });
    expect(control.isAsking('S1')).toBe(true);
    control.answerAsk('S1', change.ask!.id, { done: true, reason: '' });
    expect(await pending).toEqual(textResult('ユーザーが「終わった」を押しました\n今のページ: ログイン\nURL: http://localhost:3000/login'));
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
    expect(await answerWith(() => {})).toBe('ユーザーが「できない」を押しました。理由: できません\n今のタブ: （ページを開いていません）');
    expect(await answerWith(({ open }) => open('about:blank'))).toContain('\n今のタブ: （ページを開いていません）');
    const external = await answerWith(({ open }) => open('https://accounts.example.com/o/oauth2/auth?state=secret', { title: '外の認証' }));
    expect(external).toContain('\n今のページは Claude に許していない先（https://accounts.example.com）です。これ以上は読めず、操作もできません');
    expect(external).not.toContain('secret');
    expect(external).not.toContain('外の認証');
    expect(await answerWith(({ open }) => open('http://localhost:3000/', { title: '' }))).toContain('\n今のページ: （タイトルなし）\nURL: http://localhost:3000/');
    expect(await answerWith(({ open }) => open('読めない'))).toContain('\n今のページは Claude に許していない先（読めない URL）です');
    expect(
      await answerWith(({ open }) => {
        open('http://localhost:3000/').destroyed = true;
      }),
    ).toContain('\n今のタブ: （ページを開いていません）');
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
    control.cancelAsks();
    expect(await pending).toEqual(textResult('アプリ内ブラウザの操作がオフになったので、頼むのをやめました', true));
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
    expect(await pending).toEqual(textResult('セッションを閉じたので、頼むのをやめました', true));
  });

  it('Claude Code が取り消したら、帯を消してやめる', async () => {
    const { control, asked, open } = setup();
    open('http://localhost:3000/');
    const cancel = new AbortController();
    const pending = control.handle('S1', BROWSER_ASK_TOOL, { message: 'ログインして' }, cancel.signal);
    await flush();
    cancel.abort();
    expect(await pending).toEqual(textResult('取り消されました', true));
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
    expect(textOf(await call('list_tabs'))).toBe('タブはありません（navigate で開けます）');
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
    expect(textOf(await finish(pending))).toMatch(/^「#done」が出ました/);
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
    expect(await ctx.call('click', { selector: '#slow' })).toEqual(textResult('クリックしました: a#slow'));
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
    expect(await finish(pending)).toEqual(textResult('クリックしました: a#slow'));
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
    expect(textOf(await call('list_tabs'))).toBe('タブはありません（navigate で開けます）');
    state.host = HOST;
    accept(new FakeContents({ url: 'http://localhost:3000/', title: 'よい' }), 'tab-5');
    expect(textOf(await call('list_tabs'))).toBe('タブ（* が今のタブ）:\n  1. よい — http://localhost:3000/');
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
      ['タブ（* が今のタブ）:', '  1. 番号なし — http://localhost:3000/x', '  2. 二 — http://localhost:3000/2', '  3. 十 — http://localhost:3000/10'].join('\n'),
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
    expect(textOf(await call('list_tabs'))).toBe('タブ（* が今のタブ）:\n  1. 後 — http://localhost:3000/\n  2. ほか — http://localhost:3000/o');
    other.destroy();
    expect(textOf(await call('list_tabs'))).toBe('タブ（* が今のタブ）:\n  1. 後 — http://localhost:3000/');
    // セッションを忘れたあとに無くなっても、何も起きない
    control.forget('S1');
    second.destroy();
    expect(textOf(await call('list_tabs'))).toBe('タブはありません（navigate で開けます）');
  });

  it('待っている navigate に、知らせてきた webview を渡す', async () => {
    const { control, state, created } = setup();
    state.renderer = false;
    const pending = control.handle('S1', 'navigate', { url: 'http://localhost:3000/' });
    await vi.advanceTimersByTimeAsync(1_000);
    const page = new FakeContents({ url: 'http://localhost:3000/', title: '開いた' });
    control.attach('S1', 'tab-1', page.id);
    control.activate('S1', 'tab-1');
    expect(textOf(await finish(pending))).toBe('開きました: 開いた\nURL: http://localhost:3000/');
    expect(created).toEqual([]);
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
    expect(textOf(await call('get_console_logs'))).toBe('コンソールに出たものはありません');
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
    expect(long).toBe(`[error] ${'x'.repeat(19_992)}\n…（${30_008 - 20_000} 文字を省きました）`);
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
    expect(textOf(await call('get_failed_requests'))).toBe('500 GET http://localhost:3000/api（xhr）');
    page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(textOf(await call('get_console_logs'))).toBe('コンソールに出たものはありません');
    expect(textOf(await call('get_failed_requests'))).toBe('失敗した通信はありません');
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
        '400 GET http://localhost:3000/bad.js（script）',
        '404 GET http://localhost:3000/missing.js（script）',
        'net::ERR_CONNECTION_REFUSED POST http://localhost:9999/api（xhr）',
      ].join('\n'),
    );
    // 開いたあとの様子にも件数を出す
    expect(textOf(await call('select_tab', { index: 1 }))).toContain('失敗した通信が 3 件あります（get_failed_requests で読めます）');
    expect(textOf(await call('get_failed_requests', { clear: true })).split('\n')).toHaveLength(3);
    expect(textOf(await call('get_failed_requests'))).toBe('失敗した通信はありません');
    // 新しい 100 件まで
    for (let i = 0; i < 105; i++) network.completed!({ ...base, statusCode: 503, url: `http://localhost:3000/${i}` });
    const lines = textOf(await call('get_failed_requests')).split('\n');
    expect(lines).toHaveLength(100);
    expect(lines[0]).toBe('503 GET http://localhost:3000/5（script）');
    // 記録は webview ごと（track は同じ中身なら同じものを返す）
    expect(control.track(asWebContents(page))).toBe(control.track(asWebContents(page)));
  });

  it('webview が無くなったら記録を捨てる（同じ ID で数え直さない）', () => {
    const { control, network } = setup();
    const page = new FakeContents({ url: 'http://localhost:3000/' });
    const logs = control.track(asWebContents(page));
    expect(control.track(asWebContents(page))).toBe(logs);
    network.completed!({ statusCode: 500, method: 'GET', url: 'http://localhost:3000/a', resourceType: 'xhr', webContentsId: page.id });
    expect(logs.failed).toEqual(['500 GET http://localhost:3000/a（xhr）']);
    page.destroy();
    network.completed!({ statusCode: 500, method: 'GET', url: 'http://localhost:3000/b', resourceType: 'xhr', webContentsId: page.id });
    expect(logs.failed).toHaveLength(1);
    const again = control.track(asWebContents(page));
    expect(again).not.toBe(logs);
    expect(again).toEqual({ console: [], failed: [] });
  });
});

describe('開く（navigate）', () => {
  it('url も action も無ければ断る', async () => {
    const { call } = setup();
    expect(await call('navigate', {})).toEqual(textResult('url か action を渡してください', true));
    expect(await call('navigate', { url: '  ' })).toEqual(textResult('url か action を渡してください', true));
  });

  it('許していない先は開かない（URL はオリジンだけ伝える）。ユーザーが足した先なら開ける', async () => {
    const { call, state, sent } = setup();
    const refused = await call('navigate', { url: 'https://example.com/path?token=secret' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^開く先（https:\/\/example\.com）は、Claude に許していない先です。Claude が開けるのは localhost・127\.0\.0\.1・\*\.local と/);
    expect(textOf(refused)).not.toContain('secret');
    expect(sent.filter((s) => s.channel === IpcChannel.BrowserOpen)).toEqual([]);
    state.hosts = ['example.com'];
    expect(textOf(await call('navigate', { url: 'https://example.com/path' }))).toBe('開きました: https://example.com/path のタイトル\nURL: https://example.com/path');
  });

  it('URL として読めないものは開かない', async () => {
    const { call, sentOn } = setup();
    const refused = await call('navigate', { url: 'http://exa mple.com/' });
    expect(textOf(refused)).toMatch(/^開く先（読めない URL）は、Claude に許していない先です/);
    expect(sentOn(IpcChannel.BrowserOpen)).toEqual([]);
  });

  it('まだブラウザを開いていないセッションは、画面に開かせて読み込みを待つ。スキームが無ければ http:// を付ける', async () => {
    const { call, sentOn, created } = setup();
    expect(textOf(await call('navigate', { url: ' localhost:3000/app ' }))).toBe('開きました: http://localhost:3000/app のタイトル\nURL: http://localhost:3000/app');
    expect(sentOn(IpcChannel.BrowserOpen)).toEqual([{ sessionId: 'S1', url: 'http://localhost:3000/app' }]);
    expect(sentOn(IpcChannel.BrowserNewTab)).toEqual([]);
    expect(created.map((p) => p.url)).toEqual(['http://localhost:3000/app']);
    // 開いたタブが今のタブになる
    expect(textOf(await call('list_tabs'))).toBe('タブ（* が今のタブ）:\n* 1. http://localhost:3000/app のタイトル — http://localhost:3000/app');
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
    expect(textOf(await finish(pending))).toBe('開きました: トップ\nURL: http://localhost:3000/');
    // 移ったら、すぐ返す
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('画面が webview を知らせてこなければ、10 秒で諦める', async () => {
    const { call, state } = setup();
    state.renderer = false;
    const started = Date.now();
    expect(await call('navigate', { url: 'http://localhost:3000/' })).toEqual(textResult('アプリ内ブラウザを開けませんでした（tanacode の画面が応えませんでした）', true));
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
  });

  it('newTab: 今のタブから新しいタブを開き、番号を返す。このあとの操作は新しいタブに', async () => {
    const { control, call, open, sentOn } = setup();
    const first = open('http://localhost:3000/', { title: 'トップ' });
    expect(textOf(await call('navigate', { url: 'http://localhost:3000/b', newTab: true }))).toBe(
      '新しいタブ（タブ 2）で開きました: http://localhost:3000/b のタイトル\nURL: http://localhost:3000/b',
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
    expect(result).toEqual(textResult('http://localhost:3000/ は、許していない先（https://login.example.com）へ移ろうとしたので、止めました', true));
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
        '開きました: （タイトルなし）',
        'URL: http://localhost:3000/next',
        'コンソールにエラーが 2 件あります（get_console_logs で読めます）',
        '失敗した通信が 1 件あります（get_failed_requests で読めます）',
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
    expect(textOf(await call('navigate', { url: 'http://localhost:3000/old' }))).toBe('開きました: ページ\nURL: http://localhost:3000/');
    page.load = async () => {
      throw new Error("ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:9/'");
    };
    expect(await call('navigate', { url: 'http://localhost:9/' })).toEqual(
      textResult("http://localhost:9/ を開けませんでした（ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:9/'）", true),
    );
    page.load = () => Promise.reject('こわれた');
    expect(await call('navigate', { url: 'http://localhost:9/' })).toEqual(textResult('http://localhost:9/ を開けませんでした（こわれた）', true));
  });

  it('今のタブで開いて、許していない先へのリダイレクトを止めたら、止めたことを返す', async () => {
    const { control, call, open } = setup();
    const page = open('http://localhost:3000/');
    page.load = async () => {
      expect(control.blocksNavigation(asWebContents(page), 'https://login.example.com/auth?state=secret')).toBe(true);
      throw new Error('ERR_ABORTED (-3)');
    };
    expect(await call('navigate', { url: 'http://localhost:3000/login' })).toEqual(
      textResult('http://localhost:3000/login は、許していない先（https://login.example.com）へ移ろうとしたので、止めました', true),
    );
    // 開けたあとで、ページの中から許していない先へ移ろうとして止めたときは、結果に添える
    page.load = async (url) => {
      page.url = url;
      expect(control.blocksNavigation(asWebContents(page), 'https://ads.example.com/track?id=1')).toBe(true);
    };
    expect(textOf(await call('navigate', { url: 'http://localhost:3000/home' }))).toBe(
      '開きました: ページ\nURL: http://localhost:3000/home\n許していない先（https://ads.example.com）へ移ろう（開こう）としたので、止めました',
    );
    // 次の呼び出しには持ち越さない
    expect(textOf(await call('get_failed_requests'))).toBe('失敗した通信はありません');
  });

  it('action: 戻る・進む・読み込み直す。戻る先・進む先が無ければ断り、許していない先へは戻らない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/a', { title: 'A' });
    page.history = { entries: ['https://login.example.com/cb?code=secret', 'http://localhost:3000/a', 'http://localhost:3000/b'], index: 1 };
    expect(textOf(await call('navigate', { action: 'reload' }))).toBe('読み込み直しました: A\nURL: http://localhost:3000/a');
    expect(textOf(await call('navigate', { action: 'forward' }))).toBe('進みました: A\nURL: http://localhost:3000/b');
    expect(await call('navigate', { action: 'forward' })).toEqual(textResult('進む先がありません', true));
    expect(textOf(await call('navigate', { action: 'back' }))).toBe('戻りました: A\nURL: http://localhost:3000/a');
    const refused = await call('navigate', { action: 'back' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^移る先（https:\/\/login\.example\.com）は、Claude に許していない先です/);
    expect(page.calls).toEqual(['reload', 'goForward', 'goBack']);
    page.history = { entries: ['http://localhost:3000/a'], index: 0 };
    expect(await call('navigate', { action: 'back' })).toEqual(textResult('戻る先がありません', true));
  });

  it('action は、今のタブが空・許していない先なら断る（url があっても action を先に見る）', async () => {
    const { call, open } = setup();
    expect(textOf(await call('navigate', { action: 'reload' }))).toBe('このセッションのアプリ内ブラウザで、まだページを開いていません。navigate で開いてください');
    const page = open('about:blank');
    expect(await call('navigate', { action: 'reload', url: 'http://localhost:3000/' })).toEqual(textResult('今のタブは空です。navigate で開いてください', true));
    page.url = 'https://accounts.example.com/signin?continue=secret';
    const refused = textOf(await call('navigate', { action: 'reload' }));
    expect(refused).toMatch(/^今のページ（https:\/\/accounts\.example\.com）は、Claude に許していない先です/);
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
      ['開きました: （Claude に許していない先）', 'URL: https://login.example.com', 'このページは Claude に許していない先なので、これ以上は読めず、操作もできません'].join('\n'),
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
      'タブ（* が今のタブ）:',
      '  1. トップ — http://localhost:3000/',
      '* 2. （タイトルなし） — http://localhost:3000/b',
      '  3. （Claude に許していない先） — https://login.example.com',
    ]);
    expect(lines[4]).toMatch(/^ {2}4\. .* — （空のタブ）$/);
    expect(lines).toHaveLength(5);
  });

  it('select_tab: 画面のタブを切り替え、そのタブのページを返す。このあとの操作はそのタブに', async () => {
    const { control, call, open, sentOn } = setup();
    open('http://localhost:3000/', { title: 'トップ' });
    const second = open('http://localhost:3001/', { title: '別のアプリ' });
    expect(textOf(await call('select_tab', { index: 1 }))).toBe('タブ 1 に切り替えました: トップ\nURL: http://localhost:3000/');
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
      expect(await call('select_tab', { index })).toEqual(textResult(`タブ ${String(index)} はありません（タブは 2 個。list_tabs で確かめられます）`, true));
    }
    expect(await call('close_tab', { index: 5 })).toEqual(textResult('タブ 5 はありません（タブは 2 個。list_tabs で確かめられます）', true));
    expect(sentOn(IpcChannel.BrowserSelectTab)).toEqual([]);
    expect(sentOn(IpcChannel.BrowserCloseTab)).toEqual([]);
  });

  it('close_tab: 番号を省くと今のタブを閉じる。残りのタブの数を返す', async () => {
    const { call, open, sentOn } = setup();
    const first = open('http://localhost:3000/', { title: '一' });
    const second = open('http://localhost:3000/2', { title: '二' });
    open('http://localhost:3000/3', { title: '三' });
    expect(await call('close_tab', { index: 1 })).toEqual(textResult('タブ 1 を閉じました（残りのタブ: 2 個）'));
    expect(sentOn(IpcChannel.BrowserCloseTab)).toEqual([{ sessionId: 'S1', tabId: first.tabId }]);
    // 今のタブ（3 つ目）は、残りの 2 つ目
    expect(await call('close_tab')).toEqual(textResult('タブ 2 を閉じました（残りのタブ: 1 個）'));
    expect(sentOn(IpcChannel.BrowserCloseTab).at(-1)).toEqual({ sessionId: 'S1', tabId: 'tab-3' });
    expect(textOf(await call('list_tabs'))).toBe(`タブ（* が今のタブ）:\n  1. 二 — http://localhost:3000/2`);
    expect(second.destroyed).toBe(false);
  });

  it('close_tab: タブが無ければ、まだ開いていないと返す', async () => {
    const { call } = setup();
    expect(await call('close_tab')).toEqual(textResult('このセッションのアプリ内ブラウザで、まだページを開いていません。navigate で開いてください', true));
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
    expect(textOf(await finish(pending))).toBe('コンソールに出たものはありません');
    // 来なければ断る
    control.activate('S1', 'tab-8');
    const started = Date.now();
    expect(await call('get_console_logs')).toEqual(textResult('このセッションのアプリ内ブラウザで、まだページを開いていません。navigate で開いてください', true));
    expect(Date.now() - started).toBeGreaterThan(3_000);
  });

  it('webview の知らせを待っている途中でセッションを忘れたら、まだ開いていないと返す', async () => {
    const { control } = setup();
    control.activate('S1', 'tab-7');
    const pending = control.handle('S1', 'get_console_logs', {});
    await vi.advanceTimersByTimeAsync(1_000);
    control.forget('S1');
    expect(await finish(pending)).toEqual(textResult('このセッションのアプリ内ブラウザで、まだページを開いていません。navigate で開いてください', true));
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
      'クリックしました: a#popup\n新しいタブ（タブ 2）で開きました: http://localhost:3000/popup。このあとの操作は、このタブに対して行います（list_tabs・select_tab でタブを切り替えられます）',
    );
    expect(sentOn(IpcChannel.BrowserNewTab)).toEqual([{ sessionId: 'S1', url: 'http://localhost:3000/popup', background: false, openerTabId: page.tabId }]);
    expect(created).toHaveLength(1);
    expect(created[0].loadingPolls).toBe(0);
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
      'クリックしました: a#both\n新しいタブ（タブ 3）で開きました: http://localhost:3000/a、http://localhost:3000/b。このあとの操作は、このタブに対して行います（list_tabs・select_tab でタブを切り替えられます）',
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
    expect(result).toBe('クリックしました: a#out\n許していない先（https://evil.example.com）へ移ろう（開こう）としたので、止めました');
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
      'クリックしました: a#popup\n新しいタブで開きました: http://localhost:3000/popup。このあとの操作は、このタブに対して行います（list_tabs・select_tab でタブを切り替えられます）',
    );
  });
});
