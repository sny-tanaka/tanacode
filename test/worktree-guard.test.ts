import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '@shared/i18n';
import { toChatEvents, type TranscriptEntry } from '../src/shared/chat';
import { ownSettings } from '../src/main/statusline';
import { worktreeGuardCommand } from '../src/main/worktree-guard';

// Claude が worktree やブランチを消す操作の歯止め（アプリが --settings で足す、Bash の PreToolUse のフック）。
// macOS の awk（bwk awk）でも動くかは、TANACODE_AWK に入れた awk の場所で確かめられる（PATH の前に足す）

const run = (command: string, cwd = '/r/proj') =>
  execFileSync('sh', ['-c', worktreeGuardCommand()], {
    input: JSON.stringify({ session_id: 'x', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' } }),
    encoding: 'utf8',
    env: { ...process.env, PATH: [process.env.TANACODE_AWK, process.env.PATH].filter(Boolean).join(':') },
  });

describe('確認を出させるもの', () => {
  it.each([
    'git worktree remove --force .claude/worktrees/a',
    'git -C /r worktree remove -f x',
    'cd x && git branch -D foo',
    'git branch --delete --force foo',
    'git branch -d -f foo',
    'rm -rf .claude/worktrees/a',
    'rm -r -f /r/proj/.claude/worktrees',
    "sudo rm -fr '/r/.claude/worktrees/a'",
    'echo hi; rm -Rf "x/worktrees/y"',
    'git status\nrm -rf .claude/worktrees/b',
  ])('%s', (command) => {
    expect(JSON.parse(run(command))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: expect.stringContaining('tanacode') },
    });
  });

  it.each(['rm -rf .', 'rm -rf ..', 'rm -rf ../b', 'rm -rf *', 'rm -rf /r/proj/.claude/worktrees/a'])('worktree の中で %s', (command) => {
    expect(run(command, '/r/proj/.claude/worktrees/a')).toContain('"ask"');
  });
});

describe('何もしないもの', () => {
  it.each([
    'git worktree remove .claude/worktrees/a',
    'git branch -d foo',
    'rm -rf node_modules',
    'rm .claude/worktrees/a/x.txt',
    'git worktree list',
    'ls -la',
    'rm -rf .',
    'git push --force',
  ])('%s', (command) => {
    expect(run(command)).toBe('');
  });

  it('worktree の中でも、ほかのフォルダの rm -rf はそのまま', () => {
    expect(run('rm -rf dist', '/r/proj/.claude/worktrees/a')).toBe('');
  });
});

describe('確認の理由の言語', () => {
  afterEach(() => setLanguage('ja'));

  it('Claude Code を起動するときの言語で理由を書く（英語でも JSON として読める）', () => {
    setLanguage('en');
    const out = JSON.parse(run('git branch -D foo')) as { hookSpecificOutput: { permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(t('main.hooks.worktreeGuard'));
  });
});

describe('設定', () => {
  it('アプリが起動する Claude Code の Bash の PreToolUse に足す', () => {
    const hooks = (ownSettings(null) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } }).hooks.PreToolUse;
    expect(hooks.find((h) => h.matcher === 'Bash')?.hooks[0].command).toBe(worktreeGuardCommand());
  });

  it('アプリが足したフックなので、チャットのフックの一覧に出さない', () => {
    const entry = {
      type: 'attachment',
      uuid: 'u',
      attachment: { type: 'hook_success', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', command: worktreeGuardCommand(), stdout: '{}', toolUseID: 't' },
    } as unknown as TranscriptEntry;
    expect(toChatEvents(entry, '/r', false, () => '')).toEqual([]);
  });
});
