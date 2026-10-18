import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { t } from '@shared/i18n';
import {
  PROTOCOL,
  type ClientMessage,
  type HostMessage,
  type HostedInfo,
  type HostedPipeInfo,
  type HostedPtyInfo,
  type PipeSpawnRequest,
  type PtySpawnRequest,
} from './pty-host-protocol';
import { socketPathIn } from './socket-path';

// ホストを起動してから、待ち受けを始めるまで待つ時間
const START_TIMEOUT_MS = 5000;
const RETRY_MS = 100;

// 受け手がいない間に溜めておく pty の出力の数
const EARLY_CHUNKS = 2000;
// 受け手がいない間に溜めておくパイプの行の合計の長さ。超えたら捨て、受け手が付いたときにホストに送り直しを頼む
const EARLY_LINE_BYTES = 16 * 1024 * 1024;

// ClaudeSession が使う、pty の操作（HostedPty の形）
export interface PtyHandle {
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  // 止める。既定は SIGHUP（端末を閉じたのと同じ）
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  detach(): void;
}

// ClaudeSession が使う、パイプでつながるプロセスの操作（HostedPipe の形）
export interface PipeHandle {
  // 出力の 1 行と通し番号。最初の受け手には、それまでに届いていた行を先に渡す。同じ通し番号の行は 2 回渡さない
  onLine(listener: (line: string, seq: number) => void): void;
  // 終了コードと、標準エラーの末尾
  onExit(listener: (exitCode: number, stderr: string) => void): void;
  // 入力に 1 行書く
  send(line: string): void;
  // 入力を閉じる
  end(): void;
  // 止める（プロセスグループごと）。既定は SIGTERM
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  // この通し番号から、ホストが控えている行を送り直してもらう
  replay(from: number): void;
  // 送り直しが終わった（頼んだ行をすべて渡した）
  onReplayed(listener: () => void): void;
  detach(): void;
}

// SessionManager・ClaudeSession が使う、ホストの操作（PtyHost の形）。
// Claude Code との互換性の確認（test/cli）は、プロセスを直に起動する偽物に差し替えて、本物の SessionManager を動かす
export interface PtyHostApi {
  list(): Promise<HostedInfo[]>;
  spawn(request: Omit<PtySpawnRequest, 'id' | 'kind'>): PtyHandle;
  spawnPipe(request: Omit<PipeSpawnRequest, 'id' | 'kind'>): PipeHandle;
  attach(info: HostedPtyInfo): PtyHandle;
  attachPipe(info: HostedPipeInfo): PipeHandle;
  forget(id: string): void;
}

type PtyListeners = { data: ((data: string) => void)[]; exit: ((exitCode: number) => void)[] };

// ホストが持っている pty のひとつ。node-pty の IPty と同じように使う
export class HostedPty implements PtyHandle {
  private readonly listeners: PtyListeners = { data: [], exit: [] };
  // まだ誰も受け取っていない間に届いた出力（引き継ぎの一覧を受け取ってから、アプリが見始めるまでの分）
  private early: string[] | null = [];
  exited = false;
  // 終わったときの終了コード（あとから付いた受け手にも渡す）
  private exitCode: number | null = null;
  // アプリが受け取った（起動した・引き継いだ）。一覧で作っただけの受け皿は、引き継ぐまで終わっても消さない
  claimed = true;

  constructor(
    private readonly host: PtyHost,
    readonly id: string,
  ) {}

  // 最初の受け手には、それまでに届いていた出力を先に渡す
  onData(listener: (data: string) => void): void {
    this.listeners.data.push(listener);
    const early = this.early;
    this.early = null;
    early?.forEach(listener);
  }

  // もう終わっていれば、すぐ（次の小さな区切りで）知らせる
  onExit(listener: (exitCode: number) => void): void {
    this.listeners.exit.push(listener);
    const code = this.exitCode;
    if (code !== null) queueMicrotask(() => listener(code));
  }

  write(data: string): void {
    this.host.send({ t: 'write', id: this.id, data });
  }

  resize(cols: number, rows: number): void {
    this.host.send({ t: 'resize', id: this.id, cols, rows });
  }

  kill(signal?: 'SIGTERM' | 'SIGKILL'): void {
    this.host.send({ t: 'kill', id: this.id, ...(signal ? { signal } : {}) });
  }

