// 常駐のホスト。アプリとは別のプロセスで claude を起動して持っておき、アプリを再起動しても止めない。
// アプリが Electron を Node として（ELECTRON_RUN_AS_NODE）切り離して起動する。引数はソケットのパス。
// claude の持ち方は 2 つ。pty（ターミナルモードの TUI。画面を仮想の端末で持つ）と pipe（チャットの stream-json。出力の行を控える）。
// ホストの解釈は、行の控え・未回答の要求・種類ごとの最新に限る（何を最新として残すかはアプリがデータで渡す）。
// Electron の API は使わない
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { PipeBacklog, readLines } from './pipe-backlog';
import {
  PROTOCOL,
  STDERR_TAIL,
  type ClientMessage,
  type HostMessage,
  type HostedInfo,
  type PipeSpawnRequest,
  type PtySpawnRequest,
  type SpawnRequest,
} from './pty-host-protocol';

// 繋ぎ直したときに戻す画面の、さかのぼる行数
const SCROLLBACK = 1000;
// アプリが繋がっておらず、動いているプロセスも無い状態がこれだけ続いたら終わる
const IDLE_EXIT_MS = 10_000;
// 終わるとき、パイプのプロセスが SIGTERM で終わるのを待つ上限（過ぎたら SIGKILL）
const SHUTDOWN_GRACE_MS = 2000;
// プロセスが終わってから、出力を読み終えるのを待つ上限（孫のプロセスが出力のパイプを持ったままのこともある）
const DRAIN_MS = 1000;

type HostedPty = {
  kind: 'pty';
  req: PtySpawnRequest;
  proc: pty.IPty;
  term: Terminal;
  serializer: SerializeAddon;
  startedAt: number;
  exitCode: number | null;
};

type HostedPipe = {
  kind: 'pipe';
  req: PipeSpawnRequest;
  proc: ChildProcess;
  pid: number;
  startedAt: number;
  exitCode: number | null;
  // 出力の行の控え・種類ごとの最新・未回答の要求
  backlog: PipeBacklog;
  ended: boolean;
  stderr: string;
};

type Hosted = HostedPty | HostedPipe;

const socketPath = process.argv[2];
if (!socketPath) {
  console.error('ソケットのパスがありません');
  process.exit(1);
}
process.title = 'tanacode-pty-host';
// 作業フォルダを掴んだままにしない
process.chdir(homedir());

const hosted = new Map<string, Hosted>();
const clients = new Set<Socket>();
let idleTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function broadcast(message: HostMessage): void {
  const line = `${JSON.stringify(message)}\n`;
  for (const socket of clients) socket.write(line);
}

function spawn(req: SpawnRequest): void {
  if (hosted.has(req.id)) return;
  if (req.kind === 'pipe') spawnPipe(req);
  else spawnPty(req);
}

