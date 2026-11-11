// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  CredentialGuard,
  fillScript,
  CredentialError,
  loginFromSdkItem,
  matchingUrl,
  parseItemRef,
  sdkFailure,
  sdkSource,
  type CredentialSource,
  type ItemRef,
  type Login,
  type SdkItem,
  type SdkModule,
} from '../src/main/browser-credentials';
import { cleanLinks, isItemLink, linkForPage, normalizeSite, type CredentialLink } from '../src/shared/credential-links';
import { IpcChannel, type BrowserAskChange, type BrowserRememberChange } from '../src/shared/ipc';
import { setup, textOf, type Tab } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// 1Password から入れる（src/main/browser-credentials.ts と、browser-control.ts の fill_credential）。
// 取り出し役（1Password の SDK）は作り物に差し替える。値が Claude への答え・エラー文に出ないこと、オリジンが合うときだけ入れること、
// 入れたあとに読み取りを止めることを確かめる。欄に入れるスクリプトは jsdom の上で動かす

const USER = 'alice@example.com';
const PASS = 'S3cret-Pa55-do-not-leak';
const LINK = 'https://start.1password.com/open/i?a=ABCDEFGHIJKLMNOPQRSTUVWXYZ&v=abcdefghijklmnopqrstuvwxyz&i=zyxwvutsrqponmlkjihgfedcba&h=my.1password.com';

// 取り出し役が返すログイン
const item = (urls: string[]): Login => ({ title: 'Example', urls, username: USER, password: PASS });

