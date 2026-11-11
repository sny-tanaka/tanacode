import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthInfo, WebContents } from 'electron';
import { IpcChannel, type BrowserLoginChange } from '../src/shared/ipc';
import { BrowserLogins } from '../src/main/browser-logins';
import { FakeContents } from './helpers/fake-electron';
import { setup, textOf } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// ページが求めた HTTP の認証（src/main/browser-logins.ts）。入力欄は人にだけ出し、Claude には値を渡さない。
// 求められたらすぐ取り消し（401 の本文が出る）、人が入れたら読み込み直して、その値で 1 回だけ答える

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const as = (page: FakeContents) => page as unknown as WebContents;
const basic = (overrides: Partial<AuthInfo> = {}): AuthInfo => ({ isProxy: false, scheme: 'basic', host: 'stg.example.com', port: 443, realm: 'STG', ...overrides });

// 答えた値（引数なしは取り消し）
function answered() {
  const calls: (string | undefined)[][] = [];
  return { calls, callback: (username?: string, password?: string) => void calls.push(username === undefined ? [] : [username, password]) };
}

function make() {
  const sent: BrowserLoginChange[] = [];
  const logins = new BrowserLogins((change) => sent.push(change));
  const tab = new FakeContents({ url: '' });
  return { sent, logins, tab };
}

const place = { sessionId: 'S1', tabId: 'tab-1' };

describe('入力欄', () => {
  it('求められたら、すぐに取り消して、タブに入力欄を出す。入れた値は 1 回だけ、読み込み直したページの同じ先に使う', () => {
    const { sent, logins, tab } = make();
    const first = answered();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, first.callback);
    expect(first.calls).toEqual([[]]);
    expect(sent).toEqual([
      { ...place, login: { id: expect.any(String), origin: 'https://stg.example.com', realm: 'STG', proxy: false, insecure: false, retry: false, popup: false } },
    ]);
    const id = sent[0].login!.id;
    logins.answer('S1', id, { username: 'user', password: 'pass' });
    expect(sent.at(-1)).toEqual({ ...place, login: null });
    expect(tab.calls).toEqual(['reload']);
    // 読み込み直したページの認証に、入れた値で答える
    const second = answered();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, second.callback);
    expect(second.calls).toEqual([['user', 'pass']]);
    expect(sent).toHaveLength(2);
    // 使い切った（もう一度求められたら、また人に聞き、「通らなかった」と添える）
    const third = answered();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, third.callback);
    expect(third.calls).toEqual([[]]);
    expect(sent.at(-1)?.login?.retry).toBe(true);
  });

  it('控えた値は、別の先（ホスト・ポート・realm・プロキシ）には使わない', () => {
    for (const other of [basic({ host: 'evil.example.com' }), basic({ port: 8443 }), basic({ realm: 'other' }), basic({ isProxy: true })]) {
      const { sent, logins, tab } = make();
      logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
      logins.answer('S1', sent[0].login!.id, { username: 'user', password: 'pass' });
      const next = answered();
      logins.request(as(tab), as(tab), place, { url: 'https://evil.example.com/', authInfo: other }, next.callback);
      expect(next.calls).toEqual([[]]);
      expect(sent.at(-1)?.login?.retry).toBe(false);
    }
  });

  it('控えた値は、上限（1 分）を過ぎたら使わない', async () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    logins.answer('S1', sent[0].login!.id, { username: 'user', password: 'pass' });
    await vi.advanceTimersByTimeAsync(61_000);
    const late = answered();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, late.callback);
    expect(late.calls).toEqual([[]]);
  });

  it('出している間に、ページが別の先の認証を求めても、入力欄を差し替えない（取り消すだけ）', () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    const other = answered();
    logins.request(as(tab), as(tab), place, { url: 'https://evil.example.com/api', authInfo: basic({ host: 'evil.example.com' }) }, other.callback);
    expect(other.calls).toEqual([[]]);
    expect(sent).toHaveLength(1);
    expect(logins.list()).toEqual([{ ...place, login: sent[0].login }]);
  });

  it('キャンセルしたら、入力欄を消し、読み込み直さない。違う ID・違うセッション・形の違う返事は受け付けない', () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    const id = sent[0].login!.id;
    logins.answer('S1', 'other', { username: 'u', password: 'p' });
    logins.answer('S2', id, { username: 'u', password: 'p' });
    logins.answer('S1', id, { username: 1, password: 'p' });
    logins.answer('S1', id, 'yes');
    expect(sent).toHaveLength(1);
    logins.answer('S1', id, null);
    expect(sent.at(-1)).toEqual({ ...place, login: null });
    expect(tab.calls).toEqual([]);
  });

  it('タブが別のページへ移り始めた・閉じたら、入力欄を消す。同じ文書の中の移動・中のフレームの移動では消さない', () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    tab.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(sent).toHaveLength(1);
    tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(sent.at(-1)).toEqual({ ...place, login: null });
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    expect(sent.at(-1)?.login).not.toBeNull();
    tab.destroy();
    expect(sent.at(-1)).toEqual({ ...place, login: null });
    expect(logins.list()).toEqual([]);
  });

  it('画面がタブを知らせる前に求められたものは、知らせたときに出す', () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), null, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    expect(sent).toEqual([]);
    expect(logins.list()).toEqual([]);
    logins.place(as(tab), place);
    expect(sent).toEqual([{ ...place, login: expect.objectContaining({ origin: 'https://stg.example.com' }) }]);
  });

  it('タブから開いた別ウインドウが求めたものは、タブに出し、入れたら別ウインドウを読み込み直す', () => {
    const { sent, logins, tab } = make();
    const popup = new FakeContents({ url: '', type: 'window' });
    logins.request(as(popup), as(tab), place, { url: 'https://sso.example.com/', authInfo: basic({ host: 'sso.example.com' }) }, () => {});
    expect(sent[0].login).toMatchObject({ origin: 'https://sso.example.com', popup: true });
    logins.answer('S1', sent[0].login!.id, { username: 'u', password: 'p' });
    expect(popup.calls).toEqual(['reload']);
    expect(tab.calls).toEqual([]);
  });

  it('この Mac の外の http は「暗号化されていない」と添える。プロキシは host:port で出す。realm の制御文字は除いて長さを切る', () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), place, { url: 'http://stg.example.com/', authInfo: basic({ port: 80 }) }, () => {});
    expect(sent[0].login).toMatchObject({ origin: 'http://stg.example.com', insecure: true });
    const local = make();
    local.logins.request(as(local.tab), as(local.tab), place, { url: 'http://localhost:8080/', authInfo: basic({ host: 'localhost', port: 8080 }) }, () => {});
    expect(local.sent[0].login).toMatchObject({ origin: 'http://localhost:8080', insecure: false });
    const proxy = make();
    proxy.logins.request(as(proxy.tab), as(proxy.tab), place, { url: 'http://stg.example.com/', authInfo: basic({ isProxy: true, host: 'proxy.corp', port: 3128, realm: `a‮b\n${'x'.repeat(200)}` }) }, () => {});
    expect(proxy.sent[0].login).toMatchObject({ origin: 'proxy.corp:3128', proxy: true, insecure: false });
    expect(proxy.sent[0].login!.realm).toBe(`a b ${'x'.repeat(116)}…`);
  });
});

