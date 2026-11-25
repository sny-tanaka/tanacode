import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { setLanguage } from '@shared/i18n';
import type { AuthReplies, AuthRequest, RemoteCredential } from '@shared/remote-auth';
import { loginPage } from './remote-login-page';
import { REMOTE_IDLE_MS, type HostMessage, type RemoteListenConfig, type RemoteSession, type ServerMessage } from '@shared/remote-protocol';

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
export const IDLE_MS = REMOTE_IDLE_MS;
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
// 送りきれずにたまった量の上限。超えたら、その接続を切る（回線の遅い相手に、知らせがたまり続けないように）
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
// 1 つのセッションが同時に持てる券の数（古いものから捨てる）
export const MAX_TICKETS_PER_SESSION = 4;
// 断った接続を、相手が閉じるのを待たずに切るまで
const REFUSE_GRACE_MS = 1000;
// ログインに続けて失敗したら、そのパスキーを待たせる（この回数から。待つ時間は 1 分から倍にしていき、15 分まで）。
// 待ち受け全体では数えない（転送の後ろでは相手を見分けられず、認証の前の誰かが本人の分まで使い切れるため）
export const LOGIN_FAILURES_BEFORE_WAIT = 5;
const LOGIN_WAIT_MS = 60 * 1000;
const LOGIN_WAIT_MAX_MS = 15 * 60 * 1000;
// 本人確認の口が受ける本文の大きさの上限
const MAX_AUTH_BODY = 64 * 1024;
// main が本人確認の頼みに答えるまで待つ時間
const AUTH_TIMEOUT_MS = 10 * 1000;
// パスキーの登録・ログインを始めてから終えるまでの期限
const CEREMONY_MS = 5 * 60 * 1000;

type Client = { id: string; sessionId: string; socket: WebSocket; calls: number[]; closing: boolean };
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

// main の返事・知らせを、遠隔の接続に送れる JSON にする（Uint8Array は { "$bytes": "<base64>" }）
export function encodeForClient(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString('base64') } : v));
}

