import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL, type ClientMessage, type HostMessage, type HostedPtyInfo } from '../src/main/pty-host-protocol';

// pty ホスト（src/main/pty-host.ts）のやりとりを、テストのプロセスの中で動かして確かめる（カバレッジを測れるように）。
// ホストはファイルを読み込むと待ち受けを始める（引数はソケットのパス）。終わるとき（process.exit）と作業フォルダの移動（process.chdir）は差し替える。
// claude の代わりに /bin/sh を起動する。別のプロセスとして起動したときの振る舞い（引き継ぎ・ホストが落ちたとき）は test/pty-host.test.ts

// 起動できないものを起動しようとしたとき（node-pty が例外を投げる）を作れるようにする
vi.mock('node-pty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-pty')>();
  return {
    ...actual,
    spawn: (file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file === '/nonexistent/claude') throw new Error('posix_spawnp failed');
      return actual.spawn(file, args, options);
    },
  };
});

let dir: string;
const exits: number[] = [];
const logs: string[] = [];
const sockets: Socket[] = [];
const originalArgv = [...process.argv];
const originalTitle = process.title;
const chdirs: string[] = [];

beforeAll(() => {
  // ホストが終わろうとしても、テストのプロセスは終わらせない（終わったことだけ控える）
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    if (code === 1 && process.argv[2] === undefined) throw new Error('exit 1');
  }) as typeof process.exit);
  vi.spyOn(process, 'chdir').mockImplementation((to: string) => {
    chdirs.push(to);
  });
  vi.spyOn(console, 'log').mockImplementation((message: string) => {
    logs.push(message);
  });
  vi.spyOn(console, 'error').mockImplementation((message: string) => {
    logs.push(message);
  });
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-pty-server-'));
  exits.length = 0;
  logs.length = 0;
});
afterEach(async () => {
  vi.useRealTimers();
  for (const s of sockets.splice(0)) s.destroy();
  await sleep(50);
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  process.title = originalTitle;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(label: string, check: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`${label}: 時間切れ`);
    await sleep(20);
  }
}

// ホストを（新しく）読み込んで、待ち受けを始めるまで待つ
async function startHost(socketPath = join(dir, 'host.sock')): Promise<string> {
  vi.resetModules();
  process.argv[2] = socketPath;
  await import('../src/main/pty-host');
  process.title = originalTitle;
  await waitFor('待ち受け', () => logs.some((l) => l.includes(`待ち受けています: ${socketPath}`)));
  return socketPath;
}

type Client = { send: (m: ClientMessage | string) => void; received: () => HostMessage[]; closed: () => boolean; socket: Socket };
async function client(path: string, protocol = PROTOCOL): Promise<Client> {
  const socket = connect(path);
  sockets.push(socket);
  socket.setEncoding('utf8');
  let text = '';
  let closed = false;
  socket.on('data', (chunk: string) => (text += chunk));
  socket.on('close', () => (closed = true));
  socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const c: Client = {
    send: (m) => socket.write(typeof m === 'string' ? m : `${JSON.stringify(m)}\n`),
    received: () =>
      text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as HostMessage),
    closed: () => closed,
    socket,
  };
  c.send({ t: 'hello', protocol });
  await waitFor('hello', () => c.received().some((m) => m.t === 'hello'));
  return c;
}

const sh = (id: string, command?: string) =>
  ({
    t: 'spawn',
    id,
    tag: `tag-${id}`,
    file: '/bin/sh',
    args: command ? ['-c', command] : [],
    cwd: dir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, PS1: '$ ', TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
  }) satisfies ClientMessage;

const output = (c: Client, id: string) =>
  c
    .received()
    .flatMap((m) => (m.t === 'data' && m.id === id ? [m.data] : []))
    .join('');
const exitOf = (c: Client, id: string) => c.received().find((m): m is Extract<HostMessage, { t: 'exit' }> => m.t === 'exit' && m.id === id)?.exitCode;
async function list(c: Client, req: number): Promise<HostedPtyInfo[]> {
  c.send({ t: 'list', req });
  const reply = await waitFor('一覧', () => c.received().find((m): m is Extract<HostMessage, { t: 'list' }> => m.t === 'list' && m.req === req));
  return reply.ptys;
}
async function shutdown(path: string): Promise<void> {
  const c = await client(path);
  c.send({ t: 'shutdown' });
  await waitFor('終わり', () => exits.includes(0));
}

