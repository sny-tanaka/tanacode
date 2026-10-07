import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostExecutable, PtyHost } from '../src/main/pty-host-client';
import { PROTOCOL, type ClientMessage, type HostedPtyInfo } from '../src/main/pty-host-protocol';
import { socketPathIn } from '../src/main/socket-path';

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

// 偽物のホスト。受け取った要求を控え、hello には protocol で答える（null なら答えない）。list には ptys を返す
class FakeHost {
  readonly received: ClientMessage[] = [];
  readonly sockets: Socket[] = [];
  ptys: HostedPtyInfo[] = [];
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
          if (message.t === 'list' && this.answerList) this.send({ t: 'list', req: message.req, ptys: this.ptys }, socket);
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
const info = (id: string, patch: Partial<HostedPtyInfo> = {}): HostedPtyInfo => ({ id, tag: `tag-${id}`, pid: 1, startedAt: 0, cols: 80, rows: 24, exitCode: null, screen: '', ...patch });

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
    expect(fake!.sent('spawn')).toEqual([{ t: 'spawn', id: pty.id, ...request }]);
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
    fake!.ptys = [info('p1'), info('done', { exitCode: 0 })];
    const listed = await host.list();
    expect(listed.map((p) => p.id)).toEqual(['p1', 'done']);
    for (let i = 0; i < 2005; i++) fake!.send({ t: 'data', id: 'p1', data: `${i},` });
    await sleep(200);
    const pty = host.attach(listed[0]);
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

  it('起動したホストが待ち受けなければ、つながらないとして失敗する。つながっていない間の起動の頼みは、-1 で終わらせる', async () => {
    const { host } = await connect();
    fake!.close();
    await sleep(50);
    writeFileSync(join(dir, 'unused.js'), 'process.exit(0);\n');
    const pty = host.spawn(request);
    let exit: number | null = null;
    pty.onExit((c) => (exit = c));
    await waitFor('あきらめ', () => exit !== null, 8000);
    expect(exit).toBe(-1);
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
