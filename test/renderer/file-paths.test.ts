// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fileCandidates, linkFiles, pathOfCode, pathsIn } from '../../src/renderer/src/chat/filePaths';

// チャットの本文から、ファイルのパスの候補を拾う。ここで決まるのは候補だけ（リンクになるのは、main に確かめて実在したものだけ）。
// 本文は文章なので、パスの形をしていない・途中のものは拾わない

const paths = (text: string) => pathsIn(text).map((m) => m.candidates.map((c) => c.path));

describe('pathsIn（文字列の中のパス）', () => {
  it('絶対パス・~/・相対パスを、空白や日本語の句読点・括弧の手前までで拾う', () => {
    expect(paths('/Users/shunya.tanaka/work/tanacode-study-session/slides.md を開いて')).toEqual([['/Users/shunya.tanaka/work/tanacode-study-session/slides.md']]);
    expect(paths('「/tmp/a/b.txt」と（~/notes/c.md）、src/renderer/App.tsx。')).toEqual([['/tmp/a/b.txt'], ['~/notes/c.md'], ['src/renderer/App.tsx']]);
    expect(paths('./a/b.ts と ../c/d.json と .claude/settings.json')).toEqual([['./a/b.ts'], ['../c/d.json'], ['.claude/settings.json']]);
  });

  it('文末の「.」はパスに入れない。行（:12・:12:3・#L12）は、リンクの文字に入れて行として控える', () => {
    const [dot] = pathsIn('見て /a/b/c.md.');
    expect(dot.candidates[0]).toMatchObject({ path: '/a/b/c.md', end: '見て /a/b/c.md'.length });
    const found = pathsIn('src/a.ts:12 と src/b.ts:3:5 と src/c.ts#L7-L9 と src/d.ts: 後');
    expect(found.map((m) => [m.candidates[0].path, m.candidates[0].line])).toEqual([
      ['src/a.ts', 12],
      ['src/b.ts', 3],
      ['src/c.ts', 7],
      ['src/d.ts', undefined],
    ]);
    expect(found[0].candidates[0].end).toBe('src/a.ts:12'.length);
  });

  it('パスの直後に日本語が続くとき（/a/b.mdを開く）は、拡張子までの短い候補も添える（長い候補が先）', () => {
    expect(paths('/Users/me/資料/slides.mdを開く')).toEqual([['/Users/me/資料/slides.mdを開く', '/Users/me/資料/slides.md']]);
    // 相対パスは、拡張子で終わらないと長い候補にならない（拡張子までの候補だけ）
    expect(pathsIn('x/a.mdを')[0].candidates.map((c) => c.end)).toEqual(['x/a.md'.length]);
    expect(pathsIn('/x/a.mdを')[0].candidates.map((c) => c.end)).toEqual(['/x/a.mdを'.length, '/x/a.md'.length]);
  });

  it('パスの途中・パスでないものは拾わない（URL・日付・and/or・1 つだけの /名前・拡張子の無い相対パス）', () => {
    for (const text of ['https://example.com/docs/a.md', 'localhost:3000/api/x.json', '2026/10/22', 'and/or と input/output', '/compact と /model', 'v1.2/v1.3', 'file:///Users/me/a.md']) {
      expect(paths(text), text).toEqual([]);
    }
  });

  it('1 つだけの部分でも、拡張子があれば絶対パスとして拾う', () => {
    expect(paths('/Makefile.bak と ~/.zshrc')).toEqual([['/Makefile.bak'], ['~/.zshrc']]);
  });
});

describe('pathOfCode（インラインのコードの中）', () => {
  it('全体が 1 つのパスのときだけ。空白を含む絶対パス・行つきも', () => {
    expect(pathOfCode('/Users/me/a.md')?.candidates).toEqual([{ path: '/Users/me/a.md', end: 14, line: undefined }]);
    expect(pathOfCode(' /Users/me/My Docs/a.md:30 ')?.candidates[0]).toMatchObject({ path: '/Users/me/My Docs/a.md', line: 30 });
    expect(pathOfCode('src/a.ts#L5')?.candidates[0]).toMatchObject({ path: 'src/a.ts', line: 5 });
    for (const text of ['ls /Users/me/a.md', 'npm run build', '/compact', 'a.ts', 'https://example.com/a.md', '']) expect(pathOfCode(text), text).toBeNull();
  });
});

const dom = (html: string) => {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
};

describe('fileCandidates・linkFiles（DOM）', () => {
  it('文・インラインのコードのパスを拾い、実在が分かったものだけリンクにする（コードブロック・リンクの中は飛ばす）', () => {
    const root = dom(
      '<p>開く: /Users/me/slides.md を。<code>src/a.ts:12</code> と <code>npm run x</code></p>' +
        '<pre><code>/in/block.txt</code></pre><p><a href="https://x.dev/a/b.md">/in/link.txt</a> と /no/such.md</p>',
    );
    expect(fileCandidates(root).sort()).toEqual(['/Users/me/slides.md', '/no/such.md', 'src/a.ts'].sort());
    linkFiles(root, new Map([['/Users/me/slides.md', '/Users/me/slides.md'], ['src/a.ts', '/work/repo/src/a.ts']]));
    const links = [...root.querySelectorAll<HTMLElement>('a.file-link')].map((a) => [a.textContent, a.dataset.path, a.dataset.line, a.getAttribute('href'), a.getAttribute('role'), a.tabIndex]);
    expect(links).toEqual([
      ['/Users/me/slides.md', '/Users/me/slides.md', undefined, null, 'link', 0],
      ['src/a.ts:12', '/work/repo/src/a.ts', '12', null, 'link', 0],
    ]);
    // コードは、リンクの中に残す（見た目は変えない）。まわりの文字は変わらない
    expect(root.querySelector('a.file-link > code')?.textContent).toBe('src/a.ts:12');
    expect(root.querySelector('p')?.textContent).toBe('開く: /Users/me/slides.md を。src/a.ts:12 と npm run x');
    // 残りの候補だけが、次の確かめの対象になる。何度リンクにしても、重ならない
    expect(fileCandidates(root)).toEqual(['/no/such.md']);
    linkFiles(root, new Map([['/Users/me/slides.md', '/Users/me/slides.md']]));
    expect(root.querySelectorAll('a.file-link')).toHaveLength(2);
  });

  it('日本語が続くとき、長い候補が実在しなければ、短い候補（拡張子まで）をリンクにする', () => {
    const root = dom('<p>/Users/me/slides.mdを開く</p>');
    expect(fileCandidates(root)).toEqual(['/Users/me/slides.mdを開く', '/Users/me/slides.md']);
    linkFiles(root, new Map([['/Users/me/slides.md', '/Users/me/slides.md']]));
    expect(root.querySelector('a.file-link')?.textContent).toBe('/Users/me/slides.md');
    expect(root.textContent).toBe('/Users/me/slides.mdを開く');
  });

  it('同じ文の中の複数のパスは、実在するものだけリンクにして、間の文字を残す', () => {
    const root = dom('<p>a/x.ts と a/y.ts と a/z.ts</p>');
    linkFiles(root, new Map([['a/x.ts', '/r/a/x.ts'], ['a/z.ts', '/r/a/z.ts']]));
    expect([...root.querySelectorAll('a.file-link')].map((a) => a.textContent)).toEqual(['a/x.ts', 'a/z.ts']);
    expect(root.textContent).toBe('a/x.ts と a/y.ts と a/z.ts');
  });
});
