import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchBase, branches, branchFiles, defaultBranch, git, GitError, isIgnored, repoInfo, showAt, status } from '../src/main/git';

// git の読み取り（ソース管理パネル・セッションの差分・worktree が使う）。使い捨てのリポジトリに、本物の git で確かめる

let root: string;
let repo: string;

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// テスト用のリポジトリの設定。裏の片付け（gc）は、一時フォルダの削除とぶつかるので止める
function configure(dir: string): void {
  run(dir, 'config', 'user.name', 'tanacode');
  run(dir, 'config', 'user.email', 'tanacode@example.com');
  run(dir, 'config', 'commit.gpgsign', 'false');
  run(dir, 'config', 'gc.auto', '0');
}

function init(dir: string, branch = 'main'): void {
  mkdirSync(dir, { recursive: true });
  run(dir, 'init', '-q', '-b', branch);
  configure(dir);
}

const write = (dir: string, path: string, content: string | Buffer) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
};

// path を書いてコミットする。date: コミットの時刻（並び順を決めるため）
const commit = (dir: string, path: string, content: string | Buffer = `${path}\n`, date?: string) => {
  write(dir, path, content);
  run(dir, 'add', path);
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  execFileSync('git', ['commit', '-qm', path], { cwd: dir, env, stdio: 'ignore' });
};

const sha = (dir: string, ref = 'HEAD') => run(dir, 'rev-parse', ref);

// repo に origin（bare）を付けて、main を送る
const withOrigin = (): string => {
  const remote = join(root, 'origin.git');
  run(root, 'init', '-q', '--bare', '-b', 'main', remote);
  run(remote, 'config', 'gc.auto', '0');
  run(repo, 'remote', 'add', 'origin', remote);
  run(repo, 'push', '-q', '-u', 'origin', 'main');
  return remote;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-git-')));
  repo = join(root, 'repo');
  init(repo);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('git', () => {
  it('失敗したら、標準エラーの文を持つ GitError で知らせる', async () => {
    const error = await git(repo, ['rev-parse', '--verify', 'no-such-ref']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    // 実行したコマンドの行（Command failed: …）は付けず、git の出した文だけ
    expect((error as Error).message).toMatch(/^fatal: /);
    expect((error as Error).message).not.toContain('Command failed');
  });
});

describe('status', () => {
  it('パスは cwd からの相対に直し、cwd の外のものは除く。リネームは元のパスも返す。リポジトリでなければ null', async () => {
    commit(repo, 'a.txt');
    commit(repo, 'sub/b.txt');
    run(repo, 'mv', 'sub/b.txt', 'sub/c.txt');
    write(repo, 'a.txt', 'changed\n');
    write(repo, 'sub/new.txt', 'new\n');
    expect(await status(join(repo, 'sub'))).toEqual([
      { path: 'c.txt', from: 'b.txt', index: 'R', worktree: ' ' },
      { path: 'new.txt', index: '?', worktree: '?' },
    ]);
    expect(await status(repo)).toEqual([
      { path: 'a.txt', index: ' ', worktree: 'M' },
      { path: 'sub/c.txt', from: 'sub/b.txt', index: 'R', worktree: ' ' },
      { path: 'sub/new.txt', index: '?', worktree: '?' },
    ]);
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(await status(plain)).toBeNull();
  });

  it('1 文字の名前のファイルも返す。コピーと見なされたもの（status.renames=copies）も、元のパスを返す', async () => {
    commit(repo, 'a.txt', '1\n2\n3\n4\n5\n');
    write(repo, 'b', 'b\n');
    expect(await status(repo)).toEqual([{ path: 'b', index: '?', worktree: '?' }]);
    run(repo, 'config', 'status.renames', 'copies');
    write(repo, 'copy.txt', '1\n2\n3\n4\n5\n');
    write(repo, 'a.txt', '1\n2\n3\n4\n5\n6\n');
    run(repo, 'add', 'copy.txt', 'a.txt');
    expect(await status(repo)).toEqual([
      { path: 'a.txt', index: 'M', worktree: ' ' },
      { path: 'copy.txt', from: 'a.txt', index: 'C', worktree: ' ' },
      { path: 'b', index: '?', worktree: '?' },
    ]);
  });

  it('cwd の外から移したファイルの元のパスも、cwd からの相対パスにする（StatusEntry.from の決まり）', async () => {
    commit(repo, 'a.txt');
    mkdirSync(join(repo, 'sub'));
    run(repo, 'mv', 'a.txt', 'sub/a.txt');
    expect(await status(join(repo, 'sub'))).toEqual([{ path: 'a.txt', from: '../a.txt', index: 'R', worktree: ' ' }]);
  });

  it('isIgnored: .gitignore で無視されるファイルか', async () => {
    write(repo, '.gitignore', '*.log\n');
    expect(await isIgnored(repo, 'debug.log')).toBe(true);
    expect(await isIgnored(repo, 'a.txt')).toBe(false);
  });
});

describe('repoInfo', () => {
  it('コミットが無ければ empty。上流があれば、上流より先・後ろのコミットの数。ブランチから外れていれば branch が null', async () => {
    expect(await repoInfo(repo)).toEqual({ branch: 'main', upstream: null, ahead: 0, behind: 0, empty: true });
    commit(repo, 'a.txt');
    const remote = withOrigin();
    commit(repo, 'b.txt');
    // 別の clone から origin を 2 つ進める
    const other = join(root, 'other');
    run(root, 'clone', '-q', remote, other);
    configure(other);
    commit(other, 'c.txt');
    commit(other, 'd.txt');
    run(other, 'push', '-q', 'origin', 'main');
    run(repo, 'fetch', '-q');
    expect(await repoInfo(repo)).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2, empty: false });
    run(repo, 'switch', '-q', '--detach', 'HEAD');
    expect(await repoInfo(repo)).toEqual({ branch: null, upstream: null, ahead: 0, behind: 0, empty: false });
  });
});