function spawnPty(req: PtySpawnRequest): void {
  const term = new Terminal({ cols: req.cols, rows: req.rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  let proc: pty.IPty;
  try {
    proc = pty.spawn(req.file, req.args, { name: 'xterm-256color', cols: req.cols, rows: req.rows, cwd: req.cwd, env: req.env });
  } catch (error) {
    log(`起動できませんでした: ${req.file} ${String(error)}`);
    term.dispose();
    broadcast({ t: 'exit', id: req.id, exitCode: -1 });
    return;
  }
  const entry: HostedPty = { kind: 'pty', req, proc, term, serializer, startedAt: Date.now(), exitCode: null };
  hosted.set(req.id, entry);
  log(`起動しました（pty）: ${req.tag} pid=${proc.pid}`);
  // 画面に書き込んでからアプリへ送る。こうすると、送った出力はいつも画面（繋ぎ直したときに渡すもの）に入っている
  proc.onData((data) => term.write(data, () => broadcast({ t: 'data', id: req.id, data })));
  proc.onExit(({ exitCode }) => {
    log(`終了しました（pty）: ${req.tag} code=${exitCode}`);
    // 出力を送り終えてから終了を知らせる
    term.write('', () => finished(entry, exitCode));
  });
}

function spawnPipe(req: PipeSpawnRequest): void {
  let proc: ChildProcess;
  try {
    // 自分のプロセスグループで起動する（ホストが止めるときは、裏で動くタスクごとグループで止める。パイプは入力を閉じても、
    // ターンと裏のタスクが終わるまで動き続けるため）
    proc = spawnChild(req.file, req.args, { cwd: req.cwd, env: req.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  } catch (error) {
    log(`起動できませんでした: ${req.file} ${String(error)}`);
    broadcast({ t: 'exit', id: req.id, exitCode: -1, stderr: String(error) });
    return;
  }
  const entry: HostedPipe = {
    kind: 'pipe',
    req,
    proc,
    pid: proc.pid ?? -1,
    startedAt: Date.now(),
    exitCode: null,
    backlog: new PipeBacklog(req.retain, req.transient),
    ended: false,
    stderr: '',
  };
  hosted.set(req.id, entry);
  log(`起動しました（pipe）: ${req.tag} pid=${entry.pid}`);
  if (proc.stdout) readLines(proc.stdout, (line) => receiveLine(entry, line), (bytes) => log(`長すぎる行を捨てました: ${req.tag} ${bytes} 文字`));
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    entry.stderr = (entry.stderr + chunk).slice(-STDERR_TAIL);
  });
  // 入力の書き込みの失敗（claude が先に終わった）は、終了の知らせで分かる
  proc.stdin?.on('error', () => {});
  let exited = false;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    const exitCode = code ?? (signal ? 128 : -1);
    log(`終了しました（pipe）: ${req.tag} code=${code} signal=${signal}`);
    // 出力を読み終えてから終了を知らせる（読み終えなくても、待ちすぎない）
    const stdout = proc.stdout;
    if (!stdout || stdout.readableEnded) {
      finished(entry, exitCode);
      return;
    }
    const timer = setTimeout(() => finished(entry, exitCode), DRAIN_MS);
    stdout.once('end', () => {
      clearTimeout(timer);
      finished(entry, exitCode);
    });
  };
  proc.on('exit', onExit);
  proc.on('error', (error) => {
    log(`起動できませんでした: ${req.file} ${String(error)}`);
    entry.stderr = (entry.stderr + String(error)).slice(-STDERR_TAIL);
    onExit(-1, null);
  });
}

// 読めない行もアプリへ送る（数えてログに残すのはアプリ）。控えには入れない
function receiveLine(entry: HostedPipe, line: string): void {
  const seq = entry.backlog.receive(line);
  broadcast({ t: 'line', id: entry.req.id, seq, line });
}

// アプリが入力に書いた行
function sendLine(entry: HostedPipe, line: string): void {
  if (entry.exitCode !== null || entry.ended) return;
  entry.backlog.sent(line);
  entry.proc.stdin?.write(`${line}\n`);
}

// 控えている行を送り直す。送り直す行には印を付け、最後に送り終えたことを知らせる（アプリは、その間に届いた新しい行を待たせて、順番を保つ）
function replay(entry: HostedPipe, socket: Socket, from: number): void {
  const write = (m: HostMessage) => socket.write(`${JSON.stringify(m)}\n`);
  for (const item of entry.backlog.since(from)) write({ t: 'line', id: entry.req.id, seq: item.seq, line: item.line, replay: true });
  write({ t: 'replayed', id: entry.req.id });
}

function finished(entry: Hosted, exitCode: number): void {
  if (entry.exitCode !== null) return;
  entry.exitCode = exitCode;
  if (entry.kind === 'pipe') {
    entry.backlog.exited();
    broadcast({ t: 'exit', id: entry.req.id, exitCode, stderr: entry.stderr });
  } else {
    broadcast({ t: 'exit', id: entry.req.id, exitCode });
  }
  // アプリが見ていなければ、繋ぎ直したときに知らせるまで残す（forget で捨てる）
  if (clients.size > 0) drop(entry.req.id);
  checkIdle();
}

function drop(id: string): void {
  const entry = hosted.get(id);
  if (!entry) return;
  if (entry.kind === 'pty') entry.term.dispose();
  hosted.delete(id);
}

function info(entry: Hosted): HostedInfo {
  const base = { id: entry.req.id, tag: entry.req.tag, startedAt: entry.startedAt, exitCode: entry.exitCode };
  if (entry.kind === 'pty') {
    return { ...base, kind: 'pty', pid: entry.proc.pid, cols: entry.term.cols, rows: entry.term.rows, screen: entry.serializer.serialize() };
  }
  return {
    ...base,
    kind: 'pipe',
    pid: entry.pid,
    lastSeq: entry.backlog.lastSeq,
    firstSeq: entry.backlog.firstSeq,
    retained: entry.backlog.retained(),
    pending: entry.backlog.pending(),
    ended: entry.ended,
    stderr: entry.stderr,
  };
}

// プロセスを止める。パイプはプロセスグループごと（裏で動くタスクも一緒に止める）
function kill(entry: Hosted, signal?: 'SIGTERM' | 'SIGKILL'): void {
  if (entry.exitCode !== null) return;
  if (entry.kind === 'pty') {
    entry.proc.kill(signal);
    return;
  }
  try {
    process.kill(-entry.pid, signal ?? 'SIGTERM');
  } catch {
    // もう終わっている（グループが無い）
    try {
      entry.proc.kill(signal ?? 'SIGTERM');
    } catch {}
  }
}

function handle(socket: Socket, message: ClientMessage): void {
  const reply = (m: HostMessage) => socket.write(`${JSON.stringify(m)}\n`);
  switch (message.t) {
    case 'hello':
      reply({ t: 'hello', protocol: PROTOCOL, pid: process.pid });
      // 出力を送るのは hello のあとから（アプリが最初に読む行を hello の返事にする）
      if (message.protocol === PROTOCOL) clients.add(socket);
      checkIdle();
      return;
    case 'spawn':
      if (!shuttingDown) spawn(message);
      return;
    case 'write': {
      const entry = hosted.get(message.id);
      if (entry?.kind === 'pty') entry.proc.write(message.data);
      return;
    }
    case 'resize': {
      const entry = hosted.get(message.id);
      if (entry?.kind !== 'pty' || entry.exitCode !== null) return;
      entry.proc.resize(message.cols, message.rows);
      entry.term.resize(message.cols, message.rows);
      return;
    }
    case 'send': {
      const entry = hosted.get(message.id);
      if (entry?.kind === 'pipe') sendLine(entry, message.line);
      return;
    }
    case 'end': {
      const entry = hosted.get(message.id);
      if (entry?.kind !== 'pipe' || entry.ended) return;
      entry.ended = true;
      entry.proc.stdin?.end();
      return;
    }
    case 'replay': {
      const entry = hosted.get(message.id);
      if (entry?.kind === 'pipe') replay(entry, socket, message.from);
      return;
    }
    case 'kill': {
      const entry = hosted.get(message.id);
      if (entry) kill(entry, message.signal);
      return;
    }
    case 'forget':
      if (hosted.get(message.id)?.exitCode !== null) drop(message.id);
      return;
    case 'list':
      reply({ t: 'list', req: message.req, hosted: [...hosted.values()].map(info) });
      return;
    case 'shutdown':
      log('終わるよう指示されました');
      shutdown();
      return;
  }
}

function alive(): Hosted[] {
  return [...hosted.values()].filter((h) => h.exitCode === null);
}

function checkIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (clients.size > 0 || alive().length > 0 || shuttingDown) return;
  idleTimer = setTimeout(() => {
    log('アプリも claude も無いので終わります');
    shutdown();
  }, IDLE_EXIT_MS);
}

