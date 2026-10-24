import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PullRequest, pullRequestsOf } from '../src/main/github';
import { guardDeletes, verifyCommand } from '../src/main/worktree-guard-check';

// worktree-guard の awk が確認を出させると決めたコマンドを、読み直して確かめるところ（worktree-guard-check.ts）。
// コマンドの読み方と、本物の git のリポジトリでの確かめ。PR（gh で GitHub に問い合わせるところ）は差し替える

vi.mock('../src/main/github', () => ({ pullRequestsOf: vi.fn() }));
const prs = vi.mocked(pullRequestsOf);

// 取り出した消す操作（許す形でなければ 'ask'）
const read = (command: string, cwd = '/r/proj') => {
  const deletes = guardDeletes(command, cwd);
  if (deletes === null) return 'ask';
  return deletes.map((d) => (d.kind === 'branch' ? `branch@${d.cwd}:${d.names.join(',')}` : `worktree@${d.cwd}:${d.path}${d.forces > 1 ? `×${d.forces}` : ''}`));
};

describe('コマンドの読み方', () => {
  it.each([
    // 文字列の中に出てくるだけのもの
    "echo 'git branch -D foo'",
    'git commit -m "git branch -D foo"',
    "echo 'rm -rf .claude/worktrees/a' > note.txt",
    "gh pr create --body \"$(cat <<'EOF'\nあとで git branch -D fix/x と git worktree remove --force .claude/worktrees/a をする\nEOF\n)\"",
    'cat > notes.md <<EOF\ngit branch -D foo\nEOF',
    'grep -n "git branch -D" GUIDE.md | head -3',
    // worktree でないものの rm -rf（どの区切りも worktrees になりえない）
    'rm -rf ~/.claude-personal/projects/-Users-me-work-tanacode--claude-worktrees-tc-1024-abcd',
    'rm -rf /tmp/my-worktrees-backup',
    // 消す操作でないもの
    'git worktree remove .claude/worktrees/a',
    'git branch -d foo',
    'git',
    'command -v git',
    '[ -d .claude/worktrees ] && echo yes',
  ])('許す形で、消す操作は無い: %s', (command) => {
    expect(read(command)).toEqual([]);
  });

  it.each([
    ['git branch -D foo', ['branch@/r/proj:foo']],
    ['git branch --delete --force foo bar', ['branch@/r/proj:foo,bar']],
    ['git branch -d -f foo', ['branch@/r/proj:foo']],
    ['git branch -qD foo', ['branch@/r/proj:foo']],
    // 長いオプションの省略形
    ['git branch --del --forc foo', ['branch@/r/proj:foo']],
    ['git branch --d --f foo', ['branch@/r/proj:foo']],
    ['cd /r/other && git branch -D foo', ['branch@/r/other:foo']],
    ['cd /r/other || exit 1; git branch -D foo', ['branch@/r/other:foo']],
    ['cd -P /r/other && git branch -D foo', ['branch@/r/other:foo']],
    ['cd ../x && git branch -D foo', ['branch@/r/x:foo']],
    ['git -C ../x branch -D foo', ['branch@/r/x:foo']],
    ['git --no-pager -C /r/y branch -D foo', ['branch@/r/y:foo']],
    ['/usr/bin/git branch -D foo', ['branch@/r/proj:foo']],
    ['git worktree remove --force .claude/worktrees/a && git branch -D worktree-a', ['worktree@/r/proj:/r/proj/.claude/worktrees/a', 'branch@/r/proj:worktree-a']],
    ['git worktree remove -f "/r/proj/.claude/worktrees/b"', ['worktree@/r/proj:/r/proj/.claude/worktrees/b']],
    ['git worktree remove --forc -- .claude/worktrees/b', ['worktree@/r/proj:/r/proj/.claude/worktrees/b']],
    ['git worktree remove -f -f .claude/worktrees/b', ['worktree@/r/proj:/r/proj/.claude/worktrees/b×2']],
    ['git worktree remove -ff .claude/worktrees/b', ['worktree@/r/proj:/r/proj/.claude/worktrees/b×2']],
    // 消す操作の前の、読むだけのもの
    ['git status && git log --oneline -1 && gh pr view 3 && git branch -D foo', ['branch@/r/proj:foo']],
    ['git fetch && true', []],
    ['git stash list && git remote -v && git config --get user.name && git symbolic-ref HEAD && git branch -D foo', ['branch@/r/proj:foo']],
    ['git reflog && git worktree list && git branch && git branch -a -vv && git branch --list "fix/x" && git branch -D foo', ['branch@/r/proj:foo']],
    ['sort a.txt && [ -n x ] && X=1 git branch -D foo', ['branch@/r/proj:foo']],
    ['git branch -D foo 2>&1 >/dev/null', ['branch@/r/proj:foo']],
    // 消す操作のあとの書き換えは許す
    ['git branch -D foo && git push origin --delete foo && echo done > log.txt', ['branch@/r/proj:foo']],
    // シェルに渡す文字列・eval・コマンド置換の中も読む
    ["bash -c 'git branch -D foo'", ['branch@/r/proj:foo']],
    ["bash -lc 'cd /r/other && git branch -D foo' && git branch -D bar", ['branch@/r/other:foo', 'branch@/r/proj:bar']],
    ["eval 'git branch -D foo'", ['branch@/r/proj:foo']],
    ['echo $(git branch -D foo)', ['branch@/r/proj:foo']],
    ['echo `git branch -D foo`', ['branch@/r/proj:foo']],
    ['(cd /r/other && git branch -D foo); git branch -D bar', ['branch@/r/other:foo', 'branch@/r/proj:bar']],
    ['if git branch -D foo; then echo ok; fi', ['branch@/r/proj:foo']],
    ['{ git branch -D foo; }', ['branch@/r/proj:foo']],
    ['command git branch -D foo # 片付け', ['branch@/r/proj:foo']],
    ['nohup git branch -D foo', ['branch@/r/proj:foo']],
    ['time -p env FOO=1 git branch -D foo', ['branch@/r/proj:foo']],
    ['exec git branch -D foo', ['branch@/r/proj:foo']],
  ])('%s', (command, expected) => {
    expect(read(command)).toEqual(expected);
  });

  it.each([
    // 知らないコマンド（引数をコマンドとして動かせるもの・別のものを動かすもの）
    'xcrun git branch -D x',
    'arch -arm64 git branch -D x',
    `python3 -c "import os; os.system('git branch -D x')"`,
    `node -e "require('child_process').execSync('git branch -D x')"`,
    "perl -e 'system(\"git branch -D x\")'",
    "perl -0pi -e 's/git worktree remove --force x/y/' a.md",
    "trap 'git branch -D x' EXIT",
    "source <(echo 'git branch -D x')",
    'git branch --merged | xargs git branch -D',
    'find .claude/worktrees -maxdepth 1 -exec rm -rf {} +',
    'sudo git branch -D x',
    './git branch -D x',
    'git bd x',
    "ssh host 'git branch -D foo'",
    'gh my-alias x && git branch -D y',
    'gh',
    // 標準入力でシェルに渡すもの
    "echo 'git branch -D x' | sh",
    "bash <<< 'git branch -D x'",
    'cat <<EOF | bash\ngit branch -D x\nEOF',
    "bash -c \"$X\"",
    'sh script.sh',
    // 文法の読み落とし
    'function f { git branch -D x; }; f',
    'f() { git branch -D x; }; f',
    'coproc git branch -D x',
    'for b in a b; do git branch -D $b; done',
    'case $x in a) git branch -D x;; esac',
    'echo ${x:-$(git branch -D y)}',
    'echo $((1 + 2)) && git branch -D x',
    'eval "$(echo git branch -D x)"',
    // 名前の読み違え
    'git branch -D {a,b}',
    'git worktree remove --force .claude/worktrees/{a,b}',
    'git branch -D @{-1}',
    "git branch -D '@{-1}'",
    'git branch -D -- -',
    'git branch -D "$b"',
    "git branch -D $'x'",
    'git branch -D',
    'git branch -D --contains abc x',
    'git branch -rD origin/foo',
    'git worktree remove -f a b',
    'git worktree remove --force --dry-run a',
    'git worktree remove -fx a',
    'git worktree remove --force "$W"',
    // git・シェルの動きを変える変数
    'GIT_DIR=/x git branch -D x',
    'GIT_WORK_TREE=/x git worktree remove --force .claude/worktrees/a',
    'export GIT_DIR=/x; git branch -D x',
    'env GIT_DIR=/x git branch -D x',
    'env -i git branch -D x',
    'PATH=/x git branch -D x',
    'git -c alias.x=!sh branch -D x',
    'git --git-dir=/x branch -D x',
    '$GIT branch -D x',
    'nohup -x git branch -D x',
    'command -p git branch -D x',
    // worktree になりうる rm -rf
    'rm -rf .claude/worktrees/a',
    'rm -r -f /r/proj/.claude/worktrees',
    'echo hi; rm -Rf "x/worktrees/y"',
    'rm -rf $HOME/.claude/worktrees/a',
    'rm -rf .claude/worktrees*',
    'rm -rf .claude/worktrees{,}',
    'rm -rf ~/worktrees',
    'cd "$X" && rm -rf rel',
    // 確かめたあとで、同じコマンドの前の部分が状態を変えるもの
    'git switch x && git commit -am wip && git switch - && git branch -D x',
    'echo hi > .claude/worktrees/a/n.txt && git worktree remove --force .claude/worktrees/a',
    'echo hi > n.txt && git branch -D x',
    'echo hi > $LOG && git branch -D x',
    'git status > out.txt && git branch -D x',
    'git log --output=f && git branch -D x',
    'git push origin --delete x && git branch -D x',
    'gh pr merge 1 --squash && git pull && git branch -D x',
    'gh pr checkout 1 && git branch -D x',
    'git stash && git branch -D x',
    'git remote remove o && git branch -D x',
    'git config x y && git branch -D x',
    'git symbolic-ref HEAD refs/heads/y && git branch -D x',
    'git reflog expire --all && git branch -D x',
    'git worktree prune && git branch -D x',
    'git branch new && git branch -D x',
    'git branch -m a b && git branch -D x',
    'git branch -d y && git branch -D x',
    'git worktree remove .claude/worktrees/a && git branch -D x',
    'rm -f a.txt && git branch -D x',
    'sort -o out a.txt && git branch -D x',
    'git update-ref -d refs/heads/x && git branch -D x',
    'git fetch --prune && git branch -D x',
    // フォルダが分からなくなるもの
    'cd /B | git branch -D x',
    'cd /B & git branch -D x',
    'false || cd /B && git branch -D x',
    'pushd /B; popd; git branch -D x',
    'cd "$X" && git branch -D foo',
    'cd - && git branch -D foo',
    'cd -x && git branch -D foo',
    'git worktree foo',
    // 読めないもの
    "git branch -D 'foo",
    'git branch -D "foo',
    'git branch -D `foo',
    'echo ${x',
    'git branch -D x )',
    '( git branch -D x',
    'git branch -D x >',
    'cat <<EOF\nno end',
    'cat <<\ngit branch -D x',
  ])('許す形でないので確認を出させる: %s', (command) => {
    expect(read(command)).toBe('ask');
  });

  it.each([
    // リダイレクト・区切り
    ['git branch -D foo &>/dev/null', ['branch@/r/proj:foo']],
    ['git branch -D foo &>>/dev/null', ['branch@/r/proj:foo']],
    ['git branch -D foo |& cat', ['branch@/r/proj:foo']],
    ['git branch -D foo < /dev/null', ['branch@/r/proj:foo']],
    ['git branch -D foo && echo done >&2', ['branch@/r/proj:foo']],
    // クォート・エスケープ
    ['git branch -D fo\\o && echo "a\\"b\\$c\\\\d\\e" "x\\\ny"', ['branch@/r/proj:foo']],
    ['git branch \\\n-D foo', ['branch@/r/proj:foo']],
    ['echo "`git branch -D foo`"', ['branch@/r/proj:foo']],
    ['echo "$(git branch -D foo)" ${HOME} $ x $"y"', ['branch@/r/proj:foo']],
    ['echo `echo a\\$b`', []],
    // ヒアドキュメント
    ['cat <<- EOF\n\tgit branch -D x\n\tEOF\ngit branch -D foo', ['branch@/r/proj:foo']],
    ['cat <<\\EOF\n$(git branch -D x)\nEOF', []],
    ['cat <<EOF\n\\$x $(git branch -D foo) `echo y`\nEOF', ['branch@/r/proj:foo']],
    // git の書き方
    ["git branch --no-color --sort=name --format='%(refname)' && git branch -D foo", ['branch@/r/proj:foo']],
    ['git remote show origin && git stash show && git branch -D foo', ['branch@/r/proj:foo']],
    ['gh pr list && gh run view 1 && git branch -D foo && gh api x', ['branch@/r/proj:foo']],
  ])('%s', (command, expected) => {
    expect(read(command)).toEqual(expected);
  });

  it.each([
    'echo a;; echo b',
    'cat <<EOF',
    "cat <<'EOF\nx\nEOF",
    'git -C "$D" branch -D x',
    'git "$sub" x',
    'git branch --no x && git branch -D foo',
    'git branch --remotes --delete --force origin/x',
    'git branch --move a b && git branch -D foo',
    'git branch --all -D foo',
    'git branch -a -D foo',
    'git branch -l && git branch -D foo && git branch -vD "@{-1}"',
    'echo `echo a\\`b`',
    'git branch -m a b && git branch -D foo',
    'git worktree add x && git branch -D foo',
    'git worktree remove -f -- -- x',
    'cd "$X" && git worktree remove -f .claude/worktrees/a',
    'gh -R o/r pr view 1',
    'gh "$x" view',
    'rm -rf -- .claude/worktrees/a',
    'rm -rf ../..',
  ])('許す形でないので確認を出させる: %s', (command) => {
    expect(read(command, command === 'rm -rf ../..' ? '/r/proj/.claude/worktrees/a/src' : '/r/proj')).toBe('ask');
  });

  it.each(['rm -rf .', 'rm -rf ..', 'rm -rf ../b', 'rm -rf *', 'rm -rf /r/proj/.claude/worktrees/a', 'rm -rf /r/proj/.claude/worktrees/a/src'])('worktree の中で %s', (command) => {
    expect(read(command, '/r/proj/.claude/worktrees/a')).toBe('ask');
  });

  it('worktree の中の rm は、worktree の中のフォルダ（パスの区切りに worktrees がある）でも確認を出させる。外のフォルダは許す', () => {
    expect(read('rm -rf dist', '/r/proj/.claude/worktrees/a')).toBe('ask');
    expect(read('rm -rf /tmp/x', '/r/proj/.claude/worktrees/a')).toEqual([]);
  });

  it('~ はホームのフォルダ。cd だけならホーム', () => {
    expect(read('cd ~/x && git branch -D foo')).toEqual([`branch@${join(homedir(), 'x')}:foo`]);
    expect(read('cd && git branch -D foo')).toEqual([`branch@${homedir()}:foo`]);
  });

  it('シェルに渡した文字列の中の cd は、外に効かない', () => {
    expect(read("sh -c 'cd /r/other' && git branch -D foo")).toEqual(['branch@/r/proj:foo']);
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
    expect(await verifyCommand('git branch -D fix/x', repo)).toBe('pass');
    // マージと一緒につないだものは、確かめる時点ではまだマージされていないので確認を出させる
    expect(await verifyCommand('gh pr merge 1 --squash && git pull && git branch -D fix/x', repo)).toBe('ask');
  });

  it('origin の同じ名前のブランチと同じなら、gh で調べられなくても確認を出させない', async () => {
    git(repo, 'switch', '-q', '-c', 'release/v2.0.0');
    commit(repo, 'b.txt');
    git(repo, 'push', '-q', '-u', 'origin', 'release/v2.0.0');
    git(repo, 'switch', '-q', 'main');
    expect(await verifyCommand('git branch -D release/v2.0.0', repo)).toBe('pass');
  });

  it('手元に無いブランチ（git branch -D が失敗するだけ）は、確認を出させない', async () => {
    expect(await verifyCommand('git branch -D no-such-branch', repo)).toBe('pass');
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

  it('許す形でないもの・git のリポジトリでないところは、確認を出させる', async () => {
    expect(await verifyCommand('git branch -D "$b"', repo)).toBe('ask');
    expect(await verifyCommand('git branch -D foo', root)).toBe('ask');
  });

  it('消す操作の無い、許す形だけのものは、確かめずに通す', async () => {
    expect(await verifyCommand("echo 'git worktree remove --force x' > note.txt", repo)).toBe('pass');
  });

  it('.claude/worktrees を中に持つフォルダの rm -rf は、確認を出させる', async () => {
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
    expect(await verifyCommand(`rm -rf ${repo}`, root)).toBe('ask');
    expect(await verifyCommand('rm -rf .claude', repo)).toBe('ask');
    expect(await verifyCommand('rm -rf other', repo)).toBe('pass');
  });

  describe('git worktree remove --force', () => {
    const add = (name: string, lock = `claude session ${name} (pid 99999 start 1)`) => {
      const path = join(repo, '.claude', 'worktrees', name);
      git(repo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, path);
      git(repo, 'worktree', 'lock', '--reason', lock, path);
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

    it('detached HEAD でも、ブランチにあるコミットなら確認を出させない', async () => {
      const path = add('tc-4b');
      git(path, 'switch', '-q', '--detach');
      expect(await verifyCommand('git worktree remove --force .claude/worktrees/tc-4b', repo)).toBe('pass');
    });

    it('人が付けたロックがあれば、確認を出させる', async () => {
      add('tc-5', 'keep');
      expect(await verifyCommand('git worktree remove --force .claude/worktrees/tc-5', repo)).toBe('ask');
    });

    it('--force が 2 つ（ロックも越えて消す）なら、Claude Code のロック（動いている Claude）でも確認を出させる', async () => {
      add('tc-5b');
      expect(await verifyCommand('git worktree remove -f -f .claude/worktrees/tc-5b', repo)).toBe('ask');
    });

    it('登録の無い場所は、確認を出させる', async () => {
      mkdirSync(join(repo, '.claude', 'worktrees', 'gone'), { recursive: true });
      expect(await verifyCommand('git worktree remove --force .claude/worktrees/gone', repo)).toBe('ask');
      expect(await verifyCommand('git worktree remove --force .claude/worktrees/missing', repo)).toBe('ask');
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
