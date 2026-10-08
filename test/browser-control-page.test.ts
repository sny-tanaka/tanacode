import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '../src/shared/ipc';
import { textResult } from '../src/main/mcp-bridge';
import { keySpec } from '../src/main/browser-control';
import { FakeImage, images } from './helpers/fake-electron';
import { addChildFrame, answerCdp, logConsole, setup, textOf } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// アプリ内ブラウザの操作（src/main/browser-control.ts）のうち、ページの中を読む・動かすツール。
// ページの中で動かすスクリプトと CDP は作り物が答え、送られたもの（CDP の命令・スクリプトに埋めた値・撮った範囲）と、Claude に返す文を確かめる

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  images.buffers.length = 0;
  images.fromBuffer = new FakeImage(800, 2000, 'fullPage');
});
afterEach(() => {
  vi.useRealTimers();
});

// locate（セレクタに当たる要素を探して見える位置まで動かす）の答え
const found = (rect: { x: number; y: number; width: number; height: number }, description = 'button#go「送る」', covered: string | null = null) => ({
  rect,
  viewport: { width: 800, height: 600 },
  description,
  covered,
});

// マウスとキーの CDP の命令を、確かめやすい形にする
const inputs = (page: ReturnType<ReturnType<typeof setup>['open']>): Record<string, unknown>[] =>
  page.debugger.commands
    .filter((c) => c.method.startsWith('Input.'))
    .map((c) => ({ method: c.method.replace('Input.', ''), ...c.params, ...(c.child ? { child: c.child } : {}) }));

describe('ページを読むツールの前に（今のページ）', () => {
  it('今のタブが空・許していない先なら、ページに触れずに断る（URL はオリジンだけ）', async () => {
    const { call, open } = setup();
    const page = open('about:blank');
    expect(await call('screenshot')).toEqual(textResult('今のタブは空です。navigate で開いてください', true));
    page.url = 'https://accounts.example.com/signin?continue=secret';
    for (const tool of ['screenshot', 'get_text', 'get_accessibility_tree', 'get_console_logs', 'click', 'evaluate']) {
      const result = await call(tool, { selector: '#a', expression: '1' });
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).toMatch(/^今のページ（https:\/\/accounts\.example\.com）は、Claude に許していない先です/);
      expect(textOf(result), tool).not.toContain('secret');
    }
    expect(page.scripts).toEqual([]);
    expect(page.captures).toEqual([]);
    expect(page.evaluated).toEqual([]);
    expect(page.debugger.commands).toEqual([]);
  });
});

describe('スクリーンショット', () => {
  it('見えている範囲: Retina で撮った画像は、ページの大きさ（CSS の px）に縮めて返す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.shot = new FakeImage(1600, 1200);
    page.page.viewport = () => ({ width: 800, height: 600, dpr: 2 });
    const result = await call('screenshot');
    expect(page.captures).toEqual([undefined]);
    expect(result.content).toEqual([
      { type: 'image', data: Buffer.from('shot（縮めた）:800x600').toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: '見えている範囲・http://localhost:3000/・画像 800×600' },
    ]);
  });

  it('長い辺は 1568px まで縮める。縮める必要がなければ、そのまま', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.shot = new FakeImage(4000, 1000);
    expect(textOf(await call('screenshot'))).toContain('画像 1568×392');
    page.shot = new FakeImage(1000, 4000);
    expect(textOf(await call('screenshot'))).toContain('画像 392×1568');
    page.shot = new FakeImage(800, 600);
    const same = await call('screenshot');
    expect(same.content[0]).toEqual({ type: 'image', data: Buffer.from('shot:800x600').toString('base64'), mimeType: 'image/png' });
  });

  it('selector: 要素のまわり 8px を、見えている範囲の中で切り出す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 100.5, y: 50, width: 200, height: 40 });
    expect(textOf(await call('screenshot', { selector: '#go' }))).toBe('#go（button#go「送る」）・http://localhost:3000/・画像 800×600');
    expect(page.captures).toEqual([{ x: 92, y: 42, width: 216, height: 56 }]);
    expect(page.scriptsOf('locate')[0]).toContain('__all("#go")');
    // 左上と右下の端では、見えている範囲で切る
    page.page.locate = () => found({ x: 2, y: 3, width: 10, height: 10 });
    await call('screenshot', { selector: '#corner' });
    expect(page.captures.at(-1)).toEqual({ x: 0, y: 0, width: 26, height: 26 });
    page.page.locate = () => found({ x: 780, y: 590, width: 50, height: 50 });
    await call('screenshot', { selector: '#edge' });
    expect(page.captures.at(-1)).toEqual({ x: 772, y: 582, width: 28, height: 18 });
  });

  it('selector の要素が見えている範囲の外（大きさ 0）なら撮らない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 900, y: 10, width: 20, height: 20 });
    expect(await call('screenshot', { selector: '#out' })).toEqual(textResult('「#out」は大きさが 0 で、撮れません', true));
    page.page.locate = () => found({ x: 10, y: 700, width: 20, height: 20 });
    expect(await call('screenshot', { selector: '#below' })).toEqual(textResult('「#below」は大きさが 0 で、撮れません', true));
    expect(page.captures).toEqual([]);
  });

  it('fullPage: CDP でページ全体を撮る。幅の 2.5 倍より長いページは、上から切ったことを伝える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    answerCdp(page, {
      'Page.getLayoutMetrics': () => ({ cssContentSize: { width: 800, height: 5000.4 }, cssLayoutViewport: { clientWidth: 800 } }),
      'Page.captureScreenshot': () => ({ data: Buffer.from('PNG の中身').toString('base64') }),
    });
    const result = await call('screenshot', { fullPage: true });
    expect(page.debugger.sent('Page.captureScreenshot')[0].params).toEqual({
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 800, height: 2000, scale: 1 },
    });
    expect(images.buffers.map((b) => b.toString())).toEqual(['PNG の中身']);
    expect(textOf(result)).toBe('ページの上から 2000px（全体の高さは 5001px。続きは scroll してから撮る）・http://localhost:3000/・画像 627×1568');
    expect(page.captures).toEqual([]);
    // CDP で撮ったものは、はじめからページの大きさなので、dpr を聞かない
    expect(page.scriptsOf('viewport')).toEqual([]);
  });

  it('fullPage: 短いページは全体を撮る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    images.fromBuffer = new FakeImage(800, 1200, 'fullPage');
    answerCdp(page, {
      'Page.getLayoutMetrics': () => ({ cssContentSize: { width: 800, height: 1200 }, cssLayoutViewport: { clientWidth: 800 } }),
      'Page.captureScreenshot': () => ({ data: '' }),
    });
    expect(textOf(await call('screenshot', { fullPage: true }))).toBe('ページ全体（800×1200）・http://localhost:3000/・画像 800×1200');
    expect(page.debugger.sent('Page.captureScreenshot')[0].params).toMatchObject({ clip: { height: 1200 } });
  });

  it('撮れなかった（空の画像）ときは、そう返す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.shot = new FakeImage(0, 0);
    expect(await call('screenshot')).toEqual(textResult('スクリーンショットを撮れませんでした（ページがまだ描かれていないかもしれません）', true));
  });
});

