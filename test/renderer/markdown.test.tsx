// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown, markdownHtml } from '../../src/renderer/src/chat/Markdown';
import { mockApi } from './mock-api';

// チャットの Markdown の表示。返答は Claude（とその先のページやファイル）が書くので、信用しない。
// 混ざった HTML は文字のまま出し、外の画像は読みにいかず、実行ボタンはシェルのコードブロックにだけ付ける

afterEach(cleanup);

const show = (text: string, onRunCommand?: (command: string) => void) => render(<Markdown text={text} onRunCommand={onRunCommand} />).container.querySelector('.markdown')!;

describe('Markdown', () => {
  it('返答に混ざった HTML は、部品にせず文字のまま出す（ボタン・フォーム・style・イベントの属性を作らせない）', () => {
    const md = show('前\n\n<button onclick="alert(1)" style="position:fixed">押して</button>\n\n<span class="x" onmouseover="steal()">中</span> と <form><input></form>');
    expect(md.querySelector('button, form, input, span, [onclick], [style], [class]')).toBeNull();
    expect(md.textContent).toContain('<button onclick="alert(1)" style="position:fixed">押して</button>');
  });

  it('javascript: のリンクは href を残さない。ふつうのリンクは残す', () => {
    const md = show('[危ない](javascript:alert(1)) と [ふつう](https://example.com/docs)');
    const links = [...md.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['危ない', null],
      ['ふつう', 'https://example.com/docs'],
    ]);
  });

  it('外の画像は読みにいかず、URL を出すリンクにする（// で始まるものも）。中の画像（相対パス）は画像のまま', () => {
    const md = show('![秘密](https://evil.example/c.png?q=secret) ![](//evil.example/x.png) ![図](./diagram.png)');
    const images = [...md.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(images).toEqual(['./diagram.png']);
    const notes = [...md.querySelectorAll('a.markdown-external-image')].map((a) => [a.getAttribute('href'), a.textContent]);
    expect(notes).toEqual([
      ['https://evil.example/c.png?q=secret', '外部の画像（秘密）: https://evil.example/c.png?q=secret'],
      ['https://evil.example/x.png', '外部の画像: https://evil.example/x.png'],
    ]);
  });

  it('タスクリストのチェックボックスは、入力の部品でなく文字で出す', () => {
    const md = show('- [x] 済み\n- [ ] まだ');
    expect(md.querySelector('input')).toBeNull();
    expect([...md.querySelectorAll('li')].map((li) => li.textContent?.trim())).toEqual(['☑ 済み', '☐ まだ']);
  });

  it('シェルのコードブロックにだけ実行ボタンを付け、見えない制御文字を除いたコマンドを渡す', () => {
    const onRun = vi.fn();
    const md = show('```bash\nnpm test\u202E -- --watch\n```\n\n```ts\nconst a = 1;\n```\n\n```sh title="x"\nls\n```', onRun);
    const buttons = md.querySelectorAll('pre button.code-run');
    expect(buttons).toHaveLength(2);
    // 表示からも除く（見えている文字と実行する文字をそろえる）
    expect(md.querySelector('pre')?.textContent).toContain('npm test -- --watch');
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(onRun.mock.calls).toEqual([['npm test -- --watch'], ['ls']]);
  });

  it('実行を受け取らないとき（onRunCommand が無い）は、ボタンを付けない', () => {
    expect(show('```bash\nls\n```').querySelector('button')).toBeNull();
  });

  it('日本語の隣でも、** で強調になる', () => {
    expect(show('「重要」**です**。').querySelector('strong')?.textContent).toBe('です');
  });
});

