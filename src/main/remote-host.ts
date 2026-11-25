import { IpcChannel, type IpcEvent } from '@shared/ipc';
import { REMOTE_EVENTS } from '@shared/remote-events';
import { createHash, randomBytes } from 'node:crypto';
import { parseServerMessage, REMOTE_IDLE_MS, REMOTE_TICKET_MS, REMOTE_TICKETS_PER_SESSION, type HostMessage, type RemoteListenConfig, type RemoteSession, type ServerMessage } from '@shared/remote-protocol';
import { t } from '@shared/i18n';
import type { AuthReplies, AuthRequest, RemoteCredential } from '@shared/remote-auth';
import type { RemoteStatus } from '@shared/remote-settings';
import type { RemoteCaller } from './remote-dispatch';

// main の側の、遠隔サーバー（utilityProcess）の持ち手（Issue #464）。
// - 遠隔サーバーを起動・停止し、待ち受けの様子（status）を知らせる。落ちたら起動し直さずに止める（失敗したら閉じる）
// - 遠隔サーバーから届いた伝文は、形を確かめてから使う。呼び出し元（Caller）は、伝文の中の値ではなく、
//   main が持つ接続の控え（接続 → セッション → 登録・許したプロファイル）から組み立てる
// - 知らせ（IpcEvent）は、REMOTE_EVENTS で送るものだけを、そのプロファイルを許した接続に送る。subscribe のものは、頼んだ接続だけ

// 遠隔サーバーの子のプロセス（utilityProcess の、使う所だけ）。テストでは作り物にする
export type ServerProcess = {
  post(message: HostMessage): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
};

export type RemoteHostDeps = {
  spawn: () => ServerProcess;
  // 遠隔の接続からの頼みを、Mac の画面と同じ受け口に渡す（IpcDispatcher の fromRemote）
  call: (caller: RemoteCaller, channel: string, args: unknown[]) => Promise<unknown>;
  onStatus: (status: RemoteStatus) => void;
  // つながっている接続の数が変わった（メニューバーの様子の文を作り直す）
  onConnections: (count: number) => void;
  // その登録のパスキーで、ログインに続けて失敗した（Mac に知らせる）
  onLoginFailures: (registrationId: string) => void;
  // 断ったこと・届いた形の違う伝文など。秘密や頼みの中身は渡さない
  log: (message: string) => void;
  // 本人確認の頼み（RemoteAuth.handle）。断るときは投げる
  auth: (request: AuthRequest) => AuthReplies[keyof AuthReplies];
};

// focus: その接続（スマホの画面）が開いているセッション（チャットの知らせは、これの分だけ送る。通信量を増やさない）
type Client = { sessionId: string; subscriptions: Set<string>; focus: string | null };

export class RemoteHost {
  private child: ServerProcess | null = null;
  private config: RemoteListenConfig | null = null;
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly clients = new Map<string, Client>();
  // main が出した WebSocket の券（SHA-256 → セッションと期限）。接続のときに、ここに無い券の接続は切らせる
  private readonly tickets = new Map<string, { sessionId: string; until: number }>();
  private status: RemoteStatus = { state: 'off' };
  private credentials: RemoteCredential[] = [];

  constructor(
    private readonly deps: RemoteHostDeps,
    private readonly now: () => number = Date.now,
  ) {}

  current(): RemoteStatus {
    return this.status;
  }

  // 待ち受けを始める（始めていれば、設定を変えて始め直す）
  start(config: RemoteListenConfig): void {
    this.config = config;
    if (!this.child) this.child = this.spawnChild();
    // 始め直すと、遠隔サーバーは接続を切る（知らせてこないので、控えもここで消す）
    this.setClients(() => this.clients.clear());
    this.setStatus({ state: 'starting' });
    // 期限の切れたセッションは渡さない。渡すものは、main が控えた最後の操作の時刻のまま（使わない時間を延ばさない）
    for (const session of [...this.sessions.values()]) {
      if (this.alive(session)) this.child.post({ type: 'session-add', session });
    }
    this.child.post({ type: 'credentials', credentials: this.credentials });
    this.child.post({ type: 'listen', config });
  }

