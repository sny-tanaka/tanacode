import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { HostMessage, RemoteListenConfig, RemoteSession, ServerMessage } from '@shared/remote-protocol';

// 遠隔サーバーの中身（Issue #464）。utilityProcess（remote-server.ts）が、main との伝文の口につないで動かす。
// 127.0.0.1 だけで待ち受け、前に置いた転送（tailscale serve など）から届く頼みを受ける。決めたこと:
// - Host と Origin は、公開する URL と完全に一致しなければ、何も返さずに切る（DNS rebinding・同じ tailnet の別マシンのページからの CSRF）
// - 転送が Funnel（公開のインターネット）から届けた頼み（Tailscale-Funnel-Request）は、本人確認の前に切る
// - 転送のヘッダー（X-Forwarded-For・Tailscale-User-*）は、本人確認に使わない（Mac の中のプロセスが直接つなげば偽れる）
// - セッションは main が作って渡す（③ の本人確認）。Cookie の秘密はハッシュで持つ。WebSocket は Cookie だけに頼らず、
//   同じ Origin の fetch で取る 1 回限りの券（30 秒）を、最初の伝文で求める
// - 届いた頼みは、形の確かめ（main の IpcDispatcher）と、大きさ・頻度・接続の数の上限を通してから main に渡す。圧縮（permessage-deflate）は使わない

export const SESSION_COOKIE = '__Host-tanacode-remote';
// 使わない時間でセッションを切るまで（人の操作の頼みで延ばす）
export const IDLE_MS = 30 * 60 * 1000;
// 券の期限
export const TICKET_MS = 30 * 1000;
// 接続してから、券の伝文が届くまで待つ時間
export const HELLO_MS = 5 * 1000;
// 1 つの伝文の大きさの上限（画像の添付を送れる大きさ）
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
// 同時の接続の数の上限
export const MAX_CLIENTS = 8;
// 1 つの接続が 10 秒に送れる頼みの数の上限。超えたら切る
export const MAX_CALLS_PER_10S = 200;

type Client = { id: string; sessionId: string; socket: WebSocket; calls: number[] };
type Ticket = { sessionId: string; until: number };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function cookieOf(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

// 遠隔の接続が JSON で運ぶ Uint8Array（{ "$bytes": "<base64>" }）を戻す。ほかの値はそのまま
function decodeBytes(value: unknown, depth = 0): unknown {
  if (depth > 32 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => decodeBytes(item, depth + 1));
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === '$bytes' && typeof record.$bytes === 'string') return new Uint8Array(Buffer.from(record.$bytes, 'base64'));
  // __proto__ というキーも、プロトタイプにせず、ふつうのキーとして写す（main の確かめが、キーごと断る）
  const out: Record<string, unknown> = {};
  for (const key of keys) Object.defineProperty(out, key, { value: decodeBytes(record[key], depth + 1), enumerable: true, writable: true, configurable: true });
  return out;
}

// main の返事・知らせを、遠隔の接続に送れる JSON にする（Uint8Array は { "$bytes": "<base64>" }）
export function encodeForClient(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString('base64') } : v));
}

// 認証の前に見せる画面（③・④ で、ログインの画面に置き換える）。バージョンなどは出さない
const PLACEHOLDER_HTML = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>tanacode</title>';