describe('ページの文字（get_text）', () => {
  it('ページ全体: 同じオリジンの iframe と、別プロセスの iframe（許す先のものだけ）の文字を、iframe ごとに分けて読む', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.text = () => ({
      title: 'トップ',
      url: 'http://localhost:3000/',
      parts: [
        { frame: null, text: '見出し\n\n\n\n本文\n' },
        { frame: 'http://localhost:3000/frame', text: '  中の文字  ' },
      ],
    });
    addChildFrame(page, 'C1');
    addChildFrame(page, 'C2');
    addChildFrame(page, 'C3');
    addChildFrame(page, 'C4');
    addChildFrame(page, 'C5');
    addChildFrame(page, 'GONE');
    page.debugger.message('Target.detachedFromTarget', { sessionId: 'GONE' });
    addChildFrame(page, 'W1', 'worker');
    page.debugger.message('Target.attachedToTarget', {});
    // 種類の分からないもの
    page.debugger.message('Target.attachedToTarget', { sessionId: 'NOINFO' });
    answerCdp(
      page,
      {
        'Runtime.evaluate': (_params, child) => {
          if (child === 'C1') return { result: { value: 'ウィジェットの文字' } };
          if (child === 'C3') throw new Error('iframe が応えません');
          if (child === 'C4') return { result: { value: 42 } };
          // C5 は result の無い答え
          return {};
        },
      },
      {
        C1: 'http://127.0.0.1:5173/widget',
        C2: 'https://ads.example.com/banner',
        C3: 'http://localhost:3000/slow',
        C4: 'http://localhost:3000/num',
        C5: 'http://localhost:3000/empty',
      },
    );
    expect(textOf(await call('get_text'))).toBe(
      [
        'タイトル: トップ',
        'URL: http://localhost:3000/',
        '',
        '見出し\n\n本文',
        '',
        '--- iframe（http://localhost:3000/frame）の中 ---',
        '中の文字',
        '',
        '--- iframe（http://127.0.0.1:5173/widget）の中 ---',
        'ウィジェットの文字',
      ].join('\n'),
    );
    // 許していない先の iframe・外れた iframe・iframe でないもの（worker）の中は読まない
    const asked = page.debugger.sent('Runtime.evaluate').map((c) => `${c.child}:${c.params?.expression === 'location.href' ? 'url' : 'text'}`);
    expect(asked).toEqual(['C1:url', 'C2:url', 'C3:url', 'C4:url', 'C5:url', 'C1:text', 'C3:text', 'C4:text', 'C5:text']);
    expect(page.debugger.sent('Runtime.evaluate').find((c) => c.child === 'C1' && c.params?.expression !== 'location.href')?.params).toEqual({
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
  });

  it('selector: その要素の中だけを読む（別プロセスの iframe は見ない）。当たらなければ断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.text = (code) =>
      code.includes('"#main"') ? { title: '', url: 'http://localhost:3000/', parts: [{ frame: 'http://localhost:3000/f', text: 'メイン' }] } : null;
    expect(textOf(await call('get_text', { selector: '#main' }))).toBe('タイトル: （なし）\nURL: http://localhost:3000/\n\n--- iframe（http://localhost:3000/f）の中 ---\nメイン');
    expect(page.debugger.commands).toEqual([]);
    expect(await call('get_text', { selector: '#none' })).toEqual(textResult('「#none」に当たる要素がありません', true));
  });

  it('長い文字は 20000 文字で切る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.text = () => ({ title: 'T', url: 'http://localhost:3000/', parts: [{ frame: null, text: 'あ'.repeat(25_000) }] });
    const text = textOf(await call('get_text', { selector: 'body' }));
    expect(text).toBe(`タイトル: T\nURL: http://localhost:3000/\n\n${'あ'.repeat(20_000)}\n…（5000 文字を省きました）`);
  });
});