  // 待ち受けをやめ、遠隔サーバーを止める。接続はすべて切れる
  // オフにしたら、セッションも捨てる（入れ直したら、ログインし直す）
  stop(): void {
    const child = this.child;
    this.child = null;
    this.config = null;
    this.sessions.clear();
    this.tickets.clear();
    this.setClients(() => this.clients.clear());
    if (child) {
      child.post({ type: 'close' });
      child.kill();
    }
    this.setStatus({ state: 'off' });
  }

  // 登録したパスキーの公開の部分を、遠隔サーバーに渡す（登録・取り消しのたびに、全部を送り直す）
  setCredentials(credentials: RemoteCredential[]): void {
    this.credentials = credentials.map((c) => ({ ...c }));
    this.child?.post({ type: 'credentials', credentials: this.credentials });
  }

  // 取り消した登録のセッションを、すべて消す（その接続は切れる）
  removeRegistration(registrationId: string): void {
    for (const session of [...this.sessions.values()]) if (session.registrationId === registrationId) this.removeSession(session.sessionId);
  }

  // 本人確認を通ったセッションを足す・消す。消したセッションの接続は切れる
  addSession(session: RemoteSession): void {
    this.sessions.set(session.sessionId, session);
    this.child?.post({ type: 'session-add', session });
  }

  removeSession(sessionId: string): void {
    this.forget(sessionId);
    this.child?.post({ type: 'session-remove', sessionId });
  }

  // つながっている接続の登録（接続ごと。Mac の上の帯に出す）
  connectedRegistrations(): string[] {
    return [...this.clients.values()].map((client) => this.sessions.get(client.sessionId)?.registrationId).filter((id): id is string => Boolean(id));
  }

  // 全部のセッションを捨てる（接続は切れ、つなぎ直すにはログインし直す。Mac の上の帯の「切断」）。数の知らせは 1 回にまとめる
  removeAllSessions(): void {
    const ids = [...this.sessions.keys()];
    this.sessions.clear();
    this.tickets.clear();
    this.setClients(() => this.clients.clear());
    for (const sessionId of ids) this.child?.post({ type: 'session-remove', sessionId });
  }

  // 生きているセッションの登録（無い・切れていれば null）
  sessionRegistration(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session && this.alive(session) ? session.registrationId : null;
  }

  // そのセッションに WebSocket の券を出す（束縛の鍵の署名を確かめたあと。RemoteAuth が呼ぶ）。1 つのセッションの券の数に上限を置く（古いものから捨てる）
  grantTicket(sessionId: string): string {
    const now = this.now();
    for (const [hash, entry] of this.tickets) if (entry.until <= now) this.tickets.delete(hash);
    const mine = [...this.tickets].filter(([, entry]) => entry.sessionId === sessionId);
    for (const [old] of mine.slice(0, Math.max(0, mine.length - REMOTE_TICKETS_PER_SESSION + 1))) this.tickets.delete(old);
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(createHash('sha256').update(ticket).digest('hex'), { sessionId, until: now + REMOTE_TICKET_MS });
    return ticket;
  }

  // 接続に使った券が、main が出したもので、そのセッションの、期限の内か（1 回だけ使える）
  private takeTicket(ticket: string, sessionId: string): boolean {
    const hash = createHash('sha256').update(ticket).digest('hex');
    const entry = this.tickets.get(hash);
    this.tickets.delete(hash);
    return Boolean(entry && entry.sessionId === sessionId && entry.until > this.now());
  }

