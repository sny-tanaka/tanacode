import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL, type ClientMessage, type HostMessage, type HostedInfo, type HostedPipeInfo } from '../src/main/pty-host-protocol';

// pty ホスト（src/main/pty-host.ts）のやりとりを、テストのプロセスの中で動かして確かめる（カバレッジを測れるように）。
// ホストはファイルを読み込むと待ち受けを始める（引数はソケットのパス）。終わるとき（process.exit）と作業フォルダの移動（process.chdir）は差し替える。
// claude の代わりに /bin/sh を起動する（パイプのプロセスは、入力の行をそのまま出力に返す cat）。別のプロセスとして起動したときの振る舞い（引き継ぎ・ホストが落ちたとき）は test/pty-host.test.ts

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

// 長すぎる行を捨てるところを、小さな行で確かめられるようにする（本物は 32MB）
vi.mock('../src/main/pty-host-protocol', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/main/pty-host-protocol')>()), MAX_LINE_BYTES: 4096 }));

let dir: string;
const exits: number[] = [];
const logs: string[] = [];
const sockets: Socket[] = [];
const originalArgv = [...process.argv];
const originalTitle = process.title;
const chdirs: string[] = [];
// ホストが読み込まれるたびに足す、プロセスの合図・失敗の受け手（テストごとに外す）
const PROCESS_EVENTS = ['SIGHUP', 'SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
const baseListeners = new Map<string, ((...args: unknown[]) => void)[]>();

beforeAll(() => {
  for (const event of PROCESS_EVENTS) baseListeners.set(event, process.listeners(event as NodeJS.Signals) as ((...args: unknown[]) => void)[]);
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
  for (const event of PROCESS_EVENTS) {
    const base = baseListeners.get(event) ?? [];
    for (const listener of process.listeners(event as NodeJS.Signals)) if (!base.includes(listener as (...args: unknown[]) => void)) process.off(event, listener);
  }
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
    kind: 'pty',
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
async function list(c: Client, req: number): Promise<HostedInfo[]> {
  c.send({ t: 'list', req });
  const reply = await waitFor('一覧', () => c.received().find((m): m is Extract<HostMessage, { t: 'list' }> => m.t === 'list' && m.req === req));
  return reply.hosted;
}

// アプリとして数えない接続（hello の形を違えたもの）で一覧を見て、条件を満たすまで待つ。
// アプリが見ていない間の振る舞い（終わったプロセスの記録を残す）を変えずに、決まった時間でなく、終わったのを見て進む
async function untilListed(path: string, check: (hosted: HostedInfo[]) => boolean): Promise<void> {
  const peek = await client(path, 0);
  for (let req = 1000; ; req++) {
    if (check(await list(peek, req))) break;
    if (req > 1250) throw new Error('一覧: 時間切れ');
    await sleep(20);
  }
  peek.socket.destroy();
}

// パイプでつながるプロセス。入力の行をそのまま出力に返す（cat）。first: はじめに出す行
const pipe = (id: string, first: string[] = [], command = 'exec cat') =>
  ({
    t: 'spawn',
    kind: 'pipe',
    id,
    tag: `tag-${id}`,
    file: '/bin/sh',
    args: ['-c', `${first.map((l) => `printf '%s\\n' '${l}'`).join('; ')}${first.length ? '; ' : ''}${command}`],
    cwd: dir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    retain: [
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'task_started', key: 'task_id', until: [{ type: 'system', subtype: 'task_notification', key: 'task_id' }] },
    ],
    transient: [{ type: 'stream_event' }],
  }) satisfies ClientMessage;
const linesOf = (c: Client, id: string, replay = false) =>
  c.received().flatMap((m) => (m.t === 'line' && m.id === id && (m.replay === true) === replay ? [`${m.seq}:${m.line}`] : []));
const stderrOf = (c: Client, id: string) => c.received().find((m): m is Extract<HostMessage, { t: 'exit' }> => m.t === 'exit' && m.id === id)?.stderr;
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
    await untilListed(path, (hosted) => typeof hosted.find((p) => p.id === 'done')?.exitCode === 'number');
    const second = await client(path);
    const listed = await list(second, 1);
    expect(listed.map((p) => [p.id, p.tag, p.exitCode, p.kind])).toEqual([
      ['done', 'tag-done', 5, 'pty'],
      ['alive', 'tag-alive', null, 'pty'],
    ]);
    expect(listed[0]).toMatchObject({ screen: expect.stringContaining('bye') });
    expect(listed[1]).toMatchObject({ cols: 80, rows: 24 });
    second.send({ t: 'forget', id: 'done' });
    second.send({ t: 'forget', id: 'alive' });
    second.send({ t: 'forget', id: 'unknown' });
    expect((await list(second, 2)).map((p) => p.id)).toEqual(['alive']);
    // 終わるときは、動いている pty を止める
    second.send({ t: 'shutdown' });
    await waitFor('終わり', () => exits.includes(0));
    expect(logs.some((l) => l.includes('終了しました（pty）: tag-alive'))).toBe(true);
  });

  it('パイプのプロセス: 出力の行に通し番号を付けて届け、入力の行を渡し、入力を閉じると終わる。終わりには標準エラーの末尾を添える', async () => {
    const path = await startHost();
    const c = await client(path);
    c.send(pipe('q1', ['{"type":"system","subtype":"init","session_id":"s1"}'], 'echo 失敗の理由 >&2; exec cat'));
    // 同じ ID の起動は、2 度目を無視する
    c.send(pipe('q1', [], 'exit 9'));
    await waitFor('最初の行', () => linesOf(c, 'q1').length === 1);
    c.send({ t: 'send', id: 'q1', line: '{"type":"user","n":1}' });
    c.send({ t: 'send', id: 'q1', line: '{壊れた' });
    await waitFor('返った行', () => linesOf(c, 'q1').length === 3);
    expect(linesOf(c, 'q1')).toEqual(['1:{"type":"system","subtype":"init","session_id":"s1"}', '2:{"type":"user","n":1}', '3:{壊れた']);
    c.send({ t: 'end', id: 'q1' });
    c.send({ t: 'end', id: 'q1' });
    expect(await waitFor('終了', () => exitOf(c, 'q1') !== undefined && String(exitOf(c, 'q1')))).toBe('0');
    expect(stderrOf(c, 'q1')).toContain('失敗の理由');
    // 終わった・知らないプロセスへの頼みは無視する
    c.send({ t: 'send', id: 'q1', line: 'x' });
    c.send({ t: 'send', id: 'none', line: 'x' });
    c.send({ t: 'end', id: 'none' });
    c.send({ t: 'replay', id: 'none', from: 1 });
    expect(await list(c, 1)).toEqual([]);
    await shutdown(path);
  });

  it('パイプのプロセスの控え: 書いている途中の行は控えない・種類ごとの最新を残す・答えの無い要求を控える。送り直しは印を付けて送り、終わりを知らせる', async () => {
    const path = await startHost();
    const first = await client(path);
    first.send(pipe('q2'));
    const send = (value: unknown) => first.send({ t: 'send', id: 'q2', line: JSON.stringify(value) });
    // claude が出す行の代わりに、入力に書いた行がそのまま返る
    send({ type: 'system', subtype: 'init', session_id: 'a' });
    send({ type: 'stream_event', event: { type: 'message_start' } });
    send({ type: 'system', subtype: 'task_started', task_id: 't1' });
    send({ type: 'system', subtype: 'task_started', task_id: 't2' });
    send({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool' } });
    send({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool' } });
    send({ type: 'control_request', request_id: 'r3', request: { subtype: 'can_use_tool' } });
    send({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' });
    send({ type: 'system', subtype: 'init', session_id: 'b' });
    // claude が要求を出してから答える（入力に書いた行が出力に返ってから）
    await waitFor('要求', () => linesOf(first, 'q2').length === 9);
    // r1 はアプリが答え、r2 は claude が取り下げた（どちらも控えから外す）
    send({ type: 'control_response', response: { subtype: 'success', request_id: 'r1' } });
    send({ type: 'control_cancel_request', request_id: 'r2' });
    await waitFor('出力', () => linesOf(first, 'q2').length === 11);
    // アプリを閉じて、起動し直したアプリが引き継ぐ
    first.socket.destroy();
    await sleep(100);
    const second = await client(path);
    const [info] = (await list(second, 1)) as HostedPipeInfo[];
    expect(info).toMatchObject({ kind: 'pipe', id: 'q2', exitCode: null, lastSeq: 11, firstSeq: 1, ended: false });
    expect(info.retained.map((l) => l.seq)).toEqual([4, 9]);
    expect(info.pending.map((l) => JSON.parse(l.line).request_id)).toEqual(['r3']);
    second.send({ t: 'replay', id: 'q2', from: 8 });
    await waitFor('送り直し', () => second.received().some((m) => m.t === 'replayed' && m.id === 'q2'));
    // 書いている途中の行（2 番）は控えていない。8 番から
    expect(linesOf(second, 'q2', true).map((l) => l.split(':')[0])).toEqual(['8', '9', '10', '11']);
    second.send({ t: 'replay', id: 'q2', from: 1 });
    await waitFor('全部', () => linesOf(second, 'q2', true).length === 4 + 10);
    expect(linesOf(second, 'q2', true).slice(4).map((l) => l.split(':')[0])).not.toContain('2');
    // 止めると、プロセスグループごと SIGTERM で止める
    second.send({ t: 'kill', id: 'q2' });
    expect(await waitFor('終了', () => exitOf(second, 'q2') !== undefined && String(exitOf(second, 'q2')))).toBe('128');
    await shutdown(path);
  });

  it('もう記録を捨てたプロセスへの replay には、終わったことを返す（引き継いだアプリが待ち続けないように）', async () => {
    const path = await startHost();
    const c = await client(path);
    c.send({ t: 'replay', id: 'gone', from: 1 });
    expect(await waitFor('終わり', () => exitOf(c, 'gone') !== undefined && String(exitOf(c, 'gone')))).toBe('-1');
    await shutdown(path);
  });

  it('長すぎて捨てた行が、答えを待つ要求だったら、ホストが error で答える（アプリには届かないので、claude が待ち続けないように）', async () => {
    const path = await startHost();
    const c = await client(path);
    const long = JSON.stringify({ type: 'control_request', request_id: 'big1', request: { subtype: 'can_use_tool', input: { content: 'x'.repeat(5000) } } });
    const other = JSON.stringify({ type: 'assistant', text: 'y'.repeat(5000) });
    // cat は、ホストが入力に書いた答えを、そのまま出力に返す
    c.send(pipe('q5', [long, other]));
    await waitFor('答え', () => linesOf(c, 'q5').length === 1);
    const [answer] = linesOf(c, 'q5');
    expect(JSON.parse(answer.slice(answer.indexOf(':') + 1))).toEqual({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'big1', error: 'tanacode could not read this request because it is too long.' },
    });
    expect(logs.filter((l) => l.includes('長すぎる行を捨てました: tag-q5'))).toHaveLength(2);
    await shutdown(path);
  });

  it('アプリが見ていない間に終わったパイプのプロセスは、終了コードを持ったまま一覧に残る。終わったプロセスの要求は控えから外す', async () => {
    const path = await startHost();
    const first = await client(path);
    first.send(pipe('q3', ['{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool"}}'], 'sleep 0.3; exit 4'));
    await waitFor('出力', () => linesOf(first, 'q3').length === 1);
    first.socket.destroy();
    await untilListed(path, (hosted) => typeof hosted.find((p) => p.id === 'q3')?.exitCode === 'number');
    const second = await client(path);
    const listed = (await list(second, 1)) as HostedPipeInfo[];
    expect(listed).toMatchObject([{ id: 'q3', exitCode: 4, pending: [] }]);
    second.send({ t: 'forget', id: 'q3' });
    expect(await list(second, 2)).toEqual([]);
    await shutdown(path);
  });

  it('終わるときは、SIGTERM で終わらないパイプのプロセスを、少し待ってから SIGKILL で止める', async () => {
    const path = await startHost();
    const c = await client(path);
    c.send(pipe('stubborn', [], "trap '' TERM; echo ready; while :; do sleep 1; done"));
    await waitFor('出力', () => linesOf(c, 'stubborn').length === 1);
    const started = Date.now();
    c.send({ t: 'shutdown' });
    await waitFor('終わり', () => exits.includes(0), 8000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(logs.some((l) => l.includes('終了しました（pipe）: tag-stubborn') && l.includes('SIGKILL'))).toBe(true);
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
