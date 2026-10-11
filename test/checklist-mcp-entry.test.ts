import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECKLIST_MCP } from '../src/shared/checklist-tools';
import { CHECKLIST_CLOSED_MESSAGE, CHECKLIST_SESSION_ENV, CHECKLIST_SOCKET_ENV } from '../src/main/checklist-bridge';
import type { RelayDeps } from '../src/main/mcp-relay';
import { textResult } from '../src/main/mcp-bridge';

// チェックリストの中継の入口（src/main/checklist-mcp.ts）。Claude Code が起動すると、読み込んだだけで動き出す。
// 中継（runRelay）・フック（runHook）・アプリとのソケット（callBridge）は差し替え、
// 入口が環境変数と引数から、何をどの値で呼ぶかを確かめる（フックそのものは checklist-hook.test.ts）

const mocks = vi.hoisted(() => ({ runRelay: vi.fn(), runHook: vi.fn(), callBridge: vi.fn() }));
vi.mock('../src/main/mcp-relay', () => ({ runRelay: mocks.runRelay }));
vi.mock('../src/main/checklist-hook', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/checklist-hook')>()),
  runHook: mocks.runHook,
}));
vi.mock('../src/main/mcp-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/mcp-bridge')>()),
  callBridge: mocks.callBridge,
}));

const ENV_KEYS = [CHECKLIST_SOCKET_ENV, CHECKLIST_SESSION_ENV, 'TANACODE_VERSION'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const savedArgv = process.argv;

let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules();
  mocks.runRelay.mockReset();
  mocks.runHook.mockReset();
  mocks.callBridge.mockReset();
  process.env[CHECKLIST_SOCKET_ENV] = '/u/Application Support/tanacode/checklist.sock';
  process.env[CHECKLIST_SESSION_ENV] = 'S1';
  process.env.TANACODE_VERSION = '1.2.3';
  process.argv = [savedArgv[0], '/Apps/app.asar/out/main/checklist-mcp.js'];
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.argv = savedArgv;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// 入口を読み込む（読み込んだだけで動き出す）
const start = () => import('../src/main/checklist-mcp');

describe('中継（MCP サーバー）として動く', () => {
  it('標準入出力で中継を動かし、ツールの呼び出しを、環境変数のソケットとセッションでアプリに運ぶ', async () => {
    await start();
    expect(mocks.runRelay).toHaveBeenCalledTimes(1);
    const [input, output, deps, onClose] = mocks.runRelay.mock.calls[0] as [unknown, unknown, RelayDeps, () => void];
    expect(input).toBe(process.stdin);
    expect(output).toBe(process.stdout);
    expect(deps.server).toEqual(CHECKLIST_MCP);
    expect(deps.version).toBe('1.2.3');
    expect(mocks.runHook).not.toHaveBeenCalled();
    mocks.callBridge.mockResolvedValue(textResult('Checked #1.'));
    const signal = new AbortController().signal;
    expect(await deps.call('card_check', { list: 'やること', numbers: '1' }, signal)).toEqual(textResult('Checked #1.'));
    expect(mocks.callBridge).toHaveBeenLastCalledWith(
      '/u/Application Support/tanacode/checklist.sock',
      { session: 'S1', tool: 'card_check', args: { list: 'やること', numbers: '1' } },
      30_000,
      CHECKLIST_CLOSED_MESSAGE,
      signal,
    );
    // Claude Code が終わって標準入力が閉じたら、中継も終わる
    expect(exit).not.toHaveBeenCalled();
    onClose();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('環境変数が無ければ、ソケットとセッションは空・バージョンは 0.0.0 で動く（アプリが「起動していない」と返す）', async () => {
    delete process.env[CHECKLIST_SOCKET_ENV];
    delete process.env[CHECKLIST_SESSION_ENV];
    delete process.env.TANACODE_VERSION;
    await start();
    const deps = mocks.runRelay.mock.calls[0][2] as RelayDeps;
    expect(deps.version).toBe('0.0.0');
    mocks.callBridge.mockResolvedValue(textResult(CHECKLIST_CLOSED_MESSAGE, true));
    const signal = new AbortController().signal;
    await deps.call('checklist_overview', {}, signal);
    expect(mocks.callBridge).toHaveBeenLastCalledWith('', { session: '', tool: 'checklist_overview', args: {} }, 30_000, CHECKLIST_CLOSED_MESSAGE, signal);
  });
});

describe('--hook を付けると、チェックリストを使い続けさせるフックとして動く', () => {
  // 標準入力の代わり。Claude Code は JSON を書いて閉じる
  const stdin = () => {
    const handlers: Record<string, (chunk?: string) => void> = {};
    vi.spyOn(process.stdin, 'setEncoding').mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation(((event: string, handler: (chunk?: string) => void) => {
      handlers[event] = handler;
      return process.stdin;
    }) as typeof process.stdin.on);
    return handlers;
  };
  const stdout = () => {
    const state: { written: string[]; flushed?: () => void } = { written: [] };
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, callback?: () => void) => {
      state.written.push(String(chunk));
      state.flushed = callback;
      return true;
    }) as typeof process.stdout.write);
    return state;
  };

  it('標準入力を読み終えてからアプリに聞き、答えを標準出力に書き終えたら終わる。中継は動かさない', async () => {
    process.argv = [...process.argv, '--hook'];
    const output = JSON.stringify({ decision: 'block', reason: '直して' });
    mocks.runHook.mockResolvedValue(output);
    const input = stdin();
    const out = stdout();
    await start();
    expect(mocks.runRelay).not.toHaveBeenCalled();
    expect(mocks.runHook).not.toHaveBeenCalled();
    input.data('{"hook_event_name":');
    input.data('"Stop"}');
    input.end();
    await vi.waitFor(() => expect(out.written).toEqual([`${output}\n`]));
    expect(mocks.runHook).toHaveBeenCalledWith('{"hook_event_name":"Stop"}', '/u/Application Support/tanacode/checklist.sock', 'S1', 5_000);
    // 書き終える前には終わらない（答えが途中で切れないように）
    expect(exit).not.toHaveBeenCalled();
    out.flushed?.();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('渡すものが無ければ、何も書かずに終わる', async () => {
    process.argv = [...process.argv, '--hook'];
    mocks.runHook.mockResolvedValue('');
    const input = stdin();
    const out = stdout();
    await start();
    input.end();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(out.written).toEqual([]);
  });
});
