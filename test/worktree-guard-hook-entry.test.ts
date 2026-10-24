import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// worktree-guard の確かめの入り口（src/main/worktree-guard-hook.ts）。フックのシェルが動かすと、読み込んだだけで動き出す。
// 確かめの本体（verifyCommand）と、子のプロセスを止める pkill は差し替え、入口が標準入力から何をどの値で呼び、何を書くかを確かめる
// （本体は worktree-guard-check.test.ts、ビルドしたものをフックのシェルから動かすのは worktree-guard.test.ts）

const mocks = vi.hoisted(() => ({ verifyCommand: vi.fn(), execFileSync: vi.fn() }));
vi.mock('../src/main/worktree-guard-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/worktree-guard-check')>()),
  verifyCommand: mocks.verifyCommand,
}));
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), execFileSync: mocks.execFileSync }));

let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules();
  mocks.verifyCommand.mockReset();
  mocks.execFileSync.mockReset();
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// 標準入力の代わり
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
  const state: { written: string[] } = { written: [] };
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, callback?: () => void) => {
    state.written.push(String(chunk));
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  return state;
};
const start = () => import('../src/main/worktree-guard-hook');
const input = (value: unknown) => JSON.stringify({ session_id: 'x', hook_event_name: 'PreToolUse', tool_name: 'Bash', ...(value as object) });

describe('worktree-guard の確かめの入り口', () => {
  it('標準入力を読み終えてから、コマンドとフォルダで確かめ、答えを書いて終わる', async () => {
    mocks.verifyCommand.mockResolvedValue('pass');
    const handlers = stdin();
    const out = stdout();
    await start();
    handlers.data(input({ cwd: '/r/proj', tool_input: { command: 'git branch -D x' } }));
    expect(mocks.verifyCommand).not.toHaveBeenCalled();
    handlers.end();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(mocks.verifyCommand).toHaveBeenCalledWith('git branch -D x', '/r/proj');
    expect(out.written).toEqual(['pass\n']);
  });

  it.each([
    ['JSON でない', '{'],
    ['コマンドが無い', input({ cwd: '/r/proj', tool_input: {} })],
    ['フォルダが無い', input({ tool_input: { command: 'git branch -D x' } })],
    ['フォルダが空', input({ cwd: '', tool_input: { command: 'git branch -D x' } })],
  ])('読めないとき（%s）は ask', async (_, text) => {
    const handlers = stdin();
    const out = stdout();
    await start();
    handlers.data(text);
    handlers.end();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(mocks.verifyCommand).not.toHaveBeenCalled();
    expect(out.written).toEqual(['ask\n']);
  });

  it('確かめが失敗したら ask', async () => {
    mocks.verifyCommand.mockRejectedValue(new Error('git が無い'));
    const handlers = stdin();
    const out = stdout();
    await start();
    handlers.data(input({ cwd: '/r/proj', tool_input: { command: 'git branch -D x' } }));
    handlers.end();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(out.written).toEqual(['ask\n']);
  });

  it('時間切れになったら、動かしている子のプロセスを止めて ask', async () => {
    vi.useFakeTimers();
    mocks.verifyCommand.mockReturnValue(new Promise(() => {}));
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('子が無い');
    });
    const handlers = stdin();
    const out = stdout();
    await start();
    handlers.data(input({ cwd: '/r/proj', tool_input: { command: 'git branch -D x' } }));
    handlers.end();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.execFileSync).toHaveBeenCalledWith('pkill', ['-TERM', '-P', String(process.pid)], { stdio: 'ignore' });
    expect(out.written).toEqual(['ask\n']);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