describe('アクセシビリティのツリー', () => {
  const node = (nodeId: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({
    nodeId,
    ignored: false,
    role: { value: role },
    name: { value: name },
    ...extra,
  });

  it('役割と名前を字下げして並べる。中身の無い入れ物・無視するもの・文字の断片は飛ばし、状態と値を添える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    const top = [
      node('1', 'RootWebArea', 'トップ', { childIds: ['2', '3', '4', '8', '9'] }),
      node('2', 'generic', '', { parentId: '1', childIds: ['5'] }),
      node('5', 'button', '  送る \n ', {
        parentId: '2',
        properties: [
          { name: 'focused', value: { value: true } },
          { name: 'disabled', value: { value: false } },
          { name: 'level', value: { value: 2 } },
          { name: 'expanded', value: { value: 'true' } },
          { name: 'pressed', value: { value: 'false' } },
          { name: 'busy', value: { value: true } },
        ],
      }),
      { ...node('3', 'none', ''), parentId: '1', ignored: true, childIds: ['6'] },
      node('6', 'textbox', '名前', { parentId: '3', value: { value: 'たなか' }, childIds: ['7'] }),
      node('7', 'StaticText', 'たなか', { parentId: '6' }),
      node('4', 'checkbox', '同意', { parentId: '1', value: { value: '' }, properties: [{ name: 'checked', value: { value: 'mixed' } }] }),
      node('8', 'LineBreak', '', { parentId: '1' }),
      node('9', 'textbox', 'メモ', { parentId: '1', value: { value: 'x'.repeat(150) }, childIds: ['missing'] }),
    ];
    answerCdp(
      page,
      {
        'Page.getFrameTree': () => ({
          frameTree: {
            frame: { id: 'F0', url: 'http://localhost:3000/' },
            childFrames: [
              { frame: { id: 'F1', url: 'http://localhost:3000/ad' } },
              { frame: { id: 'F2', url: 'https://ads.example.com/' } },
              { frame: { id: 'F3', url: 'http://localhost:3000/broken' } },
            ],
          },
        }),
        'Accessibility.getFullAXTree': (params, child) => {
          if (child === 'C1') return { nodes: [node('w', 'heading', 'ウィジェット')] };
          if (child === 'C3') throw new Error('iframe が応えません');
          if (params?.frameId === 'F0') return { nodes: top };
          // ルートが分からないとき（どれも親がある）は、はじめのものから
          if (params?.frameId === 'F1') return { nodes: [node('a', 'link', '広告', { parentId: 'outside' })] };
          throw new Error('フレームがありません');
        },
      },
      { C1: 'http://127.0.0.1:5173/w', C2: 'https://ads.example.com/x', C3: 'http://localhost:3000/slow' },
    );
    addChildFrame(page, 'C1');
    addChildFrame(page, 'C2');
    addChildFrame(page, 'C3');
    expect(textOf(await call('get_accessibility_tree'))).toBe(
      [
        'URL: http://localhost:3000/',
        '- RootWebArea "トップ"',
        '  - button "送る" [focused, level=2, expanded]',
        '  - textbox "名前" 値="たなか"',
        '  - checkbox "同意" [checked=mixed]',
        `  - textbox "メモ" 値="${'x'.repeat(100)}"`,
        '--- iframe（http://localhost:3000/ad）の中 ---',
        '- link "広告"',
        '--- iframe（http://localhost:3000/broken）の中 ---',
        '--- iframe（http://127.0.0.1:5173/w）の中 ---',
        '- heading "ウィジェット"',
        '--- iframe（http://localhost:3000/slow）の中 ---',
      ].join('\n'),
    );
    // 許していない先の iframe（同じプロセス・別プロセスとも）のツリーは読まない
    expect(page.debugger.sent('Accessibility.getFullAXTree').map((c) => c.child ?? c.params?.frameId)).toEqual(['F0', 'F1', 'F3', 'C1', 'C3']);
  });

  it('1500 行で切る（そのあとのフレームは読まない）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    const ids = Array.from({ length: 1600 }, (_, i) => `b${i}`);
    answerCdp(
      page,
      {
        'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'F0', url: 'http://localhost:3000/' }, childFrames: [{ frame: { id: 'F1', url: 'http://localhost:3000/f' } }] } }),
        'Accessibility.getFullAXTree': () => ({ nodes: [node('root', 'RootWebArea', '', { childIds: ids }), ...ids.map((id) => node(id, 'button', id, { parentId: 'root' }))] }),
      },
      { C1: 'http://localhost:3000/c' },
    );
    addChildFrame(page, 'C1');
    const lines = textOf(await call('get_accessibility_tree')).split('\n');
    expect(lines).toHaveLength(1 + 1500 + 1);
    expect(lines[1]).toBe('- RootWebArea');
    expect(lines[1500]).toBe('  - button "b1498"');
    expect(lines.at(-1)).toBe('…（1500 行で切りました）');
    expect(page.debugger.sent('Accessibility.getFullAXTree')).toHaveLength(1);
  });

  it('ルートが並びの先頭でなくても、ルートから並べる。状態（selected・required・disabled など）と、名前の中の空白をまとめる', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    answerCdp(page, {
      'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'F0', url: 'http://localhost:3000/' } } }),
      'Accessibility.getFullAXTree': () => ({
        nodes: [
          node('2', 'none', '', { parentId: '1', childIds: ['3', '4'] }),
          node('3', 'InlineTextBox', '', { parentId: '2' }),
          node('4', 'option', 'お問い\n合わせ  フォーム', {
            parentId: '2',
            properties: [
              { name: 'selected', value: { value: true } },
              { name: 'required', value: { value: 'true' } },
              { name: 'disabled', value: { value: true } },
              { name: 'invalid', value: { value: 'spelling' } },
              { name: 'checked', value: { value: 'false' } },
            ],
          }),
          node('1', 'listbox', '問い合わせの種類', { childIds: ['2'] }),
        ],
      }),
    });
    expect(textOf(await call('get_accessibility_tree'))).toBe(
      ['URL: http://localhost:3000/', '- listbox "問い合わせの種類"', '  - option "お問い 合わせ フォーム" [selected, required, disabled, invalid=spelling]'].join('\n'),
    );
  });

  it('名前は 200 文字まで', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    answerCdp(page, {
      'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'F0', url: 'http://localhost:3000/' } } }),
      'Accessibility.getFullAXTree': () => ({ nodes: [{ nodeId: '1', ignored: false, role: { value: 'paragraph' }, name: { value: 'あ'.repeat(300) } }] }),
    });
    expect(textOf(await call('get_accessibility_tree')).split('\n')[1]).toBe(`- paragraph "${'あ'.repeat(200)}"`);
  });

  it('役割や名前が無いもの', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    answerCdp(page, {
      'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'F0', url: 'http://localhost:3000/' } } }),
      'Accessibility.getFullAXTree': () => ({ nodes: [{ nodeId: '1', ignored: false, childIds: ['2'] }, { nodeId: '2', parentId: '1', ignored: false, role: { value: 'img' } }] }),
    });
    expect(textOf(await call('get_accessibility_tree'))).toBe('URL: http://localhost:3000/\n- \n  - img');
  });
});

