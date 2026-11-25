// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import { ACTIVE_MS, RemoteTransport } from '../../src/renderer/src/remote/transport';

// スマホの画面の WebSocket の運び役（src/renderer/src/remote/transport.ts）。WebSocket と fetch は作り物、束縛の鍵の署名は差し替える

const sign = vi.hoisted(() => ({ result: 'signed' as string | null }));
vi.mock('../../src/renderer/src/remote/binding', async (original) => ({
  ...(await original<typeof import('../../src/renderer/src/remote/binding')>()),
  signWithBinding: async () => sign.result,
}));

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.onclose?.();
  }
  reply(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

function setup(status: { begin?: number; ticket?: number } = {}) {
  FakeSocket.all = [];
  const clock = { now: 1000 };
  const calls: { path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (path: string, init: { body: string }) => {
    calls.push({ path, body: JSON.parse(init.body) });
    const code = path === '/api/ticket/begin' ? (status.begin ?? 200) : (status.ticket ?? 200);
    const body = path === '/api/ticket/begin' ? { challengeId: 'cid', bindingChallenge: 'bc' } : { ticket: `t${calls.length}` };
    return { ok: code === 200, status: code, json: async () => body } as Response;
  });
  const signedOut = vi.fn();
  const connection = vi.fn();
  const transport = new RemoteTransport({ onSignedOut: signedOut, onConnection: connection, fetch: fetch as never, WebSocket: FakeSocket as never, now: () => clock.now });
  return { transport, calls, signedOut, connection, clock, socket: () => FakeSocket.all.at(-1)! };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  sign.result = 'signed';
});