  // セッションと、その接続の控えを消す
  private forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [hash, entry] of this.tickets) if (entry.sessionId === sessionId) this.tickets.delete(hash);
    this.setClients(() => {
      for (const [clientId, client] of this.clients) if (client.sessionId === sessionId) this.clients.delete(clientId);
    });
  }

  // セッションが期限・使わない時間の内か。切れていれば捨てる（遠隔サーバーを信じきらない）
  private alive(session: RemoteSession): boolean {
    const now = this.now();
    if (now < session.expiresAt && now - session.lastActive < REMOTE_IDLE_MS) return true;
    this.forget(session.sessionId);
    this.child?.post({ type: 'session-remove', sessionId: session.sessionId });
    return false;
  }

  // 接続の控えを変え、数が変わったら知らせる
  private setClients(change: () => void): void {
    const before = this.clients.size;
    change();
    if (this.clients.size !== before) this.deps.onConnections(this.clients.size);
  }

  // プロファイル profileId の画面への知らせを、遠隔の接続にも送る（index.ts の sendTo から呼ぶ）
  emit<C extends keyof IpcEvent>(profileId: string, channel: C, payload: IpcEvent[C]): void {
    try {
      this.emitTo(profileId, channel, payload);
    } catch (error) {
      // 遠隔への送りの失敗で、Mac の画面への知らせ（呼んだ側）を止めない
      this.deps.log(`遠隔の接続に知らせを送れませんでした（${channel}）: ${String(error)}`);
    }
  }

  private emitTo<C extends keyof IpcEvent>(profileId: string, channel: C, payload: IpcEvent[C]): void {
    if (!this.child || this.clients.size === 0) return;
    const use = REMOTE_EVENTS[channel];
    if (use === 'mac') return;
    const clientIds: string[] = [];
    for (const [clientId, client] of this.clients) {
      if (!this.sessions.get(client.sessionId)?.profileIds.includes(profileId)) continue;
      if (use === 'subscribe' && !client.subscriptions.has(channel)) continue;
      // チャットの知らせは、その接続が開いているセッションの分だけ（ほかのセッションは、開いたときに頼んで読み直す）
      if (channel === IpcChannel.ChatEvents && (payload as IpcEvent[typeof IpcChannel.ChatEvents]).sessionId !== client.focus) continue;
      clientIds.push(clientId);
    }
    if (clientIds.length > 0) this.child.post({ type: 'event', clientIds, channel, payload, profileId });
  }

  // アプリ全体の知らせ（どのプロファイルの画面にも送るもの）を、つながっているどの接続にも 1 回ずつ送る
  emitAll<C extends keyof IpcEvent>(channel: C, payload: IpcEvent[C]): void {
    try {
      if (!this.child || this.clients.size === 0) return;
      const use = REMOTE_EVENTS[channel];
      if (use === 'mac') return;
      const clientIds = [...this.clients].filter(([, client]) => use !== 'subscribe' || client.subscriptions.has(channel)).map(([clientId]) => clientId);
      if (clientIds.length > 0) this.child.post({ type: 'event', clientIds, channel, payload });
    } catch (error) {
      this.deps.log(`遠隔の接続に知らせを送れませんでした（${channel}）: ${String(error)}`);
    }
  }

  // その接続（スマホの画面）が開いているセッションを覚える（Mac の画面の「開いているセッション」には触らない）
  setFocus(clientId: string, sessionId: string | null): void {
    const client = this.clients.get(clientId);
    if (client) client.focus = sessionId;
  }

  // つながっている接続の数（Mac の上の帯に出す）
  connectionCount(): number {
    return this.clients.size;
  }

  private spawnChild(): ServerProcess {
    const child = this.deps.spawn();
    child.onMessage((raw) => this.received(child, raw));
    child.onExit((code) => {
      if (this.child !== child) return;
      // 落ちたら、起動し直さずに止める（何度も落ちる不具合で、待ち受けが出たり消えたりしないように）
      this.child = null;
      this.setClients(() => this.clients.clear());
      this.deps.log(`遠隔サーバーが終わりました（終了コード ${code}）`);
      this.setStatus({ state: 'failed', message: `exit ${code}` });
    });
    return child;
  }

  private received(child: ServerProcess, raw: unknown): void {
    if (this.child !== child) return;
    const message = parseServerMessage(raw);
    if (!message) {
      this.deps.log('遠隔サーバーから、形の違う伝文が届きました');
      // 本人確認の頼みの中身の形が違う（スマホから届いた値が欠けているなど）。返事を待たせずに断る
      const { type, id } = (typeof raw === 'object' && raw !== null ? raw : {}) as { type?: unknown; id?: unknown };
      if (type === 'auth' && typeof id === 'number' && Number.isSafeInteger(id) && id > 0) child.post({ type: 'auth-result', id, ok: false, error: 'malformed request' });
      return;
    }
    this.handle(child, message);
  }

  private handle(child: ServerProcess, message: ServerMessage): void {
    switch (message.type) {
      case 'listening':
        this.setStatus({ state: 'listening', port: message.port });
        break;
      case 'listen-failed':
        this.setStatus(message.reason === 'in-use' ? { state: 'in-use', port: this.config?.port ?? 0 } : { state: 'failed', message: message.message });
        break;
      case 'closed':
        this.setClients(() => this.clients.clear());
        break;
      case 'connected': {
        // 知らない・期限の切れたセッションの接続、main が出していない券の接続、もうある接続の id は、受けずに切らせる
        // （遠隔サーバーの論理の誤りだけでは、束縛の鍵の署名なしにつなげないように）
        const session = this.sessions.get(message.sessionId);
        if (!session || !this.alive(session) || !this.takeTicket(message.ticket, message.sessionId) || this.clients.has(message.clientId)) {
          child.post({ type: 'disconnect', clientId: message.clientId });
          return;
        }
        this.setClients(() => this.clients.set(message.clientId, { sessionId: message.sessionId, subscriptions: new Set(), focus: null }));
        break;
      }
      case 'disconnected':
        this.setClients(() => this.clients.delete(message.clientId));
        break;
      case 'login-failures':
        this.deps.onLoginFailures(message.registrationId);
        break;
      case 'session-expired':
        this.forget(message.sessionId);
        break;
      case 'subscribe': {
        const client = this.clients.get(message.clientId);
        if (!client) return;
        client.subscriptions = new Set(message.channels.filter((channel) => Object.hasOwn(REMOTE_EVENTS, channel) && REMOTE_EVENTS[channel as keyof IpcEvent] === 'subscribe'));
        break;
      }
      case 'call':
        void this.call(child, message);
        break;
      case 'auth':
        this.authenticate(child, message);
        break;
    }
  }

  private async call(child: ServerProcess, message: Extract<ServerMessage, { type: 'call' }>): Promise<void> {
    const client = this.clients.get(message.clientId);
    const session = client ? this.sessions.get(client.sessionId) : undefined;
    const reply = (result: { ok: true; value: unknown } | { ok: false; error: string }) => {
      if (message.kind === 'invoke' && this.child === child) child.post({ type: 'result', id: message.id, clientId: message.clientId, ...result });
    };
    if (!client || !session || !this.alive(session)) {
      child.post({ type: 'disconnect', clientId: message.clientId });
      return;
    }
    // プロファイルは、そのセッションに許したものだけ
    if (!session.profileIds.includes(message.profileId)) {
      reply({ ok: false, error: t('main.error.remoteProfileNotAllowed') });
      return;
    }
    // 人の操作の頼み（active）でだけ、使わない時間を数え直す（待ち受けを始め直したときに、この時刻を渡す）
    if (message.active) session.lastActive = this.now();
    const caller: RemoteCaller = { kind: 'remote', profileId: message.profileId, clientId: message.clientId, registrationId: session.registrationId };
    try {
      reply({ ok: true, value: await this.deps.call(caller, message.channel, message.args) });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private authenticate(child: ServerProcess, message: Extract<ServerMessage, { type: 'auth' }>): void {
    try {
      child.post({ type: 'auth-result', id: message.id, ok: true, value: this.deps.auth(message.request) });
    } catch (error) {
      child.post({ type: 'auth-result', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private setStatus(status: RemoteStatus): void {
    this.status = status;
    this.deps.onStatus(status);
  }
}