describe('要素の HTML とスタイル（inspect）', () => {
  it('当たった要素（10 個まで）の HTML・位置・見えているか・スタイルを並べ、残りの数を添える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.inspect = () => ({
      total: 12,
      items: [
        { html: '<button id="go">送る</button>', rect: { x: 10, y: 20, width: 100, height: 30 }, visible: true, frame: null, styles: { color: 'rgb(0, 0, 0)', 'margin-top': '4px' } },
        { html: '<button hidden></button>', rect: { x: 0, y: 0, width: 0, height: 0 }, visible: false, frame: 'http://localhost:3000/f', styles: { color: 'red', 'margin-top': '0px' } },
      ],
    });
    expect(textOf(await call('inspect', { selector: 'button', properties: ['color', 7, 'margin-top'] }))).toBe(
      [
        '「button」に当たる要素: 12 個',
        '',
        '## 1 つ目（見えている・x=10 y=20 100×30）',
        '```html',
        '<button id="go">送る</button>',
        '```',
        '- color: rgb(0, 0, 0)',
        '- margin-top: 4px',
        '',
        '## 2 つ目（見えていない・x=0 y=0 0×0・iframe（http://localhost:3000/f）の中）',
        '```html',
        '<button hidden></button>',
        '```',
        '- color: red',
        '- margin-top: 0px',
        '',
        '（ほかに 10 個あります）',
      ].join('\n'),
    );
    const code = page.scriptsOf('inspect')[0];
    expect(code).toContain('const props = ["color","margin-top"];');
    expect(code).toContain('__all("button")');
  });

  it('properties を省く・空なら、よく使うスタイルを読む。全部見せたら残りの数は添えない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.inspect = () => ({ total: 1, items: [{ html: '<p></p>', rect: { x: 1, y: 2, width: 3, height: 4 }, visible: true, frame: null, styles: {} }] });
    expect(textOf(await call('inspect', { selector: 'p' }))).toBe('「p」に当たる要素: 1 個\n\n## 1 つ目（見えている・x=1 y=2 3×4）\n```html\n<p></p>\n```');
    await call('inspect', { selector: 'p', properties: [] });
    const defaults = [
      'display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'border', 'border-radius',
      'color', 'background-color', 'background-image', 'opacity', 'font-family', 'font-size', 'font-weight', 'line-height',
      'text-align', 'overflow', 'z-index', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'visibility',
    ];
    for (const code of page.scriptsOf('inspect')) expect(code).toContain(`const props = ${JSON.stringify(defaults)};`);
  });

  it('当たらない・セレクタの書き方が違う・selector が無いときは断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.inspect = (code) =>
      code.includes('"[["') ? { error: "セレクタの書き方が違います: '[[' is not a valid selector" } : { total: 0, items: [] };
    expect(await call('inspect', { selector: '.none' })).toEqual(textResult('「.none」に当たる要素がありません', true));
    expect(await call('inspect', { selector: '[[' })).toEqual(textResult("セレクタの書き方が違います: '[[' is not a valid selector", true));
    expect(await call('inspect', {})).toEqual(textResult('selector を渡してください', true));
    expect(page.scriptsOf('inspect')).toHaveLength(2);
  });
});

