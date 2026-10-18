import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostExecutable, PtyHost } from '../src/main/pty-host-client';
import { PROTOCOL, type ClientMessage, type HostedInfo, type HostedPipeInfo, type HostedPtyInfo } from '../src/main/pty-host-protocol';
import { socketPathIn } from '../src/main/socket-path';
import { StreamClient } from '../src/main/stream/client';

// アプリ側の、pty ホストとの接続（PtyHost・HostedPty）。本物のホストとのやりとりは test/pty-host.test.ts。
// ここでは、テストが決めたとおりに答える偽物のホストで、やりとりの細かいところ（溜めておく出力・切れたとき・答えないホスト）を確かめる

let dir: string;
let fake: FakeHost | null;
const hosts: PtyHost[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-pty-client-'));
  fake = null;
});
afterEach(async () => {
  for (const host of hosts.splice(0)) host.close();
  fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label: string, check: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`${label}: 時間切れ`);
    await sleep(10);
  }
}

// 偽物のホスト。受け取った要求を控え、hello には protocol で答える（null なら答えない）。list には hosted を返す
class FakeHost {
  readonly received: ClientMessage[] = [];
  readonly sockets: Socket[] = [];
  hosted: HostedInfo[] = [];
  answerList = true;
  // hello の返事の前に、読めない行を送る
  noiseBeforeHello = false;
  private readonly server: Server;

  constructor(
    readonly path: string,
    private readonly protocol: number | null = PROTOCOL,
  ) {
    this.server = createServer((socket) => {
      this.sockets.push(socket);
      socket.setEncoding('utf8');
      let buffered = '';
      socket.on('error', () => {});
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        let newline: number;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffered.slice(0, newline)) as ClientMessage;
          buffered = buffered.slice(newline + 1);
          this.received.push(message);
          if (message.t === 'hello' && this.noiseBeforeHello) this.send('読めない行\n', socket);
          if (message.t === 'hello' && this.protocol !== null) this.send({ t: 'hello', protocol: this.protocol, pid: 1 }, socket);
          if (message.t === 'list' && this.answerList) this.send({ t: 'list', req: message.req, hosted: this.hosted }, socket);
          if (message.t === 'shutdown') socket.end();
        }
      });
    });
  }

  static async start(path: string, protocol: number | null = PROTOCOL, noiseBeforeHello = false): Promise<FakeHost> {
    const host = new FakeHost(path, protocol);
    host.noiseBeforeHello = noiseBeforeHello;
    await new Promise<void>((resolve) => host.server.listen(path, resolve));
    return host;
  }

  // アプリへ送る（行のまま書けるように、文字も受け付ける）
  send(message: unknown, socket = this.sockets.at(-1)!): void {
    socket.write(typeof message === 'string' ? message : `${JSON.stringify(message)}\n`);
  }

  sent<T extends ClientMessage['t']>(t: T): Extract<ClientMessage, { t: T }>[] {
    return this.received.filter((m) => m.t === t) as Extract<ClientMessage, { t: T }>[];
  }

  // 落ちた（接続を切って、待ち受けもやめる）
  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
  }
}

const socketPath = () => socketPathIn(dir, 'pty-host', 'pty');
async function connect(): Promise<{ host: PtyHost; fake: FakeHost }> {
  // hello の返事の前の読めない行は、飛ばして読む
  fake = await FakeHost.start(socketPath(), PROTOCOL, true);
  const host = await PtyHost.start(dir, join(dir, 'unused.js'));
  hosts.push(host);
  return { host, fake };
}
const request = { tag: 's1', file: 'claude', args: ['--x'], cwd: '/work', env: { A: '1' }, cols: 80, rows: 24 };
const pipeRequest = { tag: 's2', file: 'claude', args: ['-p'], cwd: '/work', env: { A: '1' }, retain: [{ type: 'system', subtype: 'init' }], transient: [{ type: 'stream_event' }] };
const info = (id: string, patch: Partial<HostedPtyInfo> = {}): HostedPtyInfo => ({ kind: 'pty', id, tag: `tag-${id}`, pid: 1, startedAt: 0, cols: 80, rows: 24, exitCode: null, screen: '', ...patch });
const pipeInfo = (id: string, patch: Partial<HostedPipeInfo> = {}): HostedPipeInfo => ({
  kind: 'pipe',
  id,
  tag: `tag-${id}`,
  pid: 1,
  startedAt: 0,
  exitCode: null,
  lastSeq: 0,
  firstSeq: 1,
  retained: [],
  pending: [],
  ended: false,
  stderr: '',
  ...patch,
});

