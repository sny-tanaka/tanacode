import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../src/main/git';
import { SourceControl } from '../src/main/source-control';

// ソース管理パネルの操作（ステージ・取り消し・変更を捨てる・コミット・プッシュ・ブランチの切り替え・差分の左右）。
// 使い捨てのリポジトリに、本物の git で行う

let root: string;
let repo: string;
let remote: string;
let scm: SourceControl;

const run = (cwd: string, args: string[]) => git(cwd, args);
const write = (path: string, text: string) => {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), text);
};
// git status --porcelain の 1 行目の 2 文字（ステージ・作業ツリー）とパス
const porcelain = async () =>
  (await run(repo, ['status', '--porcelain', '-uall']))
    .split('\n')
    .filter(Boolean)
    .sort();

async function init(dir: string): Promise<void> {
  await run(root, ['init', '-q', '-b', 'main', dir]);
  await run(dir, ['config', 'user.name', 'tanacode']);
  await run(dir, ['config', 'user.email', 'tanacode@example.com']);
  // 裏の片付け（gc）が、一時フォルダの削除とぶつからないように
  await run(dir, ['config', 'gc.auto', '0']);
}

// origin（bare）を作って main を送り、上流にする
async function withOrigin(): Promise<void> {
  await run(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  await run(remote, ['config', 'gc.auto', '0']);
  await run(repo, ['remote', 'add', 'origin', remote]);
  await run(repo, ['push', '-q', '-u', 'origin', 'main']);
}

const sha = async (cwd: string, ref = 'HEAD') => (await run(cwd, ['rev-parse', ref])).trim();

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-scm-ops-'));
  repo = join(root, 'repo');
  remote = join(root, 'remote.git');
  await init(repo);
  write('a.txt', 'one\n');
  await run(repo, ['add', 'a.txt']);
  await run(repo, ['commit', '-q', '-m', 'first']);
  scm = new SourceControl(repo);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('SourceControl', () => {
  it('state: リポジトリでなければ isRepo が false。リポジトリならブランチと変更を返す', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(await new SourceControl(plain).state()).toEqual({ isRepo: false });
    write('a.txt', 'two\n');
    write('b.txt', 'new\n');
    const state = await scm.state();
    expect(state).toMatchObject({ isRepo: true, branch: 'main' });
    const entries = state.isRepo ? state.entries.map((e) => [e.path, e.index, e.worktree]) : [];
    expect(entries).toEqual(
      expect.arrayContaining([
        ['a.txt', expect.anything(), 'M'],
        ['b.txt', '?', '?'],
      ]),
    );
  });

  it('stage と unstage: ステージして戻す。最初のコミットの前でも戻せる', async () => {
    write('a.txt', 'two\n');
    write('dir/b.txt', 'new\n');
    await scm.stage(['a.txt', 'dir/b.txt']);
    expect(await porcelain()).toEqual(['A  dir/b.txt', 'M  a.txt']);
    await scm.unstage(['a.txt', 'dir/b.txt']);
    expect(await porcelain()).toEqual([' M a.txt', '?? dir/b.txt']);

    // HEAD の無いリポジトリ（restore --staged が使えない）
    const fresh = join(root, 'fresh');
    await init(fresh);
    writeFileSync(join(fresh, 'x.txt'), 'x');
    const freshScm = new SourceControl(fresh);
    await freshScm.stage(['x.txt']);
    await freshScm.unstage(['x.txt']);
    expect((await run(fresh, ['status', '--porcelain'])).trim()).toBe('?? x.txt');
  });

  it('discard: 追跡しているファイルは元に戻し、未追跡のファイル・フォルダは消す。ほかのファイルには触らない', async () => {
    write('a.txt', 'changed\n');
    write('new.txt', 'new\n');
    write('newdir/c.txt', 'c\n');
    write('keep.txt', 'keep\n');
    await scm.discard(['a.txt', 'new.txt', 'newdir/c.txt']);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    expect(existsSync(join(repo, 'newdir', 'c.txt'))).toBe(false);
    expect(existsSync(join(repo, 'keep.txt'))).toBe(true);
  });

  it('discard: リポジトリの外を指すパスは、消さない（未追跡のファイルとして消すのは、git status に出たものだけ）', async () => {
    writeFileSync(join(root, 'outside.txt'), 'outside\n');
    await expect(scm.discard(['../outside.txt'])).rejects.toThrow();
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('outside\n');
  });

  it('commit: メッセージが空なら断る。コミットと、メッセージの書き直し（amend）', async () => {
    write('a.txt', 'two\n');
    await scm.stage(['a.txt']);
    await expect(scm.commit('  ', false)).rejects.toThrow('コミットメッセージを入力してください');
    await scm.commit('二つ目\n\n本文', false);
    expect(await scm.lastCommitMessage()).toBe('二つ目\n\n本文');
    await scm.commit('二つ目（直した）', true);
    expect(await scm.lastCommitMessage()).toBe('二つ目（直した）');
    expect((await run(repo, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2');
  });

  it('push: 上流が無ければ origin に同じ名前で作って追跡し、あればそのまま送る', async () => {
    await run(root, ['init', '-q', '--bare', '-b', 'main', remote]);
    await run(repo, ['remote', 'add', 'origin', remote]);
    await scm.checkout('feature', 'create');
    write('f.txt', 'f\n');
    await scm.stage(['f.txt']);
    await scm.commit('feature', false);
    await scm.push();
    expect((await run(repo, ['rev-parse', '--abbrev-ref', 'feature@{upstream}'])).trim()).toBe('origin/feature');
    write('f.txt', 'g\n');
    await scm.stage(['f.txt']);
    await scm.commit('more', false);
    await scm.push();
    expect((await run(remote, ['rev-parse', 'feature'])).trim()).toBe((await run(repo, ['rev-parse', 'HEAD'])).trim());
  });

  it('checkout: 新しいブランチ・手元のブランチ・リモートのブランチ（同じ名前で作って追跡）へ切り替える', async () => {
    await run(root, ['init', '-q', '--bare', '-b', 'main', remote]);
    await run(repo, ['remote', 'add', 'origin', remote]);
    await run(repo, ['push', '-q', 'origin', 'main', 'main:shared']);
    await run(repo, ['fetch', '-q', 'origin']);
    await scm.checkout('topic', 'create');
    expect((await scm.state()).isRepo && (await scm.state())).toMatchObject({ branch: 'topic' });
    await scm.checkout('main', 'local');
    expect(await scm.state()).toMatchObject({ branch: 'main' });
    await scm.checkout('origin/shared', 'remote');
    expect(await scm.state()).toMatchObject({ branch: 'shared' });
    expect((await run(repo, ['rev-parse', '--abbrev-ref', 'shared@{upstream}'])).trim()).toBe('origin/shared');
  });

  it('diffSides: ステージ済みは HEAD とステージ、そうでなければステージ（無ければ HEAD）と作業ツリー', async () => {
    write('a.txt', 'staged\n');
    await scm.stage(['a.txt']);
    write('a.txt', 'worktree\n');
    expect(await scm.diffSides('a.txt', true)).toEqual({ original: 'one\n', modified: 'staged\n' });
    expect(await scm.diffSides('a.txt', false)).toEqual({ original: 'staged\n', modified: 'worktree\n' });
    // 新しいファイルは、左が空
    write('n.txt', 'n\n');
    expect(await scm.diffSides('n.txt', false)).toEqual({ original: '', modified: 'n\n' });
  });

  it('branchDiffSides と baseline: ブランチの基点の内容と作業ツリー。基点に無いファイルは exists が false', async () => {
    const base = (await run(repo, ['rev-parse', 'HEAD'])).trim();
    await scm.checkout('topic', 'create');
    write('a.txt', 'topic\n');
    write('t.txt', 't\n');
    expect(await scm.branchDiffSides(base, 'a.txt')).toEqual({ original: 'one\n', modified: 'topic\n' });
    expect(await scm.baseline(base, 'a.txt')).toEqual({ exists: true, text: 'one\n' });
    expect(await scm.baseline(base, 't.txt')).toEqual({ exists: false, text: '' });
  });
});

describe('SourceControl（ブランチ・リモート・読めないとき）', () => {
  it('state: 別のブランチにいれば、基点からの変更（ブランチの変更）も返す。main にいて上流が無ければ null', async () => {
    const base = await sha(repo);
    await scm.checkout('topic', 'create');
    write('t.txt', 't\n');
    const state = await scm.state();
    expect(state.isRepo && state.branchChanges).toEqual({
      base: { ref: 'main', mergeBase: base, kind: 'branch' },
      files: { 't.txt': { kind: 'added', added: 1, removed: 0, binary: false } },
    });
    await scm.checkout('main', 'local');
    const onMain = await scm.state();
    expect(onMain.isRepo && onMain.branchChanges).toBeNull();
  });

  it('branchDiffSides: 作業ツリーで消したファイルは右が空、基点に無いファイルは左が空', async () => {
    const base = await sha(repo);
    await scm.checkout('topic', 'create');
    rmSync(join(repo, 'a.txt'));
    write('n.txt', 'n\n');
    expect(await scm.branchDiffSides(base, 'a.txt')).toEqual({ original: 'one\n', modified: '' });
    expect(await scm.branchDiffSides(base, 'n.txt')).toEqual({ original: '', modified: 'n\n' });
  });

  it('diffSides: 新しくステージしたファイルは左が空。ステージして消したファイルは右が空（未ステージ側は HEAD と比べる）', async () => {
    write('s.txt', 's\n');
    await scm.stage(['s.txt']);
    expect(await scm.diffSides('s.txt', true)).toEqual({ original: '', modified: 's\n' });
    await run(repo, ['rm', '-q', 'a.txt']);
    expect(await scm.diffSides('a.txt', true)).toEqual({ original: 'one\n', modified: '' });
    expect(await scm.diffSides('a.txt', false)).toEqual({ original: 'one\n', modified: '' });
  });

  it('branches: 手元とリモートのブランチと、デフォルトブランチ', async () => {
    await withOrigin();
    await scm.checkout('topic', 'create');
    const result = await scm.branches();
    expect(result.local.sort()).toEqual(['main', 'topic']);
    expect(result.remote).toEqual(['origin/main']);
    expect(result.defaultBranch).toBe('main');
  });

  it('discard: 未追跡のファイルだけなら、追跡しているファイルの取り消し（git restore）はしない', async () => {
    write('only-new.txt', 'new\n');
    await scm.discard(['only-new.txt']);
    expect(existsSync(join(repo, 'only-new.txt'))).toBe(false);
  });

  it('discard: リポジトリでないフォルダでは、未追跡のファイルとして消さない（git restore に任せて失敗する）', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'x.txt'), 'x\n');
    await expect(new SourceControl(plain).discard(['x.txt'])).rejects.toThrow();
    expect(readFileSync(join(plain, 'x.txt'), 'utf8')).toBe('x\n');
  });

  it('lastCommitMessage: コミットが無ければ空', async () => {
    const fresh = join(root, 'fresh');
    await init(fresh);
    expect(await new SourceControl(fresh).lastCommitMessage()).toBe('');
  });

  it('fetch と pull: origin の変更を取り込む。fetch は消えたリモートのブランチも片付ける', async () => {
    await withOrigin();
    await run(repo, ['push', '-q', 'origin', 'main:old']);
    const other = join(root, 'other');
    await run(root, ['clone', '-q', remote, other]);
    await run(other, ['config', 'user.name', 'other']);
    await run(other, ['config', 'user.email', 'other@example.com']);
    await run(other, ['config', 'gc.auto', '0']);
    writeFileSync(join(other, 'b.txt'), 'b\n');
    await run(other, ['add', 'b.txt']);
    await run(other, ['commit', '-q', '-m', 'b']);
    await run(other, ['push', '-q', 'origin', 'main']);
    await run(other, ['push', '-q', 'origin', '--delete', 'old']);
    await scm.fetch();
    expect(await sha(repo, 'origin/main')).toBe(await sha(other));
    expect((await run(repo, ['branch', '-r'])).includes('origin/old')).toBe(false);
    expect(await sha(repo)).not.toBe(await sha(other));
    await scm.pull();
    expect(await sha(repo)).toBe(await sha(other));
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('b\n');
  });

  it('switchToLatestDefault: origin が無ければ、手元のデフォルトブランチに切り替えるだけ', async () => {
    await scm.checkout('topic', 'create');
    write('t.txt', 't\n');
    await scm.stage(['t.txt']);
    await scm.commit('topic', false);
    const main = await sha(repo, 'main');
    await scm.switchToLatestDefault();
    expect(await scm.state()).toMatchObject({ branch: 'main', upstream: null });
    expect(await sha(repo)).toBe(main);
  });

  it('switchToLatestDefault: デフォルトブランチが分からなければ、切り替えずに断る', async () => {
    await scm.checkout('work', 'create');
    await run(repo, ['branch', '-D', 'main']);
    await expect(scm.switchToLatestDefault()).rejects.toThrow('デフォルトブランチが分かりません');
    expect(await scm.state()).toMatchObject({ branch: 'work' });
  });

  it('switchToLatestDefault: リモートでデフォルトブランチが変わっていれば、取り直して新しいほうに切り替える', async () => {
    await withOrigin();
    await run(repo, ['remote', 'set-head', 'origin', 'main']);
    await run(repo, ['push', '-q', 'origin', 'main:develop']);
    await run(remote, ['symbolic-ref', 'HEAD', 'refs/heads/develop']);
    await scm.switchToLatestDefault();
    expect(await scm.state()).toMatchObject({ branch: 'develop', upstream: 'origin/develop' });
  });

  it('push: 上流があれば、origin でなくても、その上流に送る（上流は変えない）', async () => {
    await withOrigin();
    const backup = join(root, 'backup.git');
    await run(root, ['init', '-q', '--bare', '-b', 'main', backup]);
    await run(backup, ['config', 'gc.auto', '0']);
    await run(repo, ['remote', 'add', 'backup', backup]);
    await scm.checkout('feature', 'create');
    await run(repo, ['push', '-q', '-u', 'backup', 'feature']);
    write('f.txt', 'f\n');
    await scm.stage(['f.txt']);
    await scm.commit('f', false);
    await scm.push();
    expect(await sha(backup, 'feature')).toBe(await sha(repo));
    await expect(run(remote, ['rev-parse', '--verify', '-q', 'feature'])).rejects.toThrow();
    expect((await run(repo, ['rev-parse', '--abbrev-ref', 'feature@{upstream}'])).trim()).toBe('backup/feature');
  });

  it('switchToLatestDefault: 手元にデフォルトブランチが無ければ、origin のものを追跡して作る', async () => {
    await withOrigin();
    await scm.checkout('topic', 'create');
    await run(repo, ['branch', '-D', 'main']);
    await scm.switchToLatestDefault();
    expect(await scm.state()).toMatchObject({ branch: 'main', upstream: 'origin/main' });
  });
});

describe('git', () => {
  it('渡すものが無ければ、標準入力をすぐ閉じる（標準入力からの入力を待つコマンドも、待ち続けずに終わる）', async () => {
    // 空の内容のハッシュ。標準入力を閉じないと、入力を待ったまま返らない
    expect((await git(repo, ['hash-object', '--stdin'])).trim()).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  }, 5000);
});
