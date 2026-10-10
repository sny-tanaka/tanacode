import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_ASK_TIMEOUT_MS, BROWSER_ASK_TOOL, BROWSER_MCP } from '../src/shared/browser-tools';
import { BROWSER_CLOSED_MESSAGE, BROWSER_SESSION_ENV, BROWSER_SOCKET_ENV } from '../src/main/browser-bridge';
import type { RelayDeps } from '../src/main/mcp-relay';
import { textResult } from '../src/main/mcp-bridge';

// アプリ内ブラウザの中継の入口（src/main/browser-mcp.ts）。Claude Code が起動すると、読み込んだだけで動き出す。
// 中継（runRelay）・フック（runGate）・アプリとのソケット（callBridge）は差し替え、
// 入口が環境変数と引数から、何をどの値で呼ぶかを確かめる（中継そのものは browser-mcp.test.ts）

const mocks = vi.hoisted(() => ({ runRelay: vi.fn(), runGate: vi.fn(), callBridge: vi.fn() }));
vi.mock('../src/main/mcp-relay', () => ({ runRelay: mocks.runRelay }));
vi.mock('../src/main/browser-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/browser-gate')>()),
  runGate: mocks.runGate,
}));
vi.mock('../src/main/mcp-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/mcp-bridge')>()),
  callBridge: mocks.callBridge,
}));

const ENV_KEYS = [BROWSER_SOCKET_ENV, BROWSER_SESSION_ENV, 'TANACODE_VERSION'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const savedArgv = process.argv;

let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules();
  mocks.runRelay.mockReset();
  mocks.runGate.mockReset();
  mocks.callBridge.mockReset();
  process.env[BROWSER_SOCKET_ENV] = '/u/Application Support/tanacode/browser.sock';
  process.env[BROWSER_SESSION_ENV] = 'S1';
  process.env.TANACODE_VERSION = '1.2.3';
  process.argv = [savedArgv[0], '/Apps/app.asar/out/main/browser-mcp.js'];
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
const start = () => import('../src/main/browser-mcp');

describe('中継（MCP サーバー）として動く', () => {
  it('標準入出力で中継を動かし、ツールの呼び出しを、環境変数のソケットとセッションでアプリに運ぶ', async () => {
    await start();
    expect(mocks.runRelay).toHaveBeenCalledTimes(1);
    const [input, output, deps, onClose] = mocks.runRelay.mock.calls[0] as [unknown, unknown, RelayDeps, () => void];
    expect(input).toBe(process.stdin);
    expect(output).toBe(process.stdout);
    expect(deps.server).toEqual(BROWSER_MCP);
    expect(deps.version).toBe('1.2.3');
    expect(mocks.runGate).not.toHaveBeenCalled();

    mocks.callBridge.mockResolvedValue(textResult('Clicked: button#go'));
    const signal = new AbortController().signal;
    expect(await deps.call('click', { selector: '#go' }, signal)).toEqual(textResult('Clicked: button#go'));
    expect(mocks.callBridge).toHaveBeenLastCalledWith(
      '/u/Application Support/tanacode/browser.sock',
      { session: 'S1', tool: 'click', args: { selector: '#go' } },
      90_000,
      BROWSER_CLOSED_MESSAGE,
      signal,
    );
    // ユーザーに操作を頼むものは、アプリの時間切れ（10 分）より少し長く待つ
    await deps.call(BROWSER_ASK_TOOL, { message: 'ログインしてください' }, signal);
    expect(mocks.callBridge).toHaveBeenLastCalledWith(
      '/u/Application Support/tanacode/browser.sock',
      { session: 'S1', tool: BROWSER_ASK_TOOL, args: { message: 'ログインしてください' } },
      BROWSER_ASK_TIMEOUT_MS + 30_000,
      BROWSER_CLOSED_MESSAGE,
      signal,
    );
    // Claude Code が終わって標準入力が閉じたら、中継も終わる
    expect(exit).not.toHaveBeenCalled();
    onClose();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('環境変数が無ければ、ソケットとセッションは空・版は 0.0.0 で動く（アプリが「起動していない」と返す）', async () => {
    delete process.env[BROWSER_SOCKET_ENV];
    delete process.env[BROWSER_SESSION_ENV];
    delete process.env.TANACODE_VERSION;
    await start();
    const deps = mocks.runRelay.mock.calls[0][2] as RelayDeps;
    expect(deps.version).toBe('0.0.0');
    mocks.callBridge.mockResolvedValue(textResult(BROWSER_CLOSED_MESSAGE, true));
    const signal = new AbortController().signal;
    expect(await deps.call('get_text', {}, signal)).toEqual(textResult(BROWSER_CLOSED_MESSAGE, true));
    expect(mocks.callBridge).toHaveBeenLastCalledWith('', { session: '', tool: 'get_text', args: {} }, 90_000, BROWSER_CLOSED_MESSAGE, signal);
  });
});

describe('--gate を付けると、JavaScript の実行の確認のフックとして動く', () => {
  it('アプリに今のページを聞いた答えを標準出力に書き、書き終えたら終わる。中継は動かさない', async () => {
    process.argv = [...process.argv, '--gate'];
    const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
    mocks.runGate.mockResolvedValue(output);
    const written: string[] = [];
    let flushed: (() => void) | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, callback?: () => void) => {
      written.push(String(chunk));
      flushed = callback;
      return true;
    }) as typeof process.stdout.write);
    await start();
    await vi.waitFor(() => expect(written).toEqual([`${output}\n`]));
    expect(mocks.runGate).toHaveBeenCalledWith('/u/Application Support/tanacode/browser.sock', 'S1', 5_000);
    expect(mocks.runRelay).not.toHaveBeenCalled();
    // 書き終える前には終わらない（答えが途中で切れないように）
    expect(exit).not.toHaveBeenCalled();
    flushed?.();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
