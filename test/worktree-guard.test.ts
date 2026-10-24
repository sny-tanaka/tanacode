import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '@shared/i18n';
import { toChatEvents, type TranscriptEntry } from '../src/shared/chat';
import { SUPPRESS_OUTPUT } from '../src/main/hook-output';
import { ownSettings } from '../src/main/statusline';
import { worktreeGuardCommand } from '../src/main/worktree-guard';
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
    // グロブ・中括弧・変数を含み、worktrees の入る区切り
    'rm -rf .claude/worktrees*',
    'rm -rf .claude/worktrees{,}',
    'rm -rf $HOME/.claude/worktrees/a',
    'rm -rf "$W"worktrees',
  ])('%s', (command) => {
    expect(JSON.parse(run(command))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: expect.stringContaining('tanacode') },
      suppressOutput: true,
    });
  });

  it.each(['rm -rf .', 'rm -rf ..', 'rm -rf ../b', 'rm -rf *', 'rm -rf /r/proj/.claude/worktrees/a'])('worktree の中で %s', (command) => {
    expect(run(command, '/r/proj/.claude/worktrees/a')).toContain('"ask"');
  });

  // 消す先や消し方を awk で確かめられない形。コマンドのどこかに worktree か .claude の文字があれば、確認を出させる（系統ごとに 1 つ）
  it.each([
    // $(…)・バッククォート
    'rm -rf $(echo .claude/worktrees/a)',
    'rm -rf `echo .claude/worktrees/a`',
    // 変数（タブなどの区切りを変数で入れるものも）
    'X=.claude/worktrees/a; rm -rf $X',
    'rm${IFS}-rf${IFS}.claude/worktrees/a',
    // \ での行の継ぎ
    'rm -rf \\\n.claude/worktrees/a',
    // ほかのコマンドが消す
    'echo .claude/worktrees/a | xargs rm -rf',
    'find .claude/worktrees/a -delete',
    // 先に cd してから消す
    'cd .claude/worktrees && rm -rf a',
    // .claude ごと・グロブ
    'rm -rf .claude',
    'rm -rf .claude/*/a',
    // 長いオプションの省略形
    'rm --rec .claude/worktrees/a',
    'git branch --del --forc foo',
    // git の引数を確かめられないもの
    'git branch -$(echo D) worktree-a',
  ])('確かめられない形: %s', (command) => {
    expect(run(command)).toContain('"ask"');
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
    // パスの一部に worktrees という文字が入るだけのフォルダ（区切りがちょうど worktrees ではない）
    'rm -rf ~/.claude-personal/projects/-Users-me-work-tanacode--claude-worktrees-tc-1024-abcd',
    'rm -rf /tmp/my-worktrees-backup x/worktrees2',
  ])('%s', (command) => {
    expect(run(command)).toBe(NOTHING);
  });

  it('worktree の中でも、ほかのフォルダの rm -rf はそのまま', () => {
    expect(run('rm -rf dist', '/r/proj/.claude/worktrees/a')).toBe(NOTHING);
  });

  // 確かめられない形でも、コマンドに worktree か .claude の文字が無ければ、今のフォルダが worktree の中でも確認を出させない
  // （ふだんの片付けのたびに確認が出ないように）
  it.each(['rm -rf "$tmp"', 'tmp=$(mktemp -d) && rm -rf "$tmp"', 'cd sub && rm -rf dist', 'rm -rf dist/*', "find . -name '*.log' -delete"])(
    'worktree の中で %s',
    (command) => {
      expect(run(command, '/r/proj/.claude/worktrees/a')).toBe(NOTHING);
    },
  );

  it.each(['git worktree add "$p" -b x', 'rm -rf .claude/tmp', 'ls .claude && rm -rf dist'])('%s', (command) => {
    expect(run(command)).toBe(NOTHING);
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
  const verified = (command: string, cwd = repo, launch = { command: process.execPath, script }) =>
    execFileSync('sh', ['-c', worktreeGuardCommand(launch)], {
      input: JSON.stringify({ session_id: 'x', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' } }),
      encoding: 'utf8',
      env: {
        ...process.env,
        // Node の動きを変える環境変数は、入り口には渡さない（渡れば、読み込めないファイルで node が落ちて ask になる）
        NODE_OPTIONS: '--require /nonexistent/x.js',
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

  it('消す操作のほかのコマンドが入ったもの（文字列の中に出てくるだけのものも）は、確認を出させる', () => {
    for (const command of [
      "echo 'git worktree remove --force x' > note.txt",
      'git commit -m "あとで git branch -D foo する"',
      "perl -0pi -e 's/git worktree remove --force x/y/' GUIDE.md",
      'git status && git branch -D no-such-branch',
    ]) {
      expect({ command, out: verified(command) }).toEqual({ command, out: expect.stringContaining('"ask"') });
    }
  });

  it('入り口が無い・場所を単一引用符で囲めないときは、確かめずに確認を出させる', () => {
    const command = 'git branch -D no-such-branch';
    expect(verified(command)).toBe(NOTHING);
    expect(verified(command, repo, { command: process.execPath, script: join(dir, 'none.js') })).toContain('"ask"');
    expect(verified(command, repo, { command: "/x/it's/node", script })).toContain('"ask"');
  });

  it('origin の同じ名前のブランチと同じブランチの git branch -D は、確認を出させない', () => {
    git(repo, 'switch', '-q', '-c', 'release/v2.0.0');
    commit(repo, 'b.txt');
    git(repo, 'push', '-q', '-u', 'origin', 'release/v2.0.0');
    git(repo, 'switch', '-q', 'main');
    expect(verified('git branch -D release/v2.0.0')).toBe(NOTHING);
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

  it('先頭の cd と消す操作だけで失うものが無ければ、今までどおり確認を出させず、確かめられない形は確認を出させる', () => {
    const path = join(repo, '.claude', 'worktrees', 'tc-1');
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-tc-1', path);
    expect(verified(`cd ${repo} && git worktree remove --force .claude/worktrees/tc-1 && git branch -D worktree-tc-1`, path)).toBe(NOTHING);
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-tc-2', join(repo, '.claude', 'worktrees', 'tc-2'));
    expect(verified('git worktree remove --force $(echo .claude/worktrees/tc-2)')).toContain('"ask"');
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
