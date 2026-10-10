// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textResult } from '../src/main/mcp-bridge';
import { setup, textOf, type Tab } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// アプリ内ブラウザの操作（src/main/browser-control.ts）が、ページの中で動かすスクリプト（要素を探す・文字を読む・待つ など）を、
// jsdom の文書の上で本当に動かして確かめる。同じオリジンの iframe の中も探すこと・位置の足し合わせ・パスワードの欄の値を渡さないこと。
// jsdom は描かないので、要素の位置（getBoundingClientRect）と、位置にある要素（elementFromPoint）はテストが決める

type Rect = { x: number; y: number; width: number; height: number };

// 要素を、見えている範囲のこの位置・大きさに置く（その文書の左上から）
function place(el: Element, rect: Rect): void {
  el.getBoundingClientRect = () =>
    ({ ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect }) as DOMRect;
}

// スクリプトを、この文書（グローバル）の上で動かす
const runInPage = (code: string): unknown => (0, eval)(code);

function usePage(page: Tab): void {
  for (const kind of ['viewport', 'locate', 'point', 'focus', 'text', 'inspect', 'wait', 'clear'] as const) page.page[kind] = runInPage;
}

// jsdom に無いもの（描かないので、innerText は textContent で代える）を、window ごとに補う（iframe の中は別の window）
function polyfill(win: Window & typeof globalThis): void {
  win.Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? '';
    },
  });
}

// 同じオリジンの iframe を足して、その中の文書を返す
function addFrame(id: string, html: string): { frame: HTMLIFrameElement; doc: Document } {
  const frame = document.createElement('iframe');
  frame.id = id;
  document.body.append(frame);
  polyfill(frame.contentWindow as Window & typeof globalThis);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = html;
  return { frame, doc };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  document.title = '';
  document.body.innerHTML = '';
  polyfill(window);
  document.elementFromPoint = () => null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ページの文字（get_text）', () => {
  it('ページ全体: いちばん外のページと、同じオリジンの iframe の文字を、iframe ごとに分けて読む', async () => {
    const { call, open } = setup();
    usePage(open('http://localhost:3000/'));
    document.title = 'トップ';
    document.body.innerHTML = '<p>本文</p>';
    addFrame('f', '<p>中の文字</p>');
    expect(textOf(await call('get_text'))).toBe(['Title: トップ', `URL: ${location.href}`, '', '本文', '', '--- inside iframe (about:blank) ---', '中の文字'].join('\n'));
  });

  it('selector: iframe の中の要素も探して、その中だけを読む。当たらなければ断る', async () => {
    const { call, open } = setup();
    usePage(open('http://localhost:3000/'));
    document.body.innerHTML = '<p id="outer">外</p>';
    addFrame('f', '<section id="inner"><p>中の文字</p></section>');
    expect(textOf(await call('get_text', { selector: '#inner' }))).toBe(`Title: (none)\nURL: ${location.href}\n\n--- inside iframe (about:blank) ---\n中の文字`);
    expect(textOf(await call('get_text', { selector: '#outer' }))).toBe(`Title: (none)\nURL: ${location.href}\n\n外`);
    expect(await call('get_text', { selector: '#none' })).toEqual(textResult('No element matches "#none".', true));
  });
});

