import type { IpcEvent } from '@shared/ipc';
import { REMOTE_EVENTS } from '@shared/remote-events';
import { parseServerMessage, type HostMessage, type RemoteListenConfig, type RemoteSession, type ServerMessage } from '@shared/remote-protocol';
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
  // 断ったこと・届いた形の違う伝文など。秘密や頼みの中身は渡さない
  log: (message: string) => void;
};

type Client = { sessionId: string; subscriptions: Set<string> };

export class RemoteHost {
  private child: ServerProcess | null = null;
  private config: RemoteListenConfig | null = null;
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly clients = new Map<string, Client>();
  private status: RemoteStatus = { state: 'off' };

  constructor(private readonly deps: RemoteHostDeps) {}

  current(): RemoteStatus {
    return this.status;
  }

  // 待ち受けを始める（始めていれば、設定を変えて始め直す）
  start(config: RemoteListenConfig): void {
    this.config = config;
    if (!this.child) this.child = this.spawnChild();
    this.setStatus({ state: 'starting' });
    for (const session of this.sessions.values()) this.child.post({ type: 'session-add', session });
    this.child.post({ type: 'listen', config });
  }

  // 待ち受けをやめ、遠隔サーバーを止める。接続はすべて切れる
  stop(): void {
    const child = this.child;
    this.child = null;
    this.config = null;
    this.clients.clear();
    if (child) {
      child.post({ type: 'close' });
      child.kill();
    }
    this.setStatus({ state: 'off' });
  }

  // 本人確認を通ったセッションを足す・消す（③）。消したセッションの接続は切れる
  addSession(session: RemoteSession): void {
    this.sessions.set(session.sessionId, session);
    this.child?.post({ type: 'session-add', session });
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [clientId, client] of this.clients) if (client.sessionId === sessionId) this.clients.delete(clientId);
    this.child?.post({ type: 'session-remove', sessionId });
  }

  // プロファイル profileId の画面への知らせを、遠隔の接続にも送る（index.ts の sendTo から呼ぶ）
  emit<C extends keyof IpcEvent>(profileId: string, channel: C, payload: IpcEvent[C]): void {
    if (!this.child || this.clients.size === 0) return;
    const use = REMOTE_EVENTS[channel];
    if (use === 'mac') return;
    const clientIds: string[] = [];
    for (const [clientId, client] of this.clients) {
      if (!this.sessions.get(client.sessionId)?.profileIds.includes(profileId)) continue;
      if (use === 'subscribe' && !client.subscriptions.has(channel)) continue;
      clientIds.push(clientId);
    }
    if (clientIds.length > 0) this.child.post({ type: 'event', clientIds, channel, payload });
  }

  // アプリ全体の知らせ（どのプロファイルの画面にも送るもの）を、つながっているどの接続にも 1 回ずつ送る
  emitAll<C extends keyof IpcEvent>(channel: C, payload: IpcEvent[C]): void {
    if (!this.child || this.clients.size === 0) return;
    const use = REMOTE_EVENTS[channel];
    if (use === 'mac') return;
    const clientIds = [...this.clients].filter(([, client]) => use !== 'subscribe' || client.subscriptions.has(channel)).map(([clientId]) => clientId);
    if (clientIds.length > 0) this.child.post({ type: 'event', clientIds, channel, payload });
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
      this.clients.clear();
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
        this.clients.clear();
        break;
      case 'connected':
        // 知らないセッションの接続は、受けずに切らせる
        if (!this.sessions.has(message.sessionId)) {
          child.post({ type: 'disconnect', clientId: message.clientId });
          return;
        }
        this.clients.set(message.clientId, { sessionId: message.sessionId, subscriptions: new Set() });
        break;
      case 'disconnected':
        this.clients.delete(message.clientId);
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
    }
  }

  private async call(child: ServerProcess, message: Extract<ServerMessage, { type: 'call' }>): Promise<void> {
    const client = this.clients.get(message.clientId);
    const session = client ? this.sessions.get(client.sessionId) : undefined;
    const reply = (result: { ok: true; value: unknown } | { ok: false; error: string }) => {
      if (message.kind === 'invoke' && this.child === child) child.post({ type: 'result', id: message.id, clientId: message.clientId, ...result });
    };
    if (!client || !session) {
      child.post({ type: 'disconnect', clientId: message.clientId });
      return;
    }
    // プロファイルは、そのセッションに許したものだけ
    if (!session.profileIds.includes(message.profileId)) {
      reply({ ok: false, error: 'profile not allowed' });
      return;
    }
    const caller: RemoteCaller = { kind: 'remote', profileId: message.profileId, clientId: message.clientId, registrationId: session.registrationId };
    try {
      reply({ ok: true, value: await this.deps.call(caller, message.channel, message.args) });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private setStatus(status: RemoteStatus): void {
    this.status = status;
    this.deps.onStatus(status);
  }
}