  // アプリはこの pty を見るのをやめる（claude は動かしたまま）
  detach(): void {
    this.listeners.data = [];
    this.listeners.exit = [];
    this.host.release(this.id);
  }

  emitData(data: string): void {
    if (this.early) {
      // 受け手がいないまま溜めすぎない（画面の描き直しは続きで追いつく）
      if (this.early.length < EARLY_CHUNKS) this.early.push(data);
      return;
    }
    for (const listener of this.listeners.data) listener(data);
  }

  emitExit(exitCode: number): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = exitCode;
    for (const listener of this.listeners.exit) listener(exitCode);
  }
}

type PipeListeners = { line: ((line: string, seq: number) => void)[]; exit: ((exitCode: number, stderr: string) => void)[]; replayed: (() => void)[] };

type QueuedLine = { line: string; seq: number };

// ホストが持っているパイプのプロセスのひとつ
export class HostedPipe implements PipeHandle {
  private readonly listeners: PipeListeners = { line: [], exit: [], replayed: [] };
  // 受け手に渡す順に並べた行（受け手がいない間は溜める）と、その合計の長さ
  private ready: QueuedLine[] = [];
  private readyBytes = 0;
  // 送り直しを頼んでから、送り終えるまでの間に届いた新しい行（送り直した行のあとに渡す）
  private held: QueuedLine[] | null = null;
  // 溜めきれずに捨てた行のいちばん古い通し番号（受け手が付いたら、ここから送り直してもらう）
  private missedFrom: number | null = null;
  // 受け手に渡した最後の通し番号（送り直しで重なった行を、もう一度渡さない）
  private delivered = 0;
  exited = false;
  // 終わったときの終了コードと標準エラーの末尾（あとから付いた受け手にも渡す）
  private exitInfo: { exitCode: number; stderr: string } | null = null;
  // アプリが受け取った（起動した・引き継いだ）。一覧で作っただけの受け皿は、引き継ぐまで終わっても消さない
  // （一覧の返事と同じ受信の中で終わりが届いても、引き継いだあとに終わったと分かるように）
  claimed = true;

  constructor(
    private readonly host: PtyHost,
    readonly id: string,
  ) {}

  onLine(listener: (line: string, seq: number) => void): void {
    this.listeners.line.push(listener);
    if (this.missedFrom !== null) {
      const from = this.missedFrom;
      this.missedFrom = null;
      this.replay(from);
    }
    this.flush();
  }

  // もう終わっていれば、すぐ（次の小さな区切りで）知らせる
  onExit(listener: (exitCode: number, stderr: string) => void): void {
    this.listeners.exit.push(listener);
    const info = this.exitInfo;
    if (info) queueMicrotask(() => listener(info.exitCode, info.stderr));
  }

  onReplayed(listener: () => void): void {
    this.listeners.replayed.push(listener);
  }

  send(line: string): void {
    this.host.send({ t: 'send', id: this.id, line });
  }

  end(): void {
    this.host.send({ t: 'end', id: this.id });
  }

  kill(signal?: 'SIGTERM' | 'SIGKILL'): void {
    this.host.send({ t: 'kill', id: this.id, ...(signal ? { signal } : {}) });
  }

  // 送り直しを頼む。送り終えるまでに届く新しい行は、送り直した行のあとに渡す（それまでに溜まっていて、まだ渡していない行のうち、
  // 頼んだ番号からのものも。頼んだ番号より前の行は、送り直す行より先なので、先に渡す）
  replay(from: number): void {
    if (this.held === null) {
      this.held = this.ready.filter((item) => item.seq >= from);
      this.ready = this.ready.filter((item) => item.seq < from);
      this.readyBytes = this.ready.reduce((sum, item) => sum + item.line.length, 0);
    }
    if (this.exited) {
      // もう終わっている（一覧の返事と同じ受信の中で終わった）。ホストは終わったときに記録を捨てているので、頼まずに、送り直しが
      // 終わったことにする。引き継ぐ側が受け手を付け終えてから（次の小さな区切りで）、待たせていた行を渡す。
      // 引き継ぐ側（StreamClient.adopt）は、受け手を付ける前に頼むので、終わりの知らせ（onExit の、次の小さな区切り）より先になる
      queueMicrotask(() => {
        if (this.held) this.emitReplayed();
      });
    } else {
      this.host.send({ t: 'replay', id: this.id, from });
    }
    this.flush();
  }

