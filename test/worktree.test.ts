import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeBranchKeep } from '@shared/ipc';
import { claudeArgs } from '../src/main/claude-session';
import { type PullRequest, pullRequestsOf } from '../src/main/github';
import {
  apfsClone,
  deleteBackup,
  hideWorktrees,
  listBackups,
  planWorktree,
  prepareNodeModules,
  removeWorktree,
  restoreWorktree,
  setAsideIgnoredDirs,
  waitForWorktree,
  worktreeLeftovers,
  type WorktreePlan,
} from '../src/main/worktree';
import { stages } from './helpers/stages';

// worktree のセッション（claude --worktree）の、アプリが受け持つところ。本物の git で確かめる。
// Claude Code が worktree を作るところは、Claude Code と同じ形（.claude/worktrees/<名前>・ブランチ worktree-<名前>・
// 「claude session …」のロック）を git で作って代わりにする（本物の Claude Code では test/cli/worktree.test.ts）。
// PR（gh で GitHub に問い合わせるところ）は差し替える

vi.mock('../src/main/github', () => ({ pullRequestsOf: vi.fn() }));
const prs = vi.mocked(pullRequestsOf);

// worktree の名前の乱数を決められるようにする（queue から順に。無ければ fixed、それも無ければ本物の乱数）
const names = vi.hoisted(() => ({ queue: [] as number[][], fixed: null as number[] | null, calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) => {
      names.calls++;
      const next = names.queue.shift() ?? names.fixed;
      return next ? Buffer.from(next) : actual.randomBytes(size);
    },
  };
});

// アプリの git の呼び出しの前に、1 度だけ割り込ませる（ほかの Claude Code が間に入る場面を作る）。中身は本物の git
const gitHook = vi.hoisted(() => ({ before: null as null | ((args: string[]) => void) }));
vi.mock('../src/main/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/git')>();
  return {
    ...actual,
    git: (cwd: string, args: string[], ...rest: unknown[]) => {
      gitHook.before?.(args);
      return (actual.git as (...a: unknown[]) => Promise<string>)(cwd, args, ...rest);
    },
  };
});

let root: string;
let repo: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  // 既定は、gh で調べられない
  prs.mockReset().mockResolvedValue(null);
  gitHook.before = null;
  names.queue = [];
  names.fixed = null;
  names.calls = 0;
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

// 残っているものと、いちばん前のブランチ（今のブランチ。無ければ起動したときのブランチ）の状態を、1 つにまとめたもの（exists は worktree のもの）
const leftoversOf = async (plan: WorktreePlan, path = plan.path) => {
  const leftovers = await worktreeLeftovers(plan, path);
  return { ...leftovers.branches[0], ...leftovers };
};

