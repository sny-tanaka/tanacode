// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialGuard,
  fillScript,
  loginFromSdkItem,
  matchingUrl,
  opArgs,
  opSource,
  opFailure,
  parseItemRef,
  readLogin,
  sdkFailure,
  sdkSource,
  type SdkItem,
  type SdkModule,
  type OpResult,
  type OpRunner,
} from '../src/main/browser-credentials';
import { cleanLinks, isItemLink, linkForPage, normalizeSite, type CredentialLink } from '../src/shared/credential-links';
import { IpcChannel, type BrowserAskChange } from '../src/shared/ipc';
import { setup, textOf, type Tab } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// 1Password から入れる（src/main/browser-credentials.ts と、browser-control.ts の fill_credential）。
// op は作り物に差し替える。値が Claude への答え・エラー文に出ないこと、オリジンが合うときだけ入れること、
// localhost 以外では人に確かめること、入れたあとに読み取りを止めることを確かめる。欄に入れるスクリプトは jsdom の上で動かす

const USER = 'alice@example.com';
const PASS = 'S3cret-Pa55-do-not-leak';
const LINK = 'https://start.1password.com/open/i?a=ABCDEFGHIJKLMNOPQRSTUVWXYZ&v=abcdefghijklmnopqrstuvwxyz&i=zyxwvutsrqponmlkjihgfedcba&h=my.1password.com';

const item = (urls: string[], fields = [
  { id: 'username', type: 'STRING', purpose: 'USERNAME', label: 'username', value: USER },
  { id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value: PASS },
]) => JSON.stringify({ id: 'x', title: 'Example', category: 'LOGIN', urls: urls.map((href) => ({ href, primary: true })), fields });

const ok = (stdout: string): OpResult => ({ code: 0, stdout, stderr: '' });

