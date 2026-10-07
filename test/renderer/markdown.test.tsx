// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown, markdownHtml } from '../../src/renderer/src/chat/Markdown';

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
    const md = show('```bash\nnpm test‮ -- --watch\n```\n\n```ts\nconst a = 1;\n```\n\n```sh title="x"\nls\n```', onRun);
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
