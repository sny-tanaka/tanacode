import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PullRequest, pullRequestsOf } from '../src/main/github';
import { guardActions, verifyCommand } from '../src/main/worktree-guard-check';

// worktree-guard の awk が確認を出させると決めたコマンドを、読み直して確かめるところ（worktree-guard-check.ts）。
// コマンドの読み方と、本物の git のリポジトリでの確かめ。PR（gh で GitHub に問い合わせるところ）は差し替える

vi.mock('../src/main/github', () => ({ pullRequestsOf: vi.fn() }));
const prs = vi.mocked(pullRequestsOf);

// 取り出したもののうち、比べやすいところ
const kinds = (command: string, cwd = '/r/proj') =>
  guardActions(command, cwd).map((a) =>
    a.kind === 'ask' ? 'ask' : `${a.kind}@${a.cwd}${a.extra ? '+extra' : ''}:${(a.kind === 'branch' ? a.names : a.paths).map((w) => (w.literal ? w.text : `?${w.text}`)).join(',')}`,
  );

describe('コマンドの読み方', () => {
  it.each([
    // 文字列の中に出てくるだけのもの
    ["perl -0pi -e 's/git worktree remove --force x/y/' a.md", []],
    ['git commit -m "git branch -D foo"', []],
    ["echo 'rm -rf .claude/worktrees/a'", []],
    ["gh pr create --body \"$(cat <<'EOF'\nあとで git branch -D fix/x と git worktree remove --force .claude/worktrees/a をする\nEOF\n)\"", []],
    ['cat > notes.md <<EOF\ngit branch -D foo\nEOF', []],
    // worktree でないものの rm -rf（パスの区切りに worktrees が無い）
    ['rm -rf ~/.claude-personal/projects/-Users-me-work-tanacode--claude-worktrees-tc-1024-abcd', []],
    ['rm -rf /tmp/my-worktrees-backup', []],
    // 確かめなくてよいもの
    ['git worktree remove .claude/worktrees/a', []],
    ['git branch -d foo', []],
  ])('%s', (command, expected) => {
    expect(kinds(command)).toEqual(expected);
  });

  it.each([
    ['git branch -D foo', ['branch@/r/proj:foo']],
    ['git branch --delete --force foo bar', ['branch@/r/proj:foo,bar']],
    ['git branch -d -f foo', ['branch@/r/proj:foo']],
    ['gh pr merge 12 --squash && git pull && git branch -D fix/xxx', ['branch@/r/proj:fix/xxx']],
    ['cd /r/other && git branch -D foo', ['branch@/r/other:foo']],
    ['git -C ../x branch -D foo', ['branch@/r/x:foo']],
    ['git worktree remove --force .claude/worktrees/a && git branch -D worktree-a', ['worktree@/r/proj:.claude/worktrees/a', 'branch@/r/proj:worktree-a']],
    ['git worktree remove -f "/r/proj/.claude/worktrees/b"', ['worktree@/r/proj:/r/proj/.claude/worktrees/b']],
    // 名前が変数で決まる・引数が足される・フォルダが分からない
    ['git branch -D "$b"', ['branch@/r/proj:?$b']],
    ['git branch --merged | xargs git branch -D', ['branch@/r/proj+extra:']],
    ['cd "$X" && git branch -D foo', ['branch@null:foo']],
    // シェルに渡す文字列・コマンド置換の中は読む
    ["bash -c 'git branch -D foo'", ['branch@/r/proj:foo']],
    ['echo $(git branch -D foo)', ['branch@/r/proj:foo']],
    ['sudo git worktree remove --force .claude/worktrees/a', ['worktree@/r/proj:.claude/worktrees/a']],
    ['bash <<EOF\ngit branch -D foo\nEOF', ['branch@/r/proj:foo']],
  ])('%s', (command, expected) => {
    expect(kinds(command)).toEqual(expected);
  });

  it.each([
    'rm -rf .claude/worktrees/a',
    'rm -r -f /r/proj/.claude/worktrees',
    'echo hi; rm -Rf "x/worktrees/y"',
    'rm -rf $HOME/.claude/worktrees/a',
    'git branch -rD origin/foo',
    "ssh host 'git branch -D foo'",
    'find .claude/worktrees -maxdepth 1 -exec rm -rf {} +',
    // 読めないもの
    "git branch -D 'foo",
  ])('確かめずに確認を出させる: %s', (command) => {
    expect(kinds(command)).toContain('ask');
  });

  it.each(['rm -rf .', 'rm -rf ..', 'rm -rf ../b', 'rm -rf *', 'rm -rf /r/proj/.claude/worktrees/a'])('worktree の中で %s', (command) => {
    expect(kinds(command, '/r/proj/.claude/worktrees/a')).toEqual(['ask']);
  });

  it('~ はホームのフォルダ', () => {
    expect(kinds('cd ~/x && git branch -D foo')).toEqual([`branch@${join(homedir(), 'x')}:foo`]);
  });
});

