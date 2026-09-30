import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PROTOCOL, type ClientMessage, type HostMessage, type HostedPtyInfo, type SpawnRequest } from './pty-host-protocol';

// ホストを起動してから、待ち受けを始めるまで待つ時間
const START_TIMEOUT_MS = 5000;
const RETRY_MS = 100;
// Unix ソケットのパスの長さの上限（macOS は 104 バイト）
const MAX_SOCKET_PATH = 100;

// 受け手がいない間に溜めておく出力の数
const EARLY_CHUNKS = 2000;

type PtyListeners = { data: ((data: string) => void)[]; exit: ((exitCode: number) => void)[] };

// ホストが持っている pty のひとつ。node-pty の IPty と同じように使う
export class HostedPty {
  private readonly listeners: PtyListeners = { data: [], exit: [] };
  // まだ誰も受け取っていない間に届いた出力（引き継ぎの一覧を受け取ってから、アプリが見始めるまでの分）
  private early: string[] | null = [];
  exited = false;

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

  onExit(listener: (exitCode: number) => void): void {
    this.listeners.exit.push(listener);
  }

  write(data: string): void {
    this.host.send({ t: 'write', id: this.id, data });
  }

  resize(cols: number, rows: number): void {
    this.host.send({ t: 'resize', id: this.id, cols, rows });
  }

  kill(): void {
    this.host.send({ t: 'kill', id: this.id });
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
    for (const listener of this.listeners.exit) listener(exitCode);
  }
}

// pty ホストとの接続。ホストが無ければ起動し、形（PROTOCOL）が違う古いホストなら止めて起動し直す
export class PtyHost {
  private socket: Socket | null = null;
  private readonly ptys = new Map<string, HostedPty>();
  private readonly pending = new Map<number, (ptys: HostedPtyInfo[]) => void>();
  private req = 0;

  private constructor(
    private readonly socketPath: string,
    private readonly hostScript: string,
    private readonly logFile: string,
  ) {}

  // dir: ソケットとログを置くフォルダ（userData）
  static async start(dir: string, hostScript: string): Promise<PtyHost> {
    const host = new PtyHost(socketPathFor(dir), hostScript, join(dir, 'pty-host.log'));
    await host.connect();
    return host;
  }

  // 動いている（または、アプリが見ていない間に終わった）pty
  list(): Promise<HostedPtyInfo[]> {
    const req = ++this.req;
    return new Promise((resolve) => {
      this.pending.set(req, resolve);
      this.send({ t: 'list', req });
    });
  }

  spawn(request: Omit<SpawnRequest, 'id'>): HostedPty {
    const id = randomUUID();
    const pty = new HostedPty(this, id);
    this.ptys.set(id, pty);
    if (!this.socket) void this.connect().then(() => this.send({ t: 'spawn', id, ...request }), () => pty.emitExit(-1));
    else this.send({ t: 'spawn', id, ...request });
    return pty;
  }

  // 前のアプリが起動した pty を引き継ぐ（一覧を受け取ったときに作ってあるものを使う）
  attach(info: HostedPtyInfo): HostedPty {
    let pty = this.ptys.get(info.id);
    if (!pty) {
      pty = new HostedPty(this, info.id);
      this.ptys.set(info.id, pty);
    }
    return pty;
  }

  // アプリが見ていない間に終わった pty の記録を捨てる
  forget(id: string): void {
    this.ptys.delete(id);
    this.send({ t: 'forget', id });
  }

  release(id: string): void {
    this.ptys.delete(id);
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

  send(message: ClientMessage): void {
    this.socket?.write(`${JSON.stringify(message)}\n`);
  }

  private async connect(): Promise<void> {
    let socket = await tryConnect(this.socketPath);
    if (socket) {
      const protocol = await hello(socket);
      if (protocol === null) {
        // 答えない。新しいホストに置き換える（新しいホストがソケットを作り直す）
        socket.destroy();
        socket = null;
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
      // ホストが落ちた。claude も一緒に止まっている
      this.socket = null;
      for (const pty of [...this.ptys.values()]) pty.emitExit(-1);
      this.ptys.clear();
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
      case 'exit': {
        const pty = this.ptys.get(message.id);
        if (!pty) return;
        this.ptys.delete(message.id);
        pty.emitExit(message.exitCode);
        return;
      }
      case 'list':
        // 一覧の画面（screen）より後の出力は、このあと同じ受信の中で続けて届く。
        // 引き継ぐ側が attach する前に捨てないよう、ここで受け皿を作っておく
        for (const info of message.ptys) {
          if (info.exitCode === null && !this.ptys.has(info.id)) this.ptys.set(info.id, new HostedPty(this, info.id));
        }
        this.pending.get(message.req)?.(message.ptys);
        this.pending.delete(message.req);
        return;
      case 'hello':
        return;
    }
  }
}

// ホストを動かす実行ファイル。macOS では、アプリ本体だと Dock にアイコンが出るので、
// 同梱の「<名前> Helper.app」（LSUIElement。Dock に出ない）を Node として使う
function hostExecutable(): string {
  if (process.platform !== 'darwin') return process.execPath;
  const name = `${basename(process.execPath)} Helper`;
  const helper = join(dirname(process.execPath), '..', 'Frameworks', `${name}.app`, 'Contents', 'MacOS', name);
  return existsSync(helper) ? helper : process.execPath;
}

// ソケットは userData に置く。パスが長すぎるときは、一時フォルダに userData ごとの名前で置く
function socketPathFor(dir: string): string {
  const path = join(dir, 'pty-host.sock');
  if (Buffer.byteLength(path) <= MAX_SOCKET_PATH) return path;
  return join(tmpdir(), `tanacode-pty-${createHash('sha1').update(dir).digest('hex').slice(0, 12)}.sock`);
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
  throw new Error(`pty ホストに繋がりません: ${path}`);
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
