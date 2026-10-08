import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServerDef } from '@shared/mcp-tools';
import { callBridge, McpBridge, mcpArgs, mcpServerEntry, textResult, type BridgeHandler } from '../src/main/mcp-bridge';
import { respond, runRelay, type RelayDeps } from '../src/main/mcp-relay';

// MCP サーバーの中継とアプリのやりとり（McpBridge・callBridge）と、中継の JSON-RPC（respond・runRelay）の、
// 壊れた・足りない・取り消された・つながらないときの扱い。うまくいくときは test/browser-mcp.test.ts などが確かめる

let root: string;
const servers: (Server | McpBridge)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-mcp-bridge-'));
});
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLOSED = 'tanacode が起動していません';

// アプリ側の待ち受けを立てる
async function bridge(handler: BridgeHandler, name = 'bridge.sock'): Promise<McpBridge> {
  const b = new McpBridge(join(root, name), handler);
  await b.start();
  servers.push(b);
  return b;
}

// アプリの代わりに、決めた返事をする待ち受け（返事を書く関数を受け取る）
async function fakeApp(onLine: (socket: Socket, line: string) => void): Promise<string> {
  const path = join(root, 'fake.sock');
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => chunk.split('\n').filter(Boolean).forEach((line) => onLine(socket, line)));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push(server);
  return path;
}

// ソケットに書いて、返ってきた行を集める
function rawClient(path: string): Promise<{ socket: Socket; lines: () => unknown[]; closed: () => boolean }> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.setEncoding('utf8');
    let buffered = '';
    let closed = false;
    socket.on('data', (chunk: string) => (buffered += chunk));
    socket.on('close', () => (closed = true));
    socket.on('error', () => {});
    socket.once('connect', () =>
      resolve({
        socket,
        lines: () =>
          buffered
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as unknown),
        closed: () => closed,
      }),
    );
  });
}

const request = { session: 's1', tool: 'get_text', args: {} };

describe('McpBridge（アプリ側の待ち受け）', () => {
  it('前のアプリが残したソケットのファイルは消して作り直し、自分だけが読み書きできるようにする', async () => {
    writeFileSync(join(root, 'bridge.sock'), '残ったもの');
    await bridge(async () => textResult('ok'));
    expect(statSync(join(root, 'bridge.sock')).mode & 0o777).toBe(0o600);
    expect(await callBridge(join(root, 'bridge.sock'), request, 5000, CLOSED)).toEqual(textResult('ok'));
  });

  it('待ち受けられない場所なら、start が失敗する', async () => {
    const b = new McpBridge(join(root, 'none', 'bridge.sock'), async () => textResult('ok'));
    await expect(b.start()).rejects.toThrow();
    // 閉じても失敗しない（ソケットのファイルが無い）
    b.close();
  });

  it('読めない行・形の違う呼び出しは答えずに飛ばし、同じ接続の次の呼び出しには答える。引数がオブジェクトでなければ空にする', async () => {
    const seen: unknown[] = [];
    const b = await bridge(async (session, tool, args) => {
      seen.push({ session, tool, args });
      return textResult(`${tool} をしました`);
    });
    const client = await rawClient(b.socketPath);
    client.socket.write('{壊れた行\n\n');
    client.socket.write(`${JSON.stringify({ id: 'x', session: 's1', tool: 't', args: {} })}\n`);
    client.socket.write(`${JSON.stringify({ id: 1, session: 1, tool: 't', args: {} })}\n`);
    client.socket.write(`${JSON.stringify({ id: 2, session: 's1', tool: 'click', args: ['a'] })}\n`);
    client.socket.write(`${JSON.stringify({ id: 3, session: 's1', tool: 'type' })}\n`);
    await sleep(100);
    expect(client.lines()).toEqual([
      { id: 2, result: textResult('click をしました') },
      { id: 3, result: textResult('type をしました') },
    ]);
    expect(seen).toEqual([
      { session: 's1', tool: 'click', args: {} },
      { session: 's1', tool: 'type', args: {} },
    ]);
    client.socket.destroy();
  });

  it('アプリの処理が失敗したら、その理由をエラーの結果にして返す（Error でないものも文字にする）', async () => {
    const b = await bridge(async (_session, tool) => {
      if (tool === 'error') throw new Error('ページがありません');
      throw 'こわれた';
    });
    expect(await callBridge(b.socketPath, { ...request, tool: 'error' }, 5000, CLOSED)).toEqual(textResult('ページがありません', true));
    expect(await callBridge(b.socketPath, { ...request, tool: 'string' }, 5000, CLOSED)).toEqual(textResult('こわれた', true));
  });

  it('中継がソケットを閉じたら、その呼び出しの signal を abort し、返事は書かない', async () => {
    let signal: AbortSignal | null = null;
    let finish!: () => void;
    const b = await bridge(
      (_session, _tool, _args, s) =>
        new Promise((resolve) => {
          signal = s;
          finish = () => resolve(textResult('遅れた返事'));
        }),
    );
    const client = await rawClient(b.socketPath);
    client.socket.write(`${JSON.stringify({ id: 1, ...request })}\n`);
    await sleep(50);
    client.socket.destroy();
    await sleep(50);
    expect(signal!.aborted).toBe(true);
    // 閉じたあとに答えが出ても、書かない（落ちない）
    finish();
    await sleep(20);
  });
});