describe('入力欄の端の扱い', () => {
  it('画面がタブの webview を作り直した（別のタブの ID で知らせた）ら、前の場所の入力欄を消して、新しい場所に出す。同じ場所なら出し直さない', () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    logins.place(as(tab), place);
    expect(sent).toHaveLength(1);
    const moved = { sessionId: 'S1', tabId: 'tab-2' };
    logins.place(as(tab), moved);
    expect(sent.slice(1)).toEqual([
      { ...place, login: null },
      { ...moved, login: sent[0].login },
    ]);
    // 出していないタブ・入力欄の無いタブには何もしない
    logins.place(as(new FakeContents()), place);
    expect(sent).toHaveLength(3);
  });

  it('画面が知らせる前に別のページへ移ったら、出さずに消す（あとで知らせても出さない）', () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), null, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    logins.place(as(tab), place);
    expect(sent).toEqual([]);
    // 入力欄が無いときの移動も何もしない
    tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(sent).toEqual([]);
  });

  it('タブから開いた別ウインドウの入力欄は、もとのタブが別のページへ移っても消す。別ウインドウを閉じたら消すが、タブの控えは残す', () => {
    const { sent, logins, tab } = make();
    const popup = new FakeContents({ url: '', type: 'window' });
    const request = { url: 'https://sso.example.com/', authInfo: basic({ host: 'sso.example.com' }) };
    logins.request(as(popup), as(tab), place, request, () => {});
    tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(sent.at(-1)).toEqual({ ...place, login: null });
    logins.request(as(popup), as(tab), place, request, () => {});
    expect(logins.notes(as(tab))[0]).toMatch(/^A popup window opened from this tab asked for HTTP authentication \(https:\/\/sso\.example\.com\)\./);
    popup.destroy();
    expect(sent.at(-1)).toEqual({ ...place, login: null });
    expect(logins.list()).toEqual([]);
    // タブはまだ開いているので、そのタブの新しい入力欄は出せる
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    expect(logins.list()).toHaveLength(1);
  });

  it('入力欄を出していない別ウインドウが閉じても、タブの入力欄は消さない', () => {
    const { sent, logins, tab } = make();
    const popup = new FakeContents({ url: '', type: 'window' });
    logins.request(as(popup), as(tab), place, { url: 'https://sso.example.com/', authInfo: basic({ host: 'sso.example.com' }) }, () => {});
    logins.answer('S1', sent[0].login!.id, null);
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    popup.destroy();
    expect(logins.list()).toEqual([{ ...place, login: sent.at(-1)!.login }]);
    expect(sent.at(-1)!.login!.origin).toBe('https://stg.example.com');
  });

  it('前に入れた値を捨てる時間切れが、あとで入れた値を捨てない', async () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    logins.answer('S1', sent.at(-1)!.login!.id, { username: 'old', password: 'old' });
    // 読み込み直したページが、別の realm を求めた（控えた値は使わず、もう一度聞く）
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic({ realm: 'other' }) }, () => {});
    await vi.advanceTimersByTimeAsync(30_000);
    logins.answer('S1', sent.at(-1)!.login!.id, { username: 'new', password: 'new' });
    // 前の値の時間切れ（入れてから 1 分）を過ぎても、あとの値（入れてから 31 秒）は使える
    await vi.advanceTimersByTimeAsync(31_000);
    const next = answered();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic({ realm: 'other' }) }, next.callback);
    expect(next.calls).toEqual([['new', 'new']]);
  });

  it('入れたあとに求めたページが閉じていたら、読み込み直さない', () => {
    const { sent, logins, tab } = make();
    const popup = new FakeContents({ url: '', type: 'window' });
    logins.request(as(popup), as(tab), place, { url: 'https://sso.example.com/', authInfo: basic({ host: 'sso.example.com' }) }, () => {});
    popup.destroyed = true;
    logins.answer('S1', sent[0].login!.id, { username: 'u', password: 'p' });
    expect(popup.calls).toEqual([]);
    expect(sent.at(-1)).toEqual({ ...place, login: null });
  });

  it('閉じたページ・入力欄を出しているタブへの認証は、取り消すだけで入力欄を出さない', () => {
    const { sent, logins, tab } = make();
    const closed = new FakeContents({ url: '' });
    closed.destroyed = true;
    const cancel = answered();
    logins.request(as(closed), as(closed), place, { url: 'https://stg.example.com/', authInfo: basic() }, cancel.callback);
    expect([cancel.calls, sent]).toEqual([[[]], []]);
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    expect(sent).toHaveLength(1);
  });

  it('realm の無い認証も出せ、同じく realm の無い先にだけ控えた値を使う', () => {
    const { sent, logins, tab } = make();
    const noRealm = basic({ realm: undefined as unknown as string });
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: noRealm }, () => {});
    expect(sent[0].login!.realm).toBe('');
    logins.answer('S1', sent[0].login!.id, { username: 'u', password: 'p' });
    const next = answered();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: noRealm }, next.callback);
    expect(next.calls).toEqual([['u', 'p']]);
  });

  it('読めない URL・http(s) でない URL のときは、認証の先を host:port で出す', () => {
    for (const url of ['not a url', 'ftp://stg.example.com/']) {
      const { sent, logins, tab } = make();
      logins.request(as(tab), as(tab), place, { url, authInfo: basic({ port: 21 }) }, () => {});
      expect(sent[0].login!.origin).toBe('stg.example.com:21');
    }
  });

  it('プロキシの認証は、Claude にもプロキシとして伝える', () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic({ isProxy: true, host: 'proxy.corp', port: 3128 }) }, () => {});
    expect(logins.notes(as(tab))[0]).toContain('asked for HTTP authentication (the proxy proxy.corp:3128).');
    logins.answer('S1', sent[0].login!.id, null);
    expect(logins.notes(as(tab))).toEqual(["The user closed tanacode's sign-in form for the HTTP authentication (the proxy proxy.corp:3128) without signing in."]);
  });

  it('セッションを消したら、そのセッションの入力欄だけを消す', () => {
    const { sent, logins, tab } = make();
    const other = new FakeContents({ url: '' });
    const elsewhere = { sessionId: 'S2', tabId: 'tab-9' };
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    logins.request(as(other), as(other), elsewhere, { url: 'https://stg.example.com/', authInfo: basic() }, () => {});
    logins.forget('S2');
    expect(logins.list()).toEqual([{ ...place, login: sent[0].login }]);
    expect(sent.at(-1)).toEqual({ ...elsewhere, login: null });
  });
});