describe('確かめ', () => {
  let root: string;
  let repo: string;
  let origin: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-qm', file);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const pr = (fields: Partial<PullRequest>): PullRequest => ({ number: 1, state: 'MERGED', headRefOid: '', baseRefName: 'main', url: 'https://github.com/o/r/pull/1', ...fields });

  beforeEach(() => {
    prs.mockReset().mockResolvedValue(null);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-guard-')));
    origin = join(root, 'origin.git');
    repo = join(root, 'repo');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'me@example.com');
    git(repo, 'config', 'user.name', 'me');
    git(repo, 'config', 'gc.auto', '0');
    git(repo, 'remote', 'add', 'origin', origin);
    commit(repo, 'a.txt');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('マージ済みの PR の head のブランチ（リモートのブランチはもう無い）は、確認を出させない', async () => {
    git(repo, 'switch', '-q', '-c', 'fix/x');
    const head = commit(repo, 'b.txt');
    git(repo, 'switch', '-q', 'main');
    prs.mockResolvedValue([pr({ headRefOid: head, commits: [{ oid: head }] })]);
    expect(await verifyCommand('gh pr merge 1 --squash && git pull && git branch -D fix/x', repo)).toBe('pass');
  });

  it('origin の同じ名前のブランチと同じなら、gh で調べられなくても確認を出させない', async () => {
    git(repo, 'switch', '-q', '-c', 'release/v2.0.0');
    commit(repo, 'b.txt');
    git(repo, 'push', '-q', '-u', 'origin', 'release/v2.0.0');
    git(repo, 'switch', '-q', 'main');
    expect(await verifyCommand('git branch -D release/v2.0.0', repo)).toBe('pass');
  });

  it('手元にしか無いコミットのあるブランチは、確認を出させる', async () => {
    git(repo, 'switch', '-q', '-c', 'fix/y');
    const head = commit(repo, 'b.txt');
    commit(repo, 'c.txt');
    git(repo, 'switch', '-q', 'main');
    // PR の head より先に、手元で足したコミットがある
    prs.mockResolvedValue([pr({ headRefOid: head, commits: [{ oid: head }] })]);
    expect(await verifyCommand('git branch -D fix/y', repo)).toBe('ask');
  });

  it.each(['git branch -D a b', 'git branch -D a && git branch -D b'])('一緒に消すブランチどうしが同じコミットを持っていても、両方を消すなら確認を出させる: %s', async (command) => {
    git(repo, 'switch', '-q', '-c', 'a');
    commit(repo, 'b.txt');
    git(repo, 'branch', 'b');
    git(repo, 'switch', '-q', 'main');
    expect(await verifyCommand(command, repo)).toBe('ask');
  });

  it('幹のブランチは、確認を出させる', async () => {
    git(repo, 'switch', '-q', '-c', 'develop');
    git(repo, 'push', '-q', '-u', 'origin', 'develop');
    git(repo, 'switch', '-q', 'main');
    expect(await verifyCommand('git branch -D develop', repo)).toBe('ask');
  });

  it('名前が変数で決まるものは、確認を出させる', async () => {
    expect(await verifyCommand('git branch -D "$b"', repo)).toBe('ask');
  });

  it('文字列の中に出てくるだけのものは、確かめずに通す', async () => {
    expect(await verifyCommand("perl -0pi -e 's/git worktree remove --force x/y/' a.md", repo)).toBe('pass');
  });

  describe('git worktree remove --force', () => {
    const add = (name: string) => {
      const path = join(repo, '.claude', 'worktrees', name);
      git(repo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, path);
      git(repo, 'worktree', 'lock', '--reason', `claude session ${name} (pid 99999 start 1)`, path);
      return path;
    };

    it('変更の残っていない worktree と、そのブランチ（PR に入っている）は、確認を出させない', async () => {
      const path = add('tc-1');
      const head = commit(path, 'b.txt');
      prs.mockResolvedValue([pr({ headRefOid: head, commits: [{ oid: head }] })]);
      expect(await verifyCommand('git worktree remove --force .claude/worktrees/tc-1 && git branch -D worktree-tc-1', repo)).toBe('pass');
    });

    it('未追跡のファイルが残っていれば、確認を出させる', async () => {
      const path = add('tc-2');
      writeFileSync(join(path, 'new.txt'), 'x\n');
      expect(await verifyCommand(`git worktree remove --force ${path}`, repo)).toBe('ask');
    });

    it('未コミットの変更が残っていれば、確認を出させる', async () => {
      const path = add('tc-3');
      writeFileSync(join(path, 'a.txt'), 'changed\n');
      expect(await verifyCommand('git worktree remove --force .claude/worktrees/tc-3', repo)).toBe('ask');
    });

    it('どこからも辿れない detached HEAD のコミットがあれば、確認を出させる', async () => {
      const path = add('tc-4');
      git(path, 'switch', '-q', '--detach');
      commit(path, 'b.txt');
      expect(await verifyCommand('git worktree remove --force .claude/worktrees/tc-4', repo)).toBe('ask');
    });

    it('人が付けたロックがあれば、確認を出させる', async () => {
      const path = join(repo, '.claude', 'worktrees', 'tc-5');
      git(repo, 'worktree', 'add', '-q', '-b', 'worktree-tc-5', path);
      git(repo, 'worktree', 'lock', '--reason', 'keep', path);
      expect(await verifyCommand('git worktree remove --force .claude/worktrees/tc-5', repo)).toBe('ask');
    });

    it('.claude/worktrees の下でない worktree は、確認を出させる', async () => {
      const path = join(root, 'elsewhere');
      git(repo, 'worktree', 'add', '-q', '-b', 'elsewhere', path);
      expect(await verifyCommand(`git worktree remove --force ${path}`, repo)).toBe('ask');
    });

    it('ブランチを一緒に消すとき、そのブランチに手元にしか無いコミットがあれば、確認を出させる', async () => {
      const path = add('tc-6');
      commit(path, 'b.txt');
      expect(await verifyCommand('git worktree remove --force .claude/worktrees/tc-6 && git branch -D worktree-tc-6', repo)).toBe('ask');
      // worktree だけなら、ブランチは残るので失うものは無い
      expect(await verifyCommand('git worktree remove --force .claude/worktrees/tc-6', repo)).toBe('pass');
    });
  });
});
