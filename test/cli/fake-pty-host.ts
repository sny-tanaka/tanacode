import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';
import * as pty from 'node-pty';
import type { ScreenLine } from '@shared/screen';
import { PipeBacklog, readLines } from '../../src/main/pipe-backlog';
import type { PipeHandle, PtyHandle, PtyHostApi } from '../../src/main/pty-host-client';
import { STDERR_TAIL, type HostedInfo, type HostedPipeInfo, type HostedPtyInfo, type PipeSpawnRequest, type PtySpawnRequest } from '../../src/main/pty-host-protocol';

// 引き継いだときに戻す画面の、さかのぼる行数（pty-host.ts と同じ）
const SCROLLBACK = 1000;

type Hosted = {
  info: Omit<HostedPtyInfo, 'screen' | 'exitCode' | 'cols' | 'rows' | 'kind'>;
  proc: pty.IPty;
  term: Terminal;
  serializer: SerializeAddon;
  exitCode: number | null;
  // アプリ（SessionManager）が今見ている受け口。アプリを終了すると外れ、次のアプリの list で作り直す
  handle: FakeHandle | null;
  disposed: boolean;
  // pty が本当に終わったとき（terminate で終わったことにしたあとも、終わるまでは少しかかる）
  gone: Promise<void>;
};

// パイプでつながる claude（stream-json）。行の控えは本物のホストと同じ PipeBacklog で持つ
type HostedPipeEntry = {
  info: { id: string; tag: string; pid: number; startedAt: number };
  proc: ChildProcess;
  backlog: PipeBacklog;
  exitCode: number | null;
  stderr: string;
  ended: boolean;
  handle: FakePipeHandle | null;
  disposed: boolean;
  gone: Promise<void>;
};

// 常駐のホスト（src/main/pty-host.ts と pty-host-client.ts の PtyHost）の代わり。常駐プロセスを起動せず、node-pty と child_process を直に使う。
// やりとりの形（spawn・spawnPipe・attach・attachPipe・list・forget、受け手がいない間の出力を溜める、引き継ぎの画面・行の控えと起動時刻）は
// PtyHost と同じにする。起動するのは、アプリが頼む 'claude' ではなく確かめる claude（file）。環境変数は env に、
// アプリが渡す statusLine・AskUserQuestion のファイルの変数と、アプリが足すフック（アプリ内ブラウザ・チェックリスト・ターミナル）の変数（passEnv）だけを足す（ふだんの環境を持ち込まない）
export class FakePtyHost implements PtyHostApi {
  // ホストが持っている pty（list に出るもの）
  private readonly ptys = new Map<string, Hosted>();
  // これまでに起動したすべて。終わったあとも画面を読めるよう、dispose まで残す
  private readonly all: Hosted[] = [];
  // ホストが持っているパイプの claude（list に出るもの）と、これまでに起動したすべて
  private readonly pipes = new Map<string, HostedPipeEntry>();
  private readonly allPipes: HostedPipeEntry[] = [];

  constructor(
    private readonly file: string,
    private readonly env: Record<string, string>,
    private readonly passEnv: string[],
  ) {}

  list(): Promise<HostedInfo[]> {
    const infos: HostedInfo[] = [];
    for (const hosted of this.pipes.values()) {
      if (hosted.exitCode === null && !hosted.handle) hosted.handle = new FakePipeHandle(hosted, this);
      infos.push({
        ...hosted.info,
        kind: 'pipe',
        exitCode: hosted.exitCode,
        lastSeq: hosted.backlog.lastSeq,
        firstSeq: hosted.backlog.firstSeq,
        retained: hosted.backlog.retained(),
        pending: hosted.backlog.pending(),
        ended: hosted.ended,
        stderr: hosted.stderr,
      });
    }
    for (const hosted of this.ptys.values()) {
      // 一覧の画面より後の出力を捨てないよう、ここで受け皿を作っておく（PtyHost の receive と同じ）
      if (hosted.exitCode === null && !hosted.handle) hosted.handle = new FakeHandle(hosted, this);
      infos.push({
        ...hosted.info,
        kind: 'pty',
        cols: hosted.term.cols,
        rows: hosted.term.rows,
        exitCode: hosted.exitCode,
        screen: hosted.serializer.serialize(),
      });
    }
    return Promise.resolve(infos);
  }