describe('Claude への知らせ', () => {
  it('入力欄を出している間は、人に頼むよう伝える。入れた・断ったことは 1 回だけ伝える。値も realm も伝えない', () => {
    const { sent, logins, tab } = make();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic({ realm: 'secret realm' }) }, () => {});
    const asking = logins.notes(as(tab)).join('\n');
    expect(asking).toContain('This page asked for HTTP authentication (https://stg.example.com).');
    expect(asking).toContain('ask_user_to_act');
    expect(asking).not.toContain('secret realm');
    logins.answer('S1', sent[0].login!.id, { username: 'user', password: 'hunter2' });
    const entered = logins.notes(as(tab)).join('\n');
    expect(entered).toBe("The user entered credentials for the HTTP authentication (https://stg.example.com) in tanacode's sign-in form, and tanacode reloaded the page.");
    expect(entered).not.toContain('hunter2');
    expect(logins.notes(as(tab))).toEqual([]);
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic({ realm: 'other' }) }, () => {});
    logins.answer('S1', sent.at(-1)!.login!.id, null);
    expect(logins.notes(as(tab))).toEqual(["The user closed tanacode's sign-in form for the HTTP authentication (https://stg.example.com) without signing in."]);
  });

  it('タブの操作の結果（navigate）に添え、画面に入力欄を送る', async () => {
    const { control, open, call, sentOn } = setup();
    const page = open('http://localhost:3000/');
    page.load = async (url) => {
      page.url = url;
      control.requestLogin(as(page), as(page), { url, authInfo: basic({ host: 'localhost', port: 3000 }) }, () => {});
    };
    const result = await call('navigate', { url: 'http://localhost:3000/admin' });
    expect(textOf(result)).toContain('This page asked for HTTP authentication (http://localhost:3000).');
    const [change] = sentOn<BrowserLoginChange>(IpcChannel.BrowserLogin);
    expect(change).toMatchObject({ sessionId: 'S1', tabId: page.tabId, login: { origin: 'http://localhost:3000' } });
    expect(control.pendingLogins()).toEqual([change]);
    control.answerLogin('S1', change.login!.id, { username: 'u', password: 'p' });
    expect(page.calls.at(-1)).toBe('reload');
    // 人に頼んだ（ask_user_to_act）返事にも添える
    const asked = call('ask_user_to_act', { message: 'ログインしてください' });
    await vi.advanceTimersByTimeAsync(0);
    const ask = sentOn<{ ask: { id: string } | null }>(IpcChannel.BrowserAsk).at(-1)!.ask!;
    control.answerAsk('S1', ask.id, { done: true, reason: '' });
    expect(textOf(await asked)).toContain("The user entered credentials for the HTTP authentication (http://localhost:3000) in tanacode's sign-in form");
  });

  it('セッションを消したら、入力欄を消す', () => {
    const { control, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    control.requestLogin(as(page), as(page), { url: 'http://localhost:3000/', authInfo: basic({ host: 'localhost', port: 3000 }) }, () => {});
    control.forget('S1');
    expect(sentOn<BrowserLoginChange>(IpcChannel.BrowserLogin).at(-1)).toEqual({ sessionId: 'S1', tabId: page.tabId, login: null });
  });
});

