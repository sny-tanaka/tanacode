import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_MCP, TERMINAL_MCP_FOR_CHILD } from '../src/shared/terminal-tools';
import { textResult } from '../src/main/mcp-bridge';
import type { RelayDeps } from '../src/main/mcp-relay';
import { TERMINAL_CLOSED_MESSAGE } from '../src/main/terminal-bridge';

// 人のターミナルの中継の入口（src/main/terminal-mcp.ts）。Claude Code が起動すると、読み込んだだけで動き出す。
// 中継（runRelay）・フック（runTerminalGate）・アプリとのソケット（callBridge）は差し替え、
// 入口が環境変数と引数から、何をどの値で呼ぶかを確かめる（中継とフックそのものは terminal-mcp.test.ts）

const mocks = vi.hoisted(() => ({ runRelay: vi.fn(), runTerminalGate: vi.fn(), callBridge: vi.fn() }));
vi.mock('../src/main/mcp-relay', () => ({ runRelay: mocks.runRelay }));
vi.mock('../src/main/terminal-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/terminal-bridge')>()),
  runTerminalGate: mocks.runTerminalGate,
}));
vi.mock('../src/main/mcp-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/mcp-bridge')>()),
  callBridge: mocks.callBridge,
}));

const ENV_KEYS = ['TANACODE_TERMINAL_SOCKET', 'TANACODE_TERMINAL_SESSION', 'TANACODE_TERMINAL_CHILD', 'TANACODE_VERSION', 'TANACODE_LANGUAGE'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const savedArgv = process.argv;
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  mocks.runRelay.mockReset();
  mocks.runTerminalGate.mockReset();
  mocks.callBridge.mockReset();
  process.env.TANACODE_TERMINAL_SOCKET = '/u/terminal.sock';
  process.env.TANACODE_TERMINAL_SESSION = 'S1';
  delete process.env.TANACODE_TERMINAL_CHILD;
  process.env.TANACODE_VERSION = '1.2.3';
  process.argv = [savedArgv[0], '/Apps/app.asar/out/main/terminal-mcp.js'];
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

const start = () => import('../src/main/terminal-mcp');

it('中継として、ツールの呼び出しを環境変数のソケットとセッションでアプリに運ぶ。子には読むツールだけを見せる', async () => {
  await start();
  const [input, output, deps, onClose] = mocks.runRelay.mock.calls[0] as [unknown, unknown, RelayDeps, () => void];
  expect(input).toBe(process.stdin);
  expect(output).toBe(process.stdout);
  expect(deps.server).toEqual(TERMINAL_MCP);
  expect(deps.version).toBe('1.2.3');
  mocks.callBridge.mockResolvedValue(textResult('ok'));
  const signal = new AbortController().signal;
  expect(await deps.call('read_terminal', { id: 'shell-1' }, signal)).toEqual(textResult('ok'));
  expect(mocks.callBridge).toHaveBeenLastCalledWith('/u/terminal.sock', { session: 'S1', tool: 'read_terminal', args: { id: 'shell-1' } }, 30_000, TERMINAL_CLOSED_MESSAGE, signal);
  onClose();
  expect(exit).toHaveBeenCalledWith(0);

  vi.resetModules();
  process.env.TANACODE_TERMINAL_CHILD = '1';
  delete process.env.TANACODE_TERMINAL_SOCKET;
  delete process.env.TANACODE_TERMINAL_SESSION;
  delete process.env.TANACODE_VERSION;
  await start();
  const child = mocks.runRelay.mock.calls[1][2] as RelayDeps;
  expect(child.server).toEqual(TERMINAL_MCP_FOR_CHILD);
  expect(child.version).toBe('0.0.0');
  await child.call('list_terminals', {}, signal);
  expect(mocks.callBridge).toHaveBeenLastCalledWith('', { session: '', tool: 'list_terminals', args: {} }, 30_000, TERMINAL_CLOSED_MESSAGE, signal);
});

it('--gate では、標準入力のフックの入力を最後まで読んでアプリに確かめさせ、答えを書き終えてから終わる。理由はアプリの言語で書く', async () => {
  process.argv = [...process.argv, '--gate'];
  process.env.TANACODE_LANGUAGE = 'en';
  const stdin = new PassThrough();
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
  mocks.runTerminalGate.mockResolvedValue('{"hookSpecificOutput":{}}');
  const written: string[] = [];
  let flushed: (() => void) | undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, callback?: () => void) => {
    written.push(String(chunk));
    flushed = callback;
    return true;
  }) as typeof process.stdout.write);
  await start();
  stdin.write('{"tool_input":');
  stdin.end('{"id":"shell-1","text":"ls"}}');
  await vi.waitFor(() => expect(written).toEqual(['{"hookSpecificOutput":{}}\n']));
  expect(mocks.runTerminalGate).toHaveBeenCalledWith('/u/terminal.sock', 'S1', '{"tool_input":{"id":"shell-1","text":"ls"}}', 5_000);
  expect(mocks.runRelay).not.toHaveBeenCalled();
  const { language } = await import('../src/shared/i18n');
  expect(language()).toBe('en');
  expect(exit).not.toHaveBeenCalled();
  flushed?.();
  expect(exit).toHaveBeenCalledWith(0);
});

it('--gate で標準入力が閉じられないときも、上限を過ぎたらそこまでの入力で進める', async () => {
  vi.useFakeTimers();
  try {
    process.argv = [...process.argv, '--gate'];
    const stdin = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    mocks.runTerminalGate.mockResolvedValue('out');
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    await start();
    stdin.write('{"tool_input"');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.runTerminalGate).toHaveBeenCalledWith('/u/terminal.sock', 'S1', '{"tool_input"', 5_000);
  } finally {
    vi.useRealTimers();
  }
});
