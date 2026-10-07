import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeArgs } from '../src/main/claude-session';
import { type PullRequest, pullRequestsOf } from '../src/main/github';
import {
  apfsClone,
  hideWorktrees,
  planWorktree,
  prepareNodeModules,
  removeWorktree,
  restoreWorktree,
  setAsideIgnoredDirs,
  waitForWorktree,
  worktreeLeftovers,
  type WorktreePlan,
} from '../src/main/worktree';

// worktree のセッション（claude --worktree）の、アプリが受け持つところ。本物の git で確かめる。
// Claude Code が worktree を作るところは、Claude Code と同じ形（.claude/worktrees/<名前>・ブランチ worktree-<名前>・
// 「claude session …」のロック）を git で作って代わりにする（本物の Claude Code では test/cli/worktree.test.ts）。
// PR（gh で GitHub に問い合わせるところ）は差し替える

vi.mock('../src/main/github', () => ({ pullRequestsOf: vi.fn() }));
const prs = vi.mocked(pullRequestsOf);

// worktree の名前の乱数を決められるようにする（queue から順に。無ければ fixed、それも無ければ本物の乱数）
const names = vi.hoisted(() => ({ queue: [] as number[][], fixed: null as number[] | null }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) => {
      const next = names.queue.shift() ?? names.fixed;
      return next ? Buffer.from(next) : actual.randomBytes(size);
    },
  };
});

let root: string;
let repo: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  // 既定は、gh で調べられない
  prs.mockReset().mockResolvedValue(null);
  names.queue = [];
  names.fixed = null;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-worktree-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'me@example.com');
  git(repo, 'config', 'user.name', 'me');
  // 裏の片付け（gc）が、一時フォルダの削除とぶつからないように
  git(repo, 'config', 'gc.auto', '0');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// Claude Code が claude --worktree で作るのと同じ形の worktree（ロックも付ける）
const create = async (cwd = repo): Promise<WorktreePlan> => {
  const plan = await planWorktree(cwd);
  git(plan.root, 'worktree', 'add', '-b', plan.branch, plan.path);
  git(plan.root, 'worktree', 'lock', '--reason', `claude session ${plan.name} (pid 99999 start 1)`, plan.path);
  return plan;
};

