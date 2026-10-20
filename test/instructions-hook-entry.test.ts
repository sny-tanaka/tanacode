import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTRUCTIONS_DIRS_ENV, INSTRUCTIONS_PROFILE_ENV } from '../src/main/instructions-launch';

// TANACODE.md を渡すフックの入口（src/main/instructions-hook.ts）。Claude Code が起動すると、読み込んだだけで動き出す。
// フックの本体（runInstructionsHook）は差し替え、入口が環境変数と標準入力から、何をどの値で呼び、何を書くかを確かめる
// （本体は project-instructions.test.ts、本物の Claude Code では test/cli/instructions.test.ts）

const mocks = vi.hoisted(() => ({ runInstructionsHook: vi.fn() }));
vi.mock('../src/main/project-instructions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/project-instructions')>()),
  runInstructionsHook: mocks.runInstructionsHook,
}));

const saved = process.env[INSTRUCTIONS_DIRS_ENV];
const savedProfile = process.env[INSTRUCTIONS_PROFILE_ENV];
let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules();
  mocks.runInstructionsHook.mockReset();
  process.env[INSTRUCTIONS_DIRS_ENV] = JSON.stringify(['/work/repo/.claude/worktrees/w1', '/work/repo']);
  process.env[INSTRUCTIONS_PROFILE_ENV] = '/Users/me/.claude-personal';
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env[INSTRUCTIONS_DIRS_ENV];
  else process.env[INSTRUCTIONS_DIRS_ENV] = saved;
  if (savedProfile === undefined) delete process.env[INSTRUCTIONS_PROFILE_ENV];
  else process.env[INSTRUCTIONS_PROFILE_ENV] = savedProfile;
});

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
const start = () => import('../src/main/instructions-hook');

describe('TANACODE.md を渡すフックの入口', () => {
  it('標準入力を読み終えてから、環境変数の探すフォルダ（セッションのフォルダとプロファイルのフォルダ）でフックを動かし、答えにアプリのフックの印を足して書き終えたら終わる', async () => {
    const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '<tanacode-instructions …>' } });
    mocks.runInstructionsHook.mockReturnValue(output);
    const input = stdin();
    const out = stdout();
    await start();
    expect(mocks.runInstructionsHook).not.toHaveBeenCalled();
    input.data('{"hook_event_name":');
    input.data('"SessionStart","source":"startup"}');
    input.end();
    expect(mocks.runInstructionsHook).toHaveBeenCalledWith('{"hook_event_name":"SessionStart","source":"startup"}', ['/work/repo/.claude/worktrees/w1', '/work/repo'], '/Users/me/.claude-personal');
    expect(out.written.map((w) => JSON.parse(w))).toEqual([{ ...JSON.parse(output), suppressOutput: true }]);
    // 書き終える前には終わらない（答えが途中で切れないように）
    expect(exit).not.toHaveBeenCalled();
    out.flushed?.();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('渡すものが無い・フックが投げた・探すフォルダが読めないときは、アプリのフックの印だけを書いて終わる（Claude の作業を止めない）', async () => {
    for (const [dirs, behave] of [
      [JSON.stringify(['/work']), () => ''],
      [JSON.stringify(['/work']), () => { throw new Error('読めない'); }],
      ['{', () => ''],
      [JSON.stringify(['/a', 3, '', null]), () => ''],
    ] as [string, () => string][]) {
      vi.resetModules();
      process.env[INSTRUCTIONS_DIRS_ENV] = dirs;
      mocks.runInstructionsHook.mockReset().mockImplementation(behave);
      const input = stdin();
      const out = stdout();
      await start();
      input.end();
      expect(out.written).toEqual(['{"suppressOutput":true}\n']);
    }
    expect(mocks.runInstructionsHook.mock.calls.at(-1)).toEqual(['', ['/a'], '/Users/me/.claude-personal']);
    delete process.env[INSTRUCTIONS_DIRS_ENV];
    delete process.env[INSTRUCTIONS_PROFILE_ENV];
    vi.resetModules();
    mocks.runInstructionsHook.mockReset().mockReturnValue('');
    const input = stdin();
    stdout();
    await start();
    input.end();
    expect(mocks.runInstructionsHook).toHaveBeenCalledWith('', [], null);
  });
});