describe('1Password から答える（fill）', () => {
  it('出している入力欄の先を返し、取り出した値で人と同じように答える（読み込み直して、同じ先に 1 回だけ使う）。Claude への知らせは残さない', () => {
    const { sent, logins, tab } = make();
    expect(logins.pendingFor(as(tab))).toBeNull();
    expect(logins.fill(as(tab), 'user', 'pass')).toBe(false);
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, answered().callback);
    expect(logins.pendingFor(as(tab))).toEqual({ origin: 'https://stg.example.com', proxy: false });
    expect(logins.fill(as(tab), 'user', 'pass')).toBe(true);
    expect(sent.at(-1)).toEqual({ ...place, login: null });
    expect(tab.calls).toEqual(['reload']);
    expect(logins.notes(as(tab))).toEqual([]);
    const again = answered();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic() }, again.callback);
    expect(again.calls).toEqual([['user', 'pass']]);
  });

  it('プロキシの入力欄は、プロキシと分かる形で返す', () => {
    const { logins, tab } = make();
    logins.request(as(tab), as(tab), place, { url: 'https://stg.example.com/', authInfo: basic({ isProxy: true, host: 'proxy.corp', port: 3128 }) }, answered().callback);
    expect(logins.pendingFor(as(tab))).toEqual({ origin: 'proxy.corp:3128', proxy: true });
  });
});