describe('クリック', () => {
  it('selector: 枠を出してから、要素の真ん中を CDP で押す。CDP は最初の 1 回だけつなぐ', async () => {
    const { call, open, activities } = setup();
    const page = open('http://localhost:3000/');
    const rect = { x: 100, y: 50, width: 201, height: 40 };
    page.page.locate = () => found(rect);
    expect(await call('click', { selector: '#go' })).toEqual(textResult('クリックしました: button#go「送る」'));
    expect(page.debugger.attachCount).toBe(1);
    expect(page.debugger.versions).toEqual(['1.3']);
    expect(page.debugger.commands[0]).toEqual({ method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child: undefined });
    expect(inputs(page)).toEqual([
      { method: 'dispatchMouseEvent', type: 'mouseMoved', x: 201, y: 70 },
      { method: 'dispatchMouseEvent', type: 'mousePressed', x: 201, y: 70, button: 'left', clickCount: 1 },
      { method: 'dispatchMouseEvent', type: 'mouseReleased', x: 201, y: 70, button: 'left', clickCount: 1 },
    ]);
    expect(activities()).toEqual([
      { sessionId: 'S1', active: true, label: 'クリック', box: null },
      { sessionId: 'S1', active: true, label: null, box: rect },
      { sessionId: 'S1', active: true, label: null, box: null },
    ]);
    await call('click', { selector: '#go' });
    expect(page.debugger.attachCount).toBe(1);
    expect(page.debugger.sent('Target.setAutoAttach')).toHaveLength(1);
  });

  it('double はダブルクリック。right・middle はそのボタン、知らないボタンは left', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 });
    expect(textOf(await call('click', { selector: '#a', double: true, button: 'right' }))).toBe('ダブルクリックしました: button#go「送る」');
    expect(inputs(page).map((i) => `${String(i.type)}:${String(i.button)}:${String(i.clickCount)}`)).toEqual([
      'mouseMoved:undefined:undefined',
      'mousePressed:right:1',
      'mouseReleased:right:1',
      'mousePressed:right:2',
      'mouseReleased:right:2',
    ]);
    page.debugger.commands.length = 0;
    await call('click', { selector: '#a', button: 'middle' });
    expect(inputs(page)[1]).toMatchObject({ type: 'mousePressed', button: 'middle' });
    page.debugger.commands.length = 0;
    await call('click', { selector: '#a', button: 'back' });
    expect(inputs(page)[1]).toMatchObject({ type: 'mousePressed', button: 'left' });
  });

  it('要素が無い・見えていない・セレクタの書き方が違うときは押さない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => ({ error: 'none' });
    expect(await call('click', { selector: '#a' })).toEqual(textResult('「#a」に当たる要素がありません', true));
    page.page.locate = () => ({ error: 'hidden', count: 3 });
    expect(await call('click', { selector: '.item' })).toEqual(textResult('「.item」に当たる要素（3 個）は、どれも見えていません', true));
    page.page.locate = () => ({ error: "セレクタの書き方が違います: '##' is not a valid selector" });
    expect(await call('click', { selector: '##' })).toEqual(textResult("セレクタの書き方が違います: '##' is not a valid selector", true));
    expect(inputs(page)).toEqual([]);
  });

  it('押した位置にほかの要素が重なっていたら、そう添える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'button#go', 'div.overlay');
    expect(textOf(await call('click', { selector: '#go' }))).toBe('クリックしました: button#go\n（押した位置には、ほかの要素 div.overlay が重なっていました）');
  });

  it('押してページが移ったら、読み込みが終わるのを待って、移った先を添える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'a#next');
    page.debugger.handler = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        page.url = 'http://localhost:3000/next';
        page.loadingPolls = 4;
      }
      return {};
    };
    expect(textOf(await call('click', { selector: '#next' }))).toBe('クリックしました: a#next\nページが移りました: http://localhost:3000/next');
    expect(page.loadingPolls).toBe(0);
  });

  it('押してページが許していない先へ移ったら、これ以上は読めないことを添える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'button#back');
    page.debugger.handler = (method, params) => {
      // 履歴を戻るページのボタン（history.back）は、移る前に止められない
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') page.url = 'https://accounts.example.com/';
      return {};
    };
    expect(textOf(await call('click', { selector: '#back' }))).toContain('（Claude に許していない先なので、これ以上は読めず、操作もできません）');
  });

  it('x・y: その位置の要素を押す（枠はその位置のまわり 20px）', async () => {
    const { call, open, activities } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'canvas#board' });
    expect(textOf(await call('click', { x: 120, y: 80 }))).toBe('クリックしました: x=120 y=80 の canvas#board');
    expect(page.scriptsOf('point')[0]).toContain('const x = 120, y = 80;');
    expect(inputs(page)[1]).toEqual({ method: 'dispatchMouseEvent', type: 'mousePressed', x: 120, y: 80, button: 'left', clickCount: 1 });
    expect(activities()[1].box).toEqual({ x: 110, y: 70, width: 20, height: 20 });
  });

  it('selector も x・y も無い・x・y が有限の数でないときは断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    for (const args of [{}, { x: 1 }, { x: '1', y: 2 }, { x: Number.NaN, y: 2 }, { x: 1, y: Number.POSITIVE_INFINITY }, { selector: '  ' }]) {
      expect(await call('click', args), JSON.stringify(args)).toEqual(textResult('selector か、x と y を渡してください', true));
    }
    expect(page.scripts).toEqual([]);
  });

  it('x・y が見えている範囲の外・要素が無いときは断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ error: 'outside', width: 800, height: 600 });
    expect(await call('click', { x: 900, y: 10 })).toEqual(textResult('x=900 y=10 は、見えている範囲（800×600）の外です', true));
    page.page.point = () => ({ error: 'none' });
    expect(await call('click', { x: 5, y: 5 })).toEqual(textResult('x=5 y=5 には要素がありません', true));
    expect(inputs(page)).toEqual([]);
  });

  it('別オリジンの iframe（許す先）の中: 別プロセスで動いていれば、その iframe のセッションに、iframe の中の位置で送る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: true, src: 'http://127.0.0.1:5173/widget', frame: { x: 300, y: 200 }, description: 'iframe#w' });
    answerCdp(page, {}, { C9: 'http://localhost:4000/other', C1: 'http://127.0.0.1:5173/widget/page' });
    addChildFrame(page, 'C9');
    addChildFrame(page, 'C1');
    expect(textOf(await call('click', { x: 350, y: 260 }))).toBe('クリックしました: x=350 y=260（別オリジンの iframe http://127.0.0.1:5173/widget/page の中）');
    expect(inputs(page)).toEqual([
      { method: 'dispatchMouseEvent', type: 'mouseMoved', x: 50, y: 60, child: 'C1' },
      { method: 'dispatchMouseEvent', type: 'mousePressed', x: 50, y: 60, button: 'left', clickCount: 1, child: 'C1' },
      { method: 'dispatchMouseEvent', type: 'mouseReleased', x: 50, y: 60, button: 'left', clickCount: 1, child: 'C1' },
    ]);
  });

  it('別オリジンの iframe（許す先）が同じプロセスなら、ページに送る。iframe の位置が分からないときも', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: true, src: 'http://127.0.0.1:5173/widget', frame: { x: 300, y: 200 }, description: 'iframe#w' });
    expect(textOf(await call('click', { x: 350, y: 260 }))).toBe('クリックしました: x=350 y=260（別オリジンの iframe http://127.0.0.1:5173/widget の中）');
    expect(inputs(page)[0]).toEqual({ method: 'dispatchMouseEvent', type: 'mouseMoved', x: 350, y: 260 });
    page.debugger.commands.length = 0;
    page.page.point = () => ({ cross: true, src: 'http://127.0.0.1:5173/widget', frame: null, description: 'iframe#w' });
    answerCdp(page, {}, { C1: 'http://127.0.0.1:5173/widget' });
    addChildFrame(page, 'C1');
    await call('click', { x: 350, y: 260 });
    expect(inputs(page)[0]).toEqual({ method: 'dispatchMouseEvent', type: 'mouseMoved', x: 350, y: 260 });
  });

  it('許していない先の iframe・src の無い iframe の中は押さない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: true, src: 'https://pay.example.com/checkout', frame: { x: 0, y: 0 }, description: 'iframe#pay' });
    const refused = await call('click', { x: 10, y: 10 });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^x=10 y=10 は、許していない先の iframe（https:\/\/pay\.example\.com.*）の中なので、押せません$/);
    page.page.point = () => ({ cross: true, src: null, frame: null, description: 'iframe' });
    expect(await call('click', { x: 10, y: 10 })).toEqual(textResult('x=10 y=10 は、許していない先の iframe（src なし）の中なので、押せません', true));
    // src が URL として読めなければ、別プロセスの iframe を探さない
    page.page.point = () => ({ cross: true, src: 'widget.html', frame: null, description: 'iframe' });
    expect(await call('click', { x: 10, y: 10 })).toEqual(textResult('x=10 y=10 は、許していない先の iframe（widget.html）の中なので、押せません', true));
    expect(page.debugger.sent('Target.getTargets')).toHaveLength(1);
    expect(inputs(page)).toEqual([]);
  });
});

