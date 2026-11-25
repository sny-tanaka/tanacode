import { createHash } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { RemoteSession, ServerMessage } from '@shared/remote-protocol';
import { IDLE_MS, MAX_CALLS_PER_10S, MAX_TICKETS_PER_SESSION, RemoteServerCore, SESSION_COOKIE, TICKET_MS } from '../src/main/remote-server-core';

// 遠隔サーバーの中身（src/main/remote-server-core.ts）を、本物の HTTP・WebSocket で動かす（127.0.0.1 の空いたポート）

const ORIGIN = 'https://mac.example.ts.net';
const HOST = 'mac.example.ts.net';
const TOKEN = 'secret-token';
const session = (over: Partial<RemoteSession> = {}): RemoteSession => ({
  sessionId: 's1',
  tokenHash: createHash('sha256').update(TOKEN).digest('hex'),
  registrationId: 'r1',
  profileIds: ['default'],
  expiresAt: Date.now() + 60 * 60 * 1000,
  lastActive: Date.now(),
  ...over,
});

type Started = { core: RemoteServerCore; port: number; posted: ServerMessage[]; clock: { now: number } };
let current: Started | null = null;

afterEach(() => {
  current?.core.handle({ type: 'close' });
  current = null;
});

async function start(): Promise<Started> {
  const posted: ServerMessage[] = [];
  const clock = { now: Date.now() };
  const core = new RemoteServerCore((message) => posted.push(message), () => clock.now);
  core.handle({ type: 'session-add', session: session() });
  core.handle({ type: 'listen', config: { port: 0, publicOrigin: ORIGIN } });
  const port = await waitFor(() => {
    const listening = posted.find((m) => m.type === 'listening');
    return listening?.type === 'listening' ? listening.port : undefined;
  });
  current = { core, port, posted, clock };
  return current;
}

async function waitFor<T>(get: () => T | undefined, timeout = 2000): Promise<T> {
  const until = Date.now() + timeout;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error('待ちきれませんでした');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// 頼みを送る。何も返さずに切られたら status: null
function send(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number | null; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? null, headers: res.headers, body }));
    });
    req.on('error', () => resolve({ status: null, headers: {}, body: '' }));
    req.end();
  });
}

const cookie = `${SESSION_COOKIE}=${TOKEN}`;

async function ticket(port: number): Promise<string> {
  const res = await send(port, 'POST', '/api/ticket', { host: HOST, origin: ORIGIN, cookie });
  return (JSON.parse(res.body) as { ticket: string }).ticket;
}

// WebSocket でつなぐ。開けなければ opened: false
function open(port: number, headers: Record<string, string>): Promise<{ ws: WebSocket; opened: boolean; messages: unknown[]; closed: Promise<number> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const messages: unknown[] = [];
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)));
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('open', () => resolve({ ws, opened: true, messages, closed }));
    ws.on('error', () => resolve({ ws, opened: false, messages, closed }));
  });
}

async function connect(port: number) {
  const value = await ticket(port);
  const client = await open(port, { host: HOST, origin: ORIGIN, cookie });
  client.ws.send(JSON.stringify({ type: 'hello', ticket: value }));
  await waitFor(() => (client.messages.length > 0 ? true : undefined));
  return client;
}