  spawn(request: Omit<PtySpawnRequest, 'id' | 'kind'>): PtyHandle {
    const id = randomUUID();
    const env = this.envFor(request.env);
    const term = new Terminal({ cols: request.cols, rows: request.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    const proc = pty.spawn(this.file, request.args, { name: 'xterm-256color', cols: request.cols, rows: request.rows, cwd: request.cwd, env });
    let ended!: () => void;
    const gone = new Promise<void>((resolve) => (ended = resolve));
    const hosted: Hosted = {
      info: { id, tag: request.tag, pid: proc.pid, startedAt: Date.now() },
      proc,
      term,
      serializer,
      exitCode: null,
      handle: null,
      disposed: false,
      gone,
    };
    const handle = new FakeHandle(hosted, this);
    // spawn の受け口は、はじめから受け手がいる（PtyHost の spawn と同じく、溜めずに渡す）
    handle.early = null;
    hosted.handle = handle;
    this.ptys.set(id, hosted);
    this.all.push(hosted);
    // 画面に書き込んでからアプリへ送る（pty-host.ts と同じ。引き継ぎの画面に、送った出力がいつも入っている）
    proc.onData((data) => {
      if (!hosted.disposed) term.write(data, () => hosted.handle?.emitData(data));
    });
    proc.onExit(({ exitCode }) => {
      ended();
      if (!hosted.disposed) term.write('', () => this.exited(hosted, exitCode));
    });
    return handle;
  }

  // stream-json の claude を起動する。自分のプロセスグループで起動し、止めるときはグループごと止める（pty-host.ts と同じ）
  spawnPipe(request: Omit<PipeSpawnRequest, 'id' | 'kind'>): PipeHandle {
    const id = randomUUID();
    const proc = spawnChild(this.file, request.args, { cwd: request.cwd, env: this.envFor(request.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let ended!: () => void;
    const gone = new Promise<void>((resolve) => (ended = resolve));
    const hosted: HostedPipeEntry = {
      info: { id, tag: request.tag, pid: proc.pid ?? -1, startedAt: Date.now() },
      proc,
      backlog: new PipeBacklog(request.retain, request.transient),
      exitCode: null,
      stderr: '',
      ended: false,
      handle: null,
      disposed: false,
      gone,
    };
    const handle = new FakePipeHandle(hosted, this);
    hosted.handle = handle;
    this.pipes.set(id, hosted);
    this.allPipes.push(hosted);
    if (proc.stdout) {
      readLines(
        proc.stdout,
        (line) => {
          if (hosted.disposed) return;
          const seq = hosted.backlog.receive(line);
          hosted.handle?.emitLine(line, seq);
        },
        () => {},
      );
    }
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      hosted.stderr = (hosted.stderr + chunk).slice(-STDERR_TAIL);
    });
    proc.stdin?.on('error', () => {});
    proc.on('error', (error) => {
      hosted.stderr += String(error);
    });
    proc.on('close', (code, signal) => {
      ended();
      if (!hosted.disposed) this.pipeExited(hosted, code ?? (signal ? 128 : -1));
    });
    return handle;
  }

  attach(info: HostedPtyInfo): PtyHandle {
    const hosted = this.ptys.get(info.id);
    if (!hosted) throw new Error(`知らない pty です: ${info.id}`);
    hosted.handle ??= new FakeHandle(hosted, this);
    return hosted.handle;
  }

  attachPipe(info: HostedPipeInfo): PipeHandle {
    const hosted = this.pipes.get(info.id);
    if (!hosted) throw new Error(`知らない claude です: ${info.id}`);
    hosted.handle ??= new FakePipeHandle(hosted, this);
    return hosted.handle;
  }

  forget(id: string): void {
    if (this.ptys.get(id)?.exitCode !== null) this.ptys.delete(id);
    if (this.pipes.get(id)?.exitCode !== null) this.pipes.delete(id);
  }

  // tag（アプリのセッション ID）の claude を止め、終わったことをすぐ知らせる（claude が自分で終わったのと同じ）。
  // プロセスが実際に終わるのは少し後なので、その知らせは捨てる
  terminate(tag: string): void {
    for (const hosted of this.ptys.values()) {
      if (hosted.info.tag !== tag || hosted.exitCode !== null) continue;
      hosted.proc.kill();
      this.exited(hosted, 0);
    }
    for (const hosted of this.pipes.values()) {
      if (hosted.info.tag !== tag || hosted.exitCode !== null) continue;
      killGroup(hosted, 'SIGTERM');
      this.pipeExited(hosted, 0);
    }
  }

  // 今動いている tag の claude の画面（ScreenTracker と同じ形の行）。無ければ null
  lines(tag: string): ScreenLine[] | null {
    const hosted = [...this.all].reverse().find((h) => h.info.tag === tag);
    if (!hosted || hosted.disposed) return null;
    const { term } = hosted;
    const buf = term.buffer.active;
    const lines: ScreenLine[] = [];
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push({ text: line?.translateToString(true) ?? '', full: !!line && (line.getCell(term.cols - 1)?.getChars() ?? '') !== '' });
    }
    return lines;
  }

  // 今動いている tag の claude の画面を、文字の属性（薄い字など）ごと書き出したもの。控えから ScreenTracker で読み直すのに使う
  serialized(tag: string): string | null {
    const hosted = [...this.all].reverse().find((h) => h.info.tag === tag);
    return hosted && !hosted.disposed ? hosted.serializer.serialize() : null;
  }

  // 今動いている tag の claude に、アプリを通さずに打つ（アプリが止まっている間の操作）。stream-json の claude には 1 行書く
  write(tag: string, data: string): void {
    for (const hosted of this.ptys.values()) if (hosted.info.tag === tag && hosted.exitCode === null) hosted.proc.write(data);
    for (const hosted of this.pipes.values()) if (hosted.info.tag === tag && hosted.exitCode === null) this.sendLine(hosted, data);
  }

  // すべての claude を止める。返すのは、どれも本当に終わったとき（timeoutMs で待つのをやめる）
  dispose(timeoutMs = 3000): Promise<void> {
    for (const hosted of this.all) {
      if (hosted.exitCode === null) hosted.proc.kill();
      hosted.handle = null;
      hosted.disposed = true;
      hosted.term.dispose();
    }
    this.ptys.clear();
    for (const hosted of this.allPipes) {
      if (hosted.exitCode === null) killGroup(hosted, 'SIGKILL');
      hosted.handle = null;
      hosted.disposed = true;
    }
    this.pipes.clear();
    const gone = Promise.all([...this.all.map((hosted) => hosted.gone), ...this.allPipes.map((hosted) => hosted.gone)]).then(() => undefined);
    return Promise.race([gone, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  release(hosted: Hosted, handle: FakeHandle): void {
    if (hosted.handle === handle) hosted.handle = null;
  }

  releasePipe(hosted: HostedPipeEntry, handle: FakePipeHandle): void {
    if (hosted.handle === handle) hosted.handle = null;
  }

  sendLine(hosted: HostedPipeEntry, line: string): void {
    if (hosted.exitCode !== null || hosted.ended) return;
    hosted.backlog.sent(line);
    hosted.proc.stdin?.write(`${line}\n`);
  }

  // 起動する claude の環境変数。ふだんの環境を持ち込まず、アプリが渡す変数（passEnv）だけを足す
  private envFor(requested: Record<string, string>): Record<string, string> {
    const env = { ...this.env };
    for (const name of this.passEnv) if (requested[name] !== undefined) env[name] = requested[name];
    return env;
  }

  private exited(hosted: Hosted, exitCode: number): void {
    if (hosted.exitCode !== null) return;
    hosted.exitCode = exitCode;
    const handle = hosted.handle;
    // アプリが見ていれば、終わった記録は残さない（pty-host.ts と同じ）。見ていなければ次の list で知らせる
    if (handle) {
      hosted.handle = null;
      this.ptys.delete(hosted.info.id);
      handle.emitExit(exitCode);
    }
  }

  private pipeExited(hosted: HostedPipeEntry, exitCode: number): void {
    if (hosted.exitCode !== null) return;
    hosted.exitCode = exitCode;
    hosted.backlog.exited();
    const handle = hosted.handle;
    if (handle) {
      hosted.handle = null;
      this.pipes.delete(hosted.info.id);
      handle.emitExit(exitCode, hosted.stderr);
    }
  }
}

// パイプの claude を、プロセスグループごと止める
function killGroup(hosted: HostedPipeEntry, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-hosted.info.pid, signal);
  } catch {
    try {
      hosted.proc.kill(signal);
    } catch {}
  }
}

// HostedPty と同じく、最初の受け手が付くまでの出力を溜めておく
class FakeHandle implements PtyHandle {
  private listeners: { data: ((data: string) => void)[]; exit: ((exitCode: number) => void)[] } = { data: [], exit: [] };
  early: string[] | null = [];
  private exited = false;

  constructor(
    private readonly hosted: Hosted,
    private readonly host: FakePtyHost,
  ) {}

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
    if (this.hosted.exitCode === null) this.hosted.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.hosted.exitCode !== null) return;
    this.hosted.proc.resize(cols, rows);
    this.hosted.term.resize(cols, rows);
  }

  kill(signal?: 'SIGTERM' | 'SIGKILL'): void {
    if (this.hosted.exitCode === null) this.hosted.proc.kill(signal);
  }

  detach(): void {
    this.listeners = { data: [], exit: [] };
    this.host.release(this.hosted, this);
  }

  emitData(data: string): void {
    if (this.early) {
      this.early.push(data);
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

// HostedPipe と同じく、受け手が付くまでの行を溜め、同じ通し番号の行は 2 回渡さない。送り直しは、その場で控えから渡す
class FakePipeHandle implements PipeHandle {
  private listeners: { line: ((line: string, seq: number) => void)[]; exit: ((exitCode: number, stderr: string) => void)[]; replayed: (() => void)[] } = {
    line: [],
    exit: [],
    replayed: [],
  };
  private ready: { line: string; seq: number }[] = [];
  private delivered = 0;
  private exited = false;

  constructor(
    private readonly hosted: HostedPipeEntry,
    private readonly host: FakePtyHost,
  ) {}

  onLine(listener: (line: string, seq: number) => void): void {
    this.listeners.line.push(listener);
    this.flush();
  }

  onExit(listener: (exitCode: number, stderr: string) => void): void {
    this.listeners.exit.push(listener);
  }

  send(line: string): void {
    this.host.sendLine(this.hosted, line);
  }

  end(): void {
    if (this.hosted.ended) return;
    this.hosted.ended = true;
    this.hosted.proc.stdin?.end();
  }

  kill(signal?: 'SIGTERM' | 'SIGKILL'): void {
    if (this.hosted.exitCode === null) killGroup(this.hosted, signal ?? 'SIGTERM');
  }

  replay(from: number): void {
    // 送り直しの行を、まだ渡していない新しい行より先に並べる。その場で控えから渡すので、すぐ送り終える
    this.ready = [...this.hosted.backlog.since(from), ...this.ready];
    this.flush();
    queueMicrotask(() => this.listeners.replayed.forEach((l) => l()));
  }

  onReplayed(listener: () => void): void {
    this.listeners.replayed.push(listener);
  }

  detach(): void {
    this.listeners = { line: [], exit: [], replayed: [] };
    this.host.releasePipe(this.hosted, this);
  }

  emitLine(line: string, seq: number): void {
    this.ready.push({ line, seq });
    this.flush();
  }

  emitExit(exitCode: number, stderr: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.listeners.exit) listener(exitCode, stderr);
  }

  private flush(): void {
    if (this.listeners.line.length === 0) return;
    const ready = this.ready;
    this.ready = [];
    for (const { line, seq } of ready) {
      if (seq <= this.delivered) continue;
      this.delivered = seq;
      for (const listener of this.listeners.line) listener(line, seq);
    }
  }
}