describe('入力（type）', () => {
  it('selector: 欄を押してから文字を入れる。submit で最後に Enter も押す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 10, y: 20, width: 100, height: 20 }, 'input#name');
    expect(await call('type', { selector: '#name', text: 'たなか', submit: true })).toEqual(textResult('input#nameに入力しました（Enter も押しました）'));
    expect(inputs(page)).toEqual([
      { method: 'dispatchMouseEvent', type: 'mousePressed', x: 60, y: 30, button: 'left', clickCount: 1 },
      { method: 'dispatchMouseEvent', type: 'mouseReleased', x: 60, y: 30, button: 'left', clickCount: 1 },
      { method: 'insertText', text: 'たなか' },
      { method: 'dispatchKeyEvent', type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0, text: '\r', unmodifiedText: '\r' },
      { method: 'dispatchKeyEvent', type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 },
    ]);
  });

  it('selector が無ければ、今フォーカスのある場所に入れる。文字が空なら入れない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('type', { text: 'abc' })).toEqual(textResult('今フォーカスのある場所に入力しました'));
    expect(inputs(page)).toEqual([{ method: 'insertText', text: 'abc' }]);
    page.debugger.commands.length = 0;
    expect(await call('type', { text: 123 })).toEqual(textResult('今フォーカスのある場所に入力しました'));
    expect(inputs(page)).toEqual([]);
  });

  it('clear: 欄の文字を全部選んで、Backspace で消してから入れる', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.clear = () => undefined;
    await call('type', { text: '新しい', clear: true });
    expect(page.scriptsOf('clear')).toHaveLength(1);
    expect(inputs(page).map((i) => `${i.method}:${String(i.type ?? i.text)}:${String(i.key ?? '')}`)).toEqual([
      'dispatchKeyEvent:rawKeyDown:Backspace',
      'dispatchKeyEvent:keyUp:Backspace',
      'insertText:新しい:',
    ]);
  });

  it('フォーカスが別オリジンの iframe（許す先・別プロセス）の中なら、消すのも入れるのも、その iframe のセッションに送る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.focus = () => 'http://127.0.0.1:5173/form';
    answerCdp(page, {}, { C1: 'http://127.0.0.1:5173/form?step=2' });
    addChildFrame(page, 'C1');
    await call('type', { text: 'abc', clear: true, submit: true });
    expect(page.scriptsOf('clear')).toEqual([]);
    const select = page.debugger.sent('Runtime.evaluate').find((c) => c.params?.expression !== 'location.href');
    expect(select?.child).toBe('C1');
    expect(String(select?.params?.expression)).toContain('selectAllChildren');
    expect(inputs(page).map((i) => `${String(i.type ?? i.method)}:${String(i.key ?? i.text)}:${String(i.child)}`)).toEqual([
      'rawKeyDown:Backspace:C1',
      'keyUp:Backspace:C1',
      'insertText:abc:C1',
      'keyDown:Enter:C1',
      'keyUp:Enter:C1',
    ]);
  });

  it('フォーカスが別オリジンの iframe（許す先）でも、同じプロセスならページに送る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.focus = () => 'http://127.0.0.1:5173/form';
    await call('type', { text: 'abc' });
    expect(inputs(page)).toEqual([{ method: 'insertText', text: 'abc' }]);
  });

  it('フォーカスが許していない先の iframe の中なら、入力しない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.focus = () => 'https://pay.example.com/card';
    const refused = await call('type', { text: '4242' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^フォーカスが、許していない先の iframe（https:\/\/pay\.example\.com.*）の中にあるので、入力できません$/);
    expect(inputs(page)).toEqual([]);
  });
});

