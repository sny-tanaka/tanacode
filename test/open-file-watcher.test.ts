import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_OPEN_FILE_WATCHES, OpenFileWatchers } from '../src/main/open-file-watcher';

// エディタで開いているタブのうち、フォルダの監視（WorkspaceWatchers）の知らせでは読み直せないもの（フォルダの外・監視しない
// フォルダの中・リンク越し）を、ファイルごとに見張る。知らせは、画面の読み直し（App の reloadFiles）が見分ける形（root と相対パス）

// macOS の一時フォルダは、リンク（/var → /private/var）越しのパス。セッションのフォルダもリンク越しのことがあるので、解かずに使う
let base: string;
// セッションのフォルダ（フォルダの監視がある）
let work: string;
// セッションのフォルダの外
let outside: string;
let roots: string[];
let changes: [string, string[]][];
let watchers: OpenFileWatchers;
const real = (path: string) => realpathSync(path);
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
// 見張りを決め直すのは非同期（realpath を待つ）
const untilWatched = (expected: string[]) => vi.waitFor(() => expect(watchers.watched().sort()).toEqual(expected.sort()), { timeout: 3000 });
const untilChanged = (root: string, path: string) =>
  vi.waitFor(() => expect(changes.some(([r, paths]) => r === root && paths.includes(path))).toBe(true), { timeout: 5000 });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tanacode-open-files-'));
  work = join(base, 'work');
  outside = join(base, 'outside');
  mkdirSync(work);
  mkdirSync(outside);
  roots = [work];
  changes = [];
  watchers = new OpenFileWatchers(
    () => roots,
    (root, paths) => changes.push([root, paths]),
  );
});
afterEach(() => {
  watchers.closeAll();
  rmSync(base, { recursive: true, force: true });
});

