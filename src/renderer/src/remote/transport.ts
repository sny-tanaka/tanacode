import { IpcChannel, type IpcEvent, type IpcInvoke, type IpcSend } from '@shared/ipc';
import type { ApiTransport } from '@shared/api-bindings';
import { REMOTE_CHANNELS } from '@shared/remote-channels';
import { REMOTE_EVENTS } from '@shared/remote-events';
import { signWithBinding, toBase64 } from './binding';

// スマホの画面の window.tanacode の運び役（Issue #464）。Mac の画面の preload（Electron の IPC）の代わりに、遠隔サーバーと WebSocket でやりとりする。
// - 券（1 回限り・30 秒）を取ってつなぐ: /api/ticket/begin で main の乱数を受け、束縛の鍵で署名して /api/ticket に送る → { type: 'hello', ticket }
// - 切れたら、券を取り直してつなぎ直す（少しずつ間をあける）。Cookie のセッションが切れていたら（401）、ログインの画面へ戻す
// - 頼みには、選んだプロファイルと、人の操作の印（active。押す・打つのあと少しの間だけ）を付ける。使わない時間は、印のある頼みでだけ数え直される
// - 遠隔では呼べないもの（表で same でないもの）は、送らずに手元で断る（知らせは捨てる）
// - Uint8Array は { "$bytes": "<base64>" } で運ぶ

// 人の操作の印を付ける長さ（最後に押した・打ったときから）
export const ACTIVE_MS = 3000;
// つながる前にためておく頼みの数と古さの上限（長く切れていたあとに、古い操作を走らせない）
export const QUEUE_MAX = 100;
export const QUEUE_MS = 30 * 1000;
// つなぎ直したときに送り直すもの（遠隔サーバーが接続ごとに覚えるもの。最後の 1 つ）
const RESEND_ON_READY = new Set<string>([IpcChannel.SessionsFocus]);
// つなぎ直すまでの間（失敗が続くと伸ばす）
const RETRY_MS = [500, 1000, 2000, 5000, 10000];

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Message = { channel: string; payload: unknown };

export type RemoteReady = { profileIds: string[]; language: 'ja' | 'en' };

export type RemoteTransportOptions = {
  // ログインの画面へ戻す（セッションが切れた・束縛の鍵が無い）
  onSignedOut: () => void;
  // つながっているか（画面に出す）
  onConnection?: (connected: boolean) => void;
  // 一度切れてから、つなぎ直した（切れていた間の知らせは届いていないので、画面は読み直す）
  onReconnected?: () => void;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  now?: () => number;
};

const encode = (value: unknown): unknown =>
  value instanceof Uint8Array ? { $bytes: toBase64(value) } : Array.isArray(value) ? value.map(encode) : value;

const decode = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$bytes === 'string' && Object.keys(record).length === 1) return Uint8Array.from(atob(record.$bytes), (c) => c.charCodeAt(0));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(record)) out[key] = decode(v);
  return out;
};

export class RemoteTransport {
  private socket: WebSocket | null = null;
  private ready = false;
  private profileId = '';
  private nextId = 1;
  private retry = 0;
  private stopped = false;
  private lastInput = -Infinity;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly queue: { id: number | null; text: string; at: number }[] = [];
  private readonly resend = new Map<string, unknown[]>();
  private everReady = false;
  private readyWaiters: ((ready: RemoteReady) => void)[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly Socket: typeof WebSocket;
  private readonly now: () => number;

  constructor(private readonly options: RemoteTransportOptions) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.Socket = options.WebSocket ?? WebSocket;
    this.now = options.now ?? Date.now;
  }

  // 人が押した・打ったことを覚える（そのあと少しの間の頼みに、人の操作の印を付ける）
  markInput(): void {
    this.lastInput = this.now();
  }

  // つなぐ。最初につながったときの握手の返事（許したプロファイルと言語）を返す
  start(): Promise<RemoteReady> {
    const first = new Promise<RemoteReady>((resolve) => this.readyWaiters.push(resolve));
    void this.connect();
    return first;
  }

  // 頼みに付けるプロファイル（握手の返事の profileIds のうちの 1 つ）
  useProfile(profileId: string): void {
    this.profileId = profileId;
  }