// 本文のファイルのパス。実在するもの（main に確かめる）だけを、押すとエディタで開くリンクにする。
// セッションごとに実在を覚えるので、テストごとに別のセッションで試す
describe('Markdown のファイルのパス', () => {
  const resolving = (existing: Record<string, string>) => {
    const api = mockApi({ 'workspace.resolveFiles': (_id: string, paths: string[]) => Promise.resolve(paths.map((p) => existing[p] ?? null)) });
    api.install();
    return api;
  };
  const files = (box: Element) => [...box.querySelectorAll<HTMLElement>('a.file-link')].map((a) => [a.textContent, a.dataset.path, a.dataset.line]);

  it('実在するパスだけリンクにして、押すと絶対パスと行で開く（Enter でも）。実在しないものは文字のまま', async () => {
    const api = resolving({ '/Users/me/slides.md': '/Users/me/slides.md', 'src/a.ts': '/work/repo/src/a.ts' });
    const onOpenFile = vi.fn();
    const box = render(<Markdown text={'/Users/me/slides.md を開いて、`src/a.ts:12` も。/no/such.md は無い'} sessionId="files-1" onOpenFile={onOpenFile} />).container;
    // 最初は文字のまま（確かめが済んでからリンクになる）
    expect(box.querySelector('a.file-link')).toBeNull();
    await waitFor(() => expect(files(box)).toHaveLength(2));
    expect(files(box)).toEqual([
      ['/Users/me/slides.md', '/Users/me/slides.md', undefined],
      ['src/a.ts:12', '/work/repo/src/a.ts', '12'],
    ]);
    // 確かめるのは、実在を調べる候補だけ（セッション付きで 1 回）
    expect(api.argsOf('workspace.resolveFiles')).toHaveLength(1);
    expect(api.argsOf('workspace.resolveFiles')[0][0]).toBe('files-1');
    expect([...(api.argsOf('workspace.resolveFiles')[0][1] as string[])].sort()).toEqual(['/Users/me/slides.md', '/no/such.md', 'src/a.ts']);
    const [slides, source] = box.querySelectorAll<HTMLElement>('a.file-link');
    fireEvent.click(slides);
    fireEvent.click(source.querySelector('code')!);
    fireEvent.keyDown(source, { key: 'Enter' });
    fireEvent.keyDown(source, { key: 'a' });
    expect(onOpenFile.mock.calls).toEqual([['/Users/me/slides.md', undefined], ['/work/repo/src/a.ts', 12], ['/work/repo/src/a.ts', 12]]);
    expect(box.textContent?.trim()).toBe('/Users/me/slides.md を開いて、src/a.ts:12 も。/no/such.md は無い');
  });

  it('実在を確かめたパスは覚えていて、同じ本文を描き直すときは、最初からリンクにする（確かめ直さない候補は呼ばない）', async () => {
    const api = resolving({ '/Users/me/slides.md': '/Users/me/slides.md' });
    const first = render(<Markdown text="/Users/me/slides.md" sessionId="files-2" onOpenFile={vi.fn()} />).container;
    await waitFor(() => expect(files(first)).toHaveLength(1));
    cleanup();
    const again = render(<Markdown text="/Users/me/slides.md" sessionId="files-2" onOpenFile={vi.fn()} />).container;
    expect(files(again)).toHaveLength(1);
    expect(api.argsOf('workspace.resolveFiles')).toHaveLength(1);
    // 別のセッションには持ち越さない（相対パスは、セッションのフォルダで決まる）
    cleanup();
    expect(files(render(<Markdown text="/Users/me/slides.md" sessionId="files-3" onOpenFile={vi.fn()} />).container)).toHaveLength(0);
  });

  it('セッションか開く関数が無ければ、確かめず、パスは文字のまま。確かめに失敗しても文字のまま', async () => {
    const api = resolving({ '/Users/me/slides.md': '/Users/me/slides.md' });
    expect(files(render(<Markdown text="/Users/me/slides.md" onOpenFile={vi.fn()} />).container)).toEqual([]);
    expect(files(render(<Markdown text="/Users/me/slides.md" sessionId="files-4" />).container)).toEqual([]);
    expect(api.argsOf('workspace.resolveFiles')).toEqual([]);
    cleanup();
    mockApi({ 'workspace.resolveFiles': () => Promise.reject(new Error('boom')) }).install();
    const box = render(<Markdown text="/Users/me/slides.md" sessionId="files-5" onOpenFile={vi.fn()} />).container;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(files(box)).toEqual([]);
    expect(box.textContent?.trim()).toBe('/Users/me/slides.md');
  });

  it('コードブロックとリンクの中のパスは、リンクにしない（確かめにも出さない）', async () => {
    const api = resolving({});
    render(<Markdown text={'```\n/in/block.txt\n```\n\n[/in/link.txt](https://example.com/x)'} sessionId="files-6" onOpenFile={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.argsOf('workspace.resolveFiles')).toEqual([]);
  });
});

describe('markdownHtml（作業の書き出し）', () => {
  it('チャットと同じく消毒し、外の画像はリンクにする（「既定のブラウザで開く」の補足は付けない）。実行ボタンは付けない', () => {
    const html = markdownHtml('<script>alert(1)</script>\n\n![x](https://evil.example/a.png)\n\n```bash\nls\n```');
    const box = document.createElement('div');
    box.innerHTML = html;
    expect(box.querySelector('script, img, button')).toBeNull();
    expect(box.textContent).toContain('<script>alert(1)</script>');
    const note = box.querySelector('a.markdown-external-image');
    expect(note?.getAttribute('href')).toBe('https://evil.example/a.png');
    expect(note?.hasAttribute('title')).toBe(false);
  });
});