describe('branches と defaultBranch', () => {
  it('手元とリモートのブランチを、新しいコミットの順に返す。origin/HEAD は除き、デフォルトブランチはその指す先', async () => {
    commit(repo, 'a.txt', 'a\n', '2026-01-01T00:00:00Z');
    withOrigin();
    run(repo, 'switch', '-q', '-c', 'topic');
    commit(repo, 'b.txt', 'b\n', '2026-01-03T00:00:00Z');
    run(repo, 'push', '-q', 'origin', 'topic');
    run(repo, 'switch', '-q', '-c', 'mid', 'main');
    commit(repo, 'c.txt', 'c\n', '2026-01-02T00:00:00Z');
    run(repo, 'remote', 'set-head', 'origin', 'main');
    expect(await branches(repo)).toEqual({ local: ['topic', 'mid', 'main'], remote: ['origin/topic', 'origin/main'], defaultBranch: 'main' });
  });

  it('origin/HEAD が無ければ、main・master・develop などのうち手元か origin にあるもの（並びの順）。無ければ null', async () => {
    const work = join(root, 'work');
    init(work, 'work');
    commit(work, 'a.txt');
    expect(await defaultBranch(work)).toBeNull();
    // origin にだけある develop
    run(work, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    expect(await defaultBranch(work)).toBe('develop');
    // master のほうが先
    run(work, 'branch', 'master');
    expect(await defaultBranch(work)).toBe('master');
    // リポジトリでなければ null
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(await defaultBranch(plain)).toBeNull();
  });

  it('development・trunk もデフォルトブランチの名前として探す', async () => {
    for (const name of ['development', 'trunk']) {
      const dir = join(root, name);
      init(dir, name);
      commit(dir, 'a.txt');
      expect(await defaultBranch(dir)).toBe(name);
    }
  });

  it('origin/HEAD があれば、main などの名前のブランチがあっても、その指す先', async () => {
    commit(repo, 'a.txt');
    withOrigin();
    run(repo, 'push', '-q', 'origin', 'main:release');
    run(repo, 'remote', 'set-head', 'origin', 'release');
    expect(await defaultBranch(repo)).toBe('release');
  });
});

describe('branchBase', () => {
  it('コミットが無ければ null', async () => {
    expect(await branchBase(repo, await repoInfo(repo))).toBeNull();
  });

  it('別のブランチにいるときは、基点のブランチ（main・develop など）のうち、分岐点がいちばん近いものと比べる', async () => {
    commit(repo, 'a.txt');
    run(repo, 'switch', '-q', '-c', 'develop');
    commit(repo, 'd.txt');
    const developHead = sha(repo);
    run(repo, 'switch', '-q', '-c', 'feature');
    commit(repo, 'f.txt');
    expect(await branchBase(repo, await repoInfo(repo))).toEqual({ ref: 'develop', mergeBase: developHead, kind: 'branch' });
    // main から分かれたブランチは main と比べる
    run(repo, 'switch', '-q', '-c', 'fix', 'main');
    commit(repo, 'x.txt');
    expect(await branchBase(repo, await repoInfo(repo))).toEqual({ ref: 'main', mergeBase: sha(repo, 'main'), kind: 'branch' });
  });

  it('基点のブランチにいるときは、全履歴を出さないよう上流と比べる。上流が無い・上流と履歴がつながらなければ null', async () => {
    commit(repo, 'a.txt');
    withOrigin();
    const pushed = sha(repo);
    commit(repo, 'b.txt');
    expect(await branchBase(repo, await repoInfo(repo))).toEqual({ ref: 'origin/main', mergeBase: pushed, kind: 'upstream' });
    // 手元の main を、履歴のつながらないコミットに置き換える（上流はそのまま）
    run(repo, 'switch', '-q', '--orphan', 'lonely');
    commit(repo, 'z.txt');
    run(repo, 'branch', '-f', 'main', 'lonely');
    run(repo, 'switch', '-q', 'main');
    expect(await branchBase(repo, await repoInfo(repo))).toBeNull();
    run(repo, 'branch', '--unset-upstream');
    expect(await branchBase(repo, await repoInfo(repo))).toBeNull();
  });

  it('origin/HEAD が指すブランチ（main 以外の名前でも）は、基点のブランチとして上流と比べる', async () => {
    const work = join(root, 'work');
    init(work, 'release');
    commit(work, 'a.txt');
    const remote = join(root, 'release.git');
    run(root, 'init', '-q', '--bare', '-b', 'release', remote);
    run(remote, 'config', 'gc.auto', '0');
    run(work, 'remote', 'add', 'origin', remote);
    run(work, 'push', '-q', '-u', 'origin', 'release');
    run(work, 'remote', 'set-head', 'origin', 'release');
    const pushed = sha(work);
    // main もあるが、origin/HEAD の指す release にいるので、main とは比べない
    run(work, 'branch', 'main');
    commit(work, 'b.txt');
    expect(await branchBase(work, await repoInfo(work))).toEqual({ ref: 'origin/release', mergeBase: pushed, kind: 'upstream' });
  });

  it('手元に無い基点のブランチ（origin/main だけ）とも比べる', async () => {
    commit(repo, 'a.txt');
    withOrigin();
    const base = sha(repo);
    run(repo, 'switch', '-q', '-c', 'feature');
    commit(repo, 'f.txt');
    run(repo, 'branch', '-D', 'main');
    expect(await branchBase(repo, await repoInfo(repo))).toEqual({ ref: 'origin/main', mergeBase: base, kind: 'branch' });
  });

  it('履歴のつながらない基点のブランチは使わない。基点が無ければ上流と比べ、上流も無ければ null', async () => {
    commit(repo, 'a.txt');
    run(repo, 'switch', '-q', '--orphan', 'feature');
    commit(repo, 'f.txt');
    expect(await branchBase(repo, await repoInfo(repo))).toBeNull();
    withOriginFor('feature');
    const pushed = sha(repo);
    commit(repo, 'g.txt');
    expect(await branchBase(repo, await repoInfo(repo))).toEqual({ ref: 'origin/feature', mergeBase: pushed, kind: 'upstream' });
  });
});

// repo に origin（bare）を付けて、branch を送って上流にする
const withOriginFor = (branch: string) => {
  const remote = join(root, 'origin.git');
  run(root, 'init', '-q', '--bare', remote);
  run(remote, 'config', 'gc.auto', '0');
  run(repo, 'remote', 'add', 'origin', remote);
  run(repo, 'push', '-q', '-u', 'origin', branch);
};

describe('branchFiles', () => {
  let base: string;
  beforeEach(() => {
    commit(repo, 'keep.txt', '1\n2\n3\n');
    commit(repo, 'gone.txt', 'x\n');
    commit(repo, 'img.bin', Buffer.from([0, 1, 2]));
    base = sha(repo);
    run(repo, 'switch', '-q', '-c', 'feature');
  });

  it('基点から作業ツリーまでの変更（コミット済み・ステージ済み・未ステージ・未追跡）を、パスの順にまとめる', async () => {
    commit(repo, 'added.txt', 'a\nb\n');
    run(repo, 'rm', '-q', 'gone.txt');
    write(repo, 'keep.txt', '1\n2 changed\n3\n4\n');
    write(repo, 'img.bin', Buffer.from([0, 1, 2, 3]));
    // 未追跡: 末尾に改行の無い文字・バイナリ・大きすぎるもの・シンボリックリンク（先は読まない）
    write(repo, 'new.txt', 'x\ny');
    write(repo, 'blob.dat', Buffer.from([0, 0, 1]));
    write(repo, 'big.txt', 'a\n'.repeat(600 * 1024));
    writeFileSync(join(root, 'outside.txt'), '1\n2\n3\n');
    symlinkSync(join(root, 'outside.txt'), join(repo, 'link.txt'));
    expect(await branchFiles(repo, base)).toEqual([
      { path: 'added.txt', kind: 'added', added: 2, removed: 0, binary: false },
      { path: 'big.txt', kind: 'added', added: 0, removed: 0, binary: false },
      { path: 'blob.dat', kind: 'added', added: 0, removed: 0, binary: true },
      { path: 'gone.txt', kind: 'deleted', added: 0, removed: 1, binary: false },
      { path: 'img.bin', kind: 'modified', added: 0, removed: 0, binary: true },
      { path: 'keep.txt', kind: 'modified', added: 2, removed: 1, binary: false },
      { path: 'link.txt', kind: 'added', added: 0, removed: 0, binary: false },
      { path: 'new.txt', kind: 'added', added: 2, removed: 0, binary: false },
    ]);
  });

  it('名前にタブのあるファイルの行数も数える。未追跡のファイルは 1MB ちょうどまで数える', async () => {
    commit(repo, 'tab\tname.txt', 'a\n');
    write(repo, 'tab\tname.txt', 'a\nb\nc\n');
    write(repo, 'limit.txt', 'a\n'.repeat(512 * 1024));
    expect(await branchFiles(repo, base)).toEqual([
      { path: 'limit.txt', kind: 'added', added: 512 * 1024, removed: 0, binary: false },
      { path: 'tab\tname.txt', kind: 'added', added: 3, removed: 0, binary: false },
    ]);
  });

  it('サブフォルダからは、そのフォルダの中の変更だけを、そのフォルダからの相対パスで返す', async () => {
    commit(repo, 'pkg/a.txt', 'a\n');
    write(repo, 'pkg/b.txt', 'b\n');
    write(repo, 'top.txt', 'top\n');
    expect(await branchFiles(join(repo, 'pkg'), base)).toEqual([
      { path: 'a.txt', kind: 'added', added: 1, removed: 0, binary: false },
      { path: 'b.txt', kind: 'added', added: 1, removed: 0, binary: false },
    ]);
  });

  it('空の未追跡のファイルは、足した行を 0 と数える（ステージしたときに git が数えるのと同じ）', async () => {
    write(repo, 'empty.txt', '');
    const untracked = await branchFiles(repo, base);
    run(repo, 'add', 'empty.txt');
    const staged = await branchFiles(repo, base);
    expect(staged).toEqual([{ path: 'empty.txt', kind: 'added', added: 0, removed: 0, binary: false }]);
    expect(untracked).toEqual(staged);
  });

  it('showAt: 基点での内容。基点に無いファイルは null', async () => {
    commit(repo, 'keep.txt', 'new\n');
    expect(await showAt(repo, base, 'keep.txt')).toBe('1\n2\n3\n');
    expect(await showAt(repo, base, 'none.txt')).toBeNull();
  });
});