describe('pty ホスト（テストのプロセスの中で動かす）', () => {
  it('起動したら、作業フォルダを掴まないようホームに移り、自分だけが読み書きできるソケットで待ち受ける', async () => {
    const path = await startHost();
    expect(chdirs.at(-1)).toBe(homedir());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const c = await client(path);
    expect(c.received()[0]).toEqual({ t: 'hello', protocol: PROTOCOL, pid: process.pid });
    await shutdown(path);
    expect(existsSync(path)).toBe(false);
  });

  it('起動した pty の出力を届け、打った文字・大きさを伝え、終了コードを知らせる', async () => {
    const path = await startHost();
    const c = await client(path);
    c.send(sh('p1'));
    // 同じ ID の起動は、2 度目を無視する
    c.send(sh('p1', 'exit 9'));
    await waitFor('プロンプト', () => output(c, 'p1').includes('$ '));
    c.send({ t: 'resize', id: 'p1', cols: 100, rows: 30 });
    await sleep(100);
    c.send({ t: 'write', id: 'p1', data: 'stty size; exit 4\r' });
    await waitFor('大きさ', () => output(c, 'p1').includes('30 100'));
    expect(await waitFor('終了', () => exitOf(c, 'p1') !== undefined && String(exitOf(c, 'p1')))).toBe('4');
    // アプリが見ているので、終わった pty はすぐ捨てる
    expect(await list(c, 1)).toEqual([]);
    // 終わった・知らない pty への頼みは無視する
    c.send({ t: 'write', id: 'p1', data: 'x' });
    c.send({ t: 'resize', id: 'p1', cols: 10, rows: 10 });
    c.send({ t: 'kill', id: 'p1' });
    await shutdown(path);
  });

  it('アプリが見ていない間に終わった pty は、終了コードと画面を持ったまま一覧に残し、forget で捨てる。動いている pty は forget で捨てない', async () => {
    const path = await startHost();
    const first = await client(path);
    first.send(sh('done', 'echo bye; sleep 0.3; exit 5'));
    first.send(sh('alive'));
    await waitFor('出力', () => output(first, 'done').includes('bye') && output(first, 'alive').includes('$ '));
    // アプリを閉じた（接続が切れた）
    first.socket.destroy();
    await sleep(800);
    const second = await client(path);
    const listed = await list(second, 1);
    expect(listed.map((p) => [p.id, p.tag, p.exitCode])).toEqual([
      ['done', 'tag-done', 5],
      ['alive', 'tag-alive', null],
    ]);
    expect(listed[0].screen).toContain('bye');
    expect(listed[1]).toMatchObject({ cols: 80, rows: 24 });
    second.send({ t: 'forget', id: 'done' });
    second.send({ t: 'forget', id: 'alive' });
    second.send({ t: 'forget', id: 'unknown' });
    expect((await list(second, 2)).map((p) => p.id)).toEqual(['alive']);
    // 終わるときは、動いている pty を止める
    second.send({ t: 'shutdown' });
    await waitFor('終わり', () => exits.includes(0));
    expect(logs.some((l) => l.includes('終了しました: tag-alive'))).toBe(true);
  });

  it('形（PROTOCOL）の違うアプリには hello だけ答え、出力は送らない', async () => {
    const path = await startHost();
    const app = await client(path);
    const old = await client(path, PROTOCOL - 1);
    app.send(sh('p1', 'echo hi'));
    await waitFor('出力', () => output(app, 'p1').includes('hi'));
    await sleep(100);
    expect(old.received().map((m) => m.t)).toEqual(['hello']);
    await shutdown(path);
  });

  it('起動できなければ、終了コード -1 を知らせる', async () => {
    const path = await startHost();
    const c = await client(path);
    c.send({ ...sh('bad'), file: '/nonexistent/claude' });
    expect(await waitFor('終了', () => exitOf(c, 'bad') !== undefined && String(exitOf(c, 'bad')))).toBe('-1');
    expect(logs.some((l) => l.includes('起動できませんでした: /nonexistent/claude'))).toBe(true);
    expect(await list(c, 1)).toEqual([]);
    await shutdown(path);
  });

  it('読めない要求は記録して飛ばし、続きの要求には答える。空の行も飛ばす', async () => {
    const path = await startHost();
    const c = await client(path);
    c.send('{壊れた\n\n');
    expect(await list(c, 7)).toEqual([]);
    expect(logs.some((l) => l.includes('読めない要求'))).toBe(true);
    await shutdown(path);
  });

  it('アプリも claude も無い状態が 10 秒続いたら、終わる', async () => {
    const path = await startHost();
    const c = await client(path);
    // ホストの待ち時間（setTimeout）だけを進める。待つのは setImmediate で
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tick = () => new Promise((r) => setImmediate(r));
    c.socket.destroy();
    for (let i = 0; i < 500 && !c.closed(); i++) await tick();
    for (let i = 0; i < 20; i++) await tick();
    vi.advanceTimersByTime(9_999);
    expect(exits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(logs.some((l) => l.includes('アプリも claude も無いので終わります'))).toBe(true);
    expect(existsSync(path)).toBe(false);
    vi.advanceTimersByTime(200);
    expect(exits).toEqual([0]);
  });

  it('待ち受けられなければ、理由を記録して終わる（1）', async () => {
    vi.resetModules();
    process.argv[2] = join(dir, 'none', 'host.sock');
    await import('../src/main/pty-host');
    await waitFor('終わり', () => exits.includes(1));
    expect(logs.some((l) => l.includes('待ち受けられません'))).toBe(true);
  });

  it('ソケットのパスが無ければ、起動せずに終わる（1）', async () => {
    vi.resetModules();
    process.argv.splice(2);
    await expect(import('../src/main/pty-host')).rejects.toThrow('exit 1');
    expect(exits).toEqual([1]);
    expect(logs).toContain('ソケットのパスがありません');
  });
});
