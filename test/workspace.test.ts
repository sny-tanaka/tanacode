import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOLVE_FILES_MAX } from '../src/shared/ipc';
import { Workspace } from '../src/main/workspace';

// 右パネルとエディタが使うワークスペース（一覧・書き込み・@ の補完の一覧・全文検索）。
// 読み分け（文字・画像・バイナリ）は test/workspace-read-file.test.ts

let root: string;
let ws: Workspace;
const put = (path: string, text: string | Buffer) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-ws-')));
  ws = new Workspace(join(root, 'repo'));
  mkdirSync(join(root, 'repo'));
  root = join(root, 'repo');
});
afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

describe('Workspace', () => {
  it('フォルダの外を指す相対パス（..）は、読みも書きもしない', async () => {
    writeFileSync(join(root, '..', 'secret.txt'), 'secret');
    await expect(ws.readFile('../secret.txt')).rejects.toThrow('outside workspace');
    await expect(ws.writeFile('../secret.txt', 'x', null)).rejects.toThrow('outside workspace');
    await expect(ws.listDir('..')).rejects.toThrow('outside workspace');
    await expect(ws.writeFile('sub/../../secret.txt', 'x', null)).rejects.toThrow('outside workspace');
    // .. そのもの、名前が .. で始まるフォルダを通って外に出るものも断る
    await expect(ws.readFile('..')).rejects.toThrow('outside workspace');
    await expect(ws.readFile('..notes/../../secret.txt')).rejects.toThrow('outside workspace');
    await expect(ws.writeFile('..notes/../../secret.txt', 'x', null)).rejects.toThrow('outside workspace');
    expect(readFileSync(join(root, '..', 'secret.txt'), 'utf8')).toBe('secret');
  });

  it('名前が .. で始まるファイル（フォルダの中のもの）は、読み書きできる', async () => {
    put('..notes.md', 'メモ\n');
    expect(await ws.readFile('..notes.md')).toEqual({ kind: 'text', text: 'メモ\n' });
    await ws.writeFile('..notes.md', '書き直し\n', 'メモ\n');
    expect(readFileSync(join(root, '..notes.md'), 'utf8')).toBe('書き直し\n');
  });

  it('listDir: フォルダを先に名前順で並べ、.git・node_modules などは出さない', async () => {
    put('b.txt', 'b');
    put('a.txt', 'a');
    put('src/x.ts', 'x');
    put('node_modules/p/index.js', 'p');
    put('.next/cache.json', '{}');
    for (const dir of ['out', 'dist', '.turbo']) put(`${dir}/x.js`, '');
    put('.DS_Store', '');
    mkdirSync(join(root, '.git'));
    expect(await ws.listDir('')).toEqual([
      { name: 'src', path: 'src', isDir: true },
      { name: 'a.txt', path: 'a.txt', isDir: false },
      { name: 'b.txt', path: 'b.txt', isDir: false },
    ]);
    expect(await ws.listDir('src')).toEqual([{ name: 'x.ts', path: 'src/x.ts', isDir: false }]);
  });

  it('writeFile: フォルダの中に書き、読み直せる', async () => {
    put('note.md', '# 前\n');
    expect(await ws.writeFile('note.md', '# 後\n', '# 前\n')).toEqual({ ok: true });
    expect(await ws.readFile('note.md')).toEqual({ kind: 'text', text: '# 後\n' });
  });

  // エディタが読んだあとに Claude Code などが書き換えたファイルを、⌘S で黙って上書きしない。
  // 変更の知らせが届く前（監視のまとめの間）や、監視しないフォルダ（out など）のファイルでも、書く前に確かめる
  it('writeFile: 今のディスクが、エディタが読んだときの中身と違えば書かず、今の中身を返す', async () => {
    put('note.md', 'Claude が書いた\n');
    expect(await ws.writeFile('note.md', '手で直した\n', '読んだとき\n')).toEqual({ ok: false, disk: { kind: 'text', text: 'Claude が書いた\n' } });
    expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('Claude が書いた\n');
    put('out/build.log', '書き換えた\n');
    expect(await ws.writeFile('out/build.log', '手で直した\n', '読んだとき\n')).toEqual({ ok: false, disk: { kind: 'text', text: '書き換えた\n' } });
    expect(readFileSync(join(root, 'out/build.log'), 'utf8')).toBe('書き換えた\n');
    // 文字でなくなっていても、書かずに今の中身（バイナリ）を返す
    put('data.txt', Buffer.from([0x61, 0x00, 0x62]));
    expect(await ws.writeFile('data.txt', '手で直した\n', '読んだとき\n')).toEqual({ ok: false, disk: { kind: 'binary' } });
    expect(readFileSync(join(root, 'data.txt'))).toEqual(Buffer.from([0x61, 0x00, 0x62]));
  });

  it('writeFile: expected が null なら確かめずに書く（衝突の知らせで「このまま保存」を選んだとき）。消えていたファイルは書き直す', async () => {
    put('note.md', 'Claude が書いた\n');
    expect(await ws.writeFile('note.md', '手で直した\n', null)).toEqual({ ok: true });
    expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('手で直した\n');
    expect(await ws.writeFile('gone.md', '手で直した\n', '読んだとき\n')).toEqual({ ok: true });
    expect(readFileSync(join(root, 'gone.md'), 'utf8')).toBe('手で直した\n');
  });

  it('listFiles: git のリポジトリなら、追跡中と未追跡（.gitignore を除く）。そうでなければフォルダをたどる', async () => {
    put('a.ts', 'a');
    put('src/b.ts', 'b');
    put('node_modules/p.js', 'p');
    expect((await ws.listFiles()).sort()).toEqual(['a.ts', 'src/b.ts']);
    execFileSync('git', ['init', '-q'], { cwd: root });
    put('.gitignore', 'ignored/\n');
    put('ignored/c.ts', 'c');
    expect((await ws.listFiles()).sort()).toEqual(['.gitignore', 'a.ts', 'node_modules/p.js', 'src/b.ts']);
  });

  it('listFiles: フォルダの設定のコマンド（fsmonitor・フック）を動かさない', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    put('a.ts', 'a');
    const mark = join(root, '..', 'fsmonitor-ran');
    execFileSync('git', ['config', 'core.fsmonitor', `touch "${mark}"; false`], { cwd: root });
    expect(await ws.listFiles()).toEqual(['a.ts']);
    expect(existsSync(mark)).toBe(false);
  });

  it('listFiles・search: git のリポジトリでも、日本語や空白を含むファイル名をそのまま返す（追跡中も未追跡も）', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    put('メモ.md', '税率を直す\n');
    execFileSync('git', ['add', 'メモ.md'], { cwd: root });
    put('仕様/画面 一覧.md', '税率の表\n');
    expect((await ws.listFiles()).sort()).toEqual(['メモ.md', '仕様/画面 一覧.md']);
    const result = await ws.search('税率', { caseSensitive: false, regex: false });
    expect(result.files.map((f) => f.path).sort()).toEqual(['メモ.md', '仕様/画面 一覧.md']);
  });

  it('search: 大文字小文字・正規表現の指定で探し、行と列と前後を詰めた抜き出しを返す。バイナリは探さない', async () => {
    put('a.ts', `const Tax = 1;\nconst tax = 2;\n${'x'.repeat(60)}TAX_RATE\n`);
    put('bin.dat', Buffer.from([0x74, 0x61, 0x78, 0x00]));
    const insensitive = await ws.search('tax', { caseSensitive: false, regex: false });
    expect(insensitive.files.map((f) => [f.path, f.matches.map((m) => m.line)])).toEqual([['a.ts', [1, 2, 3]]]);
    const third = insensitive.files[0].matches[2];
    expect(third).toMatchObject({ line: 3, column: 61, matchLength: 3 });
    expect(third.text.slice(third.matchStart, third.matchStart + third.matchLength)).toBe('TAX');
    const sensitive = await ws.search('tax', { caseSensitive: true, regex: false });
    expect(sensitive.files[0].matches.map((m) => m.line)).toEqual([2]);
    const regex = await ws.search('T[a-z]x', { caseSensitive: true, regex: true });
    expect(regex.files[0].matches.map((m) => m.line)).toEqual([1]);
    // 正規表現でないときは、記号もそのまま探す
    expect((await ws.search('T[a-z]x', { caseSensitive: true, regex: false })).files).toEqual([]);
  });

  it('search: 正規表現でないときは、. などの記号もその文字として探す。空の検索は、ファイルがあっても何も返さない', async () => {
    put('a.txt', 'axb\na.b\n');
    expect((await ws.search('a.b', { caseSensitive: true, regex: false })).files).toEqual([
      { path: 'a.txt', matches: [{ line: 2, column: 1, text: 'a.b', matchStart: 0, matchLength: 3 }] },
    ]);
    expect(await ws.search('', { caseSensitive: false, regex: false })).toEqual({ files: [], truncated: false });
  });

  it('search: 1MB ちょうどまでのファイルは探す。リンク先の無いリンクは飛ばす', async () => {
    put('limit.txt', `tax\n${'x'.repeat(1024 * 1024 - 4)}`);
    symlinkSync(join(root, 'missing.txt'), join(root, 'broken'));
    const result = await ws.search('tax', { caseSensitive: false, regex: false });
    expect(result.files.map((f) => f.path)).toEqual(['limit.txt']);
  });

  it('search: 正しくない正規表現は、理由を返す。空の検索は何も返さない', async () => {
    expect(await ws.search('(', { caseSensitive: false, regex: true })).toEqual({ files: [], truncated: false, error: '正規表現が正しくありません' });
    expect(await ws.search('', { caseSensitive: false, regex: false })).toEqual({ files: [], truncated: false });
  });

  it('info: フォルダの名前と、今のブランチ（git でなければ null）', async () => {
    expect(await ws.info()).toEqual({ root, name: 'repo', branch: null });
    execFileSync('git', ['init', '-q', '-b', 'topic'], { cwd: root });
    expect(await ws.info()).toMatchObject({ branch: 'topic' });
    // ブランチから外れていれば、コミットの先頭 7 文字
    writeFileSync(join(root, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(await ws.info()).toMatchObject({ branch: '0123456' });
  });

  it('readImage: Markdown のプレビューの画像を data URL で返す（SVG も）。画像でない・大きすぎるものは null', async () => {
    put('img/a.png', Buffer.from([1, 2, 3]));
    expect(await ws.readImage('img/a.png')).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
    put('logo.svg', '<svg/>');
    expect(await ws.readImage('logo.svg')).toBe(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`);
    put('a.txt', 'x');
    expect(await ws.readImage('a.txt')).toBeNull();
    put('anim.gif', Buffer.from([7]));
    expect(await ws.readImage('anim.gif')).toBe(`data:image/gif;base64,${Buffer.from([7]).toString('base64')}`);
    put('old.BMP', Buffer.from([8]));
    expect(await ws.readImage('old.BMP')).toBe(`data:image/bmp;base64,${Buffer.from([8]).toString('base64')}`);
    put('huge.gif', Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(await ws.readImage('huge.gif')).toBeNull();
    writeFileSync(join(root, '..', 'secret.png'), 'x');
    await expect(ws.readImage('../secret.png')).rejects.toThrow('outside workspace');
  });

  it('readImage: ワークスペースの中（リンクを解いた場所も）の画像だけを読む。絶対パスは、ワークスペースか追加したフォルダの中のものだけ', async () => {
    const dataUrl = (bytes: number[]) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    const outside = join(root, '..', 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.png'), Buffer.from([5]));
    const added = join(root, '..', 'lib');
    mkdirSync(added);
    writeFileSync(join(added, 'logo.png'), Buffer.from([6]));
    put('img/a.png', Buffer.from([1]));
    // 絶対パス: ワークスペースの中と、追加したフォルダの中は読む。外は読まない
    expect(await ws.readImage(join(root, 'img/a.png'), [added])).toBe(dataUrl([1]));
    expect(await ws.readImage(join(added, 'logo.png'), [added])).toBe(dataUrl([6]));
    await expect(ws.readImage(join(outside, 'secret.png'), [added])).rejects.toThrow('outside workspace');
    await expect(ws.readImage(join(added, 'logo.png'))).rejects.toThrow('outside workspace');
    // 中のリンク: 外を指すもの（ファイル・フォルダ）は読まず、中を指すものは読む
    symlinkSync(join(outside, 'secret.png'), join(root, 'leak.png'));
    symlinkSync(outside, join(root, 'docs'));
    symlinkSync(join(root, 'img/a.png'), join(root, 'same.png'));
    await expect(ws.readImage('leak.png')).rejects.toThrow('outside workspace');
    await expect(ws.readImage('docs/secret.png')).rejects.toThrow('outside workspace');
    expect(await ws.readImage('same.png')).toBe(dataUrl([1]));
    // 追加したフォルダの中のリンクも、外を指すものは読まない
    symlinkSync(join(outside, 'secret.png'), join(added, 'leak.png'));
    await expect(ws.readImage(join(added, 'leak.png'), [added])).rejects.toThrow('outside workspace');
    // ワークスペースのフォルダがリンクの先にあっても（/tmp と /private/tmp など）、中のものは読む
    const linked = join(root, '..', 'linked-repo');
    symlinkSync(root, linked);
    expect(await new Workspace(linked).readImage('img/a.png')).toBe(dataUrl([1]));
  });

  it('画像は 10MB ちょうどまで、絵として返す。拡張子ごとの種類', async () => {
    put('limit.png', Buffer.alloc(10 * 1024 * 1024, 1));
    expect((await ws.readFile('limit.png')).kind).toBe('image');
    expect((await ws.readImage('limit.png'))?.startsWith('data:image/png;base64,')).toBe(true);
    for (const [ext, mime] of [
      ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'],
      ['avif', 'image/avif'],
      ['ico', 'image/x-icon'],
    ]) {
      put(`a.${ext}`, Buffer.from([9]));
      expect(await ws.readImage(`a.${ext}`)).toBe(`data:${mime};base64,${Buffer.from([9]).toString('base64')}`);
    }
  });

  it('resolveFiles: 本文のパスの候補のうち、実在するファイルだけ絶対パスで返す（候補と同じ順。フォルダ・無いもの・変な値は null）', async () => {
    put('src/a.ts', 'a');
    mkdirSync(join(root, 'docs'));
    const outside = join(root, '..', 'study', 'slides.md');
    mkdirSync(join(outside, '..'), { recursive: true });
    writeFileSync(outside, '# s');
    const found = await ws.resolveFiles([outside, 'src/a.ts', './src/a.ts', join(root, 'src/a.ts'), 'docs', 'src/none.ts', '/compact', '', '../study/slides.md', 'src/a.ts\0x']);
    // 相対パスは作業フォルダから解く（./ や .. も）。外のファイルも、実在すれば返す
    expect(found).toEqual([outside, join(root, 'src/a.ts'), join(root, 'src/a.ts'), join(root, 'src/a.ts'), null, null, null, null, outside, null]);
    expect(await ws.resolveFiles([123 as unknown as string, null as unknown as string])).toEqual([null, null]);
    // 中身は読まない（エディタが開くときの上限より大きくても、実在は分かる）
    put('big.bin', Buffer.alloc(3 * 1024 * 1024));
    expect(await ws.resolveFiles(['big.bin'])).toEqual([join(root, 'big.bin')]);
  });

  it('resolveFiles: ~/ はホームから、相対パスは追加したフォルダからも探す。確かめるのは RESOLVE_FILES_MAX 件まで', async () => {
    const added = join(root, '..', 'added');
    mkdirSync(added);
    writeFileSync(join(added, 'lib.ts'), 'l');
    expect(await ws.resolveFiles(['lib.ts', 'none.ts'], [added])).toEqual([join(added, 'lib.ts'), null]);
    expect(await ws.resolveFiles(['lib.ts'])).toEqual([null]);
    // ~/ はホームから（os.homedir() は HOME を見る）
    const home = join(root, '..', 'home');
    mkdirSync(join(home, 'notes'), { recursive: true });
    writeFileSync(join(home, 'notes/a.md'), 'n');
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(homedir()).toBe(home);
      expect(await ws.resolveFiles(['~/notes/a.md', '~/notes/none.md', '~/notes'])).toEqual([join(home, 'notes/a.md'), null, null]);
    } finally {
      process.env.HOME = savedHome;
    }
    put('f.ts', 'f');
    const many = Array.from({ length: RESOLVE_FILES_MAX + 1 }, () => 'f.ts');
    const found = await ws.resolveFiles(many);
    expect(found).toHaveLength(RESOLVE_FILES_MAX + 1);
    expect(found.at(-2)).toBe(join(root, 'f.ts'));
    expect(found.at(-1)).toBeNull();
  });

  it('文字のファイルは 2MB ちょうどまで読む', async () => {
    put('limit.txt', 'a'.repeat(2 * 1024 * 1024));
    expect((await ws.readFile('limit.txt')).kind).toBe('text');
  });

  it('絶対パスは、フォルダの外のファイルでも読む（Claude が送ったファイルを、アプリの画面から開くとき）', async () => {
    writeFileSync(join(root, '..', 'sent.md'), '# 送ったファイル\n');
    expect(await ws.readFile(join(root, '..', 'sent.md'))).toEqual({ kind: 'text', text: '# 送ったファイル\n' });
  });

  it('search: フォルダを指すリンクと 1MB を超えるファイルは探さない', async () => {
    put('src/a.ts', 'tax\n');
    put('big.txt', `tax\n${'x'.repeat(1024 * 1024)}`);
    symlinkSync(join(root, 'src'), join(root, 'link'));
    const result = await ws.search('tax', { caseSensitive: false, regex: false });
    expect(result).toEqual({ files: [{ path: 'src/a.ts', matches: [{ line: 1, column: 1, text: 'tax', matchStart: 0, matchLength: 3 }] }], truncated: false });
  });

  it('search: 見つけた行が 2000 を超えたら、そこで打ち切って truncated にする', async () => {
    put('a.txt', 'tax\n'.repeat(2500));
    put('b.txt', 'tax\n'.repeat(2500));
    const result = await ws.search('tax', { caseSensitive: false, regex: false });
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].matches).toHaveLength(2000);
  });
});

// エクスプローラーのファイル操作。変えてよいのは作業フォルダと追加したフォルダの中だけ（画面から好きなパスを渡させない）
describe('Workspace のファイル操作', () => {
  it('createEntry: フォルダの中に空のファイル・フォルダを作り、ツリーの行のパスを返す。同じ名前のものがあれば作らない', async () => {
    put('src/a.ts', 'a');
    await expect(ws.createEntry('src', 'b.ts', 'file')).resolves.toBe('src/b.ts');
    expect(readFileSync(join(root, 'src/b.ts'), 'utf8')).toBe('');
    await expect(ws.createEntry('', 'lib', 'dir')).resolves.toBe('lib');
    expect(statSync(join(root, 'lib')).isDirectory()).toBe(true);
    await expect(ws.createEntry('src', 'a.ts', 'file')).rejects.toThrow('a.ts');
    await expect(ws.createEntry('', 'src', 'dir')).rejects.toThrow('src');
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('a');
  });

  it('createEntry・renameEntry: / を含む名前・. と ..・空の名前は断る', async () => {
    put('a.txt', 'a');
    for (const name of ['', '.', '..', 'x/y', '../x', 'a\0b']) {
      await expect(ws.createEntry('', name, 'file')).rejects.toThrow();
      await expect(ws.renameEntry('a.txt', name)).rejects.toThrow();
    }
    expect(readdirSync(join(root, '..')).sort()).toEqual(['repo']);
    expect(readdirSync(root)).toEqual(['a.txt']);
  });

  it('作業フォルダと追加したフォルダの外（.. ・絶対パス・外を指すリンク）は、作りも変えも捨てもしない', async () => {
    const outside = join(root, '..', 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'link'));
    const trash = vi.fn(async () => undefined);
    await expect(ws.createEntry('..', 'x.txt', 'file')).rejects.toThrow();
    await expect(ws.createEntry(outside, 'x.txt', 'file')).rejects.toThrow();
    await expect(ws.createEntry('link', 'x.txt', 'file')).rejects.toThrow();
    await expect(ws.renameEntry(join(outside, 'secret.txt'), 'y.txt')).rejects.toThrow();
    await expect(ws.renameEntry('link/secret.txt', 'y.txt')).rejects.toThrow();
    await expect(ws.trashEntry(join(outside, 'secret.txt'), [], trash)).rejects.toThrow();
    await expect(ws.trashEntry('../outside/secret.txt', [], trash)).rejects.toThrow();
    // フォルダそのもの（作業フォルダ・追加したフォルダ）は、名前を変えたり捨てたりしない
    await expect(ws.trashEntry('', [], trash)).rejects.toThrow();
    await expect(ws.trashEntry(root, [], trash)).rejects.toThrow();
    await expect(ws.trashEntry(outside, [outside], trash)).rejects.toThrow();
    await expect(ws.renameEntry(outside, 'y', [outside])).rejects.toThrow();
    expect(trash).not.toHaveBeenCalled();
    expect(readdirSync(outside)).toEqual(['secret.txt']);
  });

  it('追加したフォルダの中は、絶対パスで作り・変え・捨てられる', async () => {
    const added = join(root, '..', 'added');
    mkdirSync(added);
    await expect(ws.createEntry(added, 'a.txt', 'file', [added])).resolves.toBe(`${added}/a.txt`);
    await expect(ws.renameEntry(`${added}/a.txt`, 'b.txt', [added])).resolves.toBe(`${added}/b.txt`);
    const trash = vi.fn(async (_abs: string) => undefined);
    await ws.trashEntry(`${added}/b.txt`, [added], trash);
    expect(trash.mock.calls).toEqual([[join(added, 'b.txt')]]);
  });

  it('renameEntry: 同じフォルダの中で名前を変える（フォルダも）。同じ名前のものがあれば上書きしない。大文字と小文字だけの違いは変える', async () => {
    put('src/a.ts', 'a');
    put('src/b.ts', 'b');
    await expect(ws.renameEntry('src/a.ts', 'b.ts')).rejects.toThrow('b.ts');
    expect(readFileSync(join(root, 'src/b.ts'), 'utf8')).toBe('b');
    await expect(ws.renameEntry('src/a.ts', 'A.ts')).resolves.toBe('src/A.ts');
    expect(readdirSync(join(root, 'src')).sort()).toEqual(['A.ts', 'b.ts']);
    await expect(ws.renameEntry('src', 'lib')).resolves.toBe('lib');
    expect(readdirSync(join(root, 'lib')).sort()).toEqual(['A.ts', 'b.ts']);
    await expect(ws.renameEntry('lib/b.ts', 'b.ts')).resolves.toBe('lib/b.ts');
  });

  it('リンクの名前を変える・捨てるときは、リンクそのものを扱う（リンクの先は変えない）', async () => {
    put('target.txt', 't');
    symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'));
    await expect(ws.renameEntry('link.txt', 'link2.txt')).resolves.toBe('link2.txt');
    expect(readdirSync(root).sort()).toEqual(['link2.txt', 'target.txt']);
    const trash = vi.fn(async (_abs: string) => undefined);
    await ws.trashEntry('link2.txt', [], trash);
    expect(trash.mock.calls).toEqual([[join(root, 'link2.txt')]]);
  });

  it('trashEntry: 無いものは捨てない', async () => {
    const trash = vi.fn(async () => undefined);
    await expect(ws.trashEntry('nothing.txt', [], trash)).rejects.toThrow();
    expect(trash).not.toHaveBeenCalled();
  });
});