// removeWorktree の結果の、起動したときのブランチ。keep: 残した理由（null は消した）/ current: 今のブランチでもあるか
const launched = (plan: WorktreePlan, keep: WorktreeBranchKeep | null = null, current = true) => ({
  name: plan.branch,
  launched: true,
  current,
  deleted: keep === null,
  keep,
});

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
    names.calls = 0;
    await expect(planWorktree(repo)).rejects.toThrow('worktree の名前を決められませんでした');
    // 試すのは 20 回まで
    expect(names.calls).toBe(20);
    git(repo, 'branch', '-D', first.branch);
    mkdirSync(first.path, { recursive: true });
    await expect(planWorktree(repo)).rejects.toThrow('worktree の名前を決められませんでした');
    rmSync(first.path, { recursive: true });
    expect((await planWorktree(repo)).name).toBe(first.name);
  });

  it('名前の日付は、月と日を 2 桁ずつにする', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 2, 5, 12));
      names.queue = [[0, 1, 2, 3]];
      expect((await planWorktree(repo)).name).toBe('tc-0305-abcd');
    } finally {
      vi.useRealTimers();
    }
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

  it('exclude が改行で終わっていれば、空の行を挟まずに足す', async () => {
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '*.tmp\n');
    await hideWorktrees(repo);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe('*.tmp\n# tanacode: Claude Code の worktree（claude --worktree）\n/.claude/worktrees/\n');
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
      uncommitted: 0,
      untracked: 0,
      submodules: [],
      branches: [
        { name: plan.branch, launched: true, current: true, exists: true, unpushed: 0, contentIn: null, pr: { state: 'unknown' }, keep: null },
      ],
    });
    writeFileSync(join(plan.path, 'b.txt'), 'b\n');
    git(plan.path, 'add', 'b.txt');
    git(plan.path, 'commit', '-qm', 'b');
    writeFileSync(join(plan.path, 'a.txt'), 'changed\n');
    git(plan.path, 'mv', 'b.txt', 'c.txt');
    writeFileSync(join(plan.path, 'new.txt'), 'new\n');
    // .gitignore で無視されるものは数えない
    writeFileSync(join(plan.path, '.env'), 'SECRET=1\n');
    expect(await leftoversOf(plan)).toMatchObject({ uncommitted: 2, untracked: 1, unpushed: 1 });
  });

  it('worktree もブランチも無ければ、何も残っていない', async () => {
    const plan = await planWorktree(repo);
    expect(await leftoversOf(plan)).toMatchObject({ exists: false, uncommitted: 0, untracked: 0, unpushed: 0 });
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

  it('1 文字の名前の未追跡のファイルも数える', async () => {
    const plan = await create();
    writeFileSync(join(plan.path, 'x'), 'x\n');
    expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ untracked: 1 });
  });

  it('プッシュしていないコミットが 10 件以上あっても数える', async () => {
    const plan = await create();
    // 速く作るため、追跡しているファイルを書き換えて、1 回の git でコミットする
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(plan.path, 'a.txt'), `${i}\n`);
      git(plan.path, 'commit', '-qam', `c${i}`);
    }
    expect(await leftoversOf(plan)).toMatchObject({ unpushed: 10 });
  });

  describe('PR', () => {
    it('PR をスカッシュマージして、リモートのブランチを消していても、PR に入っているコミットはプッシュしていないと数えない', async () => {
      const done = stages();
      withOrigin();
      const plan = await create();
      commitIn(plan.path, 'b.txt');
      commitIn(plan.path, 'c.txt');
      git(plan.path, 'push', '-q', '-u', 'origin', plan.branch);
      // GitHub がマージのあとにブランチを消し、手元でも prune した（上流が無くなった）
      git(repo, 'push', '-q', 'origin', '--delete', plan.branch);
      git(repo, 'fetch', '-q', '--prune');
      done('準備（origin・worktree・コミット・プッシュ・ブランチを消す）');
      // gh で調べられなければ、どのリモートにも無いコミットとして数える
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 2, pr: { state: 'unknown' } });
      done('数える 1（PR を調べられない）');
      const head = git(repo, 'rev-parse', plan.branch);
      prs.mockResolvedValue([pull({ number: 7, state: 'MERGED', headRefOid: head })]);
      expect(await leftoversOf(plan)).toMatchObject({
        unpushed: 0,
        contentIn: null,
        submodules: [],
        pr: { state: 'merged', number: 7, base: 'main', url: 'https://github.com/me/repo/pull/7', after: 0 },
      });
      expect(prs).toHaveBeenLastCalledWith(repo, plan.branch, true);
      done('数える 2（マージ済みの PR）');
      // マージのあとに足したコミットは、プッシュしていないコミットとして数える
      commitIn(plan.path, 'd.txt');
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 1, pr: { state: 'merged', after: 1 } });
      done('数える 3（マージのあとのコミット）');
    });

    it('上流の名前が違えば、その名前で PR を探す', async () => {
      withOrigin();
      const plan = await create();
      git(plan.path, 'push', '-q', '-u', 'origin', `${plan.branch}:fix/login`);
      await worktreeLeftovers(plan, plan.path);
      expect(prs).toHaveBeenLastCalledWith(repo, 'fix/login', true);
    });

    it('開いている PR → マージ済み → 閉じたものの順に選ぶ。PR が無ければ none', async () => {
      const plan = await create();
      const head = git(repo, 'rev-parse', plan.branch);
      prs.mockResolvedValue([pull({ number: 3, state: 'CLOSED', headRefOid: head }), pull({ number: 2, state: 'MERGED', headRefOid: head })]);
      expect((await leftoversOf(plan)).pr).toMatchObject({ state: 'merged', number: 2 });
      prs.mockResolvedValue([pull({ number: 4, state: 'OPEN', headRefOid: head }), pull({ number: 2, state: 'MERGED', headRefOid: head })]);
      expect((await leftoversOf(plan)).pr).toMatchObject({ state: 'open', number: 4 });
      // 閉じたものしか無ければ閉じたもの。同じ状態のものが 2 つあれば、新しいほう（先に返るもの）
      prs.mockResolvedValue([pull({ number: 6, state: 'CLOSED', headRefOid: head })]);
      expect((await leftoversOf(plan)).pr).toMatchObject({ state: 'closed', number: 6 });
      prs.mockResolvedValue([pull({ number: 5, state: 'OPEN', headRefOid: head }), pull({ number: 4, state: 'OPEN', headRefOid: head })]);
      expect((await leftoversOf(plan)).pr).toMatchObject({ state: 'open', number: 5 });
      prs.mockResolvedValue([]);
      expect((await leftoversOf(plan)).pr).toEqual({ state: 'none' });
    });

    it('ブランチが手元に無ければ、PR のあとに足したコミットは 0', async () => {
      const plan = await planWorktree(repo);
      prs.mockResolvedValue([pull({ number: 9, state: 'OPEN', headRefOid: git(repo, 'rev-parse', 'HEAD') })]);
      expect(await worktreeLeftovers(plan, plan.path)).toEqual({
        exists: false,
        uncommitted: 0,
        untracked: 0,
        submodules: [],
        branches: [
          {
            name: plan.branch,
            launched: true,
            current: false,
            exists: false,
            unpushed: 0,
            contentIn: null,
            pr: { state: 'open', number: 9, base: 'main', url: 'https://github.com/me/repo/pull/9', after: 0 },
            keep: null,
          },
        ],
      });
    });

    it('PR の head のコミットが手元に無ければ、PR で除かずに数える', async () => {
      const plan = await create();
      commitIn(plan.path, 'b.txt');
      prs.mockResolvedValue([pull({ number: 7, state: 'MERGED', headRefOid: '0123456789abcdef0123456789abcdef01234567' })]);
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 1, pr: { state: 'merged', after: null } });
    });
  });

  describe('PR を使わずに直接コミットしたもの', () => {
    it('リモートのデフォルトブランチへ直接プッシュしたコミットは、プッシュしていないと数えない', async () => {
      withOrigin();
      prs.mockResolvedValue([]);
      const plan = await create();
      commitIn(plan.path, 'b.txt');
      git(plan.path, 'push', '-q', 'origin', 'HEAD:main');
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 0, contentIn: null, pr: { state: 'none' } });
    });

    it('手元でスカッシュマージしてコミットが作り直されていても、中身がデフォルトブランチに入っていれば数えない', async () => {
      const plan = await create();
      commitIn(plan.path, 'a.txt', 'b');
      commitIn(plan.path, 'b.txt');
      squashMerge(plan.branch);
      // マージのあとに、デフォルトブランチで同じところを変えていても見分ける
      commitIn(repo, 'a.txt', 'c');
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 0, contentIn: 'main' });
      // マージのあとに足したコミットがあれば、入っていないとみなす
      commitIn(plan.path, 'd.txt');
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 3, contentIn: null });
    });

    it('上流に無いコミットでも、手元のデフォルトブランチに取り込んであれば数えない', async () => {
      withOrigin();
      const plan = await create();
      git(plan.path, 'push', '-q', '-u', 'origin', plan.branch);
      commitIn(plan.path, 'b.txt');
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 1, contentIn: null });
      // 手元で main に取り込んだ（プッシュはしていない）
      git(repo, 'merge', '-q', '--ff-only', plan.branch);
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 0, contentIn: 'main' });
    });

    it('origin のデフォルトブランチにだけスカッシュマージされていても（手元の main は古いまま）、入っているとみなす', async () => {
      withOrigin();
      const plan = await create();
      commitIn(plan.path, 'b.txt');
      // 別の場所でスカッシュマージして origin に送った
      git(repo, 'switch', '-q', '-c', 'tmp-merge');
      squashMerge(plan.branch);
      git(repo, 'push', '-q', 'origin', 'tmp-merge:main');
      git(repo, 'switch', '-q', 'main');
      git(repo, 'branch', '-D', 'tmp-merge');
      git(repo, 'fetch', '-q', 'origin');
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 0, contentIn: 'main' });
    });

    it('変えて戻しただけ（中身の差が無い）のブランチは、デフォルトブランチに入っているとみなす', async () => {
      const plan = await create();
      commitIn(plan.path, 'b.txt');
      git(plan.path, 'rm', '-q', 'b.txt');
      git(plan.path, 'commit', '-qm', 'revert');
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 0, contentIn: 'main' });
    });

    it('デフォルトブランチと履歴のつながらないブランチは、中身を比べられないので数える', async () => {
      const plan = await create();
      git(plan.path, 'switch', '-q', '--orphan', 'lonely');
      commitIn(plan.path, 'z.txt');
      git(plan.path, 'switch', '-q', '-C', plan.branch);
      git(repo, 'branch', '-D', 'lonely');
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 1, contentIn: null });
    });

    it('デフォルトブランチが分からなければ、中身では比べずに数える', async () => {
      git(repo, 'branch', '-m', 'work');
      const plan = await create();
      commitIn(plan.path, 'a.txt', 'b');
      git(repo, 'merge', '-q', '--squash', plan.branch);
      git(repo, 'commit', '-qm', 'squash');
      expect(await leftoversOf(plan)).toMatchObject({ unpushed: 1, contentIn: null });
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
    // フォルダがあっても、.git が無ければまだできていない
    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(await waitForWorktree(empty, () => false, 1000)).toBe(false);
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

// dir（の git のデータ）を partial clone にする。手元に無いオブジェクトを取りに行くと、core.sshCommand が marker を作る
const partialCloneOf = (dir: string, marker: string) => {
  git(dir, 'config', 'core.repositoryformatversion', '1');
  git(dir, 'config', 'extensions.partialClone', 'origin');
  git(dir, 'config', 'remote.origin.promisor', 'true');
  git(dir, 'config', 'remote.origin.url', 'ssh://tanacode.invalid/repo.git');
  git(dir, 'config', 'core.sshCommand', `touch '${marker}'; false`);
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
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branches: [launched(plan)] });
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
    // 控えに使う一時的なインデックスの名前を決めておき、消えたかを確かめる。
    // インデックスはみんなで使う一時フォルダに作られるので、名前は毎回変える（決め打ちにすると、同じ機械で同時に流した
    // ほかのテストの実行（別の作業場所など）と同じファイルを取り合い、git の .lock がぶつかったり、控えの中身が欠けたりする）
    const bytes = [...globalThis.crypto.getRandomValues(new Uint8Array(6))];
    names.queue = [bytes];
    const removal = await removeWorktree(plan, plan.path);
    expect(existsSync(join(tmpdir(), `tanacode-index-${Buffer.from(bytes).toString('hex')}`))).toBe(false);
    expect(removal.backupRef).toBe(`refs/tanacode/backup/${plan.name}`);
    expect(existsSync(plan.path)).toBe(false);
    const ref = removal.backupRef!;
    expect(git(repo, 'show', `${ref}:a.txt`)).toBe('changed');
    expect(git(repo, 'show', `${ref}:staged.txt`)).toBe('staged');
    expect(git(repo, 'show', `${ref}:new.txt`)).toBe('new');
    // gitignore されたファイルは控えに入らない
    expect(git(repo, 'ls-tree', '--name-only', ref)).not.toContain('.env');
    expect(git(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', ref)).toBe(
      `tanacode <tanacode@localhost>|tanacode <tanacode@localhost>|tanacode: worktree ${plan.name} を消す前の控え（未コミットの変更と未追跡のファイル。親は、そのときの HEAD）`,
    );
    // 控えの親は worktree の HEAD
    expect(git(repo, 'rev-parse', `${ref}^`)).toBe(git(repo, 'rev-parse', 'main'));
    // 控えのコミットはブランチに入っていないので、ブランチはマージ済みとして消える
    expect(removal.branches).toEqual([launched(plan)]);
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
    expect(removal).toMatchObject({ backupRef: null, branches: [launched(plan, 'localOnly')] });
    expect(existsSync(plan.path)).toBe(false);
    expect(git(repo, 'log', '-1', '--format=%s', plan.branch)).toBe('b');
  });

  it('ブランチと同じ名前のタグ（main の上）があっても、ブランチの手元にしか無いコミットを数えて、ブランチごと残す', async () => {
    const plan = await create();
    // 名前のまま数えると、git はタグの方を読む（main の上なので、手元にしか無いコミットは 0 になる）
    git(repo, 'tag', plan.branch, 'main');
    commitIn(plan.path, 'b.txt');
    expect(await removeWorktree(plan, plan.path)).toMatchObject({ backupRef: null, branches: [launched(plan, 'localOnly')] });
    expect(git(repo, 'log', '-1', '--format=%s', `refs/heads/${plan.branch}`)).toBe('b.txt');
  });

  it('PR をスカッシュマージしたブランチは、手元のコミットがすべてその PR に入っていれば消す', async () => {
    const plan = await create();
    commitIn(plan.path, 'b.txt');
    const head = git(repo, 'rev-parse', plan.branch);
    commitIn(plan.path, 'c.txt');
    // マージした PR のあとに足したコミットがあれば残す
    prs.mockResolvedValue([pull({ number: 7, state: 'MERGED', headRefOid: head })]);
    expect(await removeWorktree(plan, plan.path)).toMatchObject({ branches: [launched(plan, 'localOnly')] });
    prs.mockResolvedValue([pull({ number: 8, state: 'MERGED', headRefOid: git(repo, 'rev-parse', plan.branch) })]);
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branches: [launched(plan, null, false)] });
    expect(git(repo, 'branch', '--list', plan.branch)).toBe('');
  });

  it('PR を使わずに、リモートのデフォルトブランチへ直接プッシュしたブランチも消す', async () => {
    withOrigin();
    const plan = await create();
    commitIn(plan.path, 'b.txt');
    git(plan.path, 'push', '-q', 'origin', 'HEAD:main');
    // 手元の main は古いままなので、git branch -d では消えない
    expect(await removeWorktree(plan, plan.path)).toMatchObject({ branches: [launched(plan)] });
    expect(git(repo, 'branch', '--list', plan.branch)).toBe('');
  });

  it('手元でデフォルトブランチにスカッシュマージしたブランチも消す', async () => {
    const plan = await create();
    commitIn(plan.path, 'b.txt');
    commitIn(plan.path, 'c.txt');
    squashMerge(plan.branch);
    expect(await removeWorktree(plan, plan.path)).toMatchObject({ branches: [launched(plan)] });
    expect(git(repo, 'branch', '--list', plan.branch)).toBe('');
  });

  it('partial clone のリポジトリでも、PR の head（手元に無いコミット）や中身の比べのために、無いものを取りに行かない', async () => {
    const plan = await create();
    commitIn(plan.path, 'b.txt');
    squashMerge(plan.branch);
    const marker = join(root, 'lazy-fetched');
    partialCloneOf(repo, marker);
    const missing = '1'.repeat(40);
    // 前提: cat-file -e は、無いコミットを取りに行って core.sshCommand を動かす
    expect(() => execFileSync('git', ['cat-file', '-e', missing], { cwd: repo, stdio: 'ignore' })).toThrow();
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    prs.mockResolvedValue([pull({ number: 1, state: 'MERGED', headRefOid: missing })]);
    // 中身で比べないので、手元でスカッシュマージしたものも、入っていない側に倒れる
    expect(await leftoversOf(plan)).toMatchObject({ unpushed: 1, contentIn: null });
    expect(await removeWorktree(plan, plan.path)).toMatchObject({ branches: [launched(plan, 'localOnly')] });
    expect(existsSync(marker)).toBe(false);
  });

  it('ロックの理由の途中に「claude session 」があっても、Claude Code のロックとはみなさない', async () => {
    const plan = await create();
    git(repo, 'worktree', 'unlock', plan.path);
    git(repo, 'worktree', 'lock', '--reason', 'not a claude session lock', plan.path);
    await expect(removeWorktree(plan, plan.path)).rejects.toThrow('not a claude session lock');
    expect(existsSync(plan.path)).toBe(true);
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

  it('ロックの理由の制御文字のうち、git が \\r・\\v などの文字で書くものも元に戻す', async () => {
    const plan = await create();
    git(repo, 'worktree', 'unlock', plan.path);
    const reason = 'a\rb\vc\fd\be\x07f';
    git(repo, 'worktree', 'lock', '--reason', reason, plan.path);
    await expect(removeWorktree(plan, plan.path)).rejects.toThrow(`（${reason}）`);
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
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branches: [] });
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
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branches: [launched(plan, 'checkedOut', false)] });
    // ロックしたまま登録を残す（git worktree prune は、ロックしたものを片付けない）
    expect(git(repo, 'worktree', 'list')).toMatch(new RegExp(`${plan.path} .* locked`));
  });

  // 同じリポジトリのほかの Claude Code が、裏の掃除で pid のもう無い claude session のロックを外すことがある
  // （確かめてから unlock するまでの間に入ると、git worktree unlock は「is not locked」で失敗する）
  it('確かめてから外すまでの間に、ほかの Claude Code がロックを外していても、worktree とブランチを消す', async () => {
    const plan = await create();
    gitHook.before = (args) => {
      if (args[0] !== 'worktree' || args[1] !== 'unlock') return;
      gitHook.before = null;
      git(repo, 'worktree', 'unlock', plan.path);
    };
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branches: [launched(plan)] });
    expect(existsSync(plan.path)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(plan.name);
  });

  it('フォルダをもう手で消していたら、git の登録を片付けて、ブランチの扱いは同じ', async () => {
    const plan = await create();
    rmSync(plan.path, { recursive: true, force: true });
    expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branches: [launched(plan, null, false)] });
    expect(git(repo, 'worktree', 'list')).not.toContain(plan.name);
  });

  // submodule を作って初期化するので、git を多く動かす（プロセスの起動が遅い Mac では、1 件に数秒かかる）
  describe('submodule', { timeout: 30_000 }, () => {
    const sub = (cwd: string, ...args: string[]) => git(cwd, '-c', 'protocol.file.allow=always', 'submodule', ...args);
    // コミットできるリポジトリを作る
    const newRepo = (dir: string) => {
      mkdirSync(dir);
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 'me@example.com');
      git(dir, 'config', 'user.name', 'me');
      commitIn(dir, 'init.txt');
    };
    // repo に submodule の lib を足してコミットし、worktree を作る。nested: lib の中に入れ子の submodule の nested も入れる。
    // init: worktree の中でも初期化する
    const withSubmodule = async ({ init = true, nested = false } = {}) => {
      const lib = join(root, 'lib');
      newRepo(lib);
      if (nested) {
        newRepo(join(root, 'nested'));
        sub(lib, 'add', '-q', join(root, 'nested'), 'nested');
        git(lib, 'commit', '-qm', 'nested');
      }
      sub(repo, 'add', '-q', lib, 'lib');
      git(repo, 'commit', '-qm', 'lib');
      const plan = await create();
      if (!init) return plan;
      sub(plan.path, 'update', '-q', '--init', '--recursive');
      git(join(plan.path, 'lib'), 'config', 'user.email', 'me@example.com');
      git(join(plan.path, 'lib'), 'config', 'user.name', 'me');
      return plan;
    };
    // 消さずに断られ、フォルダもブランチも残っていて、控えも作っていない
    const expectRefused = async (plan: WorktreePlan, paths: string) => {
      await expect(removeWorktree(plan, plan.path)).rejects.toMatchObject({ reason: 'submoduleChanges', detail: paths });
      expect(existsSync(plan.path)).toBe(true);
      expect(git(repo, 'branch', '--list', plan.branch)).not.toBe('');
      expect(git(repo, 'for-each-ref', 'refs/tanacode/')).toBe('');
    };

    it('初期化した submodule があっても、中に何も残っていなければ消して、ブランチも消す', async () => {
      const plan = await withSubmodule({ nested: true });
      expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branches: [launched(plan)] });
      expect(existsSync(plan.path)).toBe(false);
      expect(git(repo, 'branch', '--list', plan.branch)).toBe('');
      expect(git(repo, 'worktree', 'list')).not.toContain(plan.name);
    });

    it('初期化していない submodule は、今までどおり消せる', async () => {
      const plan = await withSubmodule({ init: false, nested: true });
      expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branches: [launched(plan)] });
      expect(existsSync(plan.path)).toBe(false);
    });

    it('submodule の中に未コミットの変更があれば、消さずに断る', async () => {
      const plan = await withSubmodule();
      writeFileSync(join(plan.path, 'lib', 'init.txt'), 'changed\n');
      await expectRefused(plan, 'lib');
    });

    it('submodule の中の変更は、submodule の ignore の設定があっても見落とさない', async () => {
      const plan = await withSubmodule();
      git(repo, 'config', 'submodule.lib.ignore', 'all');
      writeFileSync(join(plan.path, 'lib', 'init.txt'), 'changed\n');
      await expectRefused(plan, 'lib');
    });

    it('入れ子の submodule の中の未追跡のファイルも見て、断る', async () => {
      const plan = await withSubmodule({ nested: true });
      writeFileSync(join(plan.path, 'lib', 'nested', 'new.txt'), 'new\n');
      await expectRefused(plan, 'lib/nested');
    });

    it('submodule に、どのリモートにも無いコミットがあれば断る', async () => {
      const plan = await withSubmodule();
      commitIn(join(plan.path, 'lib'), 'local.txt');
      await expectRefused(plan, 'lib');
    });

    it('submodule のコミットが、元のフォルダの submodule にもあれば消す', async () => {
      const plan = await withSubmodule();
      const inner = join(plan.path, 'lib');
      git(inner, 'switch', '-q', '-c', 'work');
      commitIn(inner, 'local.txt');
      // 元のフォルダの submodule（.git/modules/lib）に取り込んでおく
      git(join(repo, 'lib'), 'fetch', '-q', inner, 'work:work');
      await removeWorktree(plan, plan.path);
      expect(existsSync(plan.path)).toBe(false);
    });

    it('submodule に stash があれば断る', async () => {
      const plan = await withSubmodule();
      writeFileSync(join(plan.path, 'lib', 'init.txt'), 'changed\n');
      git(join(plan.path, 'lib'), 'stash', '-q');
      await expectRefused(plan, 'lib');
    });

    it('元のフォルダ側も submodule の中も変わっていれば、控えも作らず、--force せずに断る', async () => {
      const plan = await withSubmodule();
      writeFileSync(join(plan.path, 'a.txt'), 'changed\n');
      writeFileSync(join(plan.path, 'lib', 'init.txt'), 'changed\n');
      await expectRefused(plan, 'lib');
      expect(readFileSync(join(plan.path, 'a.txt'), 'utf8')).toBe('changed\n');
    });

    it('submodule の中に何も残っていなければ、元のフォルダ側の変更は控えを残して消す', async () => {
      const plan = await withSubmodule();
      writeFileSync(join(plan.path, 'a.txt'), 'changed\n');
      expect((await removeWorktree(plan, plan.path)).backupRef).toBe(`refs/tanacode/backup/${plan.name}`);
      expect(existsSync(plan.path)).toBe(false);
      expect(git(repo, 'show', `refs/tanacode/backup/${plan.name}:a.txt`)).toBe('changed');
    });

    it('残っているものに、中に失われるものがある submodule を並べる', async () => {
      const plan = await withSubmodule({ nested: true });
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ uncommitted: 0, untracked: 0, submodules: [] });
      git(repo, 'config', 'submodule.lib.ignore', 'all');
      writeFileSync(join(plan.path, 'lib', 'nested', 'new.txt'), 'new\n');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ uncommitted: 1, submodules: ['lib/nested'] });
    });

    // worktree の submodule の git のデータ（.git/worktrees/<id>/modules/lib）
    const modulesOf = (plan: WorktreePlan) => join(repo, '.git', 'worktrees', plan.name, 'modules');

    it('deinit した submodule の git のデータに手元にしか無いコミットがあれば、元のフォルダ側が変わっていても断る', async () => {
      const plan = await withSubmodule();
      commitIn(join(plan.path, 'lib'), 'local.txt');
      git(plan.path, 'submodule', 'deinit', '-q', '-f', 'lib');
      writeFileSync(join(plan.path, 'new.txt'), 'new\n');
      await expectRefused(plan, 'lib');
      expect(existsSync(join(modulesOf(plan), 'lib'))).toBe(true);
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ submodules: ['lib'] });
    });

    it('deinit した submodule に失われるものが無ければ、元のフォルダ側がきれいでも --force で消す', async () => {
      const plan = await withSubmodule();
      git(plan.path, 'submodule', 'deinit', '-q', '-f', 'lib');
      expect(await removeWorktree(plan, plan.path)).toEqual({ backupRef: null, branches: [launched(plan)] });
      expect(existsSync(plan.path)).toBe(false);
    });

    it('gitlink を外して（git rm --cached）フォルダと git のデータだけが残った submodule も見る', async () => {
      const plan = await withSubmodule();
      commitIn(join(plan.path, 'lib'), 'local.txt');
      git(plan.path, 'rm', '-q', '--cached', 'lib');
      git(plan.path, 'commit', '-qm', 'drop lib');
      await expectRefused(plan, 'lib');
    });

    it('入れ子の submodule を deinit しても、その git のデータの手元にしか無いコミットを見落とさない', async () => {
      const plan = await withSubmodule({ nested: true });
      const nested = join(plan.path, 'lib', 'nested');
      git(nested, 'config', 'user.email', 'me@example.com');
      git(nested, 'config', 'user.name', 'me');
      commitIn(nested, 'local.txt');
      git(join(plan.path, 'lib'), 'submodule', 'deinit', '-q', '-f', 'nested');
      await expectRefused(plan, 'lib/nested');
    });

    it('submodule の中だけにあるタグが指すコミットも、手元にしか無いコミットとして見る', async () => {
      const plan = await withSubmodule();
      const inner = join(plan.path, 'lib');
      commitIn(inner, 'tagged.txt');
      git(inner, 'tag', 'v1');
      git(inner, 'checkout', '-q', 'HEAD~1');
      await expectRefused(plan, 'lib');
    });

    it('入れ子の submodule のフォルダを消したのは、外側の submodule の変更として見る', async () => {
      const plan = await withSubmodule({ nested: true });
      rmSync(join(plan.path, 'lib', 'nested'), { recursive: true, force: true });
      await expectRefused(plan, 'lib');
    });

    it('シンボリックリンクを通るパスで渡しても、submodule のパスは worktree からの形で出す', async () => {
      const plan = await withSubmodule();
      const alias = join(root, 'alias');
      symlinkSync(root, alias);
      writeFileSync(join(plan.path, 'lib', 'init.txt'), 'changed\n');
      const path = plan.path.replace(root, alias);
      await expect(removeWorktree({ ...plan, root: repo.replace(root, alias) }, path)).rejects.toMatchObject({ detail: 'lib' });
    });

    it('submodule の HEAD がまだ無くても（orphan）確かめられる', async () => {
      const plan = await withSubmodule();
      git(join(plan.path, 'lib'), 'switch', '-q', '--orphan', 'empty');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ submodules: [] });
    });

    it('submodule の中のタグを指すタグからしか辿れないコミットも、手元にしか無いコミットとして見る', async () => {
      const plan = await withSubmodule();
      const inner = join(plan.path, 'lib');
      commitIn(inner, 'tagged.txt');
      git(inner, 'tag', '-a', '-m', 'inner', 'inner');
      git(inner, '-c', 'advice.nestedTag=false', 'tag', '-a', '-m', 'outer', 'outer', 'inner');
      git(inner, 'tag', '-d', 'inner');
      git(inner, 'checkout', '-q', 'HEAD~1');
      await expectRefused(plan, 'lib');
    });

    it('submodule の中の worktree の HEAD からしか辿れないコミットも見る', async () => {
      const plan = await withSubmodule();
      const inner = join(plan.path, 'lib');
      const other = join(root, 'lib-wt');
      git(inner, 'worktree', 'add', '-q', '--detach', other);
      commitIn(other, 'wt.txt');
      await expectRefused(plan, 'lib');
    });

    it('元のフォルダの submodule が partial clone でも、無いコミットを取りに行かず（リポジトリの設定のコマンドを動かさず）、断る', async () => {
      const plan = await withSubmodule();
      commitIn(join(plan.path, 'lib'), 'local.txt');
      const original = join(repo, '.git', 'modules', 'lib');
      const marker = join(root, 'lazy-fetched');
      partialCloneOf(original, marker);
      // 前提: --missing を付けずに無いコミットを渡すと、取りに行って core.sshCommand が動く
      const local = git(join(plan.path, 'lib'), 'rev-parse', 'HEAD');
      expect(() => execFileSync('git', ['rev-list', '--count', local], { cwd: original, stdio: 'ignore' })).toThrow();
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      await expectRefused(plan, 'lib');
      expect(existsSync(marker)).toBe(false);
    });

    it('submodule の中を調べられなければ、残っているものの submodule は null（調べられなかった）にする', async () => {
      const plan = await withSubmodule();
      writeFileSync(join(modulesOf(plan), 'lib', 'HEAD'), 'broken\n');
      expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ submodules: null });
    });
  });
});