  detach(): void {
    this.listeners.line = [];
    this.listeners.exit = [];
    this.listeners.replayed = [];
    this.host.release(this.id);
  }

  // ホストから届いた行。replay: 送り直しの行
  emitLine(line: string, seq: number, replay = false): void {
    const item = { line, seq };
    if (this.held && !replay) this.held.push(item);
    else this.queue(item);
    this.flush();
  }

  // 送り直しが終わった。終わったことを知らせてから、待たせていた新しい行を渡す（受け手は、前のアプリの頃の行を読み終えてから続きを受け取る）
  emitReplayed(): void {
    const held = this.held ?? [];
    this.held = null;
    this.flush();
    for (const listener of this.listeners.replayed) listener();
    for (const item of held) this.queue(item);
    this.flush();
  }

  emitExit(exitCode: number, stderr: string): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { exitCode, stderr };
    // 送り直しの途中で終わったときも、待たせていた行は渡してから終わりを知らせる
    if (this.held) this.emitReplayed();
    for (const listener of this.listeners.exit) listener(exitCode, stderr);
  }

  private queue(item: QueuedLine): void {
    if (this.listeners.line.length === 0 && this.readyBytes + item.line.length > EARLY_LINE_BYTES) {
      // 受け手がいないまま溜めすぎない。捨てた分は、受け手が付いたときにホストの控えから送り直してもらう
      this.missedFrom ??= item.seq;
      return;
    }
    this.ready.push(item);
    this.readyBytes += item.line.length;
  }

  private flush(): void {
    if (this.listeners.line.length === 0) return;
    const ready = this.ready;
    this.ready = [];
    this.readyBytes = 0;
    for (const { line, seq } of ready) {
      if (seq <= this.delivered) continue;
      this.delivered = seq;
      for (const listener of this.listeners.line) listener(line, seq);
    }
  }
}

// 常駐のホストとの接続。ホストが無ければ起動し、形（PROTOCOL）が違う古いホストなら止めて起動し直す。
// ホストが落ちたあとは、起動・一覧の頼みでつなぎ直す。つなぐ処理は 1 本だけ走らせ（connecting）、つながるまでに送るものは溜めておいて、
// つながったら順に送る（起動の直後の initialize・止める頼みなどを黙って捨てると、起動中のまま残るため）
export class PtyHost implements PtyHostApi {
  private socket: Socket | null = null;
  // つないでいる途中の処理（つながったか、あきらめたら null に戻す）
  private connecting: Promise<void> | null = null;
  // つながるまで溜めているもの。failed: つなげなかったときに知らせる（起動・一覧の頼み）
  private queued: { message: ClientMessage; failed?: () => void }[] = [];
  private readonly ptys = new Map<string, HostedPty>();
  private readonly pipes = new Map<string, HostedPipe>();
  private readonly pending = new Map<number, (hosted: HostedInfo[]) => void>();
  private req = 0;

  private constructor(
    private readonly socketPath: string,
    private readonly hostScript: string,
    private readonly logFile: string,
  ) {}

  // dir: ソケットとログを置くフォルダ（userData）
  static async start(dir: string, hostScript: string): Promise<PtyHost> {
    const host = new PtyHost(socketPathIn(dir, 'pty-host', 'pty'), hostScript, join(dir, 'pty-host.log'));
    await host.ensureConnected();
    return host;
  }

  // 動いている（または、アプリが見ていない間に終わった）プロセス
  list(): Promise<HostedInfo[]> {
    const req = ++this.req;
    return new Promise((resolve) => {
      this.pending.set(req, resolve);
      // つなげなければ、空の一覧（ホストが落ちたときと同じ）
      this.request({ t: 'list', req }, () => {
        this.pending.delete(req);
        resolve([]);
      });
    });
  }

  spawn(request: Omit<PtySpawnRequest, 'id' | 'kind'>): HostedPty {
    const id = randomUUID();
    const pty = new HostedPty(this, id);
    this.ptys.set(id, pty);
    this.request({ t: 'spawn', id, kind: 'pty', ...request }, () => pty.emitExit(-1));
    return pty;
  }

  spawnPipe(request: Omit<PipeSpawnRequest, 'id' | 'kind'>): HostedPipe {
    const id = randomUUID();
    const pipe = new HostedPipe(this, id);
    this.pipes.set(id, pipe);
    this.request({ t: 'spawn', id, kind: 'pipe', ...request }, () => pipe.emitExit(-1, ''));
    return pipe;
  }

