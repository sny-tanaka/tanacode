import { describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import type { HostMessage, RemoteSession } from '@shared/remote-protocol';
import { RemoteHost, type ServerProcess } from '../src/main/remote-host';

// main の側の、遠隔サーバーの持ち手（src/main/remote-host.ts）。遠隔サーバーを作り物にして、伝文を送り合う

const CONFIG = { port: 47413, publicOrigin: 'https://mac.example.ts.net' };
const session = (over: Partial<RemoteSession> = {}): RemoteSession => ({ sessionId: 's1', tokenHash: 'ab', registrationId: 'r1', profileIds: ['default'], expiresAt: Date.now() + 60000, ...over });

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
  const host = new RemoteHost({ spawn: () => child, call: callSpy, onStatus: (status) => statuses.push(status), log });
  return { host, child, posted, statuses, log, call: callSpy, toHost: (m: unknown) => toHost(m), exit: (code: number) => exit(code) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RemoteHost', () => {
  it('start で、持っているセッションを渡してから待ち受けを頼み、listening で様子を listening にする', () => {
    const t = setup();
    t.host.addSession(session());
    t.host.start(CONFIG);
    expect(t.posted).toEqual([{ type: 'session-add', session: session() }, { type: 'listen', config: CONFIG }]);
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
    expect(t.posted).toEqual([{ type: 'event', clientIds: ['c1'], channel: IpcChannel.SessionsChanged, payload: [] }]);
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
    expect(t.posted).toEqual([{ type: 'event', clientIds: ['c1'], channel: IpcChannel.PtyData, payload: { sessionId: 'a', data: 'x' } }]);
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

  it('stop で、待ち受けをやめて遠隔サーバーを止める', () => {
    const t = setup();
    t.host.start(CONFIG);
    t.host.stop();
    expect(t.posted.at(-1)).toEqual({ type: 'close' });
    expect(t.child.kill).toHaveBeenCalled();
    expect(t.host.current()).toEqual({ state: 'off' });
  });
});