describe('名前と場所', () => {
  it('リポジトリのいちばん上の .claude/worktrees/<名前> に、worktree-<名前> のブランチで作る（サブフォルダからでも）', async () => {
    mkdirSync(join(repo, 'pkg'));
    const plan = await planWorktree(join(repo, 'pkg'));
    expect(plan.root).toBe(repo);
    expect(plan.name).toMatch(/^tc-\d{4}-[a-z2-9]{4}$/);
    expect(plan.path).toBe(join(repo, '.claude', 'worktrees', plan.name));
    expect(plan.branch).toBe(`worktree-${plan.name}`);
  });

  it('git のリポジトリでない・コミットが無いときは、理由を添えて断る', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    await expect(planWorktree(plain)).rejects.toThrow('git のリポジトリ');
    git(plain, 'init', '-q');
    await expect(planWorktree(plain)).rejects.toThrow('コミットが 1 つ以上');
  });

  it('同じ名前のブランチかフォルダがあれば、別の名前にする。20 回とも重なれば断る', async () => {
    const date = (() => {
      const now = new Date();
      return `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    })();
    names.queue = [
      [0, 1, 2, 3],
      [0, 1, 2, 3],
      [4, 5, 6, 39],
    ];
    const first = await planWorktree(repo);
    expect(first.name).toBe(`tc-${date}-abcd`);
    git(repo, 'branch', first.branch);
    // 1 回目は重なるので、次の乱数の名前（39 % 32 = 7 → h）
    expect((await planWorktree(repo)).name).toBe(`tc-${date}-efgh`);
    names.fixed = [0, 1, 2, 3];
    await expect(planWorktree(repo)).rejects.toThrow('worktree の名前を決められませんでした');
    git(repo, 'branch', '-D', first.branch);
    mkdirSync(first.path, { recursive: true });
    await expect(planWorktree(repo)).rejects.toThrow('worktree の名前を決められませんでした');
    rmSync(first.path, { recursive: true });
    expect((await planWorktree(repo)).name).toBe(first.name);
  });

  it('claude に --worktree を付けるのは新しい会話だけ', () => {
    const base = { claudeSessionId: 'id', remoteControlName: null, model: null, effort: null, permissionMode: null };
    expect(claudeArgs({ ...base, resume: false, worktree: 'tc-1' }).slice(0, 4)).toEqual(['--session-id', 'id', '--worktree', 'tc-1']);
    expect(claudeArgs({ ...base, resume: true, worktree: 'tc-1' })).not.toContain('--worktree');
    expect(claudeArgs({ ...base, resume: false })).not.toContain('--worktree');
  });
});

describe('元のフォルダのソース管理', () => {
  it('worktree が未追跡に出ないよう、.git/info/exclude に足す（1 回だけ）', async () => {
    const plan = await create();
    expect(git(repo, 'status', '--porcelain')).toBe('?? .claude/');
    await hideWorktrees(repo);
    await hideWorktrees(repo);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').match(/\/\.claude\/worktrees\//g)).toHaveLength(1);
    // .gitignore は書き換えない
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).not.toContain('.claude');
    expect(existsSync(plan.path)).toBe(true);
  });

  it('exclude の最後に改行が無ければ改行してから足す。worktree の中から呼んでも、元のリポジトリの exclude に足す', async () => {
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '*.tmp');
    const plan = await create();
    await hideWorktrees(plan.path);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe('*.tmp\n# tanacode: Claude Code の worktree（claude --worktree）\n/.claude/worktrees/\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('.git/info が無ければ作って足す', async () => {
    rmSync(join(repo, '.git', 'info'), { recursive: true, force: true });
    await hideWorktrees(repo);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe('# tanacode: Claude Code の worktree（claude --worktree）\n/.claude/worktrees/\n');
  });

  it('.gitignore で無視されていれば、何も足さない', async () => {
    writeFileSync(join(repo, '.gitignore'), '.claude/\n');
    await hideWorktrees(repo);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).not.toContain('tanacode');
  });
});

describe('残っているもの', () => {
  it('未コミットの変更・未追跡のファイル・プッシュしていないコミットを数える', async () => {
    const plan = await create();
    expect(await worktreeLeftovers(plan, plan.path)).toEqual({
      exists: true,
      branch: plan.branch,
      uncommitted: 0,
      untracked: 0,
      unpushed: 0,
      contentIn: null,
      pr: { state: 'unknown' },
    });
    writeFileSync(join(plan.path, 'b.txt'), 'b\n');
    git(plan.path, 'add', 'b.txt');
    git(plan.path, 'commit', '-qm', 'b');
    writeFileSync(join(plan.path, 'a.txt'), 'changed\n');
    git(plan.path, 'mv', 'b.txt', 'c.txt');
    writeFileSync(join(plan.path, 'new.txt'), 'new\n');
    // .gitignore で無視されるものは数えない
    writeFileSync(join(plan.path, '.env'), 'SECRET=1\n');
    expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ uncommitted: 2, untracked: 1, unpushed: 1 });
  });

  it('worktree もブランチも無ければ、何も残っていない', async () => {
    const plan = await planWorktree(repo);
    expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ exists: false, uncommitted: 0, untracked: 0, unpushed: 0 });
  });

  it('フォルダがあっても、worktree として登録されていなければ、無いものとして中を数えない', async () => {
    const plan = await planWorktree(repo);
    mkdirSync(plan.path, { recursive: true });
    writeFileSync(join(plan.path, 'stray.txt'), 'x\n');
    expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ exists: false, uncommitted: 0, untracked: 0 });
  });

  it('worktree の場所を、シンボリックリンクを通した別の書き方で渡しても見つける（macOS の /tmp と /private/tmp）', async () => {
    const plan = await create();
    writeFileSync(join(plan.path, 'new.txt'), 'new\n');
    const alias = join(root, 'alias');
    symlinkSync(repo, alias);
    const through = join(alias, '.claude', 'worktrees', plan.name);
    expect(await worktreeLeftovers(plan, through)).toMatchObject({ exists: true, untracked: 1 });
  });

  it('コピーと見なされた変更（status.renames=copies）は、元のパスを別の変更として数えない', async () => {
    writeFileSync(join(repo, 'a.txt'), '1\n2\n3\n4\n5\n');
    git(repo, 'commit', '-qam', 'lines');
    const plan = await create();
    git(repo, 'config', 'status.renames', 'copies');
    writeFileSync(join(plan.path, 'copy.txt'), '1\n2\n3\n4\n5\n');
    writeFileSync(join(plan.path, 'a.txt'), '1\n2\n3\n4\n5\n6\n');
    git(plan.path, 'add', 'copy.txt', 'a.txt');
    expect(git(plan.path, 'status', '--porcelain')).toBe('M  a.txt\nC  a.txt -> copy.txt');
    expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ uncommitted: 2, untracked: 0 });
  });

  it('プッシュしていないコミットが 10 件以上あっても数える', async () => {
    const plan = await create();
    for (let i = 0; i < 12; i++) commitIn(plan.path, `f${i}.txt`);
    expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 12 });
  });

  describe('PR', () => {
    it('PR をスカッシュマージして、リモートのブランチを消していても、PR に入っているコミットはプッシュしていないと数えない', async () => {
      withOrigin();
      const plan = await create();
      commitIn(plan.path, 'b.txt');
      commitIn(plan.path, 'c.txt');
      git(plan.path, 'push', '-q', '-u', 'origin', plan.branch);
      // GitHub がマージのあとにブランチを消し、手元でも prune した（上流が無くなった）
      git(repo, 'push', '-q', 'origin', '--delete', plan.branch);
      git(repo, 'fetch', '-q', '--prune');
      // gh で調べられなければ、どのリモートにも無いコミットとして数える
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 2, pr: { state: 'unknown' } });
      const head = git(repo, 'rev-parse', plan.branch);
      prs.mockResolvedValue([pull({ number: 7, state: 'MERGED', headRefOid: head })]);
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({
        unpushed: 0,
        contentIn: null,
        pr: { state: 'merged', number: 7, base: 'main', url: 'https://github.com/me/repo/pull/7', after: 0 },
      });
      expect(prs).toHaveBeenLastCalledWith(repo, plan.branch);
      // マージのあとに足したコミットは、プッシュしていないコミットとして数える
      commitIn(plan.path, 'd.txt');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 1, pr: { state: 'merged', after: 1 } });
    });

    it('上流の名前が違えば、その名前で PR を探す', async () => {
      withOrigin();
      const plan = await create();
      git(plan.path, 'push', '-q', '-u', 'origin', `${plan.branch}:fix/login`);
      await worktreeLeftovers(plan, plan.path);
      expect(prs).toHaveBeenLastCalledWith(repo, 'fix/login');
    });

    it('開いている PR → マージ済み → 閉じたものの順に選ぶ。PR が無ければ none', async () => {
      const plan = await create();
      const head = git(repo, 'rev-parse', plan.branch);
      prs.mockResolvedValue([pull({ number: 3, state: 'CLOSED', headRefOid: head }), pull({ number: 2, state: 'MERGED', headRefOid: head })]);
      expect((await worktreeLeftovers(plan, plan.path)).pr).toMatchObject({ state: 'merged', number: 2 });
      prs.mockResolvedValue([pull({ number: 4, state: 'OPEN', headRefOid: head }), pull({ number: 2, state: 'MERGED', headRefOid: head })]);
      expect((await worktreeLeftovers(plan, plan.path)).pr).toMatchObject({ state: 'open', number: 4 });
      // 閉じたものしか無ければ閉じたもの。同じ状態のものが 2 つあれば、新しいほう（先に返るもの）
      prs.mockResolvedValue([pull({ number: 6, state: 'CLOSED', headRefOid: head })]);
      expect((await worktreeLeftovers(plan, plan.path)).pr).toMatchObject({ state: 'closed', number: 6 });
      prs.mockResolvedValue([pull({ number: 5, state: 'OPEN', headRefOid: head }), pull({ number: 4, state: 'OPEN', headRefOid: head })]);
      expect((await worktreeLeftovers(plan, plan.path)).pr).toMatchObject({ state: 'open', number: 5 });
      prs.mockResolvedValue([]);
      expect((await worktreeLeftovers(plan, plan.path)).pr).toEqual({ state: 'none' });
    });

    it('ブランチが手元に無ければ、PR のあとに足したコミットは 0', async () => {
      const plan = await planWorktree(repo);
      prs.mockResolvedValue([pull({ number: 9, state: 'OPEN', headRefOid: git(repo, 'rev-parse', 'HEAD') })]);
      expect(await worktreeLeftovers(plan, plan.path)).toEqual({
        exists: false,
        branch: plan.branch,
        uncommitted: 0,
        untracked: 0,
        unpushed: 0,
        contentIn: null,
        pr: { state: 'open', number: 9, base: 'main', url: 'https://github.com/me/repo/pull/9', after: 0 },
      });
    });

    it('PR の head のコミットが手元に無ければ、PR で除かずに数える', async () => {
      const plan = await create();
      commitIn(plan.path, 'b.txt');
      prs.mockResolvedValue([pull({ number: 7, state: 'MERGED', headRefOid: '0123456789abcdef0123456789abcdef01234567' })]);
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 1, pr: { state: 'merged', after: null } });
    });
  });

  describe('PR を使わずに直接コミットしたもの', () => {
    it('リモートのデフォルトブランチへ直接プッシュしたコミットは、プッシュしていないと数えない', async () => {
      withOrigin();
      prs.mockResolvedValue([]);
      const plan = await create();
      commitIn(plan.path, 'b.txt');
      git(plan.path, 'push', '-q', 'origin', 'HEAD:main');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 0, contentIn: null, pr: { state: 'none' } });
    });

    it('手元でスカッシュマージしてコミットが作り直されていても、中身がデフォルトブランチに入っていれば数えない', async () => {
      const plan = await create();
      commitIn(plan.path, 'a.txt', 'b');
      commitIn(plan.path, 'b.txt');
      squashMerge(plan.branch);
      // マージのあとに、デフォルトブランチで同じところを変えていても見分ける
      commitIn(repo, 'a.txt', 'c');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 0, contentIn: 'main' });
      // マージのあとに足したコミットがあれば、入っていないとみなす
      commitIn(plan.path, 'd.txt');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 3, contentIn: null });
    });

    it('上流に無いコミットでも、手元のデフォルトブランチに取り込んであれば数えない', async () => {
      withOrigin();
      const plan = await create();
      git(plan.path, 'push', '-q', '-u', 'origin', plan.branch);
      commitIn(plan.path, 'b.txt');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 1, contentIn: null });
      // 手元で main に取り込んだ（プッシュはしていない）
      git(repo, 'merge', '-q', '--ff-only', plan.branch);
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 0, contentIn: 'main' });
    });

    it('変えて戻しただけ（中身の差が無い）のブランチは、デフォルトブランチに入っているとみなす', async () => {
      const plan = await create();
      commitIn(plan.path, 'b.txt');
      git(plan.path, 'rm', '-q', 'b.txt');
      git(plan.path, 'commit', '-qm', 'revert');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 0, contentIn: 'main' });
    });

    it('デフォルトブランチと履歴のつながらないブランチは、中身を比べられないので数える', async () => {
      const plan = await create();
      git(plan.path, 'switch', '-q', '--orphan', 'lonely');
      commitIn(plan.path, 'z.txt');
      git(plan.path, 'switch', '-q', '-C', plan.branch);
      git(repo, 'branch', '-D', 'lonely');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 1, contentIn: null });
    });

    it('デフォルトブランチが分からなければ、中身では比べずに数える', async () => {
      git(repo, 'branch', '-m', 'work');
      const plan = await create();
      commitIn(plan.path, 'a.txt', 'b');
      git(repo, 'merge', '-q', '--squash', plan.branch);
      git(repo, 'commit', '-qm', 'squash');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ unpushed: 1, contentIn: null });
    });
  });
});

describe('worktree ができるのを待つ', () => {
  it('.git ができたら true。Claude Code が終わったら false。時間が過ぎたら false', async () => {
    const path = join(root, 'wt');
    mkdirSync(path);
    setTimeout(() => writeFileSync(join(path, '.git'), 'gitdir: x\n'), 300);
    expect(await waitForWorktree(path, () => true, 5000)).toBe(true);
    // 待つ時間を省いても、もうあればすぐ返す
    expect(await waitForWorktree(path, () => true)).toBe(true);
    const never = join(root, 'never');
    let alive = true;
    setTimeout(() => (alive = false), 300);
    const started = Date.now();
    expect(await waitForWorktree(never, () => alive, 5000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await waitForWorktree(never, () => true, 300)).toBe(false);
  });
});

// cwd で file を書いてコミットする
const commitIn = (cwd: string, file: string, text = file) => {
  writeFileSync(join(cwd, file), `${text}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', file);
};

// repo（main にいる）に、branch をスカッシュマージする
const squashMerge = (branch: string) => {
  git(repo, 'merge', '-q', '--squash', branch);
  git(repo, 'commit', '-qm', 'squash');
};

// repo に origin（bare）を付ける
const withOrigin = () => {
  git(root, 'clone', '-q', '--bare', repo, join(root, 'origin.git'));
  git(join(root, 'origin.git'), 'config', 'gc.auto', '0');
  git(repo, 'remote', 'add', 'origin', join(root, 'origin.git'));
  git(repo, 'fetch', '-q', 'origin');
};

// gh pr list の 1 件
const pull = (pr: Pick<PullRequest, 'number' | 'state' | 'headRefOid'>): PullRequest => ({
  baseRefName: 'main',
  url: `https://github.com/me/repo/pull/${pr.number}`,
  ...pr,
});

describe('削除', () => {
  it('何も残っていなければ、Claude Code のロックを外して消し、マージ済みのブランチも消す', async () => {
    const plan = await create();
    // gitignore されたファイル（node_modules など）は、あっても --force なしで消せる
    mkdirSync(join(plan.path, 'node_modules'));
    writeFileSync(join(plan.path, 'node_modules', 'x.js'), '');
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branch: plan.branch, branchKept: false });
    expect(existsSync(plan.path)).toBe(false);
    expect(git(repo, 'branch', '--list', plan.branch)).toBe('');
    expect(git(repo, 'worktree', 'list')).not.toContain(plan.name);
  });

  describe('gitignore されたフォルダ（node_modules など）', () => {
    const trash = () => join(repo, '.git', 'tanacode-trash');
    const trashEmpty = () => !existsSync(trash()) || readdirSync(trash()).length === 0;
    // node_modules をいちばん上と、追跡しているフォルダの中に作る
    const modules = (path: string) => {
      mkdirSync(join(path, 'node_modules', 'left-pad'), { recursive: true });
      writeFileSync(join(path, 'node_modules', 'left-pad', 'index.js'), 'a');
      writeFileSync(join(path, '.env'), 'SECRET=1\n');
    };

    it('消すときは、.git の中のごみ箱へ動かして待たずに済ませ、中身は裏で消える', async () => {
      const plan = await create();
      modules(plan.path);
      await removeWorktree(plan, plan.path);
      expect(existsSync(plan.path)).toBe(false);
      expect(git(repo, 'worktree', 'list')).not.toContain(plan.name);
      await vi.waitFor(() => expect(trashEmpty()).toBe(true), { timeout: 10_000 });
      // ごみ箱は、ソース管理に出ない
      expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    });

    it('git worktree remove に失敗したときのために、元の場所に戻せる', async () => {
      const plan = await create();
      modules(plan.path);
      const aside = await setAsideIgnoredDirs(plan, plan.path);
      expect(existsSync(join(plan.path, 'node_modules'))).toBe(false);
      expect(readdirSync(trash())).toHaveLength(1);
      await aside.restore();
      expect(readFileSync(join(plan.path, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('a');
      expect(trashEmpty()).toBe(true);
    });

    it('別の worktree を消しても、まだ結果を待っている worktree のごみ箱は消さない', async () => {
      const waiting = await create();
      const other = await create();
      modules(waiting.path);
      modules(other.path);
      const aside = await setAsideIgnoredDirs(waiting, waiting.path);
      await removeWorktree(other, other.path);
      // other のごみ箱が消えても、waiting のものは残る
      await vi.waitFor(() => expect(readdirSync(trash())).toHaveLength(1), { timeout: 10_000 });
      await aside.restore();
      expect(readFileSync(join(waiting.path, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('a');
    });

    it('アプリが終わって消し残したごみ箱は、次に worktree を消すときに片付ける', async () => {
      mkdirSync(join(trash(), 'old-1234', '0', 'left-pad'), { recursive: true });
      writeFileSync(join(trash(), 'old-1234', '0', 'left-pad', 'index.js'), '');
      const plan = await create();
      await removeWorktree(plan, plan.path);
      await vi.waitFor(() => expect(trashEmpty()).toBe(true), { timeout: 10_000 });
    });
  });

  it('未コミットの変更と未追跡のファイルは、控えのコミットにしてから --force で消す。ふだんのインデックスには触らない', async () => {
    const plan = await create();
    writeFileSync(join(plan.path, 'a.txt'), 'changed\n');
    writeFileSync(join(plan.path, 'staged.txt'), 'staged\n');
    git(plan.path, 'add', 'staged.txt');
    writeFileSync(join(plan.path, 'new.txt'), 'new\n');
    writeFileSync(join(plan.path, '.env'), 'SECRET=1\n');
    const removal = await removeWorktree(plan, plan.path);
    expect(removal.backupRef).toBe(`refs/tanacode/backup/${plan.name}`);
    expect(existsSync(plan.path)).toBe(false);
    const ref = removal.backupRef!;
    expect(git(repo, 'show', `${ref}:a.txt`)).toBe('changed');
    expect(git(repo, 'show', `${ref}:staged.txt`)).toBe('staged');
    expect(git(repo, 'show', `${ref}:new.txt`)).toBe('new');
    // gitignore されたファイルは控えに入らない
    expect(git(repo, 'ls-tree', '--name-only', ref)).not.toContain('.env');
    expect(git(repo, 'log', '-1', '--format=%an <%ae>|%s', ref)).toBe(`tanacode <tanacode@localhost>|tanacode: worktree ${plan.name} を消す前の、未コミットの変更と未追跡のファイル`);
    // 控えの親は worktree の HEAD
    expect(git(repo, 'rev-parse', `${ref}^`)).toBe(git(repo, 'rev-parse', 'main'));
    // 控えのコミットはブランチに入っていないので、ブランチはマージ済みとして消える
    expect(removal.branchKept).toBe(false);
  });

  it('同じ名前の控えがあれば、上書きせずに番号を付ける', async () => {
    const plan = await create();
    writeFileSync(join(plan.path, 'new.txt'), '1\n');
    await removeWorktree(plan, plan.path);
    await restoreWorktree(plan, plan.path);
    writeFileSync(join(plan.path, 'new.txt'), '2\n');
    expect((await removeWorktree(plan, plan.path)).backupRef).toBe(`refs/tanacode/backup/${plan.name}-2`);
    expect(git(repo, 'show', `refs/tanacode/backup/${plan.name}:new.txt`)).toBe('1');
  });

  it('手元にしか無いコミットがあれば、ブランチごと残す', async () => {
    const plan = await create();
    writeFileSync(join(plan.path, 'b.txt'), 'b\n');
    git(plan.path, 'add', 'b.txt');
    git(plan.path, 'commit', '-qm', 'b');
    const removal = await removeWorktree(plan, plan.path);
    expect(removal).toMatchObject({ backupRef: null, branchKept: true });
    expect(existsSync(plan.path)).toBe(false);
    expect(git(repo, 'log', '-1', '--format=%s', plan.branch)).toBe('b');
  });

  it('PR をスカッシュマージしたブランチは、手元のコミットがすべてその PR に入っていれば消す', async () => {
    const plan = await create();
    commitIn(plan.path, 'b.txt');
    const head = git(repo, 'rev-parse', plan.branch);
    commitIn(plan.path, 'c.txt');
    // マージした PR のあとに足したコミットがあれば残す
    prs.mockResolvedValue([pull({ number: 7, state: 'MERGED', headRefOid: head })]);
    expect(await removeWorktree(plan, plan.path)).toMatchObject({ branchKept: true });
    prs.mockResolvedValue([pull({ number: 8, state: 'MERGED', headRefOid: git(repo, 'rev-parse', plan.branch) })]);
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branch: plan.branch, branchKept: false });
    expect(git(repo, 'branch', '--list', plan.branch)).toBe('');
  });

  it('PR を使わずに、リモートのデフォルトブランチへ直接プッシュしたブランチも消す', async () => {
    withOrigin();
    const plan = await create();
    commitIn(plan.path, 'b.txt');
    git(plan.path, 'push', '-q', 'origin', 'HEAD:main');
    // 手元の main は古いままなので、git branch -d では消えない
    expect(await removeWorktree(plan, plan.path)).toMatchObject({ branchKept: false });
    expect(git(repo, 'branch', '--list', plan.branch)).toBe('');
  });

  it('手元でデフォルトブランチにスカッシュマージしたブランチも消す', async () => {
    const plan = await create();
    commitIn(plan.path, 'b.txt');
    commitIn(plan.path, 'c.txt');
    squashMerge(plan.branch);
    expect(await removeWorktree(plan, plan.path)).toMatchObject({ branchKept: false });
    expect(git(repo, 'branch', '--list', plan.branch)).toBe('');
  });

  it('ユーザーが付けたロックがあれば、消さずに断る', async () => {
    const plan = await create();
    git(repo, 'worktree', 'unlock', plan.path);
    git(repo, 'worktree', 'lock', '--reason', '外付けのディスク', plan.path);
    await expect(removeWorktree(plan, plan.path)).rejects.toThrow('外付けのディスク');
    expect(existsSync(plan.path)).toBe(true);
  });

  it('ロックの理由は、git が囲んだ書き方（日本語・タブ・引用符・円記号・改行）から元に戻して添える。理由の無いロックでも断る', async () => {
    const plan = await create();
    git(repo, 'worktree', 'unlock', plan.path);
    const reason = '外付け\tの "ディスク" C:\\data\n2 行目';
    git(repo, 'worktree', 'lock', '--reason', reason, plan.path);
    await expect(removeWorktree(plan, plan.path)).rejects.toThrow(`worktree がロックされているため、消しませんでした（${reason}）`);
    git(repo, 'worktree', 'unlock', plan.path);
    git(repo, 'worktree', 'lock', plan.path);
    await expect(removeWorktree(plan, plan.path)).rejects.toThrow(/^worktree がロックされているため、消しませんでした$/);
    expect(existsSync(plan.path)).toBe(true);
  });

  it('git worktree remove に失敗したら、動かしたフォルダを元に戻して、失敗を伝える', async () => {
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'a');
    // 元のフォルダ（main の working tree）は、git worktree remove で消せない
    await expect(removeWorktree({ name: 'main', branch: 'main', root: repo }, repo)).rejects.toThrow('main working tree');
    expect(readFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('a');
    expect(readdirSync(join(repo, '.git', 'tanacode-trash'))).toEqual([]);
  });

  it('ブランチの無い worktree（ブランチから外れて作ったもの）は、消すだけでブランチは扱わない', async () => {
    const plan = await planWorktree(repo);
    git(repo, 'worktree', 'add', '-q', '--detach', plan.path);
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branch: plan.branch, branchKept: false });
    expect(existsSync(plan.path)).toBe(false);
  });

  it('ごみ箱の場所が分からなければ（git でないなど）、何も動かさずに git worktree remove に任せる', async () => {
    const plain = join(root, 'plain');
    mkdirSync(join(plain, 'node_modules'), { recursive: true });
    const aside = await setAsideIgnoredDirs({ name: 'x', branch: 'worktree-x', root: plain }, plain);
    await aside.restore();
    aside.discard();
    expect(readdirSync(plain)).toEqual(['node_modules']);
  });

  it('フォルダをもう手で消していても、ユーザーが付けたロックは外さず、登録とブランチを残す', async () => {
    const plan = await create();
    git(repo, 'worktree', 'unlock', plan.path);
    git(repo, 'worktree', 'lock', '--reason', '外付けのディスク', plan.path);
    rmSync(plan.path, { recursive: true, force: true });
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branch: plan.branch, branchKept: true });
    // ロックしたまま登録を残す（git worktree prune は、ロックしたものを片付けない）
    expect(git(repo, 'worktree', 'list')).toMatch(new RegExp(`${plan.path} .* locked`));
  });

  it('フォルダをもう手で消していたら、git の登録を片付けて、ブランチの扱いは同じ', async () => {
    const plan = await create();
    rmSync(plan.path, { recursive: true, force: true });
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branch: plan.branch, branchKept: false });
    expect(git(repo, 'worktree', 'list')).not.toContain(plan.name);
  });
});