describe('HTTP の口', () => {
  it('Host が公開する URL と同じなら、認証の前の画面を、バージョンを出さず、守りのヘッダー付きで返す', async () => {
    const { port } = await start();
    const res = await send(port, 'GET', '/', { host: HOST });
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it.each([
    ['Host が違う（DNS rebinding）', { host: 'evil.example.com' }],
    ['Host にポートが付いている', { host: `${HOST}:443` }],
    ['Funnel（公開のインターネット）から届いた', { host: HOST, 'tailscale-funnel-request': '?1' }],
  ])('%s なら、何も返さずに切る', async (_name, headers) => {
    const { port } = await start();
    expect((await send(port, 'GET', '/', headers)).status).toBeNull();
  });

  it('状態を変える頼み（POST）は、Origin も公開する URL と同じでなければ切る', async () => {
    const { port } = await start();
    expect((await send(port, 'POST', '/api/ticket', { host: HOST, cookie })).status).toBeNull();
    expect((await send(port, 'POST', '/api/ticket', { host: HOST, origin: 'https://other.example.ts.net', cookie })).status).toBeNull();
  });

  it('券は、セッションの Cookie が無ければ出さない（401）', async () => {
    const { port } = await start();
    expect((await send(port, 'POST', '/api/ticket', { host: HOST, origin: ORIGIN })).status).toBe(401);
    expect((await send(port, 'POST', '/api/ticket', { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=wrong` })).status).toBe(401);
  });

  it('知らない口は 404', async () => {
    const { port } = await start();
    expect((await send(port, 'GET', '/version', { host: HOST })).status).toBe(404);
  });

  it('ポートが使われていたら、別のポートへ逃げずに in-use を知らせる', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const posted: ServerMessage[] = [];
    const core = new RemoteServerCore((message) => posted.push(message));
    core.handle({ type: 'listen', config: { port, publicOrigin: ORIGIN } });
    const failed = await waitFor(() => posted.find((m) => m.type === 'listen-failed'));
    expect(failed).toMatchObject({ type: 'listen-failed', reason: 'in-use' });
    expect(posted.some((m) => m.type === 'listening')).toBe(false);
    blocker.close();
  });
});

describe('WebSocket の口', () => {
  it('券の伝文でつながると、main に connected を知らせ、頼みを渡し、返事と知らせを送る', async () => {
    const { port, posted, core } = await start();
    const client = await connect(port);
    expect(client.messages[0]).toEqual({ type: 'ready' });
    const connected = posted.find((m) => m.type === 'connected');
    expect(connected).toMatchObject({ type: 'connected', sessionId: 's1' });
    const clientId = connected?.type === 'connected' ? connected.clientId : '';

    client.ws.send(JSON.stringify({ id: 7, kind: 'invoke', profileId: 'default', channel: 'attachments:save', args: ['a.png', { $bytes: Buffer.from('abc').toString('base64') }] }));
    const call = await waitFor(() => posted.find((m) => m.type === 'call'));
    expect(call).toMatchObject({ type: 'call', id: 7, clientId, profileId: 'default', kind: 'invoke', channel: 'attachments:save' });
    // Uint8Array は、main が引数の形（bytes）の位置でだけ戻す。遠隔サーバーは、そのまま渡す
    expect(call?.type === 'call' && call.args[1]).toEqual({ $bytes: Buffer.from('abc').toString('base64') });

    core.handle({ type: 'result', id: 7, clientId, ok: true, value: { saved: new Uint8Array([1, 2]) } });
    core.handle({ type: 'event', clientIds: [clientId], channel: 'sessions:changed', payload: [], profileId: 'default' });
    core.handle({ type: 'event', clientIds: [clientId], channel: 'claude-version:changed', payload: null });
    await waitFor(() => (client.messages.length >= 4 ? true : undefined));
    expect(client.messages[1]).toEqual({ id: 7, ok: true, value: { saved: { $bytes: Buffer.from([1, 2]).toString('base64') } } });
    // プロファイルの知らせには、どのプロファイルのものかを付ける（アプリ全体の知らせには付けない）
    expect(client.messages[2]).toEqual({ event: 'sessions:changed', profileId: 'default', payload: [] });
    expect(client.messages[3]).toEqual({ event: 'claude-version:changed', payload: null });
    client.ws.close();
  });

  it('__proto__ のキーは、プロトタイプにせず、ふつうのキーとして main に渡す（main の確かめが断る）', async () => {
    const { port, posted } = await start();
    const client = await connect(port);
    client.ws.send('{"id":1,"kind":"invoke","profileId":"default","channel":"x","args":[{"__proto__":{"polluted":true}}]}');
    const call = await waitFor(() => posted.find((m) => m.type === 'call'));
    const arg = call?.type === 'call' ? (call.args[0] as Record<string, unknown>) : {};
    expect(Object.getPrototypeOf(arg)).toBe(Object.prototype);
    expect(Object.keys(arg)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    client.ws.close();
  });

  it.each([
    ['Origin が違う', { host: HOST, origin: 'https://other.example.ts.net', cookie }],
    ['Origin が無い', { host: HOST, cookie }],
    ['Cookie が無い', { host: HOST, origin: ORIGIN }],
    ['Host が違う', { host: 'evil.example.com', origin: ORIGIN, cookie }],
  ])('%s なら、つながらない', async (_name, headers) => {
    const { port } = await start();
    expect((await open(port, headers)).opened).toBe(false);
  });

  it('券が違う・使い回した・期限が切れたら、つながったあとに切る（4002）', async () => {
    const { port, clock } = await start();
    const bad = await open(port, { host: HOST, origin: ORIGIN, cookie });
    bad.ws.send(JSON.stringify({ type: 'hello', ticket: 'nope' }));
    expect(await bad.closed).toBe(4002);

    const value = await ticket(port);
    const first = await open(port, { host: HOST, origin: ORIGIN, cookie });
    first.ws.send(JSON.stringify({ type: 'hello', ticket: value }));
    await waitFor(() => (first.messages.length > 0 ? true : undefined));
    const again = await open(port, { host: HOST, origin: ORIGIN, cookie });
    again.ws.send(JSON.stringify({ type: 'hello', ticket: value }));
    expect(await again.closed).toBe(4002);
    first.ws.close();

    const late = await ticket(port);
    clock.now += TICKET_MS + 1;
    const expired = await open(port, { host: HOST, origin: ORIGIN, cookie });
    expired.ws.send(JSON.stringify({ type: 'hello', ticket: late }));
    expect(await expired.closed).toBe(4002);
  });

  it('形の違う伝文・バイナリは、切る（4003）', async () => {
    const { port } = await start();
    const client = await connect(port);
    client.ws.send(JSON.stringify({ id: 'x', kind: 'invoke', channel: 'a', args: [] }));
    expect(await client.closed).toBe(4003);
  });

  it('頼みが多すぎたら、切る（4008）', async () => {
    const { port } = await start();
    const client = await connect(port);
    for (let i = 0; i <= MAX_CALLS_PER_10S; i++) client.ws.send(JSON.stringify({ id: i, kind: 'send', profileId: 'default', channel: 'a', args: [] }));
    expect(await client.closed).toBe(4008);
  });

  it('セッションを消したら、その接続を切り（4001）、main に disconnected を知らせる', async () => {
    const { port, posted, core } = await start();
    const client = await connect(port);
    core.handle({ type: 'session-remove', sessionId: 's1' });
    expect(await client.closed).toBe(4001);
    await waitFor(() => posted.find((m) => m.type === 'disconnected'));
  });

  it('使わない時間が 30 分を超えたら、次の頼みで切る（4001）', async () => {
    const { port, clock } = await start();
    const client = await connect(port);
    clock.now += IDLE_MS + 1;
    client.ws.send(JSON.stringify({ id: 1, kind: 'invoke', profileId: 'default', channel: 'a', args: [] }));
    expect(await client.closed).toBe(4001);
    // main にも知らせる（控えから消させ、待ち受けを始め直したときに送り直させない）
    expect(current!.posted).toContainEqual({ type: 'session-expired', sessionId: 's1' });
  });

  it('使わない時間は、main が渡した最後の操作の時刻から数える（待ち受けを始め直しても延ばさない）', async () => {
    const { port, core, clock } = await start();
    core.handle({ type: 'session-add', session: session({ lastActive: clock.now - IDLE_MS - 1 }) });
    expect((await send(port, 'POST', '/api/ticket', { host: HOST, origin: ORIGIN, cookie })).status).toBe(401);
  });

  it('券の伝文をしくじったら、やり直させない', async () => {
    const { port } = await start();
    const value = await ticket(port);
    const client = await open(port, { host: HOST, origin: ORIGIN, cookie });
    client.ws.send(JSON.stringify({ type: 'hello', ticket: 'nope' }));
    client.ws.send(JSON.stringify({ type: 'hello', ticket: value }));
    expect(await client.closed).toBe(4002);
    expect(client.messages).toEqual([]);
  });

  it('subscribe の伝文も、頻度の上限に数える', async () => {
    const { port } = await start();
    const client = await connect(port);
    for (let i = 0; i <= MAX_CALLS_PER_10S; i++) client.ws.send(JSON.stringify({ type: 'subscribe', channels: [] }));
    expect(await client.closed).toBe(4008);
  });

  it('券は、使わずに残ったものを期限で消し、セッションごとに数の上限を置く（古いものから捨てる）', async () => {
    const { port } = await start();
    const first = await ticket(port);
    for (let i = 0; i < MAX_TICKETS_PER_SESSION; i++) await ticket(port);
    const client = await open(port, { host: HOST, origin: ORIGIN, cookie });
    client.ws.send(JSON.stringify({ type: 'hello', ticket: first }));
    expect(await client.closed).toBe(4002);
  });

  it('main が disconnect を送ったら切る', async () => {
    const { port, posted, core } = await start();
    const client = await connect(port);
    const connected = posted.find((m) => m.type === 'connected');
    core.handle({ type: 'disconnect', clientId: connected?.type === 'connected' ? connected.clientId : '' });
    expect(await client.closed).toBe(1000);
  });
});