describe('要素を探して押す（locate）', () => {
  it('見えている最初の要素の真ん中を押す。説明はタグ・ID・クラスと中の文字', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    usePage(page);
    document.body.innerHTML = '<button class="item">隠れ</button><button id="go" class="primary big extra">送る</button>';
    const go = document.getElementById('go')!;
    place(go, { x: 100, y: 50, width: 200, height: 40 });
    document.elementFromPoint = () => go;
    expect(await call('click', { selector: 'button' })).toEqual(textResult('Clicked: button#go.primary.big "送る"'));
    expect(page.debugger.sent('Input.dispatchMouseEvent')[1].params).toMatchObject({ type: 'mousePressed', x: 200, y: 70 });
  });

  it('パスワードの欄は、入っている値を説明に使わない（ほかの欄は値を使う）', async () => {
    const { call, open } = setup();
    usePage(open('http://localhost:3000/'));
    document.body.innerHTML = '<input id="user" value="tanaka"><input id="pw" type="password" value="hunter2" aria-label="パスワード"><input id="pin" type="password" value="1234">';
    for (const el of document.querySelectorAll('input')) place(el, { x: 10, y: 10, width: 100, height: 20 });
    document.elementFromPoint = (x, y) => document.querySelector(y > 0 ? '#pw' : 'body');
    const user = textOf(await call('click', { selector: '#user' }));
    expect(user).toContain('Clicked: input#user "tanaka"');
    const pw = textOf(await call('click', { selector: '#pw' }));
    expect(pw).toBe('Clicked: input#pw "パスワード"');
    const pin = textOf(await call('click', { selector: '#pin' }));
    expect(pin).toContain('Clicked: input#pin\n');
    for (const text of [pw, pin]) {
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('1234');
    }
  });

  it('押す位置にほかの要素が重なっていたら、その要素を伝える（中の要素・外の要素は重なりとみなさない）', async () => {
    const { call, open } = setup();
    usePage(open('http://localhost:3000/'));
    document.body.innerHTML = '<div id="wrap"><button id="go"><span id="label">送る</span></button></div><div class="overlay modal">幕</div>';
    place(document.getElementById('go')!, { x: 0, y: 0, width: 100, height: 40 });
    let top: Element | null = document.querySelector('.overlay');
    document.elementFromPoint = () => top;
    expect(textOf(await call('click', { selector: '#go' }))).toBe('Clicked: button#go "送る"\n(another element, div.overlay.modal, was covering the clicked position)');
    for (const id of ['label', 'wrap']) {
      top = document.getElementById(id);
      expect(textOf(await call('click', { selector: '#go' })), id).toBe('Clicked: button#go "送る"');
    }
  });

  it('当たる要素が無い・どれも見えていない（大きさ 0・visibility: hidden）・セレクタの書き方が違うときは断る', async () => {
    const { call, open } = setup();
    usePage(open('http://localhost:3000/'));
    document.body.innerHTML = '<button class="item">a</button><button class="item" style="visibility: hidden">b</button>';
    place(document.querySelectorAll('.item')[1], { x: 0, y: 0, width: 10, height: 10 });
    expect(await call('click', { selector: '.item' })).toEqual(textResult('None of the 2 elements matching ".item" is visible.', true));
    expect(await call('click', { selector: '#none' })).toEqual(textResult('No element matches "#none".', true));
    const bad = await call('click', { selector: '[[' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^Invalid selector: /);
  });

  it('iframe の中の要素: iframe の位置（枠と余白も）を足した位置を押し、iframe の中だと添える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    usePage(page);
    const { frame, doc } = addFrame('f', '<button id="inner">中のボタン</button>');
    frame.style.paddingLeft = '5px';
    frame.style.paddingTop = '3px';
    place(frame, { x: 100, y: 50, width: 400, height: 300 });
    place(doc.getElementById('inner')!, { x: 10, y: 10, width: 20, height: 20 });
    expect(textOf(await call('click', { selector: '#inner' }))).toBe('Clicked: button#inner "中のボタン" (inside iframe about:blank)');
    // 100 + 5 + 10 + 10、50 + 3 + 10 + 10
    expect(page.debugger.sent('Input.dispatchMouseEvent')[1].params).toMatchObject({ type: 'mousePressed', x: 125, y: 73 });
  });
});

describe('位置で押す（pointAt）', () => {
  it('その位置の要素を伝える。見えている範囲の外・要素が無いときは断る', async () => {
    const { call, open } = setup();
    usePage(open('http://localhost:3000/'));
    document.body.innerHTML = '<canvas id="board" aria-label="盤"></canvas>';
    document.elementFromPoint = () => document.getElementById('board');
    expect(textOf(await call('click', { x: 5, y: 5 }))).toBe('Clicked: canvas#board "盤" at x=5 y=5');
    expect(await call('click', { x: innerWidth, y: 5 })).toEqual(textResult(`x=${innerWidth} y=5 is outside the visible area (${innerWidth}×${innerHeight}).`, true));
    expect(await call('click', { x: -1, y: 5 })).toEqual(textResult(`x=-1 y=5 is outside the visible area (${innerWidth}×${innerHeight}).`, true));
    document.elementFromPoint = () => null;
    expect(await call('click', { x: 5, y: 5 })).toEqual(textResult('There is no element at x=5 y=5.', true));
  });

  it('同じオリジンの iframe の中は、iframe の中の位置で中の要素を探す', async () => {
    const { call, open } = setup();
    usePage(open('http://localhost:3000/'));
    const { frame, doc } = addFrame('f', '<a id="link" href="#">次へ</a>');
    place(frame, { x: 100, y: 50, width: 400, height: 300 });
    const asked: [number, number][] = [];
    document.elementFromPoint = () => frame;
    doc.elementFromPoint = (x, y) => {
      asked.push([x, y]);
      return doc.getElementById('link');
    };
    expect(textOf(await call('click', { x: 130, y: 70 }))).toBe('Clicked: a#link "次へ" (inside iframe about:blank) at x=130 y=70');
    expect(asked).toEqual([[30, 20]]);
  });

  it('別オリジンの iframe（中が見えない）は、src で許す先かを決める', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    usePage(page);
    const { frame } = addFrame('w', '');
    place(frame, { x: 100, y: 50, width: 400, height: 300 });
    Object.defineProperty(frame, 'contentDocument', {
      get() {
        throw new DOMException('Blocked a frame with origin', 'SecurityError');
      },
    });
    let src = 'http://127.0.0.1:5173/widget';
    Object.defineProperty(frame, 'src', { get: () => src });
    document.elementFromPoint = () => frame;
    expect(textOf(await call('click', { x: 150, y: 60 }))).toBe('Clicked: x=150 y=60 (inside cross-origin iframe http://127.0.0.1:5173/widget)');
    expect(page.debugger.sent('Input.dispatchMouseEvent')[1].params).toMatchObject({ x: 150, y: 60 });
    src = 'https://pay.example.com/checkout';
    expect((await call('click', { x: 150, y: 60 })).isError).toBe(true);
  });
});