// ホストのスクリプト（アプリは Electron を Node として起動する。テストでは Node）。good: 偽物のホストとして待ち受ける / dead: すぐ終わる
function hostScript(kind: 'good' | 'dead'): string {
  const file = join(dir, `${kind}-host.js`);
  writeFileSync(
    file,
    kind === 'dead'
      ? 'process.exit(0);\n'
      : `
const net = require('node:net');
const fs = require('node:fs');
const path = process.argv[2];
fs.writeFileSync(${JSON.stringify(join(dir, 'launched'))}, String(process.pid));
try { fs.unlinkSync(path); } catch {}
const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk;
    let i;
    while ((i = buffered.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buffered.slice(0, i));
      buffered = buffered.slice(i + 1);
      const send = (x) => socket.write(JSON.stringify(x) + '\\n');
      if (m.t === 'hello') send({ t: 'hello', protocol: ${PROTOCOL}, pid: process.pid });
      if (m.t === 'spawn') { send({ t: 'data', id: m.id, data: 'spawned:' + m.tag }); send({ t: 'exit', id: m.id, exitCode: 7 }); }
      if (m.t === 'shutdown') { server.close(); try { fs.unlinkSync(path); } catch {} socket.end(); setTimeout(() => process.exit(0), 50); }
    }
  });
});
server.listen(path);
setTimeout(() => process.exit(0), 5000);
`,
  );
  return file;
}

describe('HostedPty', () => {
  it('打った文字・大きさ・止める頼みをホストに送り、出力と終了を受け取る。終了は 1 度だけ知らせる', async () => {
    const { host } = await connect();
    const pty = host.spawn(request);
    const data: string[] = [];
    const exits: number[] = [];
    pty.onData((d) => data.push(d));
    pty.onExit((c) => exits.push(c));
    pty.write('abc');
    pty.resize(100, 30);
    pty.kill();
    await waitFor('要求', () => fake!.sent('kill').length === 1);
    expect(fake!.sent('spawn')).toEqual([{ t: 'spawn', id: pty.id, kind: 'pty', ...request }]);
    expect(fake!.sent('write')).toEqual([{ t: 'write', id: pty.id, data: 'abc' }]);
    expect(fake!.sent('resize')).toEqual([{ t: 'resize', id: pty.id, cols: 100, rows: 30 }]);
    expect(fake!.sent('kill')).toEqual([{ t: 'kill', id: pty.id }]);
    // 空の行・知らない pty の知らせ・2 度目の hello は読み飛ばす
    fake!.send('\n');
    fake!.send({ t: 'data', id: 'unknown', data: 'x' });
    fake!.send({ t: 'exit', id: 'unknown', exitCode: 1 });
    fake!.send({ t: 'hello', protocol: PROTOCOL, pid: 1 });
    fake!.send({ t: 'data', id: pty.id, data: '出力' });
    fake!.send({ t: 'exit', id: pty.id, exitCode: 3 });
    fake!.send({ t: 'exit', id: pty.id, exitCode: 4 });
    await waitFor('終了', () => exits.length > 0);
    await sleep(50);
    expect(data).toEqual(['出力']);
    expect(exits).toEqual([3]);
    pty.emitExit(5);
    expect(exits).toEqual([3]);
  });

  it('引き継ぐ pty の出力は、受け手がつくまで溜めておき、最初の受け手に渡す（溜めすぎない）', async () => {
    const { host } = await connect();
    fake!.hosted = [info('p1'), info('done', { exitCode: 0 })];
    const listed = await host.list();
    expect(listed.map((p) => p.id)).toEqual(['p1', 'done']);
    for (let i = 0; i < 2005; i++) fake!.send({ t: 'data', id: 'p1', data: `${i},` });
    await sleep(200);
    const pty = host.attach(listed[0] as HostedPtyInfo);
    const first: string[] = [];
    pty.onData((d) => first.push(d));
    expect(first).toHaveLength(2000);
    expect(first[0]).toBe('0,');
    // 2 つ目の受け手には、溜めたものは渡さない（続きだけ）
    const second: string[] = [];
    pty.onData((d) => second.push(d));
    fake!.send({ t: 'data', id: 'p1', data: '続き' });
    await waitFor('続き', () => second.length === 1);
    expect(first.at(-1)).toBe('続き');
    expect(second).toEqual(['続き']);
  });

  it('一覧に無い pty も引き継げる。同じ pty は同じものを返す', async () => {
    const { host } = await connect();
    const pty = host.attach(info('p9'));
    expect(host.attach(info('p9'))).toBe(pty);
    const data: string[] = [];
    pty.onData((d) => data.push(d));
    fake!.send({ t: 'data', id: 'p9', data: 'x' });
    await waitFor('出力', () => data.length === 1);
  });

  it('detach: claude を止めずに見るのをやめる（そのあとの出力も終了も受け取らない）。forget: 終わった pty の記録を捨てるよう頼む', async () => {
    const { host } = await connect();
    const pty = host.spawn(request);
    const got: unknown[] = [];
    pty.onData((d) => got.push(d));
    pty.onExit((c) => got.push(c));
    pty.detach();
    fake!.send({ t: 'data', id: pty.id, data: 'x' });
    fake!.send({ t: 'exit', id: pty.id, exitCode: 0 });
    host.forget('old');
    await waitFor('forget', () => fake!.sent('forget').length === 1);
    expect(fake!.sent('forget')).toEqual([{ t: 'forget', id: 'old' }]);
    expect(fake!.sent('kill')).toEqual([]);
    // 手元に残った pty から直に渡されても、受け手には届けない
    pty.emitData('y');
    pty.emitExit(1);
    expect(got).toEqual([]);
  });
});

