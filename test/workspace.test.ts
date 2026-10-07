import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    await expect(ws.writeFile('../secret.txt', 'x')).rejects.toThrow('outside workspace');
    await expect(ws.listDir('..')).rejects.toThrow('outside workspace');
    await expect(ws.writeFile('sub/../../secret.txt', 'x')).rejects.toThrow('outside workspace');
    expect(readFileSync(join(root, '..', 'secret.txt'), 'utf8')).toBe('secret');
  });

  it('listDir: フォルダを先に名前順で並べ、.git・node_modules などは出さない', async () => {
    put('b.txt', 'b');
    put('a.txt', 'a');
    put('src/x.ts', 'x');
    put('node_modules/p/index.js', 'p');
    put('.next/cache.json', '{}');
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
    await ws.writeFile('note.md', '# 後\n');
    expect(await ws.readFile('note.md')).toEqual({ kind: 'text', text: '# 後\n' });
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