describe('作り直し', () => {
  it('残したブランチから作り直す。ブランチも無ければ、今の HEAD から同じ名前のブランチで作る', async () => {
    const plan = await create();
    writeFileSync(join(plan.path, 'b.txt'), 'b\n');
    git(plan.path, 'add', 'b.txt');
    git(plan.path, 'commit', '-qm', 'b');
    await removeWorktree(plan, plan.path);
    await restoreWorktree(plan, plan.path);
    expect(readFileSync(join(plan.path, 'b.txt'), 'utf8')).toBe('b\n');
    expect(git(plan.path, 'branch', '--show-current')).toBe(plan.branch);

    git(repo, 'merge', '-q', plan.branch);
    await removeWorktree(plan, plan.path);
    expect(git(repo, 'branch', '--list', plan.branch)).toBe('');
    await restoreWorktree(plan, plan.path);
    expect(git(plan.path, 'branch', '--show-current')).toBe(plan.branch);
    expect(git(plan.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'));
  });
});

describe('node_modules', () => {
  // 元のフォルダに package.json を置いてコミットし、node_modules を作る（lock: package-lock.json の中身。null なら置かない）
  const pkg = (dir: string, lock: string | null = '{}') => {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, 'package.json'), '{}');
    if (lock !== null) writeFileSync(join(repo, dir, 'package-lock.json'), lock);
  };
  const modules = (dir: string) => {
    mkdirSync(join(repo, dir, 'node_modules', '.vite'), { recursive: true });
    mkdirSync(join(repo, dir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(repo, dir, 'node_modules', 'left-pad', 'index.js'), '');
  };
  const commit = () => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'packages');
  };
  // cp -c の代わり（APFS のクローンは macOS だけ）
  const copy = (from: string, to: string) => {
    execFileSync('cp', ['-R', from, to]);
    return Promise.resolve();
  };
  const prepare = async (plan: WorktreePlan, clone: (from: string, to: string) => Promise<void> = copy, exitCode = 0) => {
    const steps: string[] = [];
    const installs: string[] = [];
    const result = await prepareNodeModules(repo, plan.path, {
      onStep: (s) => steps.push(s),
      install: (cwd, dir, command) => {
        expect(cwd).toBe(join(plan.path, dir));
        installs.push(`${command} @ ${dir || '.'}`);
        return Promise.resolve(exitCode);
      },
      clone,
    });
    return { result, steps, installs };
  };

  it('元のフォルダの node_modules を複製し、絶対パスの入るキャッシュは除く。package-lock.json が同じなら npm install しない', async () => {
    pkg('');
    commit();
    modules('');
    const plan = await create();
    const { result, steps, installs } = await prepare(plan);
    expect(result).toEqual({ cloned: [''], failed: [], installs: [] });
    expect(existsSync(join(plan.path, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(existsSync(join(plan.path, 'node_modules', '.vite'))).toBe(false);
    expect(steps).toEqual(['copying']);
    expect(installs).toEqual([]);
  });

  it('モノレポでは、追跡している package.json の隣の node_modules をすべて複製する', async () => {
    // npm の workspaces（lock はいちばん上だけ）と、サブフォルダの別のプロジェクト（自分の lock を持つ）
    pkg('');
    pkg('packages/web', null);
    pkg('packages/api', null);
    pkg('tools/cli');
    commit();
    for (const dir of ['', 'packages/web', 'tools/cli']) modules(dir);
    const plan = await create();
    const { result, installs } = await prepare(plan);
    expect(result.cloned).toEqual(['', 'packages/web', 'tools/cli']);
    for (const dir of result.cloned) expect(existsSync(join(plan.path, dir, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    // 元のフォルダに node_modules の無い packages/api は何もしない
    expect(existsSync(join(plan.path, 'packages', 'api', 'node_modules'))).toBe(false);
    expect(installs).toEqual([]);
  });

  it('package-lock.json が元のフォルダと違う場所だけ、続けて npm install', async () => {
    pkg('', '{"v":1}');
    pkg('tools/cli', '{"v":1}');
    commit();
    modules('');
    modules('tools/cli');
    // 元のフォルダでだけ、tools/cli の lock を書き換えている（コミットしていない）
    writeFileSync(join(repo, 'tools', 'cli', 'package-lock.json'), '{"v":2}');
    const plan = await create();
    const { result, steps } = await prepare(plan, copy, 1);
    expect(result).toEqual({ cloned: ['', 'tools/cli'], failed: [], installs: [{ dir: 'tools/cli', command: 'npm install', exitCode: 1 }] });
    expect(steps).toEqual(['copying', 'installing']);
  });

  it('複製できなければ、それを受け持つ package-lock.json の場所で npm install（workspaces はいちばん上）', async () => {
    pkg('');
    pkg('packages/web', null);
    pkg('tools/cli');
    commit();
    for (const dir of ['', 'packages/web', 'tools/cli']) modules(dir);
    const plan = await create();
    const fail = (from: string) => (from.includes('packages') || from.includes('tools') ? Promise.reject(new Error('cross-device')) : copy(from, from.replace(repo, plan.path)));
    const { result, installs } = await prepare(plan, fail);
    expect(result.cloned).toEqual(['']);
    expect(result.failed).toEqual(['packages/web', 'tools/cli']);
    // 上のフォルダから順に
    expect(installs).toEqual(['npm install @ .', 'npm install @ tools/cli']);
  });

  it('lock ファイルから、使うパッケージマネージャーを見分けて install する（yarn・pnpm・bun）', async () => {
    for (const [dir, file] of [
      ['apps/yarn', 'yarn.lock'],
      ['apps/pnpm', 'pnpm-lock.yaml'],
      ['apps/bun', 'bun.lock'],
      ['apps/bunb', 'bun.lockb'],
    ]) {
      pkg(dir, null);
      writeFileSync(join(repo, dir, file), 'v1');
    }
    commit();
    for (const dir of ['apps/yarn', 'apps/pnpm', 'apps/bun', 'apps/bunb']) modules(dir);
    // 元のフォルダでだけ、lock を書き換えている
    writeFileSync(join(repo, 'apps', 'yarn', 'yarn.lock'), 'v2');
    writeFileSync(join(repo, 'apps', 'bun', 'bun.lock'), 'v2');
    const plan = await create();
    const fail = (from: string) => (from.includes('pnpm') ? Promise.reject(new Error('cross-device')) : copy(from, from.replace(repo, plan.path)));
    const { result, installs } = await prepare(plan, fail);
    expect(result.cloned).toEqual(['apps/bun', 'apps/bunb', 'apps/yarn']);
    expect(result.failed).toEqual(['apps/pnpm']);
    expect(installs).toEqual(['bun install @ apps/bun', 'pnpm install @ apps/pnpm', 'yarn install @ apps/yarn']);
  });

  it('npm 以外の lock があれば、残っている package-lock.json より、そちらを使う', async () => {
    pkg('', '{}');
    writeFileSync(join(repo, 'yarn.lock'), 'v1');
    commit();
    modules('');
    const plan = await create();
    const { installs } = await prepare(plan, () => Promise.reject(new Error('cross-device')));
    expect(installs).toEqual(['yarn install @ .']);
  });

  it("yarn の Plug'n'Play（node_modules が無い）では、.pnp.cjs が worktree に無ければ yarn install する", async () => {
    pkg('', null);
    writeFileSync(join(repo, 'yarn.lock'), 'v1');
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n.pnp.*\n');
    commit();
    writeFileSync(join(repo, '.pnp.cjs'), '');
    const plan = await create();
    const { result, steps, installs } = await prepare(plan);
    expect(result).toEqual({ cloned: [], failed: [], installs: [{ dir: '', command: 'yarn install', exitCode: 0 }] });
    expect(steps).toEqual(['installing']);
    expect(installs).toEqual(['yarn install @ .']);
  });

  it("yarn の Plug'n'Play で .pnp.cjs をコミットしていれば（zero-install）、lock が同じなら何もしない", async () => {
    pkg('', null);
    writeFileSync(join(repo, 'yarn.lock'), 'v1');
    writeFileSync(join(repo, '.pnp.cjs'), '');
    commit();
    const plan = await create();
    const { result, steps } = await prepare(plan);
    expect(result).toEqual({ cloned: [], failed: [], installs: [] });
    expect(steps).toEqual([]);
  });

  it('git で調べられないフォルダでは、いちばん上の package.json だけを見る', async () => {
    pkg('');
    modules('');
    const plain = join(root, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'package.json'), '{}');
    writeFileSync(join(plain, 'package-lock.json'), '{"v":2}');
    const installs: string[] = [];
    const result = await prepareNodeModules(repo, plain, {
      onStep: () => {},
      install: (_cwd, dir, command) => (installs.push(`${command} @ ${dir || '.'}`), Promise.resolve(0)),
      clone: copy,
    });
    expect(result).toEqual({ cloned: [''], failed: [], installs: [{ dir: '', command: 'npm install', exitCode: 0 }] });
    expect(existsSync(join(plain, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
  });

  it('node_modules の中で追跡している package.json は、パッケージの場所として見ない', async () => {
    pkg('');
    mkdirSync(join(repo, 'vendor', 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(repo, 'vendor', 'node_modules', 'x', 'package.json'), '{}');
    // .gitignore の node_modules/ を越えて、無理に追跡した
    git(repo, 'add', '-f', 'vendor/node_modules/x/package.json');
    commit();
    modules('');
    modules('vendor/node_modules/x');
    const plan = await create();
    const { result } = await prepare(plan);
    expect(result.cloned).toEqual(['']);
    expect(existsSync(join(plan.path, 'vendor', 'node_modules', 'x', 'node_modules'))).toBe(false);
  });

  it('複製できなくても、受け持つ lock ファイルが無ければ install しない（複製しかけたものは消す）', async () => {
    pkg('', null);
    commit();
    modules('');
    const plan = await create();
    const half = (_from: string, to: string) => {
      mkdirSync(join(to, 'half'), { recursive: true });
      return Promise.reject(new Error('cross-device'));
    };
    const { result, steps, installs } = await prepare(plan, half);
    expect(result).toEqual({ cloned: [], failed: [''], installs: [] });
    expect(steps).toEqual(['copying']);
    expect(installs).toEqual([]);
    expect(existsSync(join(plan.path, 'node_modules'))).toBe(false);
  });

  it.skipIf(process.platform === 'darwin')('macOS 以外では APFS のクローンができないので、複製せずに install で用意する', async () => {
    pkg('');
    commit();
    modules('');
    const plan = await create();
    const installs: string[] = [];
    const result = await prepareNodeModules(repo, plan.path, {
      onStep: () => {},
      install: (_cwd, _dir, command) => (installs.push(command), Promise.resolve(0)),
    });
    expect(result).toEqual({ cloned: [], failed: [''], installs: [{ dir: '', command: 'npm install', exitCode: 0 }] });
    await expect(apfsClone(join(repo, 'node_modules'), join(root, 'copy'))).rejects.toThrow('APFS のクローンは macOS だけ');
  });

  it('元のフォルダに node_modules が無ければ何もしない', async () => {
    pkg('');
    commit();
    const plan = await create();
    const { result, steps } = await prepare(plan);
    expect(result).toEqual({ cloned: [], failed: [], installs: [] });
    expect(steps).toEqual([]);
  });
});

// 実際の APFS のクローン（macOS だけ。ディレクトリ丸ごとを 1 回の clonefile で複製する）
describe.skipIf(process.platform !== 'darwin')('APFS のクローン', () => {
  const tree = () => {
    const from = join(root, '日本語 の', 'node_modules');
    mkdirSync(join(from, '.bin'), { recursive: true });
    mkdirSync(join(from, 'left-pad'), { recursive: true });
    writeFileSync(join(from, 'left-pad', 'index.js'), 'a');
    symlinkSync('../left-pad/index.js', join(from, '.bin', 'left-pad'));
    return from;
  };

  it('ディレクトリ丸ごと（シンボリックリンクはそのまま）複製し、複製を書き換えても元は変わらない', async () => {
    const from = tree();
    const to = join(root, 'to space', 'node_modules');
    mkdirSync(join(root, 'to space'));
    await apfsClone(from, to);
    expect(readdirSync(to, { recursive: true }).sort()).toEqual(readdirSync(from, { recursive: true }).sort());
    expect(readlinkSync(join(to, '.bin', 'left-pad'))).toBe('../left-pad/index.js');
    writeFileSync(join(to, 'left-pad', 'index.js'), 'b');
    expect(readFileSync(join(from, 'left-pad', 'index.js'), 'utf8')).toBe('a');
  });

  it('コピー先が既にあれば、その中に重ねてコピーせず、失敗にする', async () => {
    const from = tree();
    const to = join(root, 'exists');
    mkdirSync(to);
    await expect(apfsClone(from, to)).rejects.toThrow();
    expect(readdirSync(to)).toEqual([]);
  });
});