describe('callBridge（中継の側）', () => {
  it('アプリが起動していない（ソケットが無い・待ち受けていない）なら、決めた文を返す', async () => {
    expect(await callBridge(join(root, 'none.sock'), request, 5000, CLOSED)).toEqual(textResult(CLOSED, true));
    // 待ち受けていたアプリが落ちて、ソケットのファイルだけ残ったもの（ふつうのファイルではなく、ソケットのファイル。
    // ふつうのファイルにつなぐと、macOS では ENOTSOCK になる）
    const stale = join(root, 'stale.sock');
    spawnSync(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(stale)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    expect(statSync(stale).isSocket()).toBe(true);
    expect(await callBridge(stale, request, 5000, CLOSED)).toEqual(textResult(CLOSED, true));
  });

  it('ほかの理由でつながらなければ、理由（エラーのコード）を添える', async () => {
    writeFileSync(join(root, 'file'), '');
    expect(await callBridge(join(root, 'file', 'x.sock'), request, 5000, CLOSED)).toEqual(textResult('tanacode につながりませんでした（ENOTDIR）', true));
  });

  it('返事が分かれて届いても、1 行そろってから読む', async () => {
    const path = await fakeApp((socket, line) => {
      const { id } = JSON.parse(line) as { id: number };
      const text = JSON.stringify({ id, result: textResult('分かれた返事') });
      socket.write(text.slice(0, 10));
      setTimeout(() => socket.write(`${text.slice(10)}\n`), 20);
    });
    expect(await callBridge(path, request, 5000, CLOSED)).toEqual(textResult('分かれた返事'));
  });

  it('読めない返事・違う呼び出しへの返事・結果の無い返事は、読めなかったとして返す', async () => {
    const replies = ['{壊れた', JSON.stringify({ id: 99, result: textResult('ほかの') }), JSON.stringify({ id: 1 })];
    const path = await fakeApp((socket) => socket.write(`${replies.shift()}\n`));
    for (let i = 0; i < 3; i++) expect(await callBridge(path, request, 5000, CLOSED)).toEqual(textResult('tanacode の返事を読めませんでした', true));
  });

  it('返事が無ければ、待つ上限で諦める。返事の前に切れたら、切れたと返す', async () => {
    const silent = await fakeApp(() => {});
    expect(await callBridge(silent, request, 100, CLOSED)).toEqual(textResult('tanacode から返事がありませんでした。アプリが止まっていないか確かめてください', true));
    servers.pop()?.close();
    const hangUp = await fakeApp((socket) => socket.end());
    expect(await callBridge(hangUp, request, 5000, CLOSED)).toEqual(textResult('tanacode との接続が切れました。もう一度試してください', true));
  });

  it('取り消されたら、待つのをやめてソケットを閉じる（アプリは待つのをやめる）', async () => {
    let signal: AbortSignal | null = null;
    const b = await bridge((_session, _tool, _args, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const cancel = new AbortController();
    const pending = callBridge(b.socketPath, request, 5000, CLOSED, cancel.signal);
    for (let i = 0; i < 50 && !signal; i++) await sleep(10);
    cancel.abort();
    expect(await pending).toEqual(textResult('取り消されました', true));
    for (let i = 0; i < 50 && !signal!.aborted; i++) await sleep(10);
    expect(signal!.aborted).toBe(true);
  });
});

describe('起動の引数', () => {
  const def: McpServerDef = {
    name: 'tanacode-test',
    title: 'テスト',
    instructions: '',
    tools: [
      { name: 'look', kind: 'read', label: '見る', description: '見る', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'run', kind: 'act', label: '動かす', description: '動かす', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    ],
  };
  const launch = { command: '/Apps/tanacode Helper', script: '/Apps/out/main/test-mcp.js', socketPath: '/u/test.sock', version: '1.2.0' };

  it('mcpServerEntry: 中継を Node として動かし、ソケットと版を環境変数で渡す。待つ上限は指定したときだけ。許可済みは読むだけのツール', () => {
    expect(mcpServerEntry(def, launch, { TANACODE_TEST_SOCKET: '/u/test.sock' })).toEqual({
      name: 'tanacode-test',
      config: {
        type: 'stdio',
        command: '/Apps/tanacode Helper',
        args: ['/Apps/out/main/test-mcp.js'],
        env: { ELECTRON_RUN_AS_NODE: '1', TANACODE_TEST_SOCKET: '/u/test.sock', TANACODE_VERSION: '1.2.0' },
      },
      allowed: ['mcp__tanacode-test__look'],
    });
    expect(mcpServerEntry(def, launch, {}, 1000).config.timeout).toBe(1000);
  });

  it('mcpArgs: サーバーが無ければ何も付けない', () => {
    expect(mcpArgs([])).toEqual([]);
  });
});

describe('中継の JSON-RPC', () => {
  const def: McpServerDef = {
    name: 'tanacode-test',
    title: 'テスト',
    instructions: '説明',
    tools: [{ name: 'look', kind: 'read', label: '見る', description: '見る', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  };
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const deps: RelayDeps = {
    server: def,
    version: '1.2.0',
    call: async (tool, args) => {
      calls.push({ tool, args });
      if (args.fail) throw new Error('アプリが止まりました');
      return textResult(`${tool} をしました`);
    },
  };
  beforeEach(() => {
    calls.length = 0;
  });

  it('respond: 求められた版を知っていればその版、知らなければ最初の版で答える。通知（id の無いもの）には答えない', async () => {
    const init = (protocolVersion?: unknown) => respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion } }, deps);
    expect(((await init('2024-11-05'))?.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
    expect(((await init('1999-01-01'))?.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
    expect(((await init(42))?.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
    expect(await respond({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeNull();
  });

  it('respond: tools/call は、名前の無い・知らないツールを断り、引数がオブジェクトでなければ空で渡す。知らないメソッドはエラー', async () => {
    expect(await respond({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, deps)).toEqual({ jsonrpc: '2.0', id: 1, result: textResult('知らないツールです: ', true) });
    expect(await respond({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'look', arguments: ['x'] } }, deps)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: textResult('look をしました'),
    });
    expect(calls).toEqual([{ tool: 'look', args: {} }]);
    expect(await respond({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, deps)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32601, message: 'Method not found: resources/list' },
    });
  });

  it('runRelay: 読めない行には Parse error、アプリの失敗には内部エラーを返す。空の行は飛ばす。標準入力が閉じたら知らせる', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    let text = '';
    output.on('data', (chunk: string) => (text += chunk));
    let closed = false;
    runRelay(input, output, deps, () => (closed = true));
    input.write('{壊れた\n');
    input.write('   \n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'look', arguments: { fail: true } } })}\n`);
    // id の無いもの（通知）には、返事を書かない（アプリにも渡さない）
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'look', arguments: { fail: true } } })}\n`);
    // 取り消しの requestId が数でも文字でもなければ、何もしない
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: { x: 1 } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'ping' })}\n`);
    await sleep(50);
    // 返事は、答えが出た順に書く（id で対応づく）
    const lines = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: string | null })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(lines).toEqual([
      { jsonrpc: '2.0', id: 'a', error: { code: -32603, message: 'Error: アプリが止まりました' } },
      { jsonrpc: '2.0', id: 'b', result: {} },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    ]);
    input.end();
    await sleep(20);
    expect(closed).toBe(true);
  });
});