describe('OpenFileWatchers', () => {
  it('フォルダの外のファイル（絶対パスのタブ）を見張り、書き換えたら、親フォルダとファイル名で知らせる', async () => {
    const memo = join(outside, 'memo.md');
    put(memo, 'はじめ\n');
    watchers.set({ [work]: [memo] });
    await untilWatched([real(memo)]);
    writeFileSync(memo, '書き換えた\n');
    await untilChanged(outside, 'memo.md');
  });

  it('Claude Code のように、一時ファイルに書いてから rename で置き換えても知らせる。置き換えたあとの書き換えも知らせる', async () => {
    const memo = join(outside, 'memo.md');
    put(memo, 'はじめ\n');
    watchers.set({ [work]: [memo] });
    await untilWatched([real(memo)]);
    writeFileSync(join(outside, '.memo.md.tmp'), 'Claude が書いた\n');
    renameSync(join(outside, '.memo.md.tmp'), memo);
    await untilChanged(outside, 'memo.md');
    changes = [];
    writeFileSync(memo, 'もう一度\n');
    await untilChanged(outside, 'memo.md');
  });

  it('フォルダの監視で知らせが来るタブは見張らない。監視しないフォルダ（out など）の中のタブは見張り、エディタのフォルダからの相対パスで知らせる', async () => {
    put(join(work, 'src', 'tax.ts'), 'a\n');
    put(join(work, 'out', 'report.txt'), 'b\n');
    watchers.set({ [work]: ['src/tax.ts', 'out/report.txt'] });
    await untilWatched([real(join(work, 'out', 'report.txt'))]);
    writeFileSync(join(work, 'out', 'report.txt'), 'ビルドし直した\n');
    await untilChanged(work, 'out/report.txt');
  });

  it('リンク越しのタブは、リンクの先（実体）を見張り、タブのパスで知らせる', async () => {
    const note = join(outside, 'note.md');
    put(note, 'はじめ\n');
    symlinkSync(note, join(work, 'note-link.md'));
    // フォルダの中のリンクが、フォルダの中を指していても（知らせは実体のパスで来るので、タブのパスと合わない）
    put(join(work, 'docs', 'real.md'), 'x\n');
    symlinkSync(join(work, 'docs', 'real.md'), join(work, 'alias.md'));
    watchers.set({ [work]: ['note-link.md', 'alias.md'] });
    await untilWatched([real(note), real(join(work, 'docs', 'real.md'))]);
    writeFileSync(note, '実体を書き換えた\n');
    await untilChanged(work, 'note-link.md');
    writeFileSync(join(work, 'docs', 'real.md'), 'y\n');
    await untilChanged(work, 'alias.md');
  });

  it('セッションのフォルダがリンク越しのパスで、Claude が実体のパスで渡したファイル（絶対パスのタブ）も見張る。フォルダのパスのタブは見張らない', async () => {
    const linked = join(base, 'linked-work');
    symlinkSync(work, linked);
    put(join(work, 'a.ts'), 'a\n');
    roots = [linked];
    watchers.set({ [linked]: [join(real(work), 'a.ts'), 'a.ts'] });
    await untilWatched([real(join(work, 'a.ts'))]);
    writeFileSync(join(work, 'a.ts'), 'b\n');
    await untilChanged(real(work), 'a.ts');
  });

  it('同じファイルを開いているタブが複数あれば（別のエディタのフォルダ・リンク越し）、どのタブにも知らせる。見張るのは 1 つ', async () => {
    const memo = join(outside, 'memo.md');
    put(memo, 'はじめ\n');
    const other = join(base, 'other');
    mkdirSync(other);
    symlinkSync(memo, join(other, 'memo-link.md'));
    watchers.set({ [work]: [memo], [other]: ['memo-link.md'] });
    await untilWatched([real(memo)]);
    writeFileSync(memo, '書き換えた\n');
    await untilChanged(outside, 'memo.md');
    await untilChanged(other, 'memo-link.md');
  });

  it('エディタのフォルダの監視が無ければ（アーカイブした・監視がエラーで止まった）、フォルダの中のタブも見張る。監視が始まったら、見張りをやめる', async () => {
    put(join(work, 'src', 'tax.ts'), 'a\n');
    roots = [];
    watchers.set({ [work]: ['src/tax.ts'] });
    await untilWatched([real(join(work, 'src', 'tax.ts'))]);
    roots = [work];
    watchers.rootsChanged();
    await untilWatched([]);
  });

  it('タブを閉じたら見張りをやめる。まだ無いファイルは、親フォルダを見張って、作られたら知らせる', async () => {
    const memo = join(outside, 'memo.md');
    put(memo, 'はじめ\n');
    watchers.set({ [work]: [memo] });
    await untilWatched([real(memo)]);
    watchers.set({ [work]: [] });
    await untilWatched([]);
    const later = join(outside, 'later.md');
    watchers.set({ [work]: [later] });
    await untilWatched([join(real(outside), 'later.md')]);
    writeFileSync(later, '作った\n');
    await untilChanged(outside, 'later.md');
  });

  it('同じフォルダのファイルの片方を閉じても、もう片方は見張り続ける', async () => {
    const memo = join(outside, 'memo.md');
    const todo = join(outside, 'todo.md');
    put(memo, 'はじめ\n');
    put(todo, 'やること\n');
    watchers.set({ [work]: [memo, todo] });
    await untilWatched([real(memo), real(todo)]);
    watchers.set({ [work]: [todo] });
    await untilWatched([real(todo)]);
    writeFileSync(todo, '書き足した\n');
    await untilChanged(outside, 'todo.md');
  });

  it('続けて届いたら、最後に届いたタブで決める（前の決め直しの途中で届いても）', async () => {
    const memo = join(outside, 'memo.md');
    const todo = join(outside, 'todo.md');
    put(memo, 'はじめ\n');
    put(todo, 'やること\n');
    watchers.set({ [work]: [memo] });
    watchers.set({ [work]: [todo] });
    await untilWatched([real(todo)]);
  });

  it('無いフォルダの中のタブは見張らない。監視しているフォルダが消えていたら、その中のタブも見張る', async () => {
    const gone = join(base, 'gone');
    put(join(work, 'a.ts'), 'a\n');
    roots = [work, gone];
    watchers.set({ [work]: [join(gone, 'x', 'memo.md'), 'a.ts'], [gone]: ['b.ts'] });
    await untilWatched([]);
    roots = [gone];
    watchers.rootsChanged();
    await untilWatched([real(join(work, 'a.ts'))]);
  });

  it(`見張るファイルは ${MAX_OPEN_FILE_WATCHES} 個まで。画面から届いた形の違うものは捨てる`, async () => {
    watchers.set(null);
    watchers.set('/work');
    const paths = Array.from({ length: MAX_OPEN_FILE_WATCHES + 5 }, (_, i) => join(outside, `f${i}.txt`));
    for (const path of paths) put(path, '');
    watchers.set({ [work]: paths, relative: ['x'], [outside]: 'f0.txt' });
    await untilWatched(paths.slice(0, MAX_OPEN_FILE_WATCHES).map(real));
  });

  it('closeAll のあとは、タブが届いても見張らない', async () => {
    const memo = join(outside, 'memo.md');
    put(memo, 'はじめ\n');
    watchers.closeAll();
    watchers.set({ [work]: [memo] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(watchers.watched()).toEqual([]);
  });
});
