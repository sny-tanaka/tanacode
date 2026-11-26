import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addIntegrity } from '../scripts/remote-integrity';

// スマホの画面の入口（remote.html）のスクリプトとスタイルに付ける完全性の検査（scripts/remote-integrity.ts）

const sri = (text: string) => `sha384-${createHash('sha384').update(text).digest('base64')}`;

describe('addIntegrity', () => {
  it('./assets/ の下で成果物にあるスクリプト・スタイル・modulepreload に付ける。crossorigin が無ければ足す', () => {
    const files: Record<string, string> = { 'assets/a.js': 'console.log(1)', 'assets/b.css': 'body{}', 'assets/c.js': 'x' };
    const html = [
      '<script type="module" crossorigin src="./assets/a.js"></script>',
      '<link rel="stylesheet" href="./assets/b.css">',
      '<link rel="modulepreload" crossorigin href="./assets/c.js">',
    ].join('\n');
    expect(addIntegrity(html, (file) => files[file] ?? null)).toBe(
      [
        `<script type="module" crossorigin src="./assets/a.js" integrity="${sri('console.log(1)')}"></script>`,
        `<link rel="stylesheet" href="./assets/b.css" integrity="${sri('body{}')}" crossorigin>`,
        `<link rel="modulepreload" crossorigin href="./assets/c.js" integrity="${sri('x')}">`,
      ].join('\n'),
    );
  });

  it('タグと属性の名前の大文字・小文字は区別しない', () => {
    const out = addIntegrity('<SCRIPT SRC="./assets/a.js" CROSSORIGIN></SCRIPT>\n<LINK HREF="./assets/b.css" INTEGRITY="sha384-old">', (file) => (file === 'assets/a.js' ? 'a' : 'b'));
    expect(out).toBe(`<SCRIPT SRC="./assets/a.js" CROSSORIGIN integrity="${sri('a')}"></SCRIPT>\n<LINK HREF="./assets/b.css" INTEGRITY="sha384-old">`);
  });

  it('成果物に無いもの・assets の外・もう付いているものは触らない。バイト列の中身でも付ける', () => {
    const html = [
      '<link rel="manifest" href="/manifest.webmanifest" />',
      '<link rel="stylesheet" href="./assets/none.css">',
      '<script src="./assets/a.js" integrity="sha384-old"></script>',
      '<script src="./assets/bin.js"></script>',
    ].join('\n');
    const out = addIntegrity(html, (file) => (file === 'assets/a.js' ? 'a' : file === 'assets/bin.js' ? new Uint8Array([1, 2]) : null));
    const lines = out.split('\n');
    expect(lines.slice(0, 3)).toEqual(html.split('\n').slice(0, 3));
    expect(lines[3]).toBe(`<script src="./assets/bin.js" integrity="sha384-${createHash('sha384').update(new Uint8Array([1, 2])).digest('base64')}" crossorigin></script>`);
  });
});