describe('作り直し（登録の残り）', () => {
  it('フォルダを手で消して git に登録が残っていても、片付けてから作り直す', async () => {
    const plan = await planWorktree(repo);
    git(repo, 'worktree', 'add', '-q', '-b', plan.branch, plan.path);
    rmSync(plan.path, { recursive: true, force: true });
    await restoreWorktree(plan, plan.path);
    expect(git(plan.path, 'branch', '--show-current')).toBe(plan.branch);
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

  it('消したときに残した今のブランチがあれば、そのブランチで作り直し、控えの中身を作業フォルダに戻して控えを外す', async () => {
    const plan = await create();
    git(plan.path, 'switch', '-q', '-c', 'fix/x');
    commitIn(plan.path, 'b.txt');
    // 未コミットの変更（ステージしたもの・していないもの）・未追跡のファイル・消したファイル
    writeFileSync(join(plan.path, 'a.txt'), 'changed\n');
    writeFileSync(join(plan.path, 'staged.txt'), 'staged\n');
    git(plan.path, 'add', 'staged.txt');
    writeFileSync(join(plan.path, 'new.txt'), 'new\n');
    rmSync(join(plan.path, 'b.txt'));
    const removal = await removeWorktree(plan, plan.path);
    expect(removal.branches).toEqual([
      { name: 'fix/x', launched: false, current: true, deleted: false, keep: 'localOnly' },
      { name: plan.branch, launched: true, current: false, deleted: true, keep: null },
    ]);
    const backupRef = removal.backupRef!;
    expect(await restoreWorktree(plan, plan.path, { branch: 'fix/x', backupRef })).toEqual({ branch: 'fix/x', busy: null, backup: 'applied' });
    expect(git(plan.path, 'branch', '--show-current')).toBe('fix/x');
    expect(readFileSync(join(plan.path, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(plan.path, 'staged.txt'), 'utf8')).toBe('staged\n');
    expect(readFileSync(join(plan.path, 'new.txt'), 'utf8')).toBe('new\n');
    expect(existsSync(join(plan.path, 'b.txt'))).toBe(false);
    // ステージしていたものも、ステージしていない変更・未追跡のファイルとして戻る
    expect(git(plan.path, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.trim()).sort()).toEqual(['?? new.txt', '?? staged.txt', 'D b.txt', 'M a.txt']);
    expect(git(repo, 'for-each-ref', 'refs/tanacode/backup/')).toBe('');
  });

  it('残したブランチが無くなっていれば、起動したときのブランチで作り直す。先頭が控えを作ったときから変わっていれば、控えは戻さずに残す', async () => {
    const plan = await create();
    writeFileSync(join(plan.path, 'new.txt'), 'new\n');
    const { backupRef } = await removeWorktree(plan, plan.path);
    // 控えを作ったあとに、元のフォルダの main が進んだ（起動したときのブランチは消えているので、今の HEAD から作り直す）
    commitIn(repo, 'later.txt');
    expect(await restoreWorktree(plan, plan.path, { branch: 'fix/gone', backupRef })).toEqual({ branch: plan.branch, busy: null, backup: 'kept' });
    expect(git(plan.path, 'branch', '--show-current')).toBe(plan.branch);
    expect(existsSync(join(plan.path, 'new.txt'))).toBe(false);
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/tanacode/backup/')).toBe(backupRef);
  });

  it('作り直すブランチをほかの場所で取り出していれば、その先頭から detached HEAD で作り直し、控えも戻す', async () => {
    const plan = await create();
    git(plan.path, 'switch', '-q', '-c', 'fix/x');
    commitIn(plan.path, 'b.txt');
    writeFileSync(join(plan.path, 'new.txt'), 'new\n');
    const { backupRef } = await removeWorktree(plan, plan.path);
    // 消したあとに、元のフォルダで fix/x を取り出した
    git(repo, 'switch', '-q', 'fix/x');
    const restored = await restoreWorktree(plan, plan.path, { branch: 'fix/x', backupRef });
    expect(restored).toEqual({ branch: null, busy: 'fix/x', backup: 'applied' });
    expect(git(plan.path, 'branch', '--show-current')).toBe('');
    expect(git(plan.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'fix/x'));
    expect(readFileSync(join(plan.path, 'new.txt'), 'utf8')).toBe('new\n');
  });
});

describe('worktree の中で作ったブランチ（git switch -c）', () => {
  it('今のブランチを先に、起動したときのブランチをあとに並べ、PR は今のブランチで探す', async () => {
    const plan = await create();
    git(plan.path, 'switch', '-q', '-c', 'fix/x');
    commitIn(plan.path, 'b.txt');
    const leftovers = await worktreeLeftovers(plan, plan.path);
    expect(leftovers.branches).toEqual([
      { name: 'fix/x', launched: false, current: true, exists: true, unpushed: 1, contentIn: null, pr: { state: 'unknown' }, keep: 'localOnly' },
      { name: plan.branch, launched: true, current: false, exists: true, unpushed: 0, contentIn: null, pr: { state: 'unknown' }, keep: null },
    ]);
    expect(prs).toHaveBeenCalledWith(repo, 'fix/x', true);
  });

  it('起動したときのブランチを消していれば（名前を変えたなど）、今のブランチだけを並べる', async () => {
    const plan = await create();
    git(plan.path, 'branch', '-q', '-m', 'fix/renamed');
    expect((await worktreeLeftovers(plan, plan.path)).branches.map((b) => b.name)).toEqual(['fix/renamed']);
  });

  it('今のブランチの PR をスカッシュマージしていれば、今のブランチも起動したときのブランチも消す', async () => {
    const plan = await create();
    git(plan.path, 'switch', '-q', '-c', 'fix/x');
    commitIn(plan.path, 'b.txt');
    prs.mockImplementation(async (_root, branch) => (branch === 'fix/x' ? [pull({ number: 3, state: 'MERGED', headRefOid: git(repo, 'rev-parse', 'fix/x') })] : []));
    expect((await worktreeLeftovers(plan, plan.path)).branches[0]).toMatchObject({ name: 'fix/x', unpushed: 0, pr: { state: 'merged', number: 3, after: 0 }, keep: null });
    const removal = await removeWorktree(plan, plan.path);
    expect(removal.branches.map((b) => [b.name, b.deleted])).toEqual([
      ['fix/x', true],
      [plan.branch, true],
    ]);
    expect(git(repo, 'branch', '--list', 'fix/x', plan.branch)).toBe('');
  });

  it('update-branch で PR の head が手元より先に進んでいても（head は手元に無い）、手元のコミットが PR のコミットに入っていれば消す', async () => {
    const plan = await create();
    git(plan.path, 'switch', '-q', '-c', 'fix/x');
    commitIn(plan.path, 'b.txt');
    const mine = git(repo, 'rev-parse', 'fix/x');
    // GitHub で update-branch したマージのコミット（手元には無い）が head
    const merged = 'f'.repeat(40);
    prs.mockImplementation(async (_root, branch) =>
      branch === 'fix/x' ? [{ ...pull({ number: 4, state: 'MERGED', headRefOid: merged }), commits: [{ oid: mine }, { oid: merged }] }] : [],
    );
    expect((await worktreeLeftovers(plan, plan.path)).branches[0]).toMatchObject({ unpushed: 0, pr: { state: 'merged', after: 0 }, keep: null });
    // PR のコミットのあとに足したものは残す
    commitIn(plan.path, 'c.txt');
    expect((await worktreeLeftovers(plan, plan.path)).branches[0]).toMatchObject({ unpushed: 1, pr: { state: 'merged', after: 1 }, keep: 'localOnly' });
    git(plan.path, 'reset', '-q', '--hard', 'HEAD~1');
    expect((await removeWorktree(plan, plan.path)).branches.every((b) => b.deleted)).toBe(true);
  });

  it('起動したときのブランチでコミットしてから git switch -c した PR がスカッシュマージされたら、起動したときのブランチだけのコミットも PR に入っているとみなす', async () => {
    const plan = await create();
    commitIn(plan.path, 'a1.txt');
    const first = git(repo, 'rev-parse', plan.branch);
    git(plan.path, 'switch', '-q', '-c', 'fix/x');
    commitIn(plan.path, 'b.txt');
    const head = git(repo, 'rev-parse', 'fix/x');
    prs.mockImplementation(async (_root, branch) =>
      branch === 'fix/x' ? [{ ...pull({ number: 9, state: 'MERGED', headRefOid: head }), commits: [{ oid: first }, { oid: head }] }] : [],
    );
    expect((await worktreeLeftovers(plan, plan.path)).branches.map((b) => [b.name, b.unpushed, b.keep])).toEqual([
      ['fix/x', 0, null],
      [plan.branch, 0, null],
    ]);
    expect((await removeWorktree(plan, plan.path)).branches.every((b) => b.deleted)).toBe(true);
    expect(git(repo, 'branch', '--list', 'fix/x', plan.branch)).toBe('');
  });

  it('消すのは、確かめたときの先頭のままのブランチだけ。ブランチの設定（上流）も外す', async () => {
    withOrigin();
    const plan = await create();
    git(plan.path, 'switch', '-q', '-c', 'fix/x');
    commitIn(plan.path, 'b.txt');
    git(plan.path, 'push', '-q', '-u', 'origin', 'fix/x');
    expect((await removeWorktree(plan, plan.path)).branches.map((b) => [b.name, b.deleted])).toEqual([
      ['fix/x', true],
      [plan.branch, true],
    ]);
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('[branch "fix/x"]');
  });

  it('手元にしか無いコミットを 2 つのブランチが持っていれば、互いをほかのブランチとして数えず、どちらも残す', async () => {
    const plan = await create();
    commitIn(plan.path, 'b.txt');
    git(plan.path, 'switch', '-q', '-c', 'fix/x');
    const removal = await removeWorktree(plan, plan.path);
    expect(removal.branches).toEqual([
      { name: 'fix/x', launched: false, current: true, deleted: false, keep: 'localOnly' },
      { name: plan.branch, launched: true, current: false, deleted: false, keep: 'localOnly' },
    ]);
  });

  it('上流が起動したときのブランチ（--track）でも、上流にしか無いコミットを、両方を消して失わない', async () => {
    const plan = await create();
    commitIn(plan.path, 'b.txt');
    git(plan.path, 'switch', '-q', '-c', 'fix/x', '--track', plan.branch);
    const removal = await removeWorktree(plan, plan.path);
    expect(removal.branches.map((b) => b.keep)).toEqual(['localOnly', 'localOnly']);
    expect(git(repo, 'log', '-1', '--format=%s', plan.branch)).toBe('b.txt');
  });

  it('デフォルトブランチや main・develop などに切り替えていたら、そのブランチは消さない', async () => {
    const plan = await create();
    git(plan.path, 'switch', '-q', '-c', 'develop');
    const removal = await removeWorktree(plan, plan.path);
    expect(removal.branches).toEqual([
      { name: 'develop', launched: false, current: true, deleted: false, keep: 'trunk' },
      { name: plan.branch, launched: true, current: false, deleted: true, keep: null },
    ]);
    expect(git(repo, 'branch', '--list', 'develop')).toContain('develop');
    // 残すと決まっている幹のブランチの PR は調べない
    expect(prs).not.toHaveBeenCalledWith(repo, 'develop', true);
  });

  it('detached HEAD で、どのブランチにも無いコミットにいれば、控えに残す（控えの親がそのコミット）', async () => {
    const plan = await create();
    git(plan.path, 'switch', '-q', '--detach');
    commitIn(plan.path, 'b.txt');
    const stray = git(plan.path, 'rev-parse', 'HEAD');
    const removal = await removeWorktree(plan, plan.path);
    expect(removal.backupRef).toBe(`refs/tanacode/backup/${plan.name}`);
    expect(git(repo, 'rev-parse', `${removal.backupRef}^`)).toBe(stray);
    // 起動したときのブランチには、手元にしか無いコミットが無いので消す
    expect(removal.branches).toEqual([launched(plan, null, false)]);
    // 控えを消すと、そのコミットも失われることが分かる
    expect((await listBackups(repo)).map((b) => [b.ref, b.strays])).toEqual([[removal.backupRef, true]]);
  });
});

describe('控えの一覧と削除', () => {
  it('新しい順に並べ、refs/tanacode/backup/ の下のものだけを消す', async () => {
    const first = await create();
    writeFileSync(join(first.path, 'new.txt'), '1\n');
    const a = (await removeWorktree(first, first.path)).backupRef!;
    // コミットの時刻は秒までなので、ずらす
    const second = await create();
    writeFileSync(join(second.path, 'new.txt'), '2\n');
    const b = await (async () => {
      const env = process.env.GIT_COMMITTER_DATE;
      process.env.GIT_COMMITTER_DATE = '2000000000 +0000';
      try {
        return (await removeWorktree(second, second.path)).backupRef!;
      } finally {
        if (env === undefined) delete process.env.GIT_COMMITTER_DATE;
        else process.env.GIT_COMMITTER_DATE = env;
      }
    })();
    const list = await listBackups(repo);
    expect(list.map((x) => x.ref)).toEqual([b, a]);
    expect(list[0].subject).toContain(second.name);
    // 控えの親（main）はブランチから辿れる
    expect(list[0].strays).toBe(false);
    expect(list[0].date).toBe(2000000000_000);
    await expect(deleteBackup(repo, 'refs/heads/main')).rejects.toThrow('not a backup');
    await expect(deleteBackup(repo, 'refs/tanacode/backup/../../heads/main')).rejects.toThrow('not a backup');
    await deleteBackup(repo, a);
    expect((await listBackups(repo)).map((x) => x.ref)).toEqual([b]);
    expect(git(repo, 'branch', '--show-current')).toBe('main');
  });
});

describe('フォルダの設定のフィルター（git-crypt など）', () => {
  // 中身を変えて書き込み、元に戻して取り出すフィルター（rot13。なくてはならないもの）
  beforeEach(() => {
    git(repo, 'config', 'filter.rot.clean', 'tr a-z n-za-m');
    git(repo, 'config', 'filter.rot.smudge', 'tr a-z n-za-m');
    git(repo, 'config', 'filter.rot.required', 'true');
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.secret filter=rot\n');
  });

  it('作り直し・消す前の控えは、人が頼んだ操作なので、ターミナルの git と同じくフィルターを通して取り出し・書き込む', async () => {
    const plan = await create();
    writeFileSync(join(plan.path, 'kept.secret'), 'hello\n');
    git(plan.path, 'add', 'kept.secret');
    git(plan.path, 'commit', '-qm', 'secret');
    writeFileSync(join(plan.path, 'new.secret'), 'world\n');
    const removal = await removeWorktree(plan, plan.path);
    // 控えには、フィルターを通した中身が入る（git-crypt なら、暗号にしたもの）
    expect(git(repo, 'cat-file', '-p', `${removal.backupRef}:new.secret`)).toBe('jbeyq');
    await restoreWorktree(plan, plan.path);
    // 作り直した worktree には、フィルターで元に戻した中身が出る
    expect(readFileSync(join(plan.path, 'kept.secret'), 'utf8')).toBe('hello\n');
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

  it('lock が違っても、元のフォルダで依存を入れていない場所（node_modules も .pnp.cjs も無い）では install しない', async () => {
    pkg('', '{"v":1}');
    pkg('tools/cli', '{"v":1}');
    commit();
    modules('');
    writeFileSync(join(repo, 'package-lock.json'), '{"v":1}');
    writeFileSync(join(repo, 'tools', 'cli', 'package-lock.json'), '{"v":2}');
    const plan = await create();
    const { installs } = await prepare(plan);
    expect(installs).toEqual([]);
  });

  it('複製できなかった node_modules は、いちばん近い上の lock の場所で install する', async () => {
    pkg('');
    pkg('packages', '{}');
    pkg('packages/web', null);
    commit();
    for (const dir of ['', 'packages', 'packages/web']) modules(dir);
    const plan = await create();
    const fail = (from: string) => (from.includes('web') ? Promise.reject(new Error('cross-device')) : copy(from, from.replace(repo, plan.path)));
    const { installs } = await prepare(plan, fail);
    expect(installs).toEqual(['npm install @ packages']);
  });

  it('bun.lockb も bun で install する', async () => {
    pkg('', null);
    writeFileSync(join(repo, 'bun.lockb'), 'v1');
    commit();
    modules('');
    writeFileSync(join(repo, 'bun.lockb'), 'v2');
    const plan = await create();
    const { installs } = await prepare(plan);
    expect(installs).toEqual(['bun install @ .']);
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