  // 返事を待っている頼みが無くなるまで待つ（長くても timeout まで。読み込み直す前に、送った頼みを取りこぼさない）
  idle(timeout = 5000): Promise<void> {
    return new Promise((resolve) => {
      const started = this.now();
      const check = () => {
        if (this.pending.size === 0 || this.now() - started >= timeout) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  // window.tanacode を組み立てるための運び方
  api(pathForFile: ApiTransport['pathForFile'], language: ApiTransport['language']): ApiTransport {
    return {
      invoke: ((channel: keyof IpcInvoke, ...args: unknown[]) => this.call('invoke', channel, args)) as ApiTransport['invoke'],
      send: ((channel: keyof IpcSend, ...args: unknown[]) => void this.call('send', channel, args).catch(() => {})) as ApiTransport['send'],
      subscribe: ((channel: keyof IpcEvent, listener: (payload: unknown) => void) => this.on(channel, listener)) as ApiTransport['subscribe'],
      pathForFile,
      language,
    };
  }

  private call(kind: 'invoke' | 'send', channel: string, args: unknown[]): Promise<unknown> {
    // 遠隔では呼べないもの（Mac だけのもの・まだ置き換えていないもの）は、送らずに断る
    if (REMOTE_CHANNELS[channel as keyof typeof REMOTE_CHANNELS]?.use !== 'same') return Promise.reject(new Error(`${channel} is not available on remote`));
    const id = this.nextId++;
    const active = this.now() - this.lastInput < ACTIVE_MS;
    const text = JSON.stringify({ id, kind, profileId: this.profileId, channel, args: args.map(encode), active });
    const result =
      kind === 'invoke'
        ? new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
        : Promise.resolve(undefined);
    if (RESEND_ON_READY.has(channel)) this.resend.set(channel, args);
    this.write(text, id);
    return result;
  }

  private on(channel: string, listener: (payload: unknown) => void): () => void {
    const set = this.listeners.get(channel) ?? new Set();
    const added = set.size === 0;
    set.add(listener);
    this.listeners.set(channel, set);
    if (added && REMOTE_EVENTS[channel as keyof typeof REMOTE_EVENTS] === 'subscribe') this.sendSubscriptions();
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(channel);
        if (REMOTE_EVENTS[channel as keyof typeof REMOTE_EVENTS] === 'subscribe') this.sendSubscriptions();
      }
    };
  }

  // 多い知らせ（subscribe）のうち、今受けたいものの全部を送る（遠隔サーバーは、毎回全部を置き換える）
  private sendSubscriptions(): void {
    const channels = [...this.listeners.keys()].filter((c) => REMOTE_EVENTS[c as keyof typeof REMOTE_EVENTS] === 'subscribe');
    this.write(JSON.stringify({ type: 'subscribe', channels }));
  }

  // つながっていれば送り、つながっていなければ、つながるまでためる（数に上限を置き、古いものから断る）
  private write(text: string, id: number | null = null): void {
    if (this.ready && this.socket) return this.socket.send(text);
    this.queue.push({ id, text, at: this.now() });
    while (this.queue.length > QUEUE_MAX) this.drop(this.queue.shift()!);
  }

  // ためていた頼みを送らずに捨てる（返事を待っていれば断る）
  private drop(entry: { id: number | null }): void {
    if (entry.id === null) return;
    this.pending.get(entry.id)?.reject(new Error('disconnected'));
    this.pending.delete(entry.id);
  }

  private async ticket(): Promise<string | 'signed-out' | null> {
    const post = (path: string, body: unknown) =>
      this.fetchImpl(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    try {
      const begun = await post('/api/ticket/begin', {});
      if (begun.status === 401) return 'signed-out';
      if (!begun.ok) return null;
      const { challengeId, bindingChallenge } = (await begun.json()) as { challengeId: string; bindingChallenge: string };
      const bindingSignature = await signWithBinding(bindingChallenge);
      if (!bindingSignature) return 'signed-out';
      const res = await post('/api/ticket', { challengeId, bindingSignature });
      if (res.status === 401) return 'signed-out';
      if (!res.ok) return null;
      return ((await res.json()) as { ticket: string }).ticket;
    } catch {
      return null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const ticket = await this.ticket();
    if (ticket === 'signed-out') {
      this.stopped = true;
      this.options.onSignedOut();
      return;
    }
    if (!ticket) return this.later();
    const url = new URL('/ws', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new this.Socket(url.toString());
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', ticket }));
    socket.onmessage = (event) => this.received(String(event.data));
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const wasReady = this.ready;
      this.ready = false;
      if (wasReady) this.options.onConnection?.(false);
      // 返事を待っていた頼みは、つなぎ直しても返らないので断る。ためていた頼みも、断ったものを送らないよう捨てる
      for (const waiter of this.pending.values()) waiter.reject(new Error('disconnected'));
      this.pending.clear();
      this.queue.splice(0);
      this.later();
    };
  }

  private later(): void {
    if (this.stopped) return;
    const wait = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
    this.retry += 1;
    setTimeout(() => void this.connect(), wait);
  }

  private received(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'ready') {
      this.ready = true;
      this.retry = 0;
      this.options.onConnection?.(true);
      // つなぎ直したら、多い知らせと、接続ごとに覚えるもの（開いているセッション）を送り直してから、ためていたものを送る（古すぎるものは断る）
      if ([...this.listeners.keys()].some((c) => REMOTE_EVENTS[c as keyof typeof REMOTE_EVENTS] === 'subscribe')) this.sendSubscriptions();
      for (const [channel, args] of this.resend) this.socket?.send(JSON.stringify({ id: this.nextId++, kind: 'send', profileId: this.profileId, channel, args: args.map(encode), active: false }));
      const now = this.now();
      for (const queued of this.queue.splice(0)) {
        if (now - queued.at > QUEUE_MS) this.drop(queued);
        else this.socket?.send(queued.text);
      }
      const reconnected = this.everReady;
      this.everReady = true;
      if (reconnected) this.options.onReconnected?.();
      const ready: RemoteReady = { profileIds: Array.isArray(message.profileIds) ? (message.profileIds as string[]) : [], language: message.language === 'en' ? 'en' : 'ja' };
      for (const waiter of this.readyWaiters.splice(0)) waiter(ready);
      return;
    }
    if (typeof message.id === 'number') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok === true) waiter.resolve(decode(message.value));
      else waiter.reject(new Error(typeof message.error === 'string' ? message.error : 'failed'));
      return;
    }
    if (typeof message.event === 'string') {
      // プロファイルの知らせは、選んだプロファイルのものだけを受ける（アプリ全体の知らせには profileId が無い）
      if (typeof message.profileId === 'string' && message.profileId !== this.profileId) return;
      const event: Message = { channel: message.event, payload: decode(message.payload) };
      for (const listener of [...(this.listeners.get(event.channel) ?? [])]) listener(event.payload);
    }
  }
}