// 認証の前の画面の CSP（スクリプト・スタイル・アイコンは同じ origin のファイルだけ。外へはつながない）
const LOGIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

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
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly clients = new Map<string, Client>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private credentials: RemoteCredential[] = [];
  // main に頼んだ本人確認の返事を待っているもの
  private readonly authWaits = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextAuthId = 1;
  // パスキーの登録の途中のもの（WebAuthn の challenge は遠隔サーバーが作って確かめる。登録のコードを通ったものだけなので、増えすぎない）
  private readonly registrationsInFlight = new Map<string, { challenge: string; until: number }>();
  // ログインの challenge は控えずに、期限と HMAC を付けて出す（認証の前の誰かが始めるだけの頼みを重ねても、本人の分を押し出せないように）。
  // 使い終えたものだけを期限まで控える
  private readonly ceremonyKey = randomBytes(32);
  private readonly usedLogins = new Map<string, number>();
  // パスキーごとの、続けて失敗した回数と、次に受ける時刻
  private readonly loginFailures = new Map<string, { count: number; until: number }>();

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
        // 使わない時間は、main が控えた最後の操作から数える（待ち受けを始め直しても延ばさない）
        this.sessions.set(message.session.sessionId, { ...message.session });
        break;
      case 'session-remove':
        this.dropSession(message.sessionId);
        break;
      case 'result': {
        const client = this.clients.get(message.clientId);
        if (!client) return;
        this.deliver(client, encodeForClient(message.ok ? { id: message.id, ok: true, value: message.value } : { id: message.id, ok: false, error: message.error }));
        break;
      }
      case 'event': {
        const text = encodeForClient(message.profileId === undefined ? { event: message.channel, payload: message.payload } : { event: message.channel, profileId: message.profileId, payload: message.payload });
        for (const id of message.clientIds) {
          const client = this.clients.get(id);
          if (client) this.deliver(client, text);
        }
        break;
      }
      case 'credentials':
        this.credentials = message.credentials.map((c) => ({ ...c }));
        break;
      case 'auth-result': {
        const wait = this.authWaits.get(message.id);
        if (!wait) return;
        this.authWaits.delete(message.id);
        clearTimeout(wait.timer);
        if (message.ok) wait.resolve(message.value);
        else wait.reject(new Error(message.error));
        break;
      }
      case 'disconnect': {
        const client = this.clients.get(message.clientId);
        if (client) this.refuse(client.socket, 1000, client);
        break;
      }
    }
  }

  // 接続に送る。送りきれずにたまった量が上限を超えていたら、送らずに切る
  private deliver(client: Client, text: string): void {
    if (client.closing) return;
    if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.closing = true;
      client.socket.terminate();
      return;
    }
    client.socket.send(text);
  }

  // 断った接続を閉じる。相手が閉じるのを待たずに切り、それまでに届いた伝文は受けない
  private refuse(ws: WebSocket, code: number, client?: Client): void {
    if (client) client.closing = true;
    ws.close(code);
    setTimeout(() => ws.terminate(), REFUSE_GRACE_MS).unref();
  }

  private listen(config: RemoteListenConfig): void {
    this.close(false);
    this.config = config;
    setLanguage(config.language);
    const server = createServer((req, res) => this.request(req, res));
    // 認証の前に届く面なので、接続の数と、頼みを受けきるまでの時間にも上限を置く
    server.maxConnections = 32;
    server.headersTimeout = 10 * 1000;
    server.requestTimeout = 15 * 1000;
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    server.on('error', (error: NodeJS.ErrnoException) => {
      this.post({ type: 'listen-failed', reason: error.code === 'EADDRINUSE' ? 'in-use' : 'other', message: error.message });
      this.close(false);
    });
    server.listen(config.port, '127.0.0.1', () => {
      this.post({ type: 'listening', port: (server.address() as AddressInfo).port });
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
    this.registrationsInFlight.clear();
    this.usedLogins.clear();
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
  private sessionOf(req: IncomingMessage): RemoteSession | null {
    const token = cookieOf(req, SESSION_COOKIE);
    if (!token || token.length > 256) return null;
    const hash = sha256(token);
    for (const session of this.sessions.values()) {
      if (!sameHex(session.tokenHash, hash)) continue;
      return this.alive(session) ? session : null;
    }
    return null;
  }

  private alive(session: RemoteSession): boolean {
    const now = this.now();
    if (now >= session.expiresAt || now - session.lastActive >= IDLE_MS) {
      this.dropSession(session.sessionId);
      // main も控えから消す（待ち受けを始め直したときに、送り直させない）
      this.post({ type: 'session-expired', sessionId: session.sessionId });
      return false;
    }
    return true;
  }

  private expire(): void {
    for (const session of [...this.sessions.values()]) this.alive(session);
    const now = this.now();
    for (const [ticket, entry] of this.tickets) if (entry.until <= now) this.tickets.delete(ticket);
  }

  private dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [ticket, entry] of this.tickets) if (entry.sessionId === sessionId) this.tickets.delete(ticket);
    for (const client of this.clients.values()) if (client.sessionId === sessionId) this.refuse(client.socket, 4001, client);
  }

  private request(req: IncomingMessage, res: ServerResponse): void {
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    // 状態を変える頼み（GET・HEAD 以外）は、Origin も確かめる
    if (!this.trusted(req, !isGet)) {
      req.socket.destroy();
      return;
    }
    const path = String(req.url).split('?')[0];
    // 認証の前の画面（登録・ログインだけ）。バージョンなどは出さない
    const page = isGet ? loginPage(path) : null;
    if (page) {
      res.writeHead(200, { ...BASE_HEADERS, 'content-security-policy': LOGIN_CSP, 'content-type': page.type });
      res.end(page.body);
      return;
    }
    if (req.method === 'POST' && path.startsWith('/api/pair/') || req.method === 'POST' && path.startsWith('/api/login/')) {
      void this.authRoute(req, res, path);
      return;
    }
    // WebSocket の券。セッションの Cookie が要る（③ で、束縛の鍵の署名も求める）
    if (req.method === 'POST' && path === '/api/ticket') {
      const session = this.sessionOf(req);
      if (!session) return this.reply(res, 401, { error: 'unauthorized' });
      const ticket = randomBytes(32).toString('base64url');
      // 券の数に上限を置く（古いものから捨てる）
      const mine = [...this.tickets].filter(([, entry]) => entry.sessionId === session.sessionId);
      for (const [old] of mine.slice(0, Math.max(0, mine.length - MAX_TICKETS_PER_SESSION + 1))) this.tickets.delete(old);
      this.tickets.set(ticket, { sessionId: session.sessionId, until: this.now() + TICKET_MS });
      return this.reply(res, 200, { ticket });
    }
    this.reply(res, 404, { error: 'not found' });
  }

  // main に本人確認を頼む（返事が無ければ、待ちきれずに断る）
  private auth<K extends keyof AuthReplies>(request: AuthRequest & { op: K }): Promise<AuthReplies[K]> {
    const id = this.nextAuthId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.authWaits.delete(id);
        reject(new Error('no answer'));
      }, AUTH_TIMEOUT_MS);
      timer.unref();
      this.authWaits.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.post({ type: 'auth', id, request });
    });
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_AUTH_BODY) return null;
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  // 登録・ログインの口。どれも JSON を受けて JSON を返す。断るときは 400（理由は出さない。どこで断ったかを相手に教えない）
  private async authRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const now = this.now();
    const body = await this.readJson(req);
    if (!body || !this.config) return this.reply(res, 400, { error: 'bad request' });
    const origin = this.config.publicOrigin;
    const rpID = new URL(origin).hostname;
    for (const [key, entry] of this.registrationsInFlight) if (entry.until <= now) this.registrationsInFlight.delete(key);
    for (const [key, until] of this.usedLogins) if (until <= now) this.usedLogins.delete(key);
    try {
      switch (path) {
        case '/api/pair/begin': {
          const begun = await this.auth({ op: 'pair-begin', code: String(body.code ?? '') });
          const options = await generateRegistrationOptions({
            rpName: 'tanacode',
            rpID,
            userName: 'tanacode',
            userID: Buffer.from(begun.userId, 'base64url'),
            attestationType: 'none',
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            supportedAlgorithmIDs: [-7],
          });
          this.registrationsInFlight.set(begun.pairingId, { challenge: options.challenge, until: now + CEREMONY_MS });
          return this.reply(res, 200, { pairingId: begun.pairingId, options, bindingChallenge: begun.bindingChallenge });
        }
        case '/api/pair/finish': {
          const pairingId = String(body.pairingId ?? '');
          const inFlight = this.registrationsInFlight.get(pairingId);
          this.registrationsInFlight.delete(pairingId);
          if (!inFlight) throw new Error('no registration in flight');
          const verified = await verifyRegistrationResponse({
            response: body.response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
            expectedChallenge: inFlight.challenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            requireUserVerification: true,
          });
          if (!verified.verified) throw new Error('not verified');
          const { credential } = verified.registrationInfo;
          const finished = await this.auth({
            op: 'pair-finish',
            pairingId,
            credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter },
            bindingJwk: body.bindingJwk as never,
            bindingSignature: String(body.bindingSignature ?? ''),
            name: String(body.name ?? ''),
          });
          return this.reply(res, 200, finished);
        }
        case '/api/pair/status':
          return this.reply(res, 200, await this.auth({ op: 'pair-status', requestId: String(body.requestId ?? '') }));
        case '/api/login/begin': {
          const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [], challenge: this.loginChallenge(now + CEREMONY_MS) });
          const binding = await this.auth({ op: 'challenge' });
          return this.reply(res, 200, { options, challengeId: binding.challengeId, bindingChallenge: binding.challenge });
        }
        case '/api/login/finish': {
          const response = body.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'];
          const credential = this.credentials.find((c) => c.credentialId === response?.id);
          if (!credential) throw new Error('unknown login');
          const failures = this.loginFailures.get(credential.credentialId);
          if (failures && failures.until > now) return this.reply(res, 429, { error: 'too many requests' });
          // 失敗として先に数え、通ったら消す（途中で投げても数えたまま）
          this.loginFailed(credential.credentialId, now);
          let usedChallenge = '';
          const verified = await verifyAuthenticationResponse({
            response,
            expectedChallenge: (challenge) => {
              usedChallenge = challenge;
              return this.validLoginChallenge(challenge, now);
            },
            expectedOrigin: origin,
            expectedRPID: rpID,
            credential: { id: credential.credentialId, publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')), counter: credential.counter },
            requireUserVerification: true,
          });
          if (!verified.verified) throw new Error('not verified');
          this.usedLogins.set(usedChallenge, this.challengeUntil(usedChallenge));
          const login = await this.auth({
            op: 'login',
            registrationId: credential.registrationId,
            counter: verified.authenticationInfo.newCounter,
            challengeId: String(body.challengeId ?? ''),
            bindingSignature: String(body.bindingSignature ?? ''),
          });
          this.loginFailures.delete(credential.credentialId);
          res.setHeader('set-cookie', `${SESSION_COOKIE}=${login.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${login.maxAgeSeconds}`);
          return this.reply(res, 200, { ok: true });
        }
        default:
          return this.reply(res, 404, { error: 'not found' });
      }
    } catch {
      return this.reply(res, 400, { error: 'bad request' });
    }
  }

  // ログインの challenge（「期限.乱数.HMAC」。generateAuthenticationOptions が UTF-8 の base64url にして渡し、届いたものも base64url のまま確かめる）
  private loginChallenge(until: number): string {
    const body = `${until}.${randomBytes(32).toString('base64url')}`;
    return `${body}.${createHmac('sha256', this.ceremonyKey).update(body).digest('base64url')}`;
  }

  private challengeUntil(challenge: string): number {
    return Number(Buffer.from(challenge, 'base64url').toString('utf8').split('.')[0]);
  }

  // 自分が出した、期限の内の、まだ使っていない challenge なら true
  private validLoginChallenge(challenge: string, now: number): boolean {
    const parts = Buffer.from(challenge, 'base64url').toString('utf8').split('.');
    if (parts.length !== 3 || this.usedLogins.has(challenge)) return false;
    const until = Number(parts[0]);
    const mac = createHmac('sha256', this.ceremonyKey).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], 'base64url');
    return Number.isFinite(until) && until > now && given.length === mac.length && timingSafeEqual(given, mac);
  }

  private loginFailed(credentialId: string, now: number): void {
    const count = (this.loginFailures.get(credentialId)?.count ?? 0) + 1;
    const wait = count < LOGIN_FAILURES_BEFORE_WAIT ? 0 : Math.min(LOGIN_WAIT_MAX_MS, LOGIN_WAIT_MS * 2 ** (count - LOGIN_FAILURES_BEFORE_WAIT));
    this.loginFailures.set(credentialId, { count, until: now + wait });
  }

  private reply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = String(req.url).split('?')[0];
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
    // 券の伝文は 1 回だけ（しくじったら、やり直させずに切る）
    let refused = false;
    const refuse = (code: number) => {
      refused = true;
      this.refuse(ws, code, client ?? undefined);
    };
    const helloTimer = setTimeout(() => refuse(4002), HELLO_MS);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (refused || client?.closing) return;
      if (isBinary) return refuse(4003);
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return refuse(4003);
      }
      if (!client) {
        clearTimeout(helloTimer);
        client = this.hello(ws, sessionId, message);
        if (!client) refuse(4002);
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
    // 同時に握手した接続も、上限で数え直す
    if (this.clients.size >= MAX_CLIENTS) return null;
    const client: Client = { id: randomBytes(16).toString('base64url'), sessionId, socket: ws, calls: [], closing: false };
    this.clients.set(client.id, client);
    this.post({ type: 'connected', clientId: client.id, sessionId });
    ws.send(encodeForClient({ type: 'ready' }));
    return client;
  }

  // 接続からの伝文。{ id, kind, profileId, channel, args } の頼みと、{ type: 'subscribe', channels } だけを受ける
  private clientMessage(client: Client, message: unknown): void {
    const refuse = (code: number) => this.refuse(client.socket, code, client);
    // 頼みも subscribe も、頻度の上限に数える
    const now = this.now();
    client.calls = client.calls.filter((at) => now - at < 10 * 1000);
    client.calls.push(now);
    if (client.calls.length > MAX_CALLS_PER_10S) return refuse(4008);
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return refuse(4003);
    const m = message as Record<string, unknown>;
    const session = this.sessions.get(client.sessionId);
    if (!session || !this.alive(session)) return refuse(4001);
    if (m.type === 'subscribe') {
      if (!Array.isArray(m.channels)) return refuse(4003);
      this.post({ type: 'subscribe', clientId: client.id, channels: m.channels.filter((c): c is string => typeof c === 'string') });
      return;
    }
    if (typeof m.id !== 'number' || (m.kind !== 'invoke' && m.kind !== 'send') || typeof m.channel !== 'string' || typeof m.profileId !== 'string' || !Array.isArray(m.args)) {
      return refuse(4003);
    }
    // 人の操作の頼みで、使わない時間を数え直す（main も、届いた頼みで控え直す）
    session.lastActive = now;
    // Uint8Array（{ "$bytes": "<base64>" }）は、main が引数の形（bytes）の位置でだけ戻す
    this.post({ type: 'call', id: m.id, clientId: client.id, profileId: m.profileId, kind: m.kind, channel: m.channel, args: m.args });
  }
}