// すべてのプロセスを止めて終わる。パイプのプロセスは SIGTERM で終わるのを少し待ち、残れば SIGKILL（プロセスグループごと）
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const entry of alive()) kill(entry);
  server.close();
  removeSocket();
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  const wait = () => {
    const pipes = alive().filter((h) => h.kind === 'pipe');
    if (pipes.length > 0 && Date.now() < deadline) {
      setTimeout(wait, 50);
      return;
    }
    for (const entry of pipes) kill(entry, 'SIGKILL');
    // 子プロセスへ合図が届くのを少し待つ
    setTimeout(() => process.exit(0), 200);
  };
  wait();
}

function removeSocket(): void {
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    // すでに無い
  }
}

const server = createServer((socket) => {
  socket.setEncoding('utf8');
  let buffered = '';
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try {
        handle(socket, JSON.parse(line) as ClientMessage);
      } catch (error) {
        log(`読めない要求: ${String(error)}`);
      }
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    clients.delete(socket);
    checkIdle();
  });
});

removeSocket();
server.listen(socketPath, () => {
  // 自分だけがつなげるようにする（つながれば、任意のコマンドを起動できるため。アプリ内ブラウザなどの中継のソケットと同じ）
  chmodSync(socketPath, 0o600);
  log(`待ち受けています: ${socketPath} pid=${process.pid}`);
  checkIdle();
});
server.on('error', (error) => {
  log(`待ち受けられません: ${String(error)}`);
  process.exit(1);
});
// アプリと一緒に止まらないよう、端末の切断の合図は無視する
process.on('SIGHUP', () => {});