  // 前のアプリが起動した pty を引き継ぐ（一覧を受け取ったときに作ってあるものを使う。その間に終わっていれば、終わりも持っている）
  attach(info: HostedPtyInfo): HostedPty {
    let pty = this.ptys.get(info.id);
    if (!pty) {
      pty = new HostedPty(this, info.id);
      this.ptys.set(info.id, pty);
    }
    pty.claimed = true;
    if (pty.exited) this.ptys.delete(info.id);
    return pty;
  }

  attachPipe(info: HostedPipeInfo): HostedPipe {
    let pipe = this.pipes.get(info.id);
    if (!pipe) {
      pipe = new HostedPipe(this, info.id);
      this.pipes.set(info.id, pipe);
    }
    pipe.claimed = true;
    if (pipe.exited) this.pipes.delete(info.id);
    return pipe;
  }

  // アプリが見ていない間に終わったプロセスの記録を捨てる
  forget(id: string): void {
    this.ptys.delete(id);
    this.pipes.delete(id);
    this.send({ t: 'forget', id });
  }

  release(id: string): void {
    this.ptys.delete(id);
    this.pipes.delete(id);
  }

  // claude をすべて止めて、ホストも終わらせる。ホストが終わるまで待つ
  shutdown(): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => {
      socket.once('close', () => resolve());
      setTimeout(resolve, 3000);
      this.send({ t: 'shutdown' });
    });
  }

  // アプリの終了時。claude は動かしたまま接続だけ切る
  close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.end();
  }

  // つないでいる途中なら、つながってから送る。つながっておらず、つないでもいなければ捨てる（落ちたホストの、終わったプロセスへの頼み）
  send(message: ClientMessage): void {
    if (this.socket) this.socket.write(`${JSON.stringify(message)}\n`);
    else if (this.connecting) this.queued.push({ message });
  }

  // つながっていなければ、つないでから送る。つなげなければ failed
  private request(message: ClientMessage, failed: () => void): void {
    if (this.socket) {
      this.send(message);
      return;
    }
    this.queued.push({ message, failed });
    this.ensureConnected().catch(() => {});
  }

  // つなぐ処理を 1 本にまとめる。つながったら溜めたものを順に送り、あきらめたら起動・一覧の頼みに失敗を知らせる
  private ensureConnected(): Promise<void> {
    if (this.socket) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.connect().then(
        () => {
          this.connecting = null;
        },
        (error: unknown) => {
          this.connecting = null;
          const queued = this.queued;
          this.queued = [];
          for (const { failed } of queued) failed?.();
          throw error;
        },
      );
    }
    return this.connecting;
  }

  private async connect(): Promise<void> {
    let socket = await tryConnect(this.socketPath);
    if (socket) {
      const protocol = await hello(socket);
      if (protocol === null) {
        // 答えない。新しいホストに置き換える（新しいホストがソケットを作り直す）。
        // 答えないホストもまだ待ち受けているので、ソケットはここで消しておく
        // （残すと、新しいホストが作り直す前につなぎにいき、答えないホストにつなぎ直してしまう）
        socket.destroy();
        socket = null;
        removeSocket(this.socketPath);
      } else if (protocol !== PROTOCOL) {
        // 形の違う古いホスト。持っている claude ごと止めてもらい、今のアプリのホストを起動し直す
        socket.write(`${JSON.stringify({ t: 'shutdown' } satisfies ClientMessage)}\n`);
        const old = socket;
        await new Promise<void>((resolve) => {
          old.once('close', () => resolve());
          setTimeout(() => old.destroy(), 2000);
        });
        socket = null;
      }
    }
    if (!socket) {
      this.launch();
      socket = await waitForHost(this.socketPath);
      await hello(socket);
    }
    this.use(socket);
    // 溜めていたものを、つながってすぐ（あとから送るものより先に）送る
    const queued = this.queued;
    this.queued = [];
    for (const { message } of queued) this.send(message);
  }

  // ホストを、アプリと切り離して起動する（アプリが終わっても止まらない）
  private launch(): void {
    const log = openSync(this.logFile, 'a');
    try {
      const child = spawn(hostExecutable(), [this.hostScript, this.socketPath], {
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      child.unref();
    } finally {
      closeSync(log);
    }
  }

  private use(socket: Socket): void {
    this.socket = socket;
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) this.receive(JSON.parse(line) as HostMessage);
      }
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      // ホストが終わった。pty の claude は端末が閉じて一緒に止まる。パイプの claude は、ホストが終わる前にグループごと止める
      // （SIGTERM・SIGINT・失敗でも）。止める間もなく落ちた（SIGKILL など）ときは残るので、起動し直す前に、記録した pid を確かめて止める
      // （session-manager の stopLeftover）
      this.socket = null;
      for (const pty of [...this.ptys.values()]) pty.emitExit(-1);
      for (const pipe of [...this.pipes.values()]) pipe.emitExit(-1, '');
      this.ptys.clear();
      this.pipes.clear();
      for (const resolve of this.pending.values()) resolve([]);
      this.pending.clear();
    });
    socket.on('error', () => socket.destroy());
  }

  private receive(message: HostMessage): void {
    switch (message.t) {
      case 'data':
        this.ptys.get(message.id)?.emitData(message.data);
        return;
      case 'line':
        this.pipes.get(message.id)?.emitLine(message.line, message.seq, message.replay === true);
        return;
      case 'replayed':
        this.pipes.get(message.id)?.emitReplayed();
        return;
      case 'exit': {
        const pty = this.ptys.get(message.id);
        const pipe = this.pipes.get(message.id);
        // 一覧で作っただけの受け皿は、引き継ぐまで残す（引き継いだときに、終わったと分かるように）
        if (pty?.claimed !== false) this.ptys.delete(message.id);
        if (pipe?.claimed !== false) this.pipes.delete(message.id);
        pty?.emitExit(message.exitCode);
        pipe?.emitExit(message.exitCode, message.stderr ?? '');
        return;
      }
      case 'list':
        // 一覧より後の出力は、このあと同じ受信の中で続けて届く。引き継ぐ側が attach する前に捨てないよう、ここで受け皿を作っておく
        for (const info of message.hosted) {
          if (info.exitCode !== null) continue;
          if (info.kind === 'pty' && !this.ptys.has(info.id)) {
            const pty = new HostedPty(this, info.id);
            pty.claimed = false;
            this.ptys.set(info.id, pty);
          }
          if (info.kind === 'pipe' && !this.pipes.has(info.id)) {
            const pipe = new HostedPipe(this, info.id);
            pipe.claimed = false;
            this.pipes.set(info.id, pipe);
          }
        }
        this.pending.get(message.req)?.(message.hosted);
        this.pending.delete(message.req);
        return;
      case 'hello':
        return;
    }
  }
}