describe('HostedPipe', () => {
  const linesOf = (pipe: ReturnType<PtyHost['spawnPipe']>) => {
    const got: string[] = [];
    pipe.onLine((line, seq) => got.push(`${seq}:${line}`));
    return got;
  };

  it('入力の行・閉じる・止める（既定は SIGTERM）・送り直しの頼みをホストに送り、出力の行と終了（標準エラーの末尾つき）を受け取る', async () => {
    const { host } = await connect();
    const pipe = host.spawnPipe(pipeRequest);
    const got = linesOf(pipe);
    const exits: [number, string][] = [];
    pipe.onExit((c, e) => exits.push([c, e]));
    pipe.send('{"type":"user"}');
    pipe.end();
    pipe.kill();
    pipe.kill('SIGKILL');
    await waitFor('要求', () => fake!.sent('kill').length === 2);
    expect(fake!.sent('spawn')).toEqual([{ t: 'spawn', id: pipe.id, kind: 'pipe', ...pipeRequest }]);
    expect(fake!.sent('send')).toEqual([{ t: 'send', id: pipe.id, line: '{"type":"user"}' }]);
    expect(fake!.sent('end')).toEqual([{ t: 'end', id: pipe.id }]);
    expect(fake!.sent('kill')).toEqual([{ t: 'kill', id: pipe.id }, { t: 'kill', id: pipe.id, signal: 'SIGKILL' }]);
    fake!.send({ t: 'line', id: pipe.id, seq: 1, line: 'a' });
    fake!.send({ t: 'line', id: 'unknown', seq: 1, line: 'x' });
    fake!.send({ t: 'replayed', id: 'unknown' });
    fake!.send({ t: 'exit', id: pipe.id, exitCode: 2, stderr: 'エラー' });
    await waitFor('終了', () => exits.length > 0);
    expect(got).toEqual(['1:a']);
    expect(exits).toEqual([[2, 'エラー']]);
    pipe.emitExit(5, '');
    expect(exits).toHaveLength(1);
  });

  it('引き継ぐときは、送り直しを頼んでから受け取る。送り直しの間に届いた新しい行は、送り直した行のあとに渡し、重なった行は 1 度だけ渡す', async () => {
    const { host } = await connect();
    fake!.hosted = [pipeInfo('q1', { lastSeq: 3 })];
    const [listed] = (await host.list()) as HostedPipeInfo[];
    // 一覧のあと、受け手が付く前に新しい行が届いた
    fake!.send({ t: 'line', id: 'q1', seq: 4, line: 'd' });
    await sleep(50);
    const pipe = host.attachPipe(listed);
    expect(host.attachPipe(listed)).toBe(pipe);
    pipe.replay(1);
    const got = linesOf(pipe);
    await waitFor('頼み', () => fake!.sent('replay').length === 1);
    expect(fake!.sent('replay')).toEqual([{ t: 'replay', id: 'q1', from: 1 }]);
    // 送り直しの途中にも新しい行が届く
    fake!.send({ t: 'line', id: 'q1', seq: 1, line: 'a', replay: true });
    fake!.send({ t: 'line', id: 'q1', seq: 5, line: 'e' });
    fake!.send({ t: 'line', id: 'q1', seq: 2, line: 'b', replay: true });
    fake!.send({ t: 'line', id: 'q1', seq: 3, line: 'c', replay: true });
    fake!.send({ t: 'line', id: 'q1', seq: 4, line: 'd', replay: true });
    await waitFor('送り直し', () => got.length === 4);
    expect(got).toEqual(['1:a', '2:b', '3:c', '4:d']);
    fake!.send({ t: 'replayed', id: 'q1' });
    await waitFor('続き', () => got.length === 5);
    expect(got).toEqual(['1:a', '2:b', '3:c', '4:d', '5:e']);
    // 同じ番号の行がもう一度届いても渡さない
    fake!.send({ t: 'line', id: 'q1', seq: 5, line: 'e' });
    fake!.send({ t: 'line', id: 'q1', seq: 6, line: 'f' });
    await waitFor('次', () => got.length === 6);
    expect(got.at(-1)).toBe('6:f');
  });

  it('送り直しの途中で終わったら、待たせていた行を渡してから終わりを知らせる', async () => {
    const { host } = await connect();
    const pipe = host.attachPipe(pipeInfo('q2'));
    pipe.replay(1);
    const got = linesOf(pipe);
    const exits: number[] = [];
    pipe.onExit((c) => exits.push(c));
    fake!.send({ t: 'line', id: 'q2', seq: 9, line: 'live' });
    fake!.send({ t: 'exit', id: 'q2', exitCode: 0 });
    await waitFor('終了', () => exits.length === 1);
    expect(got).toEqual(['9:live']);
  });

  it('終わったあとに送り直しを頼まれたら、ホストには頼まず（もう記録が無い）、溜めていた行を渡して、送り直しの終わりを 1 度だけ知らせる', async () => {
    const { host } = await connect();
    const pipe = host.attachPipe(pipeInfo('q4'));
    const exits: number[] = [];
    pipe.onExit((c) => exits.push(c));
    fake!.send({ t: 'line', id: 'q4', seq: 1, line: 'a' });
    fake!.send({ t: 'exit', id: 'q4', exitCode: 0 });
    await waitFor('終了', () => exits.length === 1);
    const order: string[] = [];
    pipe.onReplayed(() => order.push('replayed'));
    // 引き継ぐときの頼みと、溜めすぎて捨てた分の頼みが重なっても、終わりは 1 度
    pipe.replay(1);
    pipe.replay(1);
    pipe.onLine((line, seq) => order.push(`${seq}:${line}`));
    pipe.onExit((c) => order.push(`exit:${c}`));
    await waitFor('終わり', () => order.includes('exit:0'));
    await sleep(20);
    expect(order).toEqual(['replayed', '1:a', 'exit:0']);
    // 頼んでいない（同じ接続で、あとから送ったものが届いた時点で、それより前のものは届いている）
    host.forget('probe');
    await waitFor('forget', () => fake!.sent('forget').length === 1);
    expect(fake!.sent('replay')).toEqual([]);
  });

  it('受け手がいないまま溜めすぎたら捨て、受け手が付いたときに、捨てたところから送り直してもらう', async () => {
    const { host } = await connect();
    const pipe = host.attachPipe(pipeInfo('q3'));
    // 届き切ったかは、受け手のいる別のプロセスの行で見る（同じ接続の行は、送った順に読まれる）
    const probe = host.attachPipe(pipeInfo('probe'));
    const probed: string[] = [];
    probe.onLine((line) => probed.push(line));
    const big = 'x'.repeat(9 * 1024 * 1024);
    fake!.send({ t: 'line', id: 'q3', seq: 1, line: big });
    fake!.send({ t: 'line', id: 'q3', seq: 2, line: big });
    fake!.send({ t: 'line', id: 'q3', seq: 3, line: 'small' });
    fake!.send({ t: 'line', id: 'probe', seq: 1, line: 'done' });
    await waitFor('届き切る', () => probed.length === 1, 10_000);
    const got: number[] = [];
    pipe.onLine((_line, seq) => got.push(seq));
    await waitFor('頼み', () => fake!.sent('replay').length === 1);
    expect(fake!.sent('replay')).toEqual([{ t: 'replay', id: 'q3', from: 2 }]);
    // 頼んだ番号より前の、溜めておけた行だけ先に渡す。頼んだ番号からの行は、送り直しのあとに渡す
    expect(got).toEqual([1]);
    fake!.send({ t: 'line', id: 'q3', seq: 2, line: 'again', replay: true });
    fake!.send({ t: 'replayed', id: 'q3' });
    await waitFor('送り直し', () => got.length === 3);
    expect(got).toEqual([1, 2, 3]);
  });

  it('detach: claude を止めずに見るのをやめる。ホストが落ちたら、動いていたプロセスを -1 で終わらせる', async () => {
    const { host } = await connect();
    const kept = host.spawnPipe(pipeRequest);
    const dropped = host.spawnPipe(pipeRequest);
    const got: unknown[] = [];
    dropped.onLine((l) => got.push(l));
    dropped.onExit((c) => got.push(c));
    dropped.detach();
    const exits: number[] = [];
    kept.onExit((c) => exits.push(c));
    fake!.send({ t: 'line', id: dropped.id, seq: 1, line: 'x' });
    await sleep(50);
    fake!.close();
    await waitFor('終了', () => exits.length === 1);
    expect(exits).toEqual([-1]);
    expect(got).toEqual([]);
  });
});

