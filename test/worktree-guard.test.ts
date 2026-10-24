import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '@shared/i18n';
import { toChatEvents, type TranscriptEntry } from '../src/shared/chat';
import { SUPPRESS_OUTPUT } from '../src/main/hook-output';
import { ownSettings } from '../src/main/statusline';
import { worktreeGuardCommand, worktreeGuardEnv } from '../src/main/worktree-guard';
import { buildRelay } from './cli/browser-relay-build';

// Claude が worktree やブランチを消す操作の歯止め（アプリが --settings で足す、Bash の PreToolUse のフック）。
// 確かめの入り口の環境変数が無いとき（はじめの 2 つの describe）は、awk が決めたとおりに確認を出させる。
// macOS の awk（bwk awk）でも動くかは、TANACODE_AWK に入れた awk の場所で確かめられる（PATH の前に足す）

// 何も決めないとき（アプリのフックの印だけを書く。hook-output.ts）
const NOTHING = `${SUPPRESS_OUTPUT}\n`;
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
      suppressOutput: true,
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
    expect(run(command)).toBe(NOTHING);
  });

  it('worktree の中でも、ほかのフォルダの rm -rf はそのまま', () => {
    expect(run('rm -rf dist', '/r/proj/.claude/worktrees/a')).toBe(NOTHING);
  });
});

// awk が確認を出させると決めたものを、確かめの入り口（worktree-guard-hook.ts をアプリと同じく 1 つの JS にまとめたもの）で確かめる。
// アプリでは tanacode 本体を Node として動かす。ここでは node で動かす。gh は、調べられない（失敗する）ものに差し替える
describe('確かめの入り口があるとき', () => {
  let dir: string;
  let repo: string;
  let script: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-qm', file);
  };
  const verified = (command: string, cwd = repo) =>
    execFileSync('sh', ['-c', worktreeGuardCommand()], {
      input: JSON.stringify({ session_id: 'x', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' } }),
      encoding: 'utf8',
      env: {
        ...process.env,
        ...worktreeGuardEnv({ command: process.execPath, script }),
        PATH: [process.env.TANACODE_AWK, join(dir, 'bin'), process.env.PATH].filter(Boolean).join(':'),
      },
    });

  beforeAll(async () => {
    script = await buildRelay('worktree-guard-hook');
  }, 60_000);

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-guard-hook-')));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const origin = join(dir, 'origin.git');
    repo = join(dir, 'repo');
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'me@example.com');
    git(repo, 'config', 'user.name', 'me');
    git(repo, 'config', 'gc.auto', '0');
    git(repo, 'remote', 'add', 'origin', origin);
    commit(repo, 'a.txt');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('worktree でないものの rm -rf・文字列の中に出てくるだけのものは、確認を出させない', () => {
    for (const command of [
      'rm -rf ~/.claude-personal/projects/-Users-me-work-tanacode--claude-worktrees-tc-1024-abcd',
      "perl -0pi -e 's/git worktree remove --force x/y/' GUIDE.md",
      'git commit -m "あとで git branch -D foo する"',
    ]) {
      expect({ command, out: verified(command) }).toEqual({ command, out: NOTHING });
    }
  });

  it('origin の同じ名前のブランチと同じブランチの git branch -D は、確認を出させない', () => {
    git(repo, 'switch', '-q', '-c', 'release/v2.0.0');
    commit(repo, 'b.txt');
    git(repo, 'push', '-q', '-u', 'origin', 'release/v2.0.0');
    git(repo, 'switch', '-q', 'main');
    expect(verified('git pull && git branch -D release/v2.0.0')).toBe(NOTHING);
  });

  it('手元にしか無いコミットのあるブランチの git branch -D は、今までどおり確認を出させる', () => {
    git(repo, 'switch', '-q', '-c', 'fix/x');
    commit(repo, 'b.txt');
    git(repo, 'switch', '-q', 'main');
    expect(JSON.parse(verified('git branch -D fix/x'))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
  });

  it('変更の残っていない worktree の git worktree remove --force は確認を出させず、未追跡のファイルが残っていれば出させる', () => {
    const path = join(repo, '.claude', 'worktrees', 'tc-1');
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-tc-1', path);
    expect(verified('git worktree remove --force .claude/worktrees/tc-1')).toBe(NOTHING);
    writeFileSync(join(path, 'new.txt'), 'x\n');
    expect(verified('git worktree remove --force .claude/worktrees/tc-1')).toContain('"ask"');
  });

  it('worktree の rm -rf は、今までどおり確かめずに確認を出させる', () => {
    expect(verified('rm -rf .claude/worktrees/a')).toContain('"ask"');
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