describe('アイテムの参照', () => {
  it('共有リンクから、アカウント・保管庫・アイテムの ID を読む', () => {
    expect(parseItemRef(LINK)).toEqual({ account: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', vault: 'abcdefghijklmnopqrstuvwxyz', item: 'zyxwvutsrqponmlkjihgfedcba' });
    expect(opArgs(parseItemRef(LINK))).toEqual([
      'item', 'get', 'zyxwvutsrqponmlkjihgfedcba', '--vault=abcdefghijklmnopqrstuvwxyz', '--account=ABCDEFGHIJKLMNOPQRSTUVWXYZ', '--format=json',
    ]);
  });

  it('op:// は保管庫とアイテムの名前だけを受け付ける', () => {
    expect(parseItemRef('op://Dev/My%20Site')).toEqual({ vault: 'Dev', item: 'My Site' });
    expect(() => parseItemRef('op://Dev/My Site/password')).toThrow(/without a field/);
    expect(() => parseItemRef('op://Dev/--help')).toThrow(/cannot start with "-"/);
  });

  it('1Password のリンクでないもの・ID の形が違うものは断る', () => {
    expect(() => parseItemRef('https://evil.example.com/open/i?v=abcdefghijklmnopqrstuvwxyz&i=zyxwvutsrqponmlkjihgfedcba')).toThrow(/not a 1Password item link/);
    expect(() => parseItemRef('https://start.1password.com/open/i?v=--vault&i=zyxwvutsrqponmlkjihgfedcba')).toThrow(/malformed/);
    expect(() => parseItemRef('my password')).toThrow(/Pass a 1Password item link/);
  });
});

describe('op の失敗の伝え方', () => {
  it('入っていない・サインインしていない・承認されなかった・見つからない', () => {
    expect(opFailure({ code: null, stdout: '', stderr: '', missing: true })).toMatch(/not installed.*brew install 1password-cli/);
    expect(opFailure({ code: 1, stdout: '', stderr: '[ERROR] 2026/11/11 10:00:00 You are not currently signed in. Please run `op signin --help`' })).toMatch(/not signed in/);
    expect(opFailure({ code: 1, stdout: '', stderr: '[ERROR] 2026/11/11 10:00:00 authorization prompt dismissed, please try again' })).toMatch(/did not approve/);
    expect(opFailure({ code: 1, stdout: '', stderr: '[ERROR] 2026/11/11 10:00:00 "foo" isn\'t an item in the "Dev" vault' })).toMatch(/was not found/);
    expect(opFailure({ code: null, stdout: '', stderr: '', timedOut: true })).toMatch(/did not answer within 45 seconds/);
  });

  it('知らない失敗は、日時を外した 1 行目だけを添える', () => {
    expect(opFailure({ code: 3, stdout: '', stderr: '[ERROR] 2026/11/11 10:00:00 something odd\nmore' })).toBe('1Password CLI failed (exit code 3): something odd');
  });
});

describe('値の取り出し', () => {
  it('purpose でユーザー名とパスワードを選ぶ', async () => {
    await expect(readLogin(parseItemRef(LINK), async () => ok(item(['https://example.com/login'])))).resolves.toEqual({
      title: 'Example',
      urls: ['https://example.com/login'],
      username: USER,
      password: PASS,
    });
  });

  it('読めない答えは、中身をエラー文に入れない', async () => {
    const error = await readLogin(parseItemRef(LINK), async () => ok(`{"password": "${PASS}"`)).catch((e: Error) => e);
    expect(String(error)).not.toContain(PASS);
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
  let opCalls: string[][];
  let opResult: OpResult;
  let filled: string[];

  const env = () => {
    links = [];
    opCalls = [];
    filled = [];
    const run: OpRunner = async (args) => {
      opCalls.push(args);
      return opResult;
    };
    return setup({ credentials: { source: opSource(run), links: () => links } });
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
    opResult = ok(item(['http://localhost:3000']));
    page(ctx, 'http://localhost:3000/login');
    const result = await ctx.call('fill_credential', { item: LINK });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Filled the username into input#email and password into input#pw from the 1Password item "Example" on http://localhost:3000');
    expect(opCalls).toEqual([opArgs(parseItemRef(LINK))]);
    expect(filled).toHaveLength(1);
    expect(filled[0]).toContain(PASS);
    noLeak(ctx, textOf(result));
  });

  it('localhost 以外でも人に確かめずに入れる（リンクを渡した時点で許している）。控えが無いサイトなら、控え方を Claude に伝える', async () => {
    const ctx = env();
    ctx.state.hosts = ['example.com'];
    opResult = ok(item(['https://example.com']));
    page(ctx, 'https://example.com/login');
    const result = await ctx.call('fill_credential', { item: LINK });
    expect(result.isError).toBeFalsy();
    expect(filled).toHaveLength(1);
    expect(textOf(result)).toContain('they can save it under "サイトごとの 1Password のアイテム"');
    noLeak(ctx, textOf(result));
    links = [{ site: 'example.com', link: LINK }];
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).not.toContain('they can save it');
  });

  it('1Password の答えが上限の近くまでかかったら入れない（時間切れを返したあとに入らないように）', async () => {
    const ctx = setup({
      credentials: {
        // 人が 1Password の承認を 56 秒たってから押した
        source: opSource(() => new Promise((resolve) => setTimeout(() => resolve(ok(item(['http://localhost:3000']))), 56_000))),
        links: () => [],
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

  it('アイテムの URL と今のページが合わなければ入れない', async () => {
    const ctx = env();
    ctx.state.hosts = ['evil.test'];
    opResult = ok(item(['https://example.com']));
    page(ctx, 'https://evil.test/login');
    const result = await ctx.call('fill_credential', { item: LINK });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The 1Password item "Example" is for https://example.com, not for this page (https://evil.test). Nothing was filled.');
    expect(filled).toEqual([]);
  });

  it('URL の無いアイテムには入れない', async () => {
    const ctx = env();
    opResult = ok(item([]));
    page(ctx, 'http://localhost:3000/login');
    expect(textOf(await ctx.call('fill_credential', { item: LINK }))).toMatch(/has no website URL/);
    expect(filled).toEqual([]);
  });

  it('op が無いときは、入れ方を伝える', async () => {
    const ctx = env();
    opResult = { code: null, stdout: '', stderr: '', missing: true };
    page(ctx, 'http://localhost:3000/login');
    const result = await ctx.call('fill_credential', { item: LINK });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not installed/);
  });

  it('入れたページでは evaluate を断り、パスワードが見える形にされたら読むツールも断る。ページを移ったら戻す', async () => {
    const ctx = env();
    opResult = ok(item(['http://localhost:3000']));
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
    opResult = ok(item(['http://localhost:3000']));
    page(ctx, 'http://localhost:3000/login');
    const none = await ctx.call('fill_credential', {});
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/No 1Password item is saved for this site \(localhost:3000\)/);
    expect(opCalls).toEqual([]);
    links = [{ site: 'localhost:3000', link: LINK }];
    const result = await ctx.call('fill_credential', {});
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('(the item the user saved for this site)');
    expect(opCalls).toEqual([opArgs(parseItemRef(LINK))]);
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

  it('承認が切れたら、クライアントを作り直して 1 回だけやり直す', async () => {
    let calls = 0;
    const fake = fakeSdk(async () => {
      if (calls++ === 0) throw Object.assign(new Error('desktop session expired'), { name: 'DesktopSessionExpiredError' });
      return sdkItem();
    });
    await expect(sdkSource(fake.load, '1').read(parseItemRef(LINK))).resolves.toMatchObject({ password: PASS });
    expect(fake.made).toHaveLength(2);
  });

  it('op:// はアカウントが分からないので断る', async () => {
    const fake = fakeSdk(async () => sdkItem());
    await expect(sdkSource(fake.load, '1').read(parseItemRef('op://Dev/Site'))).rejects.toThrow(/Copy Private Link/);
    expect(fake.made).toEqual([]);
  });

  it('失敗は Claude に返す文にする（アプリが無い・承認されなかった）', async () => {
    const fake = fakeSdk(async () => {
      throw new Error('Native library is not available.');
    });
    await expect(sdkSource(fake.load, '1').read(parseItemRef(LINK))).rejects.toThrow(/Could not reach the 1Password app/);
    expect(sdkFailure(new Error('authorization denied by user'))).toMatch(/did not approve/);
    expect(sdkFailure(new Error('weird\nsecond'))).toBe('1Password could not read the item: weird');
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

  it('保存するときに、形の違うものを除き、同じサイトは後のものを残す', () => {
    expect(cleanLinks([{ site: 'Example.com', link: LINK }, { site: 'bad site', link: LINK }, { site: 'x.test', link: 'nope' }, { site: 'example.com', link: ` ${LINK} ` }])).toEqual([
      { site: 'example.com', link: LINK },
    ]);
  });
});