describe('アイテムの参照', () => {
  it('共有リンクから、アカウント・保管庫・アイテムの ID を読む', () => {
    expect(parseItemRef(LINK)).toEqual({ account: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', vault: 'abcdefghijklmnopqrstuvwxyz', item: 'zyxwvutsrqponmlkjihgfedcba' });
  });

  it('1Password のリンクでないもの・ID の形が違うものは断る', () => {
    expect(() => parseItemRef('https://evil.example.com/open/i?v=abcdefghijklmnopqrstuvwxyz&i=zyxwvutsrqponmlkjihgfedcba')).toThrow(/not a 1Password item link/);
    expect(() => parseItemRef('https://start.1password.com/open/i?v=--vault&i=zyxwvutsrqponmlkjihgfedcba')).toThrow(/malformed/);
    expect(() => parseItemRef('https://start.1password.com/open/i?v=abcdefghijklmnopqrstuvwxyz&i=zyxwvutsrqponmlkjihgfedcba')).toThrow(/missing the account/);
    expect(() => parseItemRef('op://Dev/Site')).toThrow(/not a 1Password item link/);
    expect(() => parseItemRef('https://start.1password.com/open/i?a=ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toThrow(/missing the account, vault or item ID/);
    expect(() => parseItemRef('my password')).toThrow(/Pass a 1Password item link/);
  });
});

describe('オリジンの照合', () => {
  it('同じホストか、その下のサブドメインに合う', () => {
    expect(matchingUrl('https://example.com/login', ['https://example.com'])).toBe('https://example.com');
    expect(matchingUrl('https://login.example.com/', ['example.com'])).toBe('example.com');
    expect(matchingUrl('https://example.com.evil.test/', ['https://example.com'])).toBeNull();
    expect(matchingUrl('https://notexample.com/', ['https://example.com'])).toBeNull();
    expect(matchingUrl('https://example.com/', ['https://login.example.com'])).toBeNull();
  });

  it('読めない URL・http(s) でないものには合わせない', () => {
    expect(matchingUrl('not a url', ['https://example.com'])).toBeNull();
    expect(matchingUrl('https://example.com/', ['http://[bad', 'ftp://example.com'])).toBeNull();
    expect(matchingUrl('https://example.com/', ['http://[bad', 'https://example.com'])).toBe('https://example.com');
  });

  it('ポートと http を確かめる', () => {
    expect(matchingUrl('http://localhost:3000/login', ['http://localhost:3000'])).not.toBeNull();
    expect(matchingUrl('http://localhost:4000/login', ['http://localhost:3000'])).toBeNull();
    // https のアイテムを、http のページには入れない（localhost を除く）
    expect(matchingUrl('http://example.com/login', ['https://example.com'])).toBeNull();
    expect(matchingUrl('http://intranet.test/login', ['http://intranet.test'])).not.toBeNull();
    expect(matchingUrl('file:///tmp/a.html', ['https://example.com'])).toBeNull();
  });
});

describe('欄に入れるスクリプト（jsdom）', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form id="f">
        <input id="search" type="search">
        <input id="email" name="email" type="email">
        <input id="pw" name="pw" type="password">
      </form>`;
    // jsdom は描かないので、どの要素も見えていることにする
    for (const el of document.querySelectorAll('input')) {
      el.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20, toJSON: () => ({}) }) as DOMRect;
    }
    delete (window as { __tanacodeFilled?: unknown }).__tanacodeFilled;
  });

  const run = (code: string): unknown => (0, eval)(code);

  it('selector が無ければ、パスワードの欄と、その前のユーザー名の欄を見つけて入れる。答えに値を入れない', () => {
    const events: string[] = [];
    document.querySelector('#pw')!.addEventListener('input', () => events.push('input'));
    document.querySelector('#pw')!.addEventListener('change', () => events.push('change'));
    const result = run(fillScript({ username: USER, password: PASS }));
    expect(result).toEqual({ filled: [{ field: 'username', element: 'input#email[name="email"]' }, { field: 'password', element: 'input#pw[name="pw"]' }] });
    expect(JSON.stringify(result)).not.toContain(PASS);
    expect(document.querySelector<HTMLInputElement>('#email')!.value).toBe(USER);
    expect(document.querySelector<HTMLInputElement>('#pw')!.value).toBe(PASS);
    expect(events).toEqual(['input', 'change']);
  });

  it('パスワードでない欄には、パスワードを入れない', () => {
    expect(run(fillScript({ passwordSelector: '#email', username: null, password: PASS }))).toEqual({ error: 'input#email[name="email"] is not a password field (<input type=password>)' });
    expect(document.querySelector<HTMLInputElement>('#email')!.value).toBe('');
  });

  it('ユーザー名だけを入れる（ユーザー名とパスワードを別の画面で聞くログイン）', () => {
    expect(run(fillScript({ usernameSelector: '#email', username: USER, password: null }))).toEqual({ filled: [{ field: 'username', element: 'input#email[name="email"]' }] });
    expect(document.querySelector<HTMLInputElement>('#pw')!.value).toBe('');
  });
});

describe('fill_credential', () => {
  let links: CredentialLink[];
  let opCalls: ItemRef[];
  let opResult: Login | Error;
  let filled: string[];

  const env = () => {
    links = [];
    opCalls = [];
    filled = [];
    const source: CredentialSource = {
      read: async (ref) => {
        opCalls.push(ref);
        if (opResult instanceof Error) throw opResult;
        return opResult;
      },
    };
    return setup({ credentials: { source, links: () => links, remember: (link) => (links = [...links.filter((l) => l.site !== link.site), link]) } });
  };

  // ページの作り物: 入れるスクリプトを受け取って控え、入れた結果を返す
  const page = (ctx: ReturnType<typeof env>, url: string): Tab => {
    const tab = ctx.open(url);
    tab.page.credentialFill = (code) => {
      filled.push(code);
      return { filled: [{ field: 'username', element: 'input#email' }, { field: 'password', element: 'input#pw' }] };
    };
    return tab;
  };

  // Claude に返したもの・画面に送ったものに、値が無いか
  const noLeak = (ctx: ReturnType<typeof env>, ...texts: string[]) => {
    for (const text of [...texts, JSON.stringify(ctx.sent)]) {
      expect(text).not.toContain(PASS);
      expect(text).not.toContain(USER);
    }
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('入れて、値を返さない。値はページのスクリプトにだけ入る', async () => {
    const ctx = env();
    opResult = (item(['http://localhost:3000']));
    page(ctx, 'http://localhost:3000/login');
    const result = await ctx.call('fill_credential', { item: LINK });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Filled the username into input#email and password into input#pw from the 1Password item "Example" on http://localhost:3000');
    expect(opCalls).toEqual([parseItemRef(LINK)]);
    expect(filled).toHaveLength(1);
    expect(filled[0]).toContain(PASS);
    noLeak(ctx, textOf(result));
  });

  it('localhost 以外でも人に確かめずに入れる（リンクを渡した時点で許している）。控えが無いサイトなら、入れたあとに帯で控えるかを聞き、返事は待たない', async () => {
    const ctx = env();
    ctx.state.hosts = ['example.com'];
    opResult = item(['https://example.com']);
    page(ctx, 'https://example.com/login');
    const offers = () => ctx.sentOn<BrowserRememberChange>(IpcChannel.BrowserRemember);
    const result = await ctx.call('fill_credential', { item: LINK });
    expect(result.isError).toBeFalsy();
    expect(filled).toHaveLength(1);
    expect(textOf(result)).toContain('tanacode is asking the user, in a banner in the in-app browser, whether to use this item for example.com from now on');
    expect(textOf(result)).toContain('Do not ask about it in the chat.');
    noLeak(ctx, textOf(result));
    expect(offers()).toEqual([{ sessionId: 'S1', offer: { id: expect.any(String), site: 'example.com', title: 'Example' } }]);
    expect(ctx.control.pendingRemembers()).toEqual(offers());
    // まだ控えていない（人が「使う」を押すまで）
    expect(links).toEqual([]);
    const id = offers()[0].offer!.id;
    // 前の問いへの返事・形の違う返事は捨てる
    ctx.control.answerRemember('S1', 'old', true);
    ctx.control.answerRemember('S2', id, true);
    expect(links).toEqual([]);
    ctx.control.answerRemember('S1', id, true);
    expect(links).toEqual([{ site: 'example.com', link: LINK }]);
    expect(offers().at(-1)).toEqual({ sessionId: 'S1', offer: null });
    expect(ctx.control.pendingRemembers()).toEqual([]);
    // 控えたサイトでは、もう聞かない
    const again = await ctx.call('fill_credential', { item: LINK });
    expect(textOf(again)).not.toContain('asking the user');
    expect(offers()).toHaveLength(2);
  });

  it('「使わない」・セッションを閉じたときは控えない。新しく聞いたら前の問いは消える', async () => {
    const ctx = env();
    ctx.state.hosts = ['example.com'];
    opResult = item(['https://example.com']);
    page(ctx, 'https://example.com/login');
    const offers = () => ctx.sentOn<BrowserRememberChange>(IpcChannel.BrowserRemember);
    await ctx.call('fill_credential', { item: LINK });
    await ctx.call('fill_credential', { item: LINK });
    const [first, second] = offers();
    expect(first.offer!.id).not.toBe(second.offer!.id);
    ctx.control.answerRemember('S1', first.offer!.id, true);
    expect(links).toEqual([]);
    ctx.control.answerRemember('S1', second.offer!.id, false);
    expect(links).toEqual([]);
    expect(offers().at(-1)).toEqual({ sessionId: 'S1', offer: null });
    await ctx.call('fill_credential', { item: LINK });
    ctx.control.forget('S1');
    expect(offers().at(-1)).toEqual({ sessionId: 'S1', offer: null });
    expect(ctx.control.pendingRemembers()).toEqual([]);
    expect(links).toEqual([]);
  });

  it('1Password の答えが上限の近くまでかかったら入れない（時間切れを返したあとに入らないように）', async () => {
    const ctx = setup({
      credentials: {
        // 人が 1Password の承認を 56 秒たってから押した
        source: { read: () => new Promise((resolve) => setTimeout(() => resolve(item(['http://localhost:3000'])), 56_000)) },
        links: () => [],
        remember: () => {},
      },
    });
    const tab = ctx.open('http://localhost:3000/login');
    tab.page.credentialFill = () => {
      throw new Error('入れてはいけない');
    };
    const result = await ctx.call('fill_credential', { item: LINK });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/1Password answered too late/);
    expect(tab.scriptsOf('credentialFill')).toEqual([]);
  });

  it('ページが HTTP の認証を求めていれば、その入力欄に答える（照合する先は認証を求めた先）。プロキシ・合わないアイテムには答えない', async () => {
    const ctx = env();
    ctx.state.hosts = ['stg.example.com'];
    const tab = page(ctx, 'https://stg.example.com/');
    const auth = (isProxy = false) =>
      ctx.control.requestLogin(tab as unknown as WebContents, tab as unknown as WebContents, { url: 'https://stg.example.com/', authInfo: { isProxy, scheme: 'basic', host: isProxy ? 'proxy.corp' : 'stg.example.com', port: isProxy ? 3128 : 443, realm: 'STG' } }, () => {});

    auth(true);
    opResult = (item(['https://stg.example.com']));
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toMatch(/sign-in to the proxy proxy\.corp:3128, which fill_credential cannot answer/);
    ctx.control.answerLogin('S1', ctx.control.pendingLogins()[0].login!.id, null);

    auth();
    opResult = (item(['https://other.test']));
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toBe('The 1Password item "Example" is not for https://stg.example.com, which is asking for HTTP authentication. Nothing was filled.');
    expect(tab.calls).not.toContain('reload');

    opResult = (item(['https://stg.example.com']));
    const result = await ctx.call('fill_credential', { item: LINK });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Signed in to the HTTP authentication of https://stg.example.com with the 1Password item "Example"');
    expect(textOf(result)).toContain('whether to use this item for stg.example.com from now on');
    expect(tab.calls).toContain('reload');
    expect(filled).toEqual([]);
    expect(ctx.control.pendingLogins()).toEqual([]);
    noLeak(ctx, textOf(result));
  });

  it('入れる途中の端: アイテムの URL が読めない・ページのスクリプトが答えない・null を返す', async () => {
    const ctx = env();
    const tab = page(ctx, 'http://localhost:3000/login');
    opResult = item(['http://[bad', 'other.test']);
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toBe('The 1Password item "Example" is for http://[bad, https://other.test, not for this page (http://localhost:3000). Nothing was filled.');
    // ユーザー名の欄だけ（パスワードは入れない）
    opResult = item(['http://localhost:3000']);
    tab.page.credentialFill = (code) => (filled.push(code), { filled: [{ field: 'username', element: 'input#email' }] });
    expect(textOf(await ctx.call('fill_credential', { item: LINK, usernameSelector: '#email' }))).toContain('Filled the username into input#email');
    expect(filled.at(-1)).toContain('"p":null');
    opResult = item(['http://localhost:3000']);
    tab.page.credentialFill = () => {
      throw new Error('ページが答えない');
    };
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toBe('Could not fill the credential: the page did not respond. Nothing was filled.');
    tab.page.credentialFill = () => null;
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toBe('Could not fill the credential: the page did not respond. Nothing was filled.');
  });

  it('HTTP の認証: ユーザー名かパスワードの無いアイテムでは答えない。控えたリンクでも答え、控えたものと伝える', async () => {
    const ctx = env();
    ctx.state.hosts = ['stg.example.com'];
    const tab = page(ctx, 'https://stg.example.com/');
    ctx.control.requestLogin(tab as unknown as WebContents, tab as unknown as WebContents, { url: 'https://stg.example.com/', authInfo: { isProxy: false, scheme: 'basic', host: 'stg.example.com', port: 443, realm: 'STG' } }, () => {});
    opResult = { ...item(['https://stg.example.com']), username: null };
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toBe('The 1Password item "Example" needs both a username and a password for HTTP authentication. Nothing was filled.');
    links = [{ site: 'stg.example.com', link: LINK }];
    opResult = item(['https://stg.example.com']);
    const result = await ctx.call('fill_credential', {});
    expect(textOf(result)).toContain('with the 1Password item "Example" (the item the user saved for this site)');
    expect(textOf(result)).not.toContain('asking the user');
  });

  it('アイテムの URL と今のページが合わなければ入れない', async () => {
    const ctx = env();
    ctx.state.hosts = ['evil.test'];
    opResult = (item(['https://example.com']));
    page(ctx, 'https://evil.test/login');
    const result = await ctx.call('fill_credential', { item: LINK });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The 1Password item "Example" is for https://example.com, not for this page (https://evil.test). Nothing was filled.');
    expect(filled).toEqual([]);
  });

  it('入れられないとき: アイテムに欄が無い・待つ間にページが移った・欄が見つからない。selector を 1 つだけ渡したら、その欄だけ', async () => {
    const ctx = env();
    const tab = page(ctx, 'http://localhost:3000/login');
    opResult = { ...item(['http://localhost:3000']), username: null };
    expect(textOf(await ctx.call('fill_credential', { item: LINK, usernameSelector: '#email' }))).toBe('The 1Password item "Example" has no username. Nothing was filled.');
    opResult = { ...item(['http://localhost:3000']), password: null };
    expect(textOf(await ctx.call('fill_credential', { item: LINK, passwordSelector: '#pw' }))).toBe('The 1Password item "Example" has no password. Nothing was filled.');
    opResult = { ...item(['http://localhost:3000']), username: null, password: null };
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toBe('The 1Password item "Example" has neither a username nor a password. Nothing was filled.');
    expect(filled).toEqual([]);

    // 1Password を待つ間に、別のサイトへ移った
    let moved: Tab | null = null;
    const other = setup({ credentials: { source: { read: async () => ((moved!.url = 'http://localhost:4000/'), item(['http://localhost:3000'])) }, links: () => [], remember: () => {} } });
    moved = other.open('http://localhost:3000/login');
    expect(textOf(await other.call('fill_credential', { item: LINK }))).toBe('The page changed while waiting for 1Password, so nothing was filled.');
    expect(moved.scriptsOf('credentialFill')).toEqual([]);

    // 欄が見つからない（ページのスクリプトが理由を返した）
    tab.url = 'http://localhost:3000/login';
    tab.page.credentialFill = (code) => (filled.push(code), { error: 'no visible password field on the page' });
    opResult = item(['http://localhost:3000']);
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toBe('Could not fill the credential: no visible password field on the page. Nothing was filled.');
    // パスワードの欄だけ（ユーザー名は入れない）
    expect(filled.at(-1)).toContain('"u":"alice@example.com"');
    tab.page.credentialFill = (code) => (filled.push(code), { filled: [{ field: 'password', element: 'input#pw' }] });
    expect(textOf(await ctx.call('fill_credential', { item: LINK, passwordSelector: '#pw' }))).toContain('Filled the password into input#pw');
    expect(filled.at(-1)).toContain('"u":null');
  });

  it('URL の無いアイテムには入れない', async () => {
    const ctx = env();
    opResult = (item([]));
    page(ctx, 'http://localhost:3000/login');
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toMatch(/has no website URL/);
    expect(filled).toEqual([]);
  });

  it('1Password から取り出せないときは、その理由を伝える', async () => {
    const ctx = env();
    opResult = new CredentialError(sdkFailure(new Error('Native library is not available.')));
    page(ctx, 'http://localhost:3000/login');
    const result = await ctx.call('fill_credential', { item: LINK });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Could not reach the 1Password app/);
  });

  it('入れたページでは evaluate を断り、パスワードが見える形にされたら読むツールも断る。ページを移ったら戻す', async () => {
    const ctx = env();
    opResult = (item(['http://localhost:3000']));
    const tab = page(ctx, 'http://localhost:3000/login');
    let exposed = false;
    tab.page.credentialCheck = () => exposed;
    tab.page.text = () => ({ title: 'Login', url: tab.url, parts: [{ frame: null, text: 'Login' }] });
    await ctx.call('fill_credential', { item: LINK });

    const evaluate = await ctx.call('evaluate', { expression: 'document.querySelector("#pw").value' });
    expect(evaluate.isError).toBe(true);
    expect(textOf(evaluate)).toMatch(/evaluate is not available on this page/);
    expect(tab.evaluated).toEqual([]);

    expect((await ctx.call('get_text')).isError).toBeFalsy();
    exposed = true;
    const text = await ctx.call('get_text');
    expect(text.isError).toBe(true);
    expect(textOf(text)).toMatch(/shown as plain text/);

    // 別の文書へ移った（送ったあとのページ）
    tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'http://localhost:3000/home' });
    tab.evaluate = () => 1;
    expect((await ctx.call('evaluate', { expression: '1' })).isError).toBeFalsy();
  });

  it('item を省くと、今のサイトに控えたリンクを使う。控えていなければ断る', async () => {
    const ctx = env();
    opResult = (item(['http://localhost:3000']));
    page(ctx, 'http://localhost:3000/login');
    const none = await ctx.call('fill_credential', {});
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/No 1Password item is saved for this site \(http:\/\/localhost:3000\)/);
    expect(opCalls).toEqual([]);
    links = [{ site: 'localhost:3000', link: LINK }];
    const result = await ctx.call('fill_credential', {});
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('(the item the user saved for this site)');
    expect(opCalls).toEqual([parseItemRef(LINK)]);
  });

  it('ログインを頼むときは、帯に 1Password の案内の印を付ける（頼みの語・ページのパスワード欄）。リンクを控えたサイトでは付けない', async () => {
    const ctx = env();
    const tab = page(ctx, 'http://localhost:3000/login');
    let hasPassword = false;
    tab.page.hasPassword = () => hasPassword;
    const askWith = async (message: string) => {
      const pending = ctx.control.handle('S1', 'ask_user_to_act', { message });
      await vi.advanceTimersByTimeAsync(0);
      const change = ctx.sentOn<BrowserAskChange>(IpcChannel.BrowserAsk).at(-1)!;
      ctx.control.answerAsk('S1', change.ask!.id, { done: true, reason: '' });
      await pending;
      return change.ask!.login === true;
    };
    // 頼みの文が文字でないもの（頼みは断られる）・タブの無いセッションでも、決めるのに失敗しない
    await ctx.control.handle('S1', 'ask_user_to_act', { message: 123 });
    const empty = env();
    const pendingEmpty = empty.control.handle('S2', 'ask_user_to_act', { message: 'ログインしてください' });
    await vi.advanceTimersByTimeAsync(0);
    const emptyChange = empty.sentOn<BrowserAskChange>(IpcChannel.BrowserAsk).at(-1)!;
    expect(emptyChange.ask!.login).toBe(true);
    empty.control.answerAsk('S2', emptyChange.ask!.id, { done: true, reason: '' });
    await pendingEmpty;
    expect(await askWith('Please log in with the test account')).toBe(true);
    expect(await askWith('テスト用のアカウントでサインインしてください')).toBe(true);
    expect(await askWith('2 段階認証のコードを入れてください')).toBe(false);
    hasPassword = true;
    expect(await askWith('続きをお願いします')).toBe(true);
    links = [{ site: 'localhost:3000', link: LINK }];
    expect(await askWith('ログインしてください')).toBe(false);
  });

  it('作り物がなければ使えないと伝える', async () => {
    const ctx = setup();
    ctx.open('http://localhost:3000/login');
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toMatch(/not available/);
  });
});

describe('CredentialGuard', () => {
  it('入れたページのタブが閉じたら、控えを捨てる', async () => {
    const guard = new CredentialGuard();
    const tab = new (await import('./helpers/fake-electron')).FakeContents({ url: 'http://localhost:3000/' });
    guard.mark(tab as unknown as WebContents, tab.url);
    expect(await guard.refusal('evaluate', tab.id, async () => false)).toMatch(/evaluate is not available/);
    tab.emit('destroyed');
    expect(await guard.refusal('evaluate', tab.id, async () => false)).toBeNull();
  });

  it('iframe の中の移動・同じ文書の中の移動では、控えを捨てない', async () => {
    const guard = new CredentialGuard();
    const tab = new (await import('./helpers/fake-electron')).FakeContents({ url: 'http://localhost:3000/' });
    guard.mark(tab as unknown as WebContents, tab.url);
    guard.mark(tab as unknown as WebContents, tab.url);
    tab.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(await guard.refusal('evaluate', tab.id, async () => false)).toMatch(/evaluate is not available/);
  });

  it('入れていないページでは何も断らない（ページで確かめもしない）', async () => {
    const guard = new CredentialGuard();
    const check = vi.fn(async () => true);
    expect(await guard.refusal('evaluate', 1, check)).toBeNull();
    expect(await guard.refusal('screenshot', 1, check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });
});

describe('1Password SDK の取り出し役', () => {
  const sdkItem = (over: Partial<SdkItem> = {}): SdkItem => ({
    title: 'Example',
    category: 'Login',
    websites: [{ url: 'https://example.com' }],
    fields: [
      { id: 'username', fieldType: 'Text', value: USER },
      { id: 'password', fieldType: 'Concealed', value: PASS },
      // セクションの中の欄は、組み込みのユーザー名・パスワードとして扱わない
      { id: 'password', fieldType: 'Concealed', value: 'other', sectionId: 's1' },
    ],
    ...over,
  });

  // SDK の作り物。作ったクライアントのアカウントと、引いたアイテムを控える
  const fakeSdk = (get: (vault: string, item: string) => Promise<SdkItem>) => {
    const made: { account: unknown; integrationName: string; integrationVersion: string }[] = [];
    const gets: [string, string][] = [];
    let loads = 0;
    const sdk: SdkModule = {
      DesktopAuth: class {
        constructor(readonly accountName: string) {}
      },
      createClient: async (config) => {
        made.push({ account: (config.auth as { accountName: string }).accountName, integrationName: config.integrationName, integrationVersion: config.integrationVersion });
        return { items: { get: async (vault, item) => (gets.push([vault, item]), get(vault, item)) } };
      },
    };
    return { load: async () => (loads++, sdk), made, gets, loads: () => loads };
  };

  it('リンクのアカウントでデスクトップアプリ連携のクライアントを作り、保管庫とアイテムの ID で引く。クライアントは使い回す', async () => {
    const fake = fakeSdk(async () => sdkItem());
    const source = sdkSource(fake.load, '2.8.4');
    await expect(source.read(parseItemRef(LINK))).resolves.toEqual({ title: 'Example', urls: ['https://example.com'], username: USER, password: PASS });
    await source.read(parseItemRef(LINK));
    expect(fake.made).toEqual([{ account: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', integrationName: 'tanacode', integrationVersion: '2.8.4' }]);
    expect(fake.gets).toEqual([
      ['abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba'],
      ['abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba'],
    ]);
    expect(fake.loads()).toBe(1);
  });

  it('クライアントを作れなかったら忘れて、次はまた作る', async () => {
    let attempts = 0;
    const sdk: SdkModule = {
      DesktopAuth: class {
        constructor(readonly accountName: string) {}
      },
      createClient: async () => {
        if (attempts++ === 0) throw new Error('Native library is not available.');
        return { items: { get: async () => sdkItem() } };
      },
    };
    const source = sdkSource(async () => sdk, '1');
    await expect(source.read(parseItemRef(LINK))).rejects.toThrow(/Could not reach the 1Password app/);
    await expect(source.read(parseItemRef(LINK))).resolves.toMatchObject({ password: PASS });
    expect(attempts).toBe(2);
  });

  it('承認が切れたら、クライアントを作り直して 1 回だけやり直す', async () => {
    let calls = 0;
    const fake = fakeSdk(async () => {
      if (calls++ === 0) throw Object.assign(new Error('desktop session expired'), { name: 'DesktopSessionExpiredError' });
      return sdkItem();
    });
    await expect(sdkSource(fake.load, '1').read(parseItemRef(LINK))).resolves.toMatchObject({ password: PASS });
    expect(fake.made).toHaveLength(2);
  });

  it('失敗は Claude に返す文にする（アプリが無い・承認されなかった）', async () => {
    const fake = fakeSdk(async () => {
      throw new Error('Native library is not available.');
    });
    await expect(sdkSource(fake.load, '1').read(parseItemRef(LINK))).rejects.toThrow(/Could not reach the 1Password app/);
    expect(sdkFailure(new Error('authorization denied by user'))).toMatch(/did not approve/);
    expect(sdkFailure(new Error('weird\nsecond'))).toBe('1Password could not read the item: weird');
    expect(sdkFailure('')).toBe('1Password could not read the item.');
    expect(sdkFailure(new Error('SDK integration disabled'))).toMatch(/Could not connect to the 1Password app/);
    expect(sdkFailure(new Error('the vault is locked'))).toMatch(/is locked/);
    expect(sdkFailure(new Error('account not found'))).toMatch(/account in the link was not found/);
    expect(sdkFailure(new Error('item not found'))).toMatch(/item was not found/);
  });

  it('名前の無いアイテムは (untitled)、空の URL は除く', () => {
    expect(loginFromSdkItem(sdkItem({ title: '', websites: [{ url: '' }, { url: 'https://a.test' }] }))).toMatchObject({ title: '(untitled)', urls: ['https://a.test'] });
  });

  it('組み込みの欄だけをユーザー名・パスワードにする', () => {
    expect(loginFromSdkItem(sdkItem({ fields: [{ id: 'password', fieldType: 'Concealed', value: 'x', sectionId: 's' }] }))).toMatchObject({ username: null, password: null });
  });
});

describe('サイトごとのリンク', () => {
  it('サイトの書き方をそろえる', () => {
    expect(normalizeSite('https://Example.com/login')).toBe('example.com');
    expect(normalizeSite('localhost:3000')).toBe('localhost:3000');
    expect(normalizeSite('file:///tmp')).toBeNull();
    expect(normalizeSite('a b')).toBeNull();
  });

  it('書き方の違うサイト', () => {
    expect(normalizeSite('')).toBeNull();
    expect(normalizeSite('ftp://example.com')).toBeNull();
    expect(normalizeSite('http://[bad')).toBeNull();
    expect(normalizeSite('[::1]:3000')).toBe('[::1]:3000');
  });

  it('読めないページ・http(s) でないページには、控えたリンクを使わない', () => {
    const links = [{ site: 'example.com', link: 'a' }];
    expect(linkForPage(links, 'not a url')).toBeNull();
    expect(linkForPage(links, 'file:///tmp/a.html')).toBeNull();
    expect(linkForPage(links, 'https://example.com:8443/')?.link).toBe('a');
  });

  it('リンクの形を確かめる', () => {
    expect(isItemLink(LINK)).toBe(true);
    expect(isItemLink('https://evil.test/open/i?a=ABCDEFGHIJKLMNOPQRSTUVWXYZ&v=abcdefghijklmnopqrstuvwxyz&i=zyxwvutsrqponmlkjihgfedcba')).toBe(false);
    expect(isItemLink('https://start.1password.com/open/i?v=abcdefghijklmnopqrstuvwxyz&i=zyxwvutsrqponmlkjihgfedcba')).toBe(false);
  });

  it('ポートを付けて控えたものを先に、無ければホスト名で探す。サブドメインには合わせない', () => {
    const links = [
      { site: 'localhost', link: 'a' },
      { site: 'localhost:3000', link: 'b' },
      { site: 'example.com', link: 'c' },
    ];
    expect(linkForPage(links, 'http://localhost:3000/x')?.link).toBe('b');
    expect(linkForPage(links, 'http://localhost:4000/x')?.link).toBe('a');
    expect(linkForPage(links, 'https://login.example.com/')).toBeNull();
  });

  it('保存するときに、一覧でないもの・形の違う項目は除く', () => {
    expect(cleanLinks('nope')).toEqual([]);
    expect(cleanLinks([null, 1, { site: 1, link: LINK }, { site: 'a.test' }])).toEqual([]);
  });

  it('保存するときに、形の違うものを除き、同じサイトは後のものを残す', () => {
    expect(cleanLinks([{ site: 'Example.com', link: LINK }, { site: 'bad site', link: LINK }, { site: 'x.test', link: 'nope' }, { site: 'example.com', link: ` ${LINK} ` }])).toEqual([
      { site: 'example.com', link: LINK },
    ]);
  });
});