describe('待つ（wait_for）', () => {
  it('selector: 出て見えるまで待つ。attached は DOM に入れば、hidden は消えるまで', async () => {
    const { call, control, open } = setup();
    usePage(open('http://localhost:3000/'));
    const pending = control.handle('S1', 'wait_for', { selector: '#done', timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(400);
    document.body.innerHTML = '<p id="done">できた</p>';
    // まだ大きさが 0（見えていない）
    await vi.advanceTimersByTimeAsync(400);
    place(document.getElementById('done')!, { x: 0, y: 0, width: 50, height: 20 });
    await vi.advanceTimersByTimeAsync(400);
    expect(textOf(await pending)).toMatch(/^"#done" appeared \(\d+ ms\)$/);
    document.body.innerHTML = '<p id="later">あとで</p>';
    expect(textOf(await call('wait_for', { selector: '#later', state: 'attached' }))).toBe('"#later" appeared (0 ms)');
    expect(textOf(await call('wait_for', { selector: '#gone', state: 'hidden' }))).toBe('"#gone" disappeared (0 ms)');
    expect(await call('wait_for', { selector: '#later', timeoutMs: 300 })).toEqual(textResult('"#later" did not appear within 300 ms.', true));
  });

  it('text: iframe の中も探し、その文字を持つ要素が見えれば出たとみなす。selector もあれば、要素が無いときだけ文字で探す', async () => {
    const { call, open } = setup();
    usePage(open('http://localhost:3000/'));
    const { doc } = addFrame('f', '<div><span id="toast">保存しました</span></div>');
    place(doc.getElementById('toast')!, { x: 0, y: 0, width: 80, height: 20 });
    expect(textOf(await call('wait_for', { text: '保存しました' }))).toBe('"保存しました" appeared (0 ms)');
    expect(textOf(await call('wait_for', { selector: '#none', text: '保存しました' }))).toBe('"#none" appeared (0 ms)');
    expect(await call('wait_for', { text: '失敗しました', timeoutMs: 0 })).toEqual(textResult('"失敗しました" did not appear within 0 ms.', true));
  });
});

describe('要素の HTML とスタイル（inspect）', () => {
  it('位置・見えているか・計算済みのスタイル・HTML（2000 文字まで）を読む。iframe の中のものは、そう添える', async () => {
    const { call, open } = setup();
    usePage(open('http://localhost:3000/'));
    document.body.innerHTML = `<button id="go" style="color: rgb(255, 0, 0)">送る</button><p class="long">${'あ'.repeat(2100)}</p>`;
    place(document.getElementById('go')!, { x: 10.4, y: 20.6, width: 100, height: 30 });
    const { doc } = addFrame('f', '<button id="hidden" style="display: none">隠れ</button>');
    place(doc.getElementById('hidden')!, { x: 0, y: 0, width: 10, height: 10 });
    expect(textOf(await call('inspect', { selector: '#go', properties: ['color'] }))).toBe(
      'Elements matching "#go": 1\n\n## Element 1 (visible, x=10 y=21 100×30)\n```html\n<button id="go" style="color: rgb(255, 0, 0)">送る</button>\n```\n- color: rgb(255, 0, 0)',
    );
    expect(textOf(await call('inspect', { selector: '#hidden', properties: ['display'] }))).toContain('## Element 1 (not visible, x=0 y=0 10×10, inside iframe (about:blank))');
    const long = textOf(await call('inspect', { selector: '.long', properties: ['color'] }));
    expect(long).toContain(`<p class="long">${'あ'.repeat(2000 - '<p class="long">'.length)}…\n\`\`\``);
    const bad = await call('inspect', { selector: '[[' });
    expect(textOf(bad)).toMatch(/^Invalid selector: /);
  });
});

describe('入力（type）の clear', () => {
  it('フォーカスのある欄の文字を全部選んでから消す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    usePage(page);
    document.body.innerHTML = '<input id="name" value="前の名前">';
    const input = document.getElementById('name') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(2, 2);
    expect(await call('type', { text: '新しい名前', clear: true })).toEqual(textResult('Typed into the focused element'));
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, '前の名前'.length]);
    expect(page.debugger.sent('Input.dispatchKeyEvent')[0].params).toMatchObject({ key: 'Backspace' });
    expect(page.debugger.sent('Input.insertText')[0].params).toEqual({ text: '新しい名前' });
  });
});