// ホストを動かす実行ファイル。macOS では、アプリ本体だと Dock にアイコンが出るので、
// 同梱の「<名前> Helper.app」（LSUIElement。Dock に出ない）を Node として使う。アプリ内ブラウザの中継（browser-mcp.js）も同じもので動かす
export function hostExecutable(): string {
  if (process.platform !== 'darwin') return process.execPath;
  const name = `${basename(process.execPath)} Helper`;
  const helper = join(dirname(process.execPath), '..', 'Frameworks', `${name}.app`, 'Contents', 'MacOS', name);
  return existsSync(helper) ? helper : process.execPath;
}

// 待ち受けのソケットを消す（つながっている接続は切れない）
function removeSocket(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // 消せなければ、新しいホストが作り直す
  }
}

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

async function waitForHost(path: string): Promise<Socket> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const socket = await tryConnect(path);
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  throw new Error(t('main.error.ptyHostUnreachable', { path }));
}

// ホストの形（PROTOCOL）を聞く。答えが無ければ null
function hello(socket: Socket): Promise<number | null> {
  return new Promise((resolve) => {
    let buffered = '';
    const timer = setTimeout(() => finish(null), 2000);
    const onData = (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const message = JSON.parse(line) as HostMessage;
          if (message.t === 'hello') return finish(message.protocol);
        } catch {
          // 読めない行は飛ばす
        }
      }
    };
    const finish = (protocol: number | null) => {
      clearTimeout(timer);
      socket.off('data', onData);
      resolve(protocol);
    };
    socket.on('data', onData);
    socket.write(`${JSON.stringify({ t: 'hello', protocol: PROTOCOL } satisfies ClientMessage)}\n`);
  });
}