describe('一覧の直後に終わったプロセス', () => {
  it('一覧の返事と同じ受信の中で終わったプロセスも、引き継いだときに終わったと分かる（受け皿を引き継ぐまで残す）', async () => {
    const { host } = await connect();
    fake!.answerList = false;
    const listing = host.list();
    await waitFor('一覧の頼み', () => fake!.sent('list').length === 1);
    const { req } = fake!.sent('list')[0];
    fake!.send(
      [
        JSON.stringify({ t: 'list', req, hosted: [pipeInfo('q9'), info('p9')] }),
        JSON.stringify({ t: 'exit', id: 'q9', exitCode: 3, stderr: '終わり' }),
        JSON.stringify({ t: 'exit', id: 'p9', exitCode: 4 }),
        '',
      ].join('\n'),
    );
    const [listedPipe, listedPty] = await listing;
    await sleep(50);
    const pipe = host.attachPipe(listedPipe as HostedPipeInfo);
    const pipeExits: [number, string][] = [];
    pipe.onExit((code, stderr) => pipeExits.push([code, stderr]));
    const pty = host.attach(listedPty as HostedPtyInfo);
    const ptyExits: number[] = [];
    pty.onExit((code) => ptyExits.push(code));
    await waitFor('終わり', () => pipeExits.length === 1 && ptyExits.length === 1);
    expect(pipeExits).toEqual([[3, '終わり']]);
    expect(ptyExits).toEqual([4]);
    // 終わりは 1 度だけ
    fake!.send({ t: 'exit', id: 'q9', exitCode: 3, stderr: '終わり' });
    await sleep(50);
    expect(pipeExits).toHaveLength(1);
  });

  it('引き継いだあとに、ホストがもう記録を捨てたと分かっても（知らない id の replay への exit）、終わったことにする', async () => {
    const { host } = await connect();
    fake!.hosted = [pipeInfo('q8', { lastSeq: 2 })];
    const [listed] = (await host.list()) as HostedPipeInfo[];
    const pipe = host.attachPipe(listed);
    const exits: number[] = [];
    pipe.onExit((code) => exits.push(code));
    pipe.replay(1);
    await waitFor('頼み', () => fake!.sent('replay').length === 1);
    fake!.send({ t: 'exit', id: 'q8', exitCode: -1 });
    await waitFor('終わり', () => exits.length === 1);
    expect(exits).toEqual([-1]);
  });
});