describe('RemoteTransport', () => {
  it('券を取り（乱数に署名）、hello でつなぐ。握手の返事でプロファイルと言語を返し、ためていた頼みを送る', async () => {
    const t = setup();
    const ready = t.transport.start();
    const api = t.transport.api(() => '', () => 'ja');
    t.transport.useProfile('p1');
    const listed = api.invoke(IpcChannel.SessionsList);
    await vi.waitFor(() => expect(t.socket().sent).toEqual([{ type: 'hello', ticket: 't2' }]));
    expect(t.calls).toEqual([{ path: '/api/ticket/begin', body: {} }, { path: '/api/ticket', body: { challengeId: 'cid', bindingSignature: 'signed' } }]);
    expect(t.socket().url).toBe('ws://localhost:3000/ws');
    t.socket().reply({ type: 'ready', profileIds: ['p1', 'p2'], language: 'en' });
    await expect(ready).resolves.toEqual({ profileIds: ['p1', 'p2'], language: 'en' });
    expect(t.connection).toHaveBeenCalledWith(true);
    expect(t.socket().sent[1]).toEqual({ id: 1, kind: 'invoke', profileId: 'p1', channel: IpcChannel.SessionsList, args: [], active: false });
    t.socket().reply({ id: 1, ok: true, value: [{ id: 's1', image: { $bytes: btoa('ab') } }] });
    await expect(listed).resolves.toEqual([{ id: 's1', image: new Uint8Array([97, 98]) }]);
  });

  it('押した・打ったすぐあとの頼みにだけ、人の操作の印を付ける。Uint8Array は $bytes で送る。断られたら理由で失敗する', async () => {
    const t = setup();
    void t.transport.start();
    const api = t.transport.api(() => '', () => 'ja');
    await vi.waitFor(() => expect(t.socket().sent).toHaveLength(1));
    t.socket().reply({ type: 'ready', profileIds: ['p1'], language: 'ja' });
    t.transport.markInput();
    api.send(IpcChannel.PtyWrite, 's1', 'ls');
    t.clock.now += ACTIVE_MS;
    const saved = api.invoke(IpcChannel.AttachmentSave, 'image/png', new Uint8Array([1, 2, 3]));
    expect(t.socket().sent.slice(1)).toEqual([
      expect.objectContaining({ kind: 'send', channel: IpcChannel.PtyWrite, args: ['s1', 'ls'], active: true }),
      expect.objectContaining({ kind: 'invoke', channel: IpcChannel.AttachmentSave, args: ['image/png', { $bytes: 'AQID' }], active: false }),
    ]);
    t.socket().reply({ id: 2, ok: false, error: 'too big' });
    await expect(saved).rejects.toThrow('too big');
    // 知らない id・形の違う伝文は捨てる
    t.socket().reply({ id: 99, ok: true });
    t.socket().onmessage?.({ data: 'not json' });
  });

  it('遠隔では呼べないもの（same でないもの）は、送らずに手元で断る', async () => {
    const t = setup();
    void t.transport.start();
    const api = t.transport.api(() => '', () => 'ja');
    await expect(api.invoke(IpcChannel.FolderPick)).rejects.toThrow('is not available on remote');
    api.send(IpcChannel.SessionsFocus, 's1');
    await vi.waitFor(() => expect(t.socket().sent).toHaveLength(1));
    expect(t.socket().sent).toEqual([{ type: 'hello', ticket: 't2' }]);
  });

  it('知らせは、選んだプロファイルのものとアプリ全体のものだけを受ける。多い知らせ（subscribe）は、受けたいものの全部を頼む', async () => {
    const t = setup();
    void t.transport.start();
    const api = t.transport.api(() => '', () => 'ja');
    t.transport.useProfile('p1');
    const chat = vi.fn();
    const off = api.subscribe(IpcChannel.ChatEvents, chat);
    const pty = vi.fn();
    const offPty = api.subscribe(IpcChannel.PtyData, pty);
    api.subscribe(IpcChannel.PtyData, vi.fn());
    await vi.waitFor(() => expect(t.socket().sent).toHaveLength(1));
    t.socket().reply({ type: 'ready', profileIds: ['p1'], language: 'ja' });
    expect(t.socket().sent.slice(1)).toEqual([{ type: 'subscribe', channels: [IpcChannel.PtyData] }, { type: 'subscribe', channels: [IpcChannel.PtyData] }]);
    t.socket().reply({ event: IpcChannel.ChatEvents, profileId: 'p1', payload: { a: 1 } });
    t.socket().reply({ event: IpcChannel.ChatEvents, profileId: 'p2', payload: { a: 2 } });
    t.socket().reply({ event: IpcChannel.ChatEvents, payload: { a: 3 } });
    expect(chat.mock.calls).toEqual([[{ a: 1 }], [{ a: 3 }]]);
    off();
    t.socket().reply({ event: IpcChannel.ChatEvents, profileId: 'p1', payload: { a: 4 } });
    expect(chat).toHaveBeenCalledTimes(2);
    offPty();
    expect(t.socket().sent).toHaveLength(3);
  });

  it('切れたら、待っていた頼みを断り、券を取り直してつなぎ直す（多い知らせも頼み直す）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = setup();
    void t.transport.start();
    const api = t.transport.api(() => '', () => 'ja');
    api.subscribe(IpcChannel.ShellData, vi.fn());
    await vi.waitFor(() => expect(t.socket().sent).toHaveLength(1));
    t.socket().reply({ type: 'ready', profileIds: ['p1'], language: 'ja' });
    const waiting = api.invoke(IpcChannel.SessionsList);
    const first = t.socket();
    first.close();
    await expect(waiting).rejects.toThrow('disconnected');
    expect(t.connection).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    await vi.waitFor(() => expect(t.socket().sent).toHaveLength(1));
    t.socket().reply({ type: 'ready', profileIds: ['p1'], language: 'ja' });
    expect(t.socket().sent[1]).toEqual({ type: 'subscribe', channels: [IpcChannel.ShellData] });
    // 前の接続の閉じる知らせが遅れて来ても、今の接続は切らない
    first.onclose?.();
    t.transport.stop();
  });

  it('券を取れなければ、間をあけてやり直す。セッションが切れた（401）・束縛の鍵が無いときは、ログインの画面へ戻す', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const failing = setup({ ticket: 500 });
    void failing.transport.start();
    await vi.waitFor(() => expect(failing.calls).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(failing.calls).toHaveLength(4));
    failing.transport.stop();
    expect(FakeSocket.all).toHaveLength(0);

    for (const status of [{ begin: 401 }, { ticket: 401 }]) {
      const out = setup(status);
      void out.transport.start();
      await vi.waitFor(() => expect(out.signedOut).toHaveBeenCalledTimes(1));
    }
    sign.result = null;
    const noKey = setup();
    void noKey.transport.start();
    await vi.waitFor(() => expect(noKey.signedOut).toHaveBeenCalledTimes(1));
    const broken = setup({ begin: 500 });
    void broken.transport.start();
    await vi.waitFor(() => expect(broken.calls).toHaveLength(1));
    broken.transport.stop();
    await flush();
  });
});
