import { randomUUID } from 'node:crypto';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';
import * as pty from 'node-pty';
import type { ScreenLine } from '@shared/screen';
import type { PtyHandle, PtyHostApi } from '../../src/main/pty-host-client';
import type { HostedPtyInfo, SpawnRequest } from '../../src/main/pty-host-protocol';

// 引き継いだときに戻す画面の、さかのぼる行数（pty-host.ts と同じ）
const SCROLLBACK = 1000;

type Hosted = {
  info: Omit<HostedPtyInfo, 'screen' | 'exitCode' | 'cols' | 'rows'>;
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

// pty ホスト（src/main/pty-host.ts と pty-host-client.ts の PtyHost）の代わり。常駐プロセスを起動せず、node-pty を直に使う。
// やりとりの形（spawn・attach・list・forget、受け手がいない間の出力を溜める、引き継ぎの画面と起動時刻）は PtyHost と同じにする。
// 起動するのは、アプリが頼む 'claude' ではなく確かめる claude（file）。環境変数は env に、
// アプリが渡す statusLine・AskUserQuestion のファイルの変数と、アプリ内ブラウザの JavaScript の実行の確認のフックの変数（passEnv）だけを足す（ふだんの環境を持ち込まない）
export class FakePtyHost implements PtyHostApi {
  // ホストが持っている pty（list に出るもの）
  private readonly ptys = new Map<string, Hosted>();
  // これまでに起動したすべて。終わったあとも画面を読めるよう、dispose まで残す
  private readonly all: Hosted[] = [];

  constructor(
    private readonly file: string,
    private readonly env: Record<string, string>,
    private readonly passEnv: string[],
  ) {}

  list(): Promise<HostedPtyInfo[]> {
    const infos: HostedPtyInfo[] = [];
    for (const hosted of this.ptys.values()) {
      // 一覧の画面より後の出力を捨てないよう、ここで受け皿を作っておく（PtyHost の receive と同じ）
      if (hosted.exitCode === null && !hosted.handle) hosted.handle = new FakeHandle(hosted, this);
      infos.push({
        ...hosted.info,
        cols: hosted.term.cols,
        rows: hosted.term.rows,
        exitCode: hosted.exitCode,
        screen: hosted.serializer.serialize(),
      });
    }
    return Promise.resolve(infos);
  }

  spawn(request: Omit<SpawnRequest, 'id'>): PtyHandle {
    const id = randomUUID();
    const env = { ...this.env };
    for (const name of this.passEnv) if (request.env[name] !== undefined) env[name] = request.env[name];
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

  attach(info: HostedPtyInfo): PtyHandle {
    const hosted = this.ptys.get(info.id);
    if (!hosted) throw new Error(`知らない pty です: ${info.id}`);
    hosted.handle ??= new FakeHandle(hosted, this);
    return hosted.handle;
  }

  forget(id: string): void {
    if (this.ptys.get(id)?.exitCode !== null) this.ptys.delete(id);
  }

  // tag（アプリのセッション ID）の claude を止め、終わったことをすぐ知らせる（claude が自分で終わったのと同じ）。
  // pty が実際に終わるのは少し後なので、その知らせは捨てる
  terminate(tag: string): void {
    for (const hosted of this.ptys.values()) {
      if (hosted.info.tag !== tag || hosted.exitCode !== null) continue;
      hosted.proc.kill();
      this.exited(hosted, 0);
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

  // 今動いている tag の claude に、アプリを通さずに打つ（アプリが止まっている間の操作）
  write(tag: string, data: string): void {
    for (const hosted of this.ptys.values()) if (hosted.info.tag === tag && hosted.exitCode === null) hosted.proc.write(data);
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
    const gone = Promise.all(this.all.map((hosted) => hosted.gone)).then(() => undefined);
    return Promise.race([gone, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  release(hosted: Hosted, handle: FakeHandle): void {
    if (hosted.handle === handle) hosted.handle = null;
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

  kill(): void {
    if (this.hosted.exitCode === null) this.hosted.proc.kill();
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