describe('引き継ぎ（本物の HostedPipe と StreamClient）', () => {
  it('答えを待っている要求を出し直し、送り直しの間に届いた取り下げは、送り直した行のあとに渡す。取り下げた要求には答えない', async () => {
    const { host } = await connect();
    const request = (id: string) => JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'make' }, tool_use_id: `toolu_${id}` } });
    fake!.hosted = [
      pipeInfo('q7', {
        lastSeq: 3,
        firstSeq: 2,
        retained: [{ seq: 1, line: JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', permissionMode: 'plan' }) }],
        pending: [{ seq: 3, line: request('r1') }],
      }),
    ];
    const [listed] = (await host.list()) as HostedPipeInfo[];
    const pipe = host.attachPipe(listed);
    const order: string[] = [];
    const client = new StreamClient(pipe, {
      onMessage: (message, past) => order.push(`${message.type}${'subtype' in message ? `/${String(message.subtype)}` : ''}:${past ? 'past' : 'live'}`),
      onPermission: (id) => order.push(`permission:${id}`),
      onCancel: (id) => order.push(`cancel:${id}`),
      onExit: () => order.push('exit'),
      onCaughtUp: () => order.push('caught-up'),
    });
    client.adopt(listed);
    await waitFor('送り直しの頼み', () => fake!.sent('replay').length === 1);
    expect(fake!.sent('replay')[0]).toEqual({ t: 'replay', id: 'q7', from: 2 });
    // 送り直しの途中に、claude が要求を取り下げた（スマホで答えた）
    fake!.send({ t: 'line', id: 'q7', seq: 2, line: JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [] } }), replay: true });
    fake!.send({ t: 'line', id: 'q7', seq: 4, line: JSON.stringify({ type: 'control_cancel_request', request_id: 'r1' }) });
    fake!.send({ t: 'line', id: 'q7', seq: 3, line: request('r1'), replay: true });
    await sleep(50);
    // 取り下げは、送り直しが終わるまで待たせる
    expect(order).not.toContain('cancel:r1');
    fake!.send({ t: 'replayed', id: 'q7' });
    await waitFor('取り下げ', () => order.includes('cancel:r1'));
    expect(order).toEqual(['system/init:past', 'permission:r1', 'assistant:past', 'caught-up', 'cancel:r1']);
    expect(client.pendingPermissions()).toEqual([]);
    expect(client.respond('r1', { behavior: 'allow' })).toBe(false);
  });

  it('list の返事・行・exit が同じかたまりで届いても、引き継ぐと行が届き、onCaughtUp が来てから終了が知らされる', async () => {
    const { host } = await connect();
    fake!.answerList = false;
    const listing = host.list();
    await waitFor('一覧の頼み', () => fake!.sent('list').length === 1);
    const { req } = fake!.sent('list')[0];
    // 一覧のあとに claude がターンを終えて終わった。ホストは終わったときに記録を捨てるので、あとから送り直しは頼めない
    fake!.send(
      [
        JSON.stringify({
          t: 'list',
          req,
          hosted: [pipeInfo('q6', { lastSeq: 2, firstSeq: 2, retained: [{ seq: 1, line: JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', permissionMode: 'default' }) }] })],
        }),
        JSON.stringify({ t: 'line', id: 'q6', seq: 3, line: JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) }),
        JSON.stringify({ t: 'exit', id: 'q6', exitCode: 0, stderr: '' }),
        '',
      ].join('\n'),
    );
    const [listed] = (await listing) as HostedPipeInfo[];
    await sleep(50);
    const pipe = host.attachPipe(listed);
    const order: string[] = [];
    const client = new StreamClient(pipe, {
      onMessage: (message, past) => order.push(`${message.type}${'subtype' in message ? `/${String(message.subtype)}` : ''}:${past ? 'past' : 'live'}`),
      onPermission: (id) => order.push(`permission:${id}`),
      onCancel: (id) => order.push(`cancel:${id}`),
      onExit: (code) => order.push(`exit:${code}`),
      onCaughtUp: () => order.push('caught-up'),
    });
    client.adopt(listed);
    await waitFor('終わり', () => order.some((item) => item.startsWith('exit:')));
    // ふつうの引き継ぎと同じ順（前のアプリの頃の行 → 読み終わり → 一覧のあとの行）で渡してから、終わりを知らせる
    expect(order).toEqual(['system/init:past', 'caught-up', 'result/success:live', 'exit:0']);
    // 読み終わりも終わりも 1 度だけ
    await sleep(50);
    expect(order).toHaveLength(4);
  });
});

describe('PtyHost', () => {
  it('ホストが落ちたら、動いていた pty を -1 で終わらせ、答えを待っている一覧には空を返す', async () => {
    const { host } = await connect();
    const pty = host.spawn(request);
    const exits: number[] = [];
    pty.onExit((c) => exits.push(c));
    fake!.answerList = false;
    const listing = host.list();
    await waitFor('list', () => fake!.sent('list').length === 1);
    fake!.close();
    expect(await listing).toEqual([]);
    expect(exits).toEqual([-1]);
  });

  it('shutdown: ホストに終わるよう頼み、接続が閉じるまで待つ。つながっていなければ、すぐ返す', async () => {
    const { host } = await connect();
    await host.shutdown();
    expect(fake!.sent('shutdown')).toHaveLength(1);
    host.close();
    await host.shutdown();
    expect(fake!.sent('shutdown')).toHaveLength(1);
  });

  it('hello に答えない古いホストには、2 秒待ってから、新しいホストを起動する', async () => {
    fake = await FakeHost.start(socketPath(), null);
    const startedAt = Date.now();
    const host = await PtyHost.start(dir, hostScript('good'));
    hosts.push(host);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1900);
    expect(existsSync(join(dir, 'launched'))).toBe(true);
  }, 15_000);

  it('hello に答えない古いホストを置き換えたら、新しいホストにつなぐ（答えない古いホストにつなぎ直さない）', async () => {
    fake = await FakeHost.start(socketPath(), null);
    const host = await PtyHost.start(dir, hostScript('good'));
    hosts.push(host);
    const pty = host.spawn({ ...request, tag: 'new' });
    const data: string[] = [];
    pty.onData((d) => data.push(d));
    await waitFor('新しいホストの答え', () => data.length === 1, 5000);
    expect(data).toEqual(['spawned:new']);
    // 古いホストには、hello のほかは何も頼まない
    expect(fake.received.map((m) => m.t)).toEqual(['hello']);
    await host.shutdown();
  }, 15_000);

  // ホストが落ちたあと、同じ場所で待ち受けている（起動し直した）ホスト
  async function restarted(): Promise<FakeHost> {
    fake!.close();
    await sleep(50);
    fake = await FakeHost.start(socketPath());
    return fake;
  }

  it('つなぎ直している間に送ったもの（起動の直後の入力の行・止める頼み）は、捨てずに、つながってから順に送る', async () => {
    const { host } = await connect();
    const again = await restarted();
    const pipe = host.spawnPipe(pipeRequest);
    // 起動の直後に送る initialize と、止める頼み（end_session のあとの kill）。つながる前に送っている
    pipe.send('{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}');
    pipe.end();
    pipe.kill();
    await waitFor('止める頼み', () => again.sent('kill').length === 1);
    expect(again.received.filter((m) => m.t !== 'hello').map((m) => m.t)).toEqual(['spawn', 'send', 'end', 'kill']);
    expect(again.sent('send')).toEqual([{ t: 'send', id: pipe.id, line: '{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}' }]);
  });

  it('ホストが落ちたあとの一覧は、つなぎ直してから聞く（答えないまま待たせない）', async () => {
    const { host } = await connect();
    const again = await restarted();
    again.hosted = [info('p1')];
    const listed = await Promise.race([host.list(), sleep(3000).then(() => 'つながらないまま' as const)]);
    expect(listed).not.toBe('つながらないまま');
    expect((listed as HostedInfo[]).map((p) => p.id)).toEqual(['p1']);
  });

  it('つながっていない間に続けて頼んでも、つなぐのは 1 回（接続を 2 本張らない・ホストを 2 つ起動しない）', async () => {
    const { host } = await connect();
    const again = await restarted();
    const first = host.spawn(request);
    const second = host.spawnPipe(pipeRequest);
    const listing = host.list();
    await waitFor('2 つの起動', () => again.sent('spawn').length === 2);
    await listing;
    expect(again.sent('spawn').map((m) => m.id)).toEqual([first.id, second.id]);
    expect(again.sockets).toHaveLength(1);
    expect(again.sent('hello')).toHaveLength(1);
  });

  it('つながっていない間に起動を頼んだら、ホストを起動し直してから頼む', async () => {
    const { host } = await connect();
    // ホストが落ちた
    fake!.close();
    await sleep(50);
    // 起動し直すホストのスクリプト（PtyHost.start に渡したもの）を、偽物のホストにする
    writeFileSync(join(dir, 'unused.js'), `require(${JSON.stringify(hostScript('good'))});\n`);
    const pty = host.spawn({ ...request, tag: 'again' });
    const data: string[] = [];
    pty.onData((d) => data.push(d));
    await waitFor('起動し直したホストの答え', () => data.length === 1, 8000);
    expect(data).toEqual(['spawned:again']);
    await host.shutdown();
  }, 15_000);

  it('起動したホストが待ち受けなければ、つながらないとして失敗する。つながっていない間の起動の頼みは -1 で終わらせ、一覧は空で返し、溜めた入力は捨てる', async () => {
    const { host } = await connect();
    fake!.close();
    await sleep(50);
    writeFileSync(join(dir, 'unused.js'), 'process.exit(0);\n');
    const pty = host.spawn(request);
    let exit: number | null = null;
    pty.onExit((c) => (exit = c));
    // つないでいる途中に、起動の頼み・一覧・入力の行（溜められる）を重ねる
    const pipe = host.spawnPipe(pipeRequest);
    let pipeExit: number | null = null;
    pipe.onExit((c) => (pipeExit = c));
    pipe.send('{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}');
    const listed = host.list();
    await waitFor('あきらめ', () => exit !== null, 8000);
    expect(exit).toBe(-1);
    expect(pipeExit).toBe(-1);
    expect(await listed).toEqual([]);
    // 溜めていたものは捨てた（次につながっても、あきらめた頃の入力を送らない）
    expect((host as unknown as { queued: unknown[] }).queued).toEqual([]);
    await expect(PtyHost.start(dir, hostScript('dead'))).rejects.toThrow(`pty ホストに繋がりません: ${socketPath()}`);
  }, 20_000);
});

describe('hostExecutable', () => {
  const original = { platform: process.platform, execPath: process.execPath };
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: original.platform });
    process.execPath = original.execPath;
  });

  it('macOS では、同梱の Helper.app（Dock に出ない）を使う。無ければアプリ本体', () => {
    const app = join(dir, 'tanacode.app', 'Contents');
    process.execPath = join(app, 'MacOS', 'tanacode');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(hostExecutable()).toBe(process.execPath);
    const helper = join(app, 'Frameworks', 'tanacode Helper.app', 'Contents', 'MacOS', 'tanacode Helper');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, '');
    expect(hostExecutable()).toBe(helper);
  });

  it('macOS でなければ、実行しているもの', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(hostExecutable()).toBe(process.execPath);
  });
});
