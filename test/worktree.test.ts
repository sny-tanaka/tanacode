import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeArgs } from '../src/main/claude-session';
import {
  hideWorktrees,
  planWorktree,
  prepareNodeModules,
  removeWorktree,
  restoreWorktree,
  worktreeLeftovers,
  type WorktreePlan,
} from '../src/main/worktree';

// worktree のセッション（claude --worktree）の、アプリが受け持つところ。本物の git で確かめる。
// Claude Code が worktree を作るところは、Claude Code と同じ形（.claude/worktrees/<名前>・ブランチ worktree-<名前>・
// 「claude session …」のロック）を git で作って代わりにする（本物の Claude Code では test/cli/worktree.test.ts）

let root: string;
let repo: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-worktree-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'me@example.com');
  git(repo, 'config', 'user.name', 'me');
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

  it('.gitignore で無視されていれば、何も足さない', async () => {
    writeFileSync(join(repo, '.gitignore'), '.claude/\n');
    await hideWorktrees(repo);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).not.toContain('tanacode');
  });
});

describe('残っているもの', () => {
  it('未コミットの変更・未追跡のファイル・プッシュしていないコミット・デフォルトブランチに入っていないコミットを数える', async () => {
    const plan = await create();
    expect(await worktreeLeftovers(plan, plan.path)).toEqual({
      exists: true,
      branch: plan.branch,
      uncommitted: 0,
      untracked: 0,
      unpushed: 0,
      unmerged: 0,
      defaultBranch: 'main',
    });
    writeFileSync(join(plan.path, 'b.txt'), 'b\n');
    git(plan.path, 'add', 'b.txt');
    git(plan.path, 'commit', '-qm', 'b');
    writeFileSync(join(plan.path, 'a.txt'), 'changed\n');
    git(plan.path, 'mv', 'b.txt', 'c.txt');
    writeFileSync(join(plan.path, 'new.txt'), 'new\n');
    // .gitignore で無視されるものは数えない
    writeFileSync(join(plan.path, '.env'), 'SECRET=1\n');
    expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ uncommitted: 2, untracked: 1, unpushed: 1, unmerged: 1 });
  });

  it('worktree もブランチも無ければ、何も残っていない', async () => {
    const plan = await planWorktree(repo);
    expect(await worktreeLeftovers(plan, plan.path)).toMatchObject({ exists: false, uncommitted: 0, untracked: 0, unpushed: 0, unmerged: 0 });
  });
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
    expect(git(repo, 'log', '-1', '--format=%an %s', ref)).toContain('tanacode');
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

  it('まだどこにも入っていないコミットがあれば、ブランチごと残す', async () => {
    const plan = await create();
    writeFileSync(join(plan.path, 'b.txt'), 'b\n');
    git(plan.path, 'add', 'b.txt');
    git(plan.path, 'commit', '-qm', 'b');
    const removal = await removeWorktree(plan, plan.path);
    expect(removal).toMatchObject({ backupRef: null, branchKept: true });
    expect(existsSync(plan.path)).toBe(false);
    expect(git(repo, 'log', '-1', '--format=%s', plan.branch)).toBe('b');
  });

  it('ユーザーが付けたロックがあれば、消さずに断る', async () => {
    const plan = await create();
    git(repo, 'worktree', 'unlock', plan.path);
    git(repo, 'worktree', 'lock', '--reason', '外付けのディスク', plan.path);
    await expect(removeWorktree(plan, plan.path)).rejects.toThrow('外付けのディスク');
    expect(existsSync(plan.path)).toBe(true);
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
      install: (cwd, dir) => {
        expect(cwd).toBe(join(plan.path, dir));
        installs.push(dir);
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
    expect(result).toEqual({ cloned: ['', 'tools/cli'], failed: [], installs: [{ dir: 'tools/cli', exitCode: 1 }] });
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
    expect(installs).toEqual(['', 'tools/cli']);
  });

  it('npm のプロジェクトでなければ（yarn・pnpm など）、複製だけで npm install はしない', async () => {
    pkg('', null);
    writeFileSync(join(repo, 'yarn.lock'), '');
    commit();
    modules('');
    const plan = await create();
    const { result, installs } = await prepare(plan, () => Promise.reject(new Error('cross-device')));
    expect(result).toEqual({ cloned: [], failed: [''], installs: [] });
    expect(installs).toEqual([]);
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
