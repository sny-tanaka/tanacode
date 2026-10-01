import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Workspace } from '../src/main/workspace';

// エディタで開くファイルの読み分け（文字・画像・バイナリ・大きすぎる）

let root: string;
let workspace: Workspace;

// PNG の先頭（0 バイトを含むので、以前は「バイナリ」として返していた）
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tanacode-read-file-'));
  workspace = new Workspace(root);
  await writeFile(join(root, 'shot.png'), PNG);
  await writeFile(join(root, 'PHOTO.JPG'), PNG);
  await writeFile(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await writeFile(join(root, 'app.dmg'), Buffer.from([0x78, 0x00, 0x01]));
  await writeFile(join(root, 'note.md'), '# メモ\n');
  // 文字の上限（2MB）は超えるが、画像の上限（10MB）には収まる
  await writeFile(join(root, 'retina.png'), Buffer.alloc(3 * 1024 * 1024, 1));
  await writeFile(join(root, 'huge.png'), Buffer.alloc(10 * 1024 * 1024 + 1, 1));
  await writeFile(join(root, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
});

afterAll(() => rm(root, { recursive: true, force: true }));

it('PNG は、中身の data URL を添えた画像として返す', async () => {
  expect(await workspace.readFile('shot.png')).toEqual({ kind: 'image', url: `data:image/png;base64,${PNG.toString('base64')}` });
});

it('拡張子の大文字・小文字を区別しない', async () => {
  const content = await workspace.readFile('PHOTO.JPG');
  expect(content.kind === 'image' && content.url.startsWith('data:image/jpeg;base64,')).toBe(true);
});

it('文字の上限を超える画像も、画像の上限までは絵として返す', async () => {
  expect((await workspace.readFile('retina.png')).kind).toBe('image');
});

it('画像の上限（10MB）を超えたら、大きすぎるとして返す', async () => {
  expect(await workspace.readFile('huge.png')).toEqual({ kind: 'too-large', size: 10 * 1024 * 1024 + 1 });
});

it('SVG は文字として編集できるので、画像にしない', async () => {
  expect(await workspace.readFile('logo.svg')).toEqual({ kind: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
});

it('画像でない 0 バイト入りのファイルは、バイナリ', async () => {
  expect(await workspace.readFile('app.dmg')).toEqual({ kind: 'binary' });
});

it('文字のファイルは文字として返し、2MB を超えたら大きすぎる', async () => {
  expect(await workspace.readFile('note.md')).toEqual({ kind: 'text', text: '# メモ\n' });
  expect(await workspace.readFile('big.txt')).toEqual({ kind: 'too-large', size: 2 * 1024 * 1024 + 1 });
});
