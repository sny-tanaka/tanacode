// pty ホスト。アプリとは別の常駐プロセスで claude を起動して持っておき、アプリを再起動しても止めない。
// アプリが Electron を Node として（ELECTRON_RUN_AS_NODE）切り離して起動する。引数はソケットのパス。
// Electron の API は使わない
import { existsSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { PROTOCOL, type ClientMessage, type HostMessage, type HostedPtyInfo, type SpawnRequest } from './pty-host-protocol';

// 繋ぎ直したときに戻す画面の、さかのぼる行数
const SCROLLBACK = 1000;
// アプリが繋がっておらず、動いている pty も無い状態がこれだけ続いたら終わる
const IDLE_EXIT_MS = 10_000;

type Hosted = {
  req: SpawnRequest;
  proc: pty.IPty;
  term: Terminal;
  serializer: SerializeAddon;
  startedAt: number;
  exitCode: number | null;
};

const socketPath = process.argv[2];
if (!socketPath) {
  console.error('ソケットのパスがありません');
  process.exit(1);
}
process.title = 'tanacode-pty-host';
// 作業フォルダを掴んだままにしない
process.chdir(homedir());

const ptys = new Map<string, Hosted>();
const clients = new Set<Socket>();
let idleTimer: NodeJS.Timeout | null = null;

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function broadcast(message: HostMessage): void {
  const line = `${JSON.stringify(message)}\n`;
  for (const socket of clients) socket.write(line);
}

function spawn(req: SpawnRequest): void {
  if (ptys.has(req.id)) return;
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
  const hosted: Hosted = { req, proc, term, serializer, startedAt: Date.now(), exitCode: null };
  ptys.set(req.id, hosted);
  log(`起動しました: ${req.tag} pid=${proc.pid}`);
  // 画面に書き込んでからアプリへ送る。こうすると、送った出力はいつも画面（繋ぎ直したときに渡すもの）に入っている
  proc.onData((data) => term.write(data, () => broadcast({ t: 'data', id: req.id, data })));
  proc.onExit(({ exitCode }) => {
    log(`終了しました: ${req.tag} code=${exitCode}`);
    // 出力を送り終えてから終了を知らせる
    term.write('', () => {
      hosted.exitCode = exitCode;
      broadcast({ t: 'exit', id: req.id, exitCode });
      // アプリが見ていなければ、繋ぎ直したときに知らせるまで残す（forget で捨てる）
      if (clients.size > 0) drop(req.id);
      checkIdle();
    });
  });
}

function drop(id: string): void {
  const hosted = ptys.get(id);
  if (!hosted) return;
  hosted.term.dispose();
  ptys.delete(id);
}

function info(hosted: Hosted): HostedPtyInfo {
  return {
    id: hosted.req.id,
    tag: hosted.req.tag,
    pid: hosted.proc.pid,
    startedAt: hosted.startedAt,
    cols: hosted.term.cols,
    rows: hosted.term.rows,
    exitCode: hosted.exitCode,
    screen: hosted.serializer.serialize(),
  };
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
      spawn(message);
      return;
    case 'write':
      ptys.get(message.id)?.proc.write(message.data);
      return;
    case 'resize': {
      const hosted = ptys.get(message.id);
      if (!hosted || hosted.exitCode !== null) return;
      hosted.proc.resize(message.cols, message.rows);
      hosted.term.resize(message.cols, message.rows);
      return;
    }
    case 'kill':
      ptys.get(message.id)?.proc.kill();
      return;
    case 'forget':
      if (ptys.get(message.id)?.exitCode !== null) drop(message.id);
      return;
    case 'list':
      reply({ t: 'list', req: message.req, ptys: [...ptys.values()].map(info) });
      return;
    case 'shutdown':
      log('終わるよう指示されました');
      shutdown();
      return;
  }
}

function checkIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const alive = [...ptys.values()].some((h) => h.exitCode === null);
  if (clients.size > 0 || alive) return;
  idleTimer = setTimeout(() => {
    log('アプリも claude も無いので終わります');
    shutdown();
  }, IDLE_EXIT_MS);
}

function shutdown(): void {
  for (const hosted of ptys.values()) if (hosted.exitCode === null) hosted.proc.kill();
  server.close();
  removeSocket();
  // 子プロセスへ合図が届くのを少し待つ
  setTimeout(() => process.exit(0), 200);
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
  log(`待ち受けています: ${socketPath} pid=${process.pid}`);
  checkIdle();
});
server.on('error', (error) => {
  log(`待ち受けられません: ${String(error)}`);
  process.exit(1);
});
// アプリと一緒に止まらないよう、端末の切断の合図は無視する
process.on('SIGHUP', () => {});