// どの応答にも付けるヘッダー
const BASE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export class RemoteServerCore {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private config: RemoteListenConfig | null = null;
  private readonly sessions = new Map<string, RemoteSession & { lastActive: number }>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly clients = new Map<string, Client>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly post: (message: ServerMessage) => void,
    private readonly now: () => number = Date.now,
  ) {}

  // main から届いた伝文（形は main が作るので信じる）
  handle(message: HostMessage): void {
    switch (message.type) {
      case 'listen':
        this.listen(message.config);
        break;
      case 'close':
        this.close();
        break;
      case 'session-add':
        this.sessions.set(message.session.sessionId, { ...message.session, lastActive: this.now() });
        break;
      case 'session-remove':
        this.dropSession(message.sessionId);
        break;
      case 'result': {
        const client = this.clients.get(message.clientId);
        if (!client) return;
        client.socket.send(encodeForClient(message.ok ? { id: message.id, ok: true, value: message.value } : { id: message.id, ok: false, error: message.error }));
        break;
      }
      case 'event':
        for (const id of message.clientIds) this.clients.get(id)?.socket.send(encodeForClient({ event: message.channel, payload: message.payload }));
        break;
      case 'disconnect':
        this.clients.get(message.clientId)?.socket.close(1000);
        break;
    }
  }

  private listen(config: RemoteListenConfig): void {
    this.close(false);
    this.config = config;
    const server = createServer((req, res) => this.request(req, res));
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    server.on('error', (error: NodeJS.ErrnoException) => {
      this.post({ type: 'listen-failed', reason: error.code === 'EADDRINUSE' ? 'in-use' : 'other', message: error.message });
      this.close(false);
    });
    server.listen(config.port, '127.0.0.1', () => {
      const address = server.address();
      this.post({ type: 'listening', port: typeof address === 'object' && address ? address.port : config.port });
    });
    this.server = server;
    this.wss = wss;
    this.idleTimer = setInterval(() => this.expire(), 60 * 1000);
  }

  private close(report = true): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const client of this.clients.values()) client.socket.terminate();
    this.clients.clear();
    this.tickets.clear();
    this.wss?.close();
    this.server?.close();
    this.server?.closeAllConnections();
    const was = this.server !== null;
    this.server = null;
    this.wss = null;
    this.config = null;
    if (report && was) this.post({ type: 'closed' });
  }

  // Host と Origin が公開する URL と同じか、Funnel から来ていないか。違えば false（呼んだ側が何も返さずに切る）
  private trusted(req: IncomingMessage, needOrigin: boolean): boolean {
    if (!this.config) return false;
    const expected = new URL(this.config.publicOrigin);
    if (req.headers.host !== expected.host) return false;
    if (req.headers['tailscale-funnel-request'] !== undefined) return false;
    if (needOrigin && req.headers.origin !== this.config.publicOrigin) return false;
    return true;
  }

  // Cookie のセッション（期限の切れていないもの）
  private sessionOf(req: IncomingMessage): (RemoteSession & { lastActive: number }) | null {
    const token = cookieOf(req, SESSION_COOKIE);
    if (!token || token.length > 256) return null;
    const hash = sha256(token);
    for (const session of this.sessions.values()) {
      if (!sameHex(session.tokenHash, hash)) continue;
      return this.alive(session) ? session : null;
    }
    return null;
  }

  private alive(session: RemoteSession & { lastActive: number }): boolean {
    const now = this.now();
    if (now >= session.expiresAt || now - session.lastActive >= IDLE_MS) {
      this.dropSession(session.sessionId);
      return false;
    }
    return true;
  }

  private expire(): void {
    for (const session of [...this.sessions.values()]) this.alive(session);
  }

  private dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [ticket, entry] of this.tickets) if (entry.sessionId === sessionId) this.tickets.delete(ticket);
    for (const client of this.clients.values()) if (client.sessionId === sessionId) client.socket.close(4001);
  }

  private request(req: IncomingMessage, res: ServerResponse): void {
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    // 状態を変える頼み（GET・HEAD 以外）は、Origin も確かめる
    if (!this.trusted(req, !isGet)) {
      req.socket.destroy();
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (isGet && path === '/') {
      res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8' });
      res.end(PLACEHOLDER_HTML);
      return;
    }
    // WebSocket の券。セッションの Cookie が要る（③ で、束縛の鍵の署名も求める）
    if (req.method === 'POST' && path === '/api/ticket') {
      const session = this.sessionOf(req);
      if (!session) return this.reply(res, 401, { error: 'unauthorized' });
      const ticket = randomBytes(32).toString('base64url');
      this.tickets.set(ticket, { sessionId: session.sessionId, until: this.now() + TICKET_MS });
      return this.reply(res, 200, { ticket });
    }
    this.reply(res, 404, { error: 'not found' });
  }

  private reply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '/').split('?')[0];
    const session = path === '/ws' && this.trusted(req, true) ? this.sessionOf(req) : null;
    if (!session || !this.wss || this.clients.size >= MAX_CLIENTS) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, session.sessionId));
  }

  // 接続を受けた。最初の伝文で、同じセッションの券を求める
  private accept(ws: WebSocket, sessionId: string): void {
    let client: Client | null = null;
    const helloTimer = setTimeout(() => ws.close(4002), HELLO_MS);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return ws.close(4003);
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return ws.close(4003);
      }
      if (!client) {
        clearTimeout(helloTimer);
        client = this.hello(ws, sessionId, message);
        if (!client) ws.close(4002);
        return;
      }
      this.clientMessage(client, message);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (client && this.clients.get(client.id) === client) {
        this.clients.delete(client.id);
        this.post({ type: 'disconnected', clientId: client.id });
      }
    });
  }

  private hello(ws: WebSocket, sessionId: string, message: unknown): Client | null {
    const ticket = typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'hello' ? (message as { ticket?: unknown }).ticket : null;
    if (typeof ticket !== 'string') return null;
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.sessionId !== sessionId || entry.until <= this.now()) return null;
    const session = this.sessions.get(sessionId);
    if (!session || !this.alive(session)) return null;
    const client: Client = { id: randomBytes(16).toString('base64url'), sessionId, socket: ws, calls: [] };
    this.clients.set(client.id, client);
    this.post({ type: 'connected', clientId: client.id, sessionId });
    ws.send(encodeForClient({ type: 'ready' }));
    return client;
  }

  // 接続からの伝文。{ id, kind, profileId, channel, args } の頼みと、{ type: 'subscribe', channels } だけを受ける
  private clientMessage(client: Client, message: unknown): void {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return client.socket.close(4003);
    const m = message as Record<string, unknown>;
    if (m.type === 'subscribe') {
      if (!Array.isArray(m.channels)) return client.socket.close(4003);
      this.post({ type: 'subscribe', clientId: client.id, channels: m.channels.filter((c): c is string => typeof c === 'string') });
      return;
    }
    const now = this.now();
    client.calls = client.calls.filter((at) => now - at < 10 * 1000);
    client.calls.push(now);
    if (client.calls.length > MAX_CALLS_PER_10S) return client.socket.close(4008);
    const session = this.sessions.get(client.sessionId);
    if (!session || !this.alive(session)) return client.socket.close(4001);
    if (typeof m.id !== 'number' || (m.kind !== 'invoke' && m.kind !== 'send') || typeof m.channel !== 'string' || typeof m.profileId !== 'string' || !Array.isArray(m.args)) {
      return client.socket.close(4003);
    }
    // 人の操作の頼みで、使わない時間を数え直す
    session.lastActive = now;
    this.post({ type: 'call', id: m.id, clientId: client.id, profileId: m.profileId, kind: m.kind, channel: m.channel, args: decodeBytes(m.args) as unknown[] });
  }
}
