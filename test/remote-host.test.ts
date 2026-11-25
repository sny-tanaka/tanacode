import { describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import type { HostMessage, RemoteSession } from '@shared/remote-protocol';
import { RemoteHost, type ServerProcess } from '../src/main/remote-host';

// main の側の、遠隔サーバーの持ち手（src/main/remote-host.ts）。遠隔サーバーを作り物にして、伝文を送り合う

const CONFIG = { port: 47413, publicOrigin: 'https://mac.example.ts.net', language: 'ja' as const };
const clock = { now: 1_000_000_000 };
const session = (over: Partial<RemoteSession> = {}): RemoteSession => ({ sessionId: 's1', tokenHash: 'ab', registrationId: 'r1', profileIds: ['default'], expiresAt: clock.now + 60 * 60 * 1000, lastActive: clock.now, ...over });

function setup(call: (...args: unknown[]) => Promise<unknown> = async () => 'ok') {
  const posted: HostMessage[] = [];
  let toHost: (message: unknown) => void = () => {};
  let exit: (code: number) => void = () => {};
  const child: ServerProcess = {
    post: (message) => posted.push(message),
    onMessage: (listener) => (toHost = listener),
    onExit: (listener) => (exit = listener),
    kill: vi.fn(),
  };
  const statuses: unknown[] = [];
  const log = vi.fn();
  const callSpy = vi.fn(call);
  const connections: number[] = [];
  const auth = vi.fn((request: { op: string }) => {
    if (request.op === 'pair-begin') throw new Error('wrong code');
    return { challengeId: 'c', challenge: 'x' };
  });
  const host = new RemoteHost({ spawn: () => child, call: callSpy, onStatus: (status) => statuses.push(status), onConnections: (count) => connections.push(count), log, auth: auth as never }, () => clock.now);
  return { host, child, posted, statuses, connections, log, auth, call: callSpy, toHost: (m: unknown) => toHost(m), exit: (code: number) => exit(code) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RemoteHost', () => {
  it('start で、持っているセッションを渡してから待ち受けを頼み、listening で様子を listening にする', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    expect(t.posted).toEqual([{ type: 'session-add', session: session() }, { type: 'credentials', credentials: [] }, { type: 'listen', config: CONFIG }]);
    t.toHost({ type: 'listening', port: 47413 });
    expect(t.host.current()).toEqual({ state: 'listening', port: 47413 });
  });

  it('ポートが使われていたら in-use、ほかの理由なら failed', () => {
    const t = setup();
    t.host.start(CONFIG);
    t.toHost({ type: 'listen-failed', reason: 'in-use', message: 'EADDRINUSE' });
    expect(t.host.current()).toEqual({ state: 'in-use', port: 47413 });
    t.toHost({ type: 'listen-failed', reason: 'other', message: 'boom' });
    expect(t.host.current()).toEqual({ state: 'failed', message: 'boom' });
  });

  it('形の違う伝文は使わずに記録する', () => {
    const t = setup();
    t.host.start(CONFIG);
    t.toHost({ type: 'listening', port: 'x' });
    t.toHost({ type: 'call', id: 1 });
    expect(t.log).toHaveBeenCalledTimes(2);
    expect(t.host.current()).toEqual({ state: 'starting' });
    // 本人確認の頼みの中身が違えば、待たせずに断る。番号の読めないもの・形の違う伝文には返さない
    const before = t.posted.length;
    t.toHost({ type: 'auth', id: 7, request: { op: 'pair-status', requestId: '' } });
    expect(t.posted.at(-1)).toEqual({ type: 'auth-result', id: 7, ok: false, error: 'malformed request' });
    for (const raw of [{ type: 'auth', id: 0 }, { type: 'auth', id: 1.5 }, { type: 'auth', id: '1' }, null, 'x']) t.toHost(raw);
    expect(t.posted.length).toBe(before + 1);
  });

  it('知らないセッションの接続は、切らせる', () => {
    const t = setup();
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 'unknown' });
    expect(t.posted.at(-1)).toEqual({ type: 'disconnect', clientId: 'c1' });
    expect(t.host.connectionCount()).toBe(0);
  });

  it('頼みは、伝文の値ではなく接続の控えから呼び出し元を組み立てて渡し、返事を返す', async () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'call', id: 3, clientId: 'c1', profileId: 'default', kind: 'invoke', channel: IpcChannel.SessionsList, args: [] });
    await flush();
    expect(t.call).toHaveBeenCalledWith({ kind: 'remote', profileId: 'default', clientId: 'c1', registrationId: 'r1' }, IpcChannel.SessionsList, []);
    expect(t.posted.at(-1)).toEqual({ type: 'result', id: 3, clientId: 'c1', ok: true, value: 'ok' });
  });

  it('許していないプロファイルへの頼みは、受け口を呼ばずに断る', async () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'call', id: 4, clientId: 'c1', profileId: 'other', kind: 'invoke', channel: IpcChannel.SessionsList, args: [] });
    await flush();
    expect(t.call).not.toHaveBeenCalled();
    expect(t.posted.at(-1)).toMatchObject({ type: 'result', id: 4, ok: false });
  });

  it('受け口が投げたら、理由を返す。知らせ（send）には返事を返さない', async () => {
    const t = setup(async () => {
      throw new Error('だめ');
    });
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'call', id: 5, clientId: 'c1', profileId: 'default', kind: 'invoke', channel: 'x', args: [] });
    t.toHost({ type: 'call', id: 6, clientId: 'c1', profileId: 'default', kind: 'send', channel: 'x', args: [] });
    await flush();
    expect(t.posted.filter((m) => m.type === 'result')).toEqual([{ type: 'result', id: 5, clientId: 'c1', ok: false, error: 'だめ' }]);
  });

  it('知らない接続からの頼みは、切らせる', async () => {
    const t = setup();
    t.host.start(CONFIG);
    t.toHost({ type: 'call', id: 1, clientId: 'ghost', profileId: 'default', kind: 'invoke', channel: 'x', args: [] });
    await flush();
    expect(t.call).not.toHaveBeenCalled();
    expect(t.posted.at(-1)).toEqual({ type: 'disconnect', clientId: 'ghost' });
  });

  it('知らせは、そのプロファイルを許した接続にだけ送る。Mac だけのものは送らない', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.addSession(session({ sessionId: 's2', profileIds: ['work'] }));
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'connected', clientId: 'c2', sessionId: 's2' });
    t.posted.length = 0;
    t.host.emit('default', IpcChannel.SessionsChanged, []);
    t.host.emit('default', IpcChannel.McpSettingsOpen, undefined);
    expect(t.posted).toEqual([{ type: 'event', clientIds: ['c1'], channel: IpcChannel.SessionsChanged, payload: [], profileId: 'default' }]);
  });

  it('多い知らせ（subscribe）は、頼んだ接続にだけ送る。subscribe でないチャンネルは頼めない', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.posted.length = 0;
    t.host.emit('default', IpcChannel.PtyData, { sessionId: 'a', data: 'x' });
    expect(t.posted).toEqual([]);
    t.toHost({ type: 'subscribe', clientId: 'c1', channels: [IpcChannel.PtyData, IpcChannel.McpSettingsOpen] });
    t.host.emit('default', IpcChannel.PtyData, { sessionId: 'a', data: 'x' });
    t.host.emit('default', IpcChannel.McpSettingsOpen, undefined);
    expect(t.posted).toEqual([{ type: 'event', clientIds: ['c1'], channel: IpcChannel.PtyData, payload: { sessionId: 'a', data: 'x' }, profileId: 'default' }]);
  });

  it('アプリ全体の知らせ（emitAll）は、どの接続にも 1 回ずつ送る', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.addSession(session({ sessionId: 's2', profileIds: ['work', 'default'] }));
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'connected', clientId: 'c2', sessionId: 's2' });
    t.posted.length = 0;
    t.host.emitAll(IpcChannel.ClaudeVersionChanged, null as never);
    expect(t.posted).toEqual([{ type: 'event', clientIds: ['c1', 'c2'], channel: IpcChannel.ClaudeVersionChanged, payload: null }]);
  });

  it('アプリ全体の知らせも、Mac だけのものは送らない。接続が無ければ何も送らない', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.posted.length = 0;
    t.host.emitAll(IpcChannel.ClaudeVersionChanged, null as never);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.host.emitAll(IpcChannel.AppUpdateChecked, undefined);
    expect(t.posted).toEqual([]);
  });

  it('遠隔サーバーが待ち受けをやめたら（closed）、接続の控えを消す', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'closed' });
    expect(t.host.connectionCount()).toBe(0);
  });

  it('アプリ全体の多い知らせ（subscribe）は、頼んだ接続にだけ送る', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'connected', clientId: 'c2', sessionId: 's1' });
    t.toHost({ type: 'subscribe', clientId: 'c2', channels: [IpcChannel.SystemStats] });
    t.toHost({ type: 'subscribe', clientId: 'ghost', channels: [IpcChannel.SystemStats] });
    t.posted.length = 0;
    t.host.emitAll(IpcChannel.SystemStats, null as never);
    t.toHost({ type: 'subscribe', clientId: 'c2', channels: [] });
    t.host.emitAll(IpcChannel.SystemStats, null as never);
    expect(t.posted).toEqual([{ type: 'event', clientIds: ['c2'], channel: IpcChannel.SystemStats, payload: null }]);
  });

  it('セッションを消しても、ほかのセッションの接続は残す', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.addSession(session({ sessionId: 's2' }));
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'connected', clientId: 'c2', sessionId: 's2' });
    t.host.removeSession('s1');
    expect(t.host.connectionCount()).toBe(1);
  });

  it('止めたあとの古い遠隔サーバーからの伝文と終わりは、受けない', () => {
    const t = setup();
    t.host.start(CONFIG);
    t.host.stop();
    t.toHost({ type: 'listening', port: 1 });
    t.exit(1);
    expect(t.host.current()).toEqual({ state: 'off' });
  });

  it('始める前にポートが使われていると知らされたら、ポートは 0 にする', () => {
    const t = setup();
    t.host.start(CONFIG);
    (t.host as unknown as { config: null }).config = null;
    t.toHost({ type: 'listen-failed', reason: 'in-use', message: 'x' });
    expect(t.host.current()).toEqual({ state: 'in-use', port: 0 });
  });

  it('受け口が Error でないものを投げても、文字にして返す', async () => {
    const t = setup(async () => {
      throw 'だめ';
    });
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'call', id: 9, clientId: 'c1', profileId: 'default', kind: 'invoke', channel: 'x', args: [] });
    await flush();
    expect(t.posted.at(-1)).toEqual({ type: 'result', id: 9, clientId: 'c1', ok: false, error: 'だめ' });
  });

  it('本人確認の頼みは auth に渡し、返事を返す。投げたら理由を返す', () => {
    const t = setup();
    t.host.start(CONFIG);
    t.posted.length = 0;
    t.toHost({ type: 'auth', id: 1, request: { op: 'challenge' } });
    t.toHost({ type: 'auth', id: 2, request: { op: 'pair-begin', code: '12345678' } });
    t.toHost({ type: 'auth', id: 3, request: { op: 'nope' } });
    expect(t.posted).toEqual([
      { type: 'auth-result', id: 1, ok: true, value: { challengeId: 'c', challenge: 'x' } },
      { type: 'auth-result', id: 2, ok: false, error: 'wrong code' },
      // 知らない頼みは、auth に渡さずに断る
      { type: 'auth-result', id: 3, ok: false, error: 'malformed request' },
    ]);
  });

  it('パスキーの一覧を、遠隔サーバーに送り直す。取り消した登録のセッションは消す', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.addSession(session({ sessionId: 's2', registrationId: 'r2' }));
    t.host.start(CONFIG);
    t.posted.length = 0;
    t.host.setCredentials([{ registrationId: 'r1', credentialId: 'c', publicKey: 'p', counter: 0 }]);
    t.host.removeRegistration('r1');
    expect(t.posted).toEqual([
      { type: 'credentials', credentials: [{ registrationId: 'r1', credentialId: 'c', publicKey: 'p', counter: 0 }] },
      { type: 'session-remove', sessionId: 's1' },
    ]);
  });

  it('セッションを消すと、その接続の控えを消し、遠隔サーバーにも知らせる', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.host.removeSession('s1');
    expect(t.host.connectionCount()).toBe(0);
    expect(t.posted.at(-1)).toEqual({ type: 'session-remove', sessionId: 's1' });
  });

  it('遠隔サーバーが落ちたら、起動し直さずに failed にし、接続の控えを消す', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.exit(1);
    expect(t.host.current()).toMatchObject({ state: 'failed' });
    expect(t.host.connectionCount()).toBe(0);
    t.host.emit('default', IpcChannel.SessionsChanged, []);
    expect(t.posted.filter((m) => m.type === 'event')).toEqual([]);
  });

  it('stop で、待ち受けをやめて遠隔サーバーを止め、セッションも捨てる（入れ直したら、ログインし直す）', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.host.stop();
    expect(t.posted.at(-1)).toEqual({ type: 'close' });
    expect(t.child.kill).toHaveBeenCalled();
    expect(t.host.current()).toEqual({ state: 'off' });
    t.posted.length = 0;
    t.host.start(CONFIG);
    expect(t.posted).toEqual([{ type: 'credentials', credentials: [] }, { type: 'listen', config: CONFIG }]);
  });

  it('始め直すと、接続の控えを消し、期限の切れたセッションは送らない。送るセッションは、最後の操作の時刻のまま', async () => {
    const t = setup();
    t.host.addSession(session());
    t.host.addSession(session({ sessionId: 's2', lastActive: clock.now - 31 * 60 * 1000 }));
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'call', id: 1, clientId: 'c1', profileId: 'default', kind: 'send', channel: 'x', args: [] });
    await flush();
    clock.now += 5 * 60 * 1000;
    t.posted.length = 0;
    t.host.start(CONFIG);
    expect(t.host.connectionCount()).toBe(0);
    expect(t.posted).toHaveLength(3);
    expect(t.posted[0]).toMatchObject({ type: 'session-add', session: { sessionId: 's1', lastActive: clock.now - 5 * 60 * 1000 } });
    expect(t.posted[2]).toEqual({ type: 'listen', config: CONFIG });
  });

  it('遠隔サーバーが期限でセッションを捨てたら、main も控えから消す', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'session-expired', sessionId: 's1' });
    expect(t.host.connectionCount()).toBe(0);
    t.posted.length = 0;
    t.host.start(CONFIG);
    expect(t.posted).toEqual([{ type: 'credentials', credentials: [] }, { type: 'listen', config: CONFIG }]);
  });

  it('main でも、使わない時間と期限を確かめる（遠隔サーバーを信じきらない）', async () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    clock.now += 31 * 60 * 1000;
    t.toHost({ type: 'call', id: 1, clientId: 'c1', profileId: 'default', kind: 'invoke', channel: 'x', args: [] });
    await flush();
    expect(t.call).not.toHaveBeenCalled();
    expect(t.posted).toContainEqual({ type: 'session-remove', sessionId: 's1' });
    expect(t.posted.at(-1)).toEqual({ type: 'disconnect', clientId: 'c1' });
  });

  it('もうある接続の id で connected が届いたら、付け替えずに切らせる', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.addSession(session({ sessionId: 's2', profileIds: ['work'] }));
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's2' });
    expect(t.posted.at(-1)).toEqual({ type: 'disconnect', clientId: 'c1' });
    t.host.emit('work', IpcChannel.SessionsChanged, []);
    expect(t.posted.filter((m) => m.type === 'event')).toEqual([]);
  });

  it('つながっている数が変わったら知らせる', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.toHost({ type: 'disconnected', clientId: 'c1' });
    expect(t.connections).toEqual([1, 0]);
  });

  it('遠隔への送りが失敗しても、投げずに記録する（Mac の画面への知らせを止めない）', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    t.toHost({ type: 'connected', clientId: 'c1', sessionId: 's1' });
    t.child.post = () => {
      throw new Error('closed');
    };
    expect(() => t.host.emit('default', IpcChannel.SessionsChanged, [])).not.toThrow();
    expect(() => t.host.emitAll(IpcChannel.ClaudeVersionChanged, null as never)).not.toThrow();
    expect(t.log).toHaveBeenCalledTimes(2);
  });
});