describe('キー（press_key）', () => {
  it('キーと一緒に押すキーを CDP で送る。Shift なら文字も入れる', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('press_key', { key: 'Enter', modifiers: ['shift'] })).toEqual(textResult('shift+Enter を押しました'));
    expect(inputs(page)).toEqual([
      { method: 'dispatchKeyEvent', type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8, text: '\r', unmodifiedText: '\r' },
      { method: 'dispatchKeyEvent', type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 },
    ]);
  });

  it('Ctrl・⌘ と一緒なら文字を入れない（rawKeyDown）。知らない修飾キーは数えない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(textOf(await call('press_key', { key: 'a', modifiers: ['control', 'meta', 'hyper', 3] }))).toBe('control+meta+hyper+a を押しました');
    expect(inputs(page)[0]).toEqual({ method: 'dispatchKeyEvent', type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 6 });
    page.debugger.commands.length = 0;
    await call('press_key', { key: 'a', modifiers: ['alt'] });
    expect(inputs(page)[0]).toMatchObject({ type: 'keyDown', modifiers: 1, text: 'a' });
    page.debugger.commands.length = 0;
    await call('press_key', { key: 'Tab', modifiers: 'shift' });
    expect(inputs(page)[0]).toMatchObject({ type: 'rawKeyDown', key: 'Tab', modifiers: 0 });
  });

  it('フォーカスが別プロセスの iframe（許す先）の中なら、その iframe に送る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.focus = () => 'http://127.0.0.1:5173/form';
    answerCdp(page, {}, { C1: 'http://127.0.0.1:5173/form' });
    addChildFrame(page, 'C1');
    await call('press_key', { key: 'Escape' });
    expect(inputs(page).map((i) => i.child)).toEqual(['C1', 'C1']);
  });

  it('知らないキー・key が無いときは押さない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('press_key', { key: 'Hyper' })).toEqual(textResult('知らないキーです: Hyper', true));
    expect(await call('press_key', {})).toEqual(textResult('key を渡してください', true));
    expect(inputs(page)).toEqual([]);
  });

  it('keySpec: 名前の付いたキーは、ページに届く key・code・キーコードにする', () => {
    const named = ['Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    expect(named.map((name) => keySpec(name))).toEqual([
      { key: 'Tab', code: 'Tab', keyCode: 9 },
      { key: 'Escape', code: 'Escape', keyCode: 27 },
      { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      { key: 'Delete', code: 'Delete', keyCode: 46 },
      { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      { key: 'Home', code: 'Home', keyCode: 36 },
      { key: 'End', code: 'End', keyCode: 35 },
      { key: 'PageUp', code: 'PageUp', keyCode: 33 },
      { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    ]);
    // 短い名前
    expect(['enter', 'esc', 'up', 'down', 'left', 'right'].map((name) => keySpec(name))).toEqual([
      { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
      { key: 'Escape', code: 'Escape', keyCode: 27 },
      { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    ]);
  });

  it('keySpec: 名前の付いたキー（大文字小文字を問わない）・F1〜F12・英字・数字・記号', () => {
    expect(keySpec('ESC')).toEqual({ key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(keySpec('return')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(keySpec('Space')).toEqual({ key: ' ', code: 'Space', keyCode: 32, text: ' ' });
    expect(keySpec('down')).toEqual({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 });
    expect(keySpec('PageUp')).toEqual({ key: 'PageUp', code: 'PageUp', keyCode: 33 });
    expect(keySpec('f1')).toEqual({ key: 'F1', code: 'F1', keyCode: 112 });
    expect(keySpec('F12')).toEqual({ key: 'F12', code: 'F12', keyCode: 123 });
    expect(keySpec('F13')).toBeNull();
    expect(keySpec('F0')).toBeNull();
    expect(keySpec('xf1')).toBeNull();
    expect(keySpec('a')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
    expect(keySpec('Z')).toEqual({ key: 'Z', code: 'KeyZ', keyCode: 90, text: 'Z' });
    expect(keySpec('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55, text: '7' });
    expect(keySpec('!')).toEqual({ key: '!', code: '', keyCode: 0, text: '!' });
    expect(keySpec('😀')).toEqual({ key: '😀', code: '', keyCode: 0, text: '😀' });
    expect(keySpec('ab')).toBeNull();
    expect(keySpec('')).toBeNull();
  });
});

describe('スクロール', () => {
  it('selector か deltaX・deltaY が無ければ断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('scroll', {})).toEqual(textResult('selector か deltaX・deltaY を渡してください', true));
    expect(await call('scroll', { deltaY: 0, deltaX: '10' })).toEqual(textResult('selector か deltaX・deltaY を渡してください', true));
    expect(page.scripts).toEqual([]);
  });

  it('selector: その要素が見える位置まで動かし、動いた入れ物と位置を返す。当たらなければ断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.scroll = (code) => (code.includes('"#footer"') ? { x: 0, y: 640, where: 'ページ' } : null);
    expect(await call('scroll', { selector: '#footer' })).toEqual(textResult('スクロールしました（ページの位置: x=0 y=640）'));
    const code = page.scriptsOf('scroll')[0];
    expect(code).toContain("target.scrollIntoView({ block: 'center', inline: 'nearest' });");
    expect(code).toContain('const dx = 0, dy = 0;');
    expect(await call('scroll', { selector: '#none' })).toEqual(textResult('「#none」に当たる要素がありません', true));
  });

  it('deltaX・deltaY: その分だけ動かす（数でないものは 0）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.scroll = () => ({ x: 0, y: 300, where: '中の入れ物' });
    expect(await call('scroll', { deltaY: 300, deltaX: 'x' })).toEqual(textResult('スクロールしました（中の入れ物の位置: x=0 y=300）'));
    const code = page.scriptsOf('scroll')[0];
    expect(code).toContain('const target = null;');
    expect(code).toContain('const dx = 0, dy = 300;');
    expect(code).not.toContain('scrollIntoView');
  });
});

describe('待つ（wait_for）', () => {
  it('selector か text が無ければ断る', async () => {
    const { call, open } = setup();
    open('http://localhost:3000/');
    expect(await call('wait_for', { state: 'hidden' })).toEqual(textResult('selector か text を渡してください', true));
  });

  it('出るまで 150ms ごとに確かめ、出たら待った時間を返す。確かめるスクリプトの失敗は「まだ」とみなす', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    const answers: (() => boolean)[] = [
      () => false,
      () => {
        throw new Error('ページを移っている途中です');
      },
      () => true,
    ];
    page.page.wait = () => answers.shift()!();
    expect(await call('wait_for', { selector: '#done' })).toEqual(textResult('「#done」が出ました（300 ms）'));
    const code = page.scriptsOf('wait')[0];
    expect(code).toContain('const state = "visible";');
    expect(code).toContain('el = (__all("#done")[0] || {}).el || null;');
    expect(code).not.toContain('const want');
  });

  it('hidden: 消えるまで待つ。text: ページに出る文字で待つ（selector もあれば、要素が無いときだけ文字で探す）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.wait = () => true;
    expect(textOf(await call('wait_for', { selector: '#spinner', state: 'hidden' }))).toMatch(/^「#spinner」が消えました（\d+ ms）$/);
    expect(page.scriptsOf('wait')[0]).toContain('const state = "hidden";');
    expect(textOf(await call('wait_for', { text: '保存しました' }))).toMatch(/^「保存しました」が出ました/);
    const textOnly = page.scriptsOf('wait')[1];
    expect(textOnly).toContain('if (!false) {');
    expect(textOnly).toContain('const want = "保存しました";');
    await call('wait_for', { selector: '#toast', text: '保存しました', state: 'attached' });
    const both = page.scriptsOf('wait')[2];
    expect(both).toContain('if (!el) {');
    expect(both).toContain('const state = "attached";');
  });

  it('上限まで待っても出なければ断る。上限は 30 秒まで・0 より小さければ 0・数でなければ 10 秒', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.wait = () => false;
    const waited = async (args: Record<string, unknown>) => {
      const started = Date.now();
      const result = await call('wait_for', args);
      return { text: textOf(result), error: result.isError, ms: Date.now() - started };
    };
    const short = await waited({ selector: '#never', timeoutMs: 1000 });
    expect(short).toMatchObject({ text: '1000 ms 待っても、「#never」が出ませんでした', error: true });
    expect(short.ms).toBeGreaterThan(1000);
    expect(short.ms).toBeLessThan(1300);
    expect((await waited({ text: 'まだ', state: 'hidden', timeoutMs: 1000 })).text).toBe('1000 ms 待っても、「まだ」が消えませんでした');
    const long = await waited({ selector: '#never', timeoutMs: 99_999 });
    expect(long.text).toBe('30000 ms 待っても、「#never」が出ませんでした');
    expect(long.ms).toBeLessThan(31_000);
    expect((await waited({ selector: '#never', timeoutMs: -5 })).text).toBe('0 ms 待っても、「#never」が出ませんでした');
    const fallback = await waited({ selector: '#never', timeoutMs: '5' });
    expect(fallback.text).toBe('10000 ms 待っても、「#never」が出ませんでした');
    expect((await waited({ selector: '#never', timeoutMs: Number.NaN })).text).toBe('10000 ms 待っても、「#never」が出ませんでした');
    expect(fallback.ms).toBeGreaterThan(10_000);
    expect(fallback.ms).toBeLessThan(10_500);
  });
});

describe('表示幅（set_viewport）', () => {
  it('画面に幅を送り、描き直したあとのページの大きさを返す', async () => {
    const { call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    page.page.viewport = () => ({ width: 390, height: 844, dpr: 3 });
    expect(await call('set_viewport', { width: 'mobile' })).toEqual(textResult('表示幅を mobile にしました（ページの幅 390px・高さ 844px）'));
    await call('set_viewport', { width: 'tablet' });
    await call('set_viewport', { width: 'full' });
    expect(sentOn(IpcChannel.BrowserViewport)).toEqual([
      { sessionId: 'S1', width: 390 },
      { sessionId: 'S1', width: 768 },
      { sessionId: 'S1', width: 0 },
    ]);
  });

  it('知らない幅・幅が無いときは、画面に送らない', async () => {
    const { call, open, sentOn } = setup();
    open('http://localhost:3000/');
    expect(await call('set_viewport', { width: 'desktop' })).toEqual(textResult('表示幅は full・mobile・tablet のどれかです: desktop', true));
    expect(await call('set_viewport', {})).toEqual(textResult('width を渡してください', true));
    expect(sentOn(IpcChannel.BrowserViewport)).toEqual([]);
  });
});

describe('JavaScript の実行（evaluate）', () => {
  it('最後の式の値を JSON にして返す。JSON にならないものは文字にする', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    const values: unknown[] = [];
    page.evaluate = () => values.shift();
    const run = async (value: unknown) => {
      values.push(value);
      return textOf(await call('evaluate', { expression: 'document.title' }));
    };
    expect(await run({ a: 1, b: [true, null] })).toBe('{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
    expect(await run(undefined)).toBe('undefined');
    expect(await run('文字')).toBe('"文字"');
    expect(await run(Symbol('しるし'))).toBe('Symbol(しるし)');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(await run(loop)).toBe('[object Object]');
    expect(await run(10n)).toBe('10');
    expect(await run('x'.repeat(25_000))).toBe(`"${'x'.repeat(19_999)}\n…（5002 文字を省きました）`);
    expect(page.evaluated).toEqual(Array(7).fill('document.title'));
  });

  it('失敗したら、そのときコンソールに出たエラーを返す（前から出ていたもの・エラーでないものは含めない）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    logConsole(page, 'error', '前からあったエラー');
    page.evaluate = () => {
      logConsole(page, 'warning', 'ついでの警告');
      logConsole(page, 'error', "Uncaught TypeError: Cannot read properties of null (reading 'click')");
      logConsole(page, 'error', 'Uncaught (in promise) だめ');
      throw new Error('Script failed to execute');
    };
    expect(await call('evaluate', { expression: "document.querySelector('#x').click()" })).toEqual(
      textResult("実行に失敗しました: Uncaught TypeError: Cannot read properties of null (reading 'click')\nUncaught (in promise) だめ", true),
    );
    page.evaluate = () => {
      throw new Error('Script failed to execute');
    };
    expect(await call('evaluate', { expression: 'x' })).toEqual(textResult('実行に失敗しました: Script failed to execute', true));
    page.evaluate = () => Promise.reject('こわれた');
    expect(await call('evaluate', { expression: 'x' })).toEqual(textResult('実行に失敗しました: こわれた', true));
    expect(await call('evaluate', {})).toEqual(textResult('expression を渡してください', true));
  });
});

describe('CDP のつなぎ方', () => {
  it('つなげなければ、理由を返す（Error でないものも）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.debugger.attachError = new Error('Another debugger is already attached to the target');
    expect(await call('get_accessibility_tree')).toEqual(
      textResult('ページを操作する準備ができませんでした（Another debugger is already attached to the target）', true),
    );
    page.debugger.attachError = 'だめ';
    expect(await call('get_accessibility_tree')).toEqual(textResult('ページを操作する準備ができませんでした（だめ）', true));
    expect(page.debugger.commands).toEqual([]);
  });

  it('attach に失敗しても、もうつながっていれば続ける。別プロセスの iframe につなぐ設定は、つないだときだけ送る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.debugger.attached = true;
    page.debugger.attachError = new Error('Another debugger is already attached to the target');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 });
    page.debugger.handler = (method) => {
      if (method === 'Target.setAutoAttach') throw new Error('使えない命令です');
      return {};
    };
    expect(textOf(await call('click', { selector: '#go' }))).toBe('クリックしました: button#go「送る」');
    expect(page.debugger.sent('Target.setAutoAttach')).toHaveLength(1);
    await call('click', { selector: '#go' });
    expect(page.debugger.sent('Target.setAutoAttach')).toHaveLength(1);
  });

  it('CDP が外れたら（DevTools を開いたなど）、次の操作でつなぎ直し、別プロセスの iframe も数え直す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.text = () => ({ title: 'T', url: 'http://localhost:3000/', parts: [{ frame: null, text: '本文' }] });
    answerCdp(page, { 'Runtime.evaluate': () => ({ result: { value: '中' } }) }, { C1: 'http://localhost:3000/frame' });
    addChildFrame(page, 'C1');
    expect(textOf(await call('get_text'))).toContain('--- iframe（http://localhost:3000/frame）の中 ---\n中');
    page.debugger.detachNow();
    page.debugger.commands.length = 0;
    expect(textOf(await call('get_text'))).toBe('タイトル: T\nURL: http://localhost:3000/\n\n本文');
    expect(page.debugger.attachCount).toBe(2);
    expect(page.debugger.commands.map((c) => c.method)).toEqual(['Target.setAutoAttach', 'Target.getTargets']);
  });

  it('別プロセスの iframe の今の URL が読めなければ、その iframe は数えない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.text = () => ({ title: 'T', url: 'http://localhost:3000/', parts: [{ frame: null, text: '本文' }] });
    page.debugger.handler = (method, params, child) => {
      if (method === 'Target.getTargets') throw new Error('使えない命令です');
      if (child === 'C1' && params?.expression === 'location.href') return { result: { value: undefined } };
      if (child === 'C2' && params?.expression === 'location.href') return null;
      if (child === 'C3' && params?.expression === 'location.href') throw new Error('iframe が応えません');
      if (child === 'C4' && params?.expression === 'location.href') return {};
      return { result: { value: '読んではいけない' } };
    };
    addChildFrame(page, 'C1');
    addChildFrame(page, 'C2');
    addChildFrame(page, 'C3');
    addChildFrame(page, 'C4');
    expect(textOf(await call('get_text'))).toBe('タイトル: T\nURL: http://localhost:3000/\n\n本文');
    expect(page.debugger.sent('Runtime.evaluate').map((c) => c.child)).toEqual(['C1', 'C2', 'C3', 'C4']);
  });
});
