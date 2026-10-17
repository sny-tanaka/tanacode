import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserToolId } from '../src/shared/browser-tools';
import { IpcChannel } from '../src/shared/ipc';
import { BROWSER_GATE_REQUEST } from '../src/main/browser-bridge';
import { textResult } from '../src/main/mcp-bridge';
import { keySpec } from '../src/main/browser-control';
import { FakeImage, HOST, images } from './helpers/fake-electron';
import { addChildFrame, answerCdp, logConsole, setup, textOf } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// アプリ内ブラウザの操作（src/main/browser-control.ts）のうち、ページの中を読む・動かすツール。
// ページの中で動かすスクリプトと CDP は作り物が答え、送られたもの（CDP の命令・スクリプトに埋めた値・撮った範囲）と、Claude に返す文を確かめる

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  images.buffers.length = 0;
  images.fromBuffer = new FakeImage(800, 2000, 'fullPage');
  HOST.backgroundThrottling = true;
  HOST.throttling.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

// locate（セレクタに当たる要素を探して見える位置まで動かす）の答え
const found = (rect: { x: number; y: number; width: number; height: number }, description = 'button#go "送る"', covered: string | null = null) => ({
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
    expect(await call('screenshot')).toEqual(textResult('The current tab is empty. Open a page with navigate.', true));
    page.url = 'https://accounts.example.com/signin?continue=secret';
    for (const tool of ['screenshot', 'get_text', 'get_accessibility_tree', 'get_console_logs', 'click', 'evaluate']) {
      const result = await call(tool, { selector: '#a', expression: '1' });
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).toMatch(/^The current page \(https:\/\/accounts\.example\.com\) is not allowed for Claude: it is outside the hosts the user allowed for Claude .*To use it, open it with navigate \(tanacode asks the user for permission\)\.$/);
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
      { type: 'text', text: 'Visible area, http://localhost:3000/, image 800×600' },
    ]);
  });

  it('長い辺は 1568px まで縮める。縮める必要がなければ、そのまま', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.shot = new FakeImage(4000, 1000);
    expect(textOf(await call('screenshot'))).toContain('image 1568×392');
    page.shot = new FakeImage(1000, 4000);
    expect(textOf(await call('screenshot'))).toContain('image 392×1568');
    page.shot = new FakeImage(800, 600);
    const same = await call('screenshot');
    expect(same.content[0]).toEqual({ type: 'image', data: Buffer.from('shot:800x600').toString('base64'), mimeType: 'image/png' });
  });

  it('selector: 要素のまわり 8px を、見えている範囲の中で切り出す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 100.5, y: 50, width: 200, height: 40 });
    expect(textOf(await call('screenshot', { selector: '#go' }))).toBe('#go (button#go "送る"), http://localhost:3000/, image 800×600');
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
    expect(await call('screenshot', { selector: '#out' })).toEqual(textResult('"#out" has zero size and cannot be captured.', true));
    page.page.locate = () => found({ x: 10, y: 700, width: 20, height: 20 });
    expect(await call('screenshot', { selector: '#below' })).toEqual(textResult('"#below" has zero size and cannot be captured.', true));
    expect(page.captures).toEqual([]);
  });

  it('ツールを動かす間、アプリの画面を描かれる状態にする（非表示の画面を表示にさせ、backgroundThrottling を切って、終えたら戻す）。撮る間は、タブの分も切る', async () => {
    // アプリの画面が隠れている扱い（見ていないプロファイルの画面・画面のロック）だと、タブの大きさが決まらず、撮っても返ってこない
    const { call, open, state } = setup();
    const page = open('http://localhost:3000/');
    const during: unknown[][] = [];
    page.capture = async () => {
      during.push([page.backgroundThrottling, HOST.backgroundThrottling, [...state.draws]]);
      return page.shot;
    };
    await call('screenshot');
    page.page.locate = () => found({ x: 100, y: 50, width: 200, height: 40 });
    await call('screenshot', { selector: '#go' });
    expect(during).toEqual([
      [false, false, ['頼む']],
      [false, false, ['頼む', '戻す', '頼む']],
    ]);
    expect(page.throttling).toEqual([false, true, false, true]);
    expect(HOST.throttling).toEqual([false, true, false, true]);
    expect(state.draws).toEqual(['頼む', '戻す', '頼む', '戻す']);
    // 撮らないツールでも、アプリの画面は描かせる（要素の位置を取るには、タブの大きさが決まっている必要がある）。タブの分は切らない
    page.page.text = () => {
      during.push([page.backgroundThrottling, HOST.backgroundThrottling, state.draws.length]);
      return { title: 'ページ', url: 'http://localhost:3000/', parts: [{ frame: null, text: '本文' }] };
    };
    await call('get_text');
    expect(during.at(-1)).toEqual([true, false, 5]);
    expect(state.draws).toHaveLength(6);
    expect(page.throttling).toHaveLength(4);
    expect(HOST.throttling).toEqual([false, true, false, true, false, true]);
    // ページ全体（CDP）も、撮る間はタブの分を切る
    answerCdp(page, {
      'Page.getLayoutMetrics': () => ({ cssContentSize: { width: 800, height: 900 }, cssLayoutViewport: { clientWidth: 800 } }),
      'Page.captureScreenshot': () => {
        during.push([page.backgroundThrottling, HOST.backgroundThrottling]);
        return { data: '' };
      },
    });
    await call('screenshot', { fullPage: true });
    expect(during.at(-1)).toEqual([false, false]);
    expect([page.backgroundThrottling, HOST.backgroundThrottling]).toEqual([true, true]);
  });

  it('タブの大きさが決まっていない（0）ときは、同じ大きさが 2 回続くまで待ってから撮る', async () => {
    // アプリの画面を描かせ始めた直後は、タブの置き場所がまだ決まっていない。そのまま撮ると、空の絵や、途中の大きさの絵になる
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    const sizes = [
      [0, 0],
      [0, 0],
      [471, 115],
      [952, 851],
      [952, 851],
    ];
    let asked = 0;
    page.page.size = () => {
      const [laidOutWidth, laidOutHeight] = sizes[Math.min(asked++, sizes.length - 1)];
      return { laidOutWidth, laidOutHeight };
    };
    const capturedAfter: number[] = [];
    page.capture = async () => {
      capturedAfter.push(asked);
      return page.shot;
    };
    expect((await call('screenshot')).isError).toBeFalsy();
    expect(capturedAfter).toEqual([5]);
    // 決まっているときは、1 回聞くだけで待たない。要素を探す前（selector）にも聞く
    page.page.locate = () => found({ x: 100, y: 50, width: 200, height: 40 });
    await call('screenshot', { selector: '#go' });
    expect(capturedAfter).toEqual([5, 6]);
    expect(page.scripts.map((s) => s.kind).slice(-3)).toEqual(['size', 'locate', 'viewport']);
  });

  it('待ってもタブの大きさが決まらなければ、そのまま進める', async () => {
    const { control, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.size = () => ({ laidOutWidth: 0, laidOutHeight: 0 });
    const pending = control.handle('S1', 'screenshot', {});
    await vi.advanceTimersByTimeAsync(2_900);
    expect(page.captures).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).isError).toBeFalsy();
    expect(page.captures).toHaveLength(1);
  });

  it('空の絵が返ったら、少しの間、撮り直す', async () => {
    // 描かせ始めた直後は、まだ 1 枚も描かれていないことがある
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    let taken = 0;
    page.capture = async () => (++taken < 3 ? new FakeImage(0, 0) : page.shot);
    expect(textOf(await call('screenshot'))).toBe('Visible area, http://localhost:3000/, image 800×600');
    expect(taken).toBe(3);
  });

  it('撮れなかったときも戻す。もともと切ってあるものには触れない', async () => {
    const { call, open, state } = setup();
    const page = open('http://localhost:3000/');
    page.capture = async () => {
      throw new Error('Current display surface not available for capture');
    };
    expect(await call('screenshot')).toEqual(textResult('Current display surface not available for capture', true));
    expect(page.throttling).toEqual([false, true]);
    expect(HOST.throttling).toEqual([false, true]);
    expect(state.draws).toEqual(['頼む', '戻す']);
    // アプリの画面は、もともと描かせ続ける設定だった
    HOST.backgroundThrottling = false;
    HOST.throttling.length = 0;
    page.capture = async () => page.shot;
    await call('screenshot');
    expect(HOST.throttling).toEqual([]);
    expect(HOST.backgroundThrottling).toBe(false);
    expect(page.throttling).toEqual([false, true, false, true]);
  });

  it('同じ画面のタブを同時に撮っている間は、最後の 1 つが終わるまで戻さない', async () => {
    const { control, open } = setup();
    const first = open('http://localhost:3000/', { sessionId: 'S1' });
    const second = open('http://localhost:3001/', { sessionId: 'S2' });
    let finishFirst: () => void = () => {};
    let finishSecond: () => void = () => {};
    first.capture = () => new Promise((resolve) => (finishFirst = () => resolve(first.shot)));
    second.capture = () => new Promise((resolve) => (finishSecond = () => resolve(second.shot)));
    const a = control.handle('S1', 'screenshot', {});
    const b = control.handle('S2', 'screenshot', {});
    await vi.advanceTimersByTimeAsync(10);
    expect(HOST.throttling).toEqual([false]);
    finishFirst();
    await vi.advanceTimersByTimeAsync(10);
    expect((await a).isError).toBeFalsy();
    // 1 つめのタブは戻すが、アプリの画面は、2 つめが撮り終えるまで描かせ続ける
    expect(first.throttling).toEqual([false, true]);
    expect(HOST.throttling).toEqual([false]);
    finishSecond();
    await vi.advanceTimersByTimeAsync(10);
    expect((await b).isError).toBeFalsy();
    expect(second.throttling).toEqual([false, true]);
    expect(HOST.throttling).toEqual([false, true]);
  });

  it('15 秒たっても撮れなければ、1 回の操作の上限（60 秒）を待たずに、理由の見当を添えて断る', async () => {
    const { control, open, state } = setup();
    const page = open('http://localhost:3000/');
    // ウインドウが描かれていないと、capturePage は返ってこない（エラーにもならない）
    page.capture = () => new Promise(() => {});
    const pending = control.handle('S1', 'screenshot', {});
    await vi.advanceTimersByTimeAsync(14_000);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Could not take a screenshot: nothing came back within 15 seconds.');
    expect(textOf(result)).toContain('the window is hidden, or the screen is locked');
    // 描かれる状態にしたものは戻す
    expect(page.throttling).toEqual([false, true]);
    expect(HOST.throttling).toEqual([false, true]);
    expect(state.draws).toEqual(['頼む', '戻す']);
    // ページ全体（CDP）も同じ
    answerCdp(page, {
      'Page.getLayoutMetrics': () => ({ cssContentSize: { width: 800, height: 900 }, cssLayoutViewport: { clientWidth: 800 } }),
      'Page.captureScreenshot': () => new Promise(() => {}),
    });
    const full = control.handle('S1', 'screenshot', { fullPage: true });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(textOf(await full)).toContain('Could not take a screenshot: nothing came back within 15 seconds.');
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
    expect(textOf(result)).toBe('Top 2000px of the page (full height 5001px; scroll and take another screenshot for the rest), http://localhost:3000/, image 627×1568');
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
    expect(textOf(await call('screenshot', { fullPage: true }))).toBe('Full page (800×1200), http://localhost:3000/, image 800×1200');
    expect(page.debugger.sent('Page.captureScreenshot')[0].params).toMatchObject({ clip: { height: 1200 } });
  });

  it('撮り直しても撮れなかった（空の画像）ときは、そう返す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.shot = new FakeImage(0, 0);
    expect(await call('screenshot')).toEqual(textResult('Could not take a screenshot (the page may not have been rendered yet).', true));
    // 3 秒の間、0.1 秒おきに撮り直した
    expect(page.captures.length).toBeGreaterThan(20);
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
        'Title: トップ',
        'URL: http://localhost:3000/',
        '',
        '見出し\n\n本文',
        '',
        '--- inside iframe (http://localhost:3000/frame) ---',
        '中の文字',
        '',
        '--- inside iframe (http://127.0.0.1:5173/widget) ---',
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
    expect(textOf(await call('get_text', { selector: '#main' }))).toBe('Title: (none)\nURL: http://localhost:3000/\n\n--- inside iframe (http://localhost:3000/f) ---\nメイン');
    expect(page.debugger.commands).toEqual([]);
    expect(await call('get_text', { selector: '#none' })).toEqual(textResult('No element matches "#none".', true));
  });

  it('長い文字は 20000 文字で切る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.text = () => ({ title: 'T', url: 'http://localhost:3000/', parts: [{ frame: null, text: 'あ'.repeat(25_000) }] });
    const text = textOf(await call('get_text', { selector: 'body' }));
    expect(text).toBe(`Title: T\nURL: http://localhost:3000/\n\n${'あ'.repeat(20_000)}\n…(5000 more characters omitted)`);
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
        '  - textbox "名前" value="たなか"',
        '  - checkbox "同意" [checked=mixed]',
        `  - textbox "メモ" value="${'x'.repeat(100)}"`,
        '--- inside iframe (http://localhost:3000/ad) ---',
        '- link "広告"',
        '--- inside iframe (http://localhost:3000/broken) ---',
        '--- inside iframe (http://127.0.0.1:5173/w) ---',
        '- heading "ウィジェット"',
        '--- inside iframe (http://localhost:3000/slow) ---',
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
    expect(lines.at(-1)).toBe('…(truncated at 1500 lines)');
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
        'Elements matching "button": 12',
        '',
        '## Element 1 (visible, x=10 y=20 100×30)',
        '```html',
        '<button id="go">送る</button>',
        '```',
        '- color: rgb(0, 0, 0)',
        '- margin-top: 4px',
        '',
        '## Element 2 (not visible, x=0 y=0 0×0, inside iframe (http://localhost:3000/f))',
        '```html',
        '<button hidden></button>',
        '```',
        '- color: red',
        '- margin-top: 0px',
        '',
        '(10 more not shown)',
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
    expect(textOf(await call('inspect', { selector: 'p' }))).toBe('Elements matching "p": 1\n\n## Element 1 (visible, x=1 y=2 3×4)\n```html\n<p></p>\n```');
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
      code.includes('"[["') ? { error: "Invalid selector: '[[' is not a valid selector" } : { total: 0, items: [] };
    expect(await call('inspect', { selector: '.none' })).toEqual(textResult('No element matches ".none".', true));
    expect(await call('inspect', { selector: '[[' })).toEqual(textResult("Invalid selector: '[[' is not a valid selector", true));
    expect(await call('inspect', {})).toEqual(textResult('Provide selector.', true));
    expect(page.scriptsOf('inspect')).toHaveLength(2);
  });
});

describe('クリック', () => {
  it('selector: 枠を出してから、要素の真ん中を CDP で押す。CDP は最初の 1 回だけつなぐ', async () => {
    const { call, open, activities } = setup();
    const page = open('http://localhost:3000/');
    const rect = { x: 100, y: 50, width: 201, height: 40 };
    page.page.locate = () => found(rect);
    expect(await call('click', { selector: '#go' })).toEqual(textResult('Clicked: button#go "送る"'));
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
    expect(textOf(await call('click', { selector: '#a', double: true, button: 'right' }))).toBe('Double-clicked: button#go "送る"');
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
    expect(await call('click', { selector: '#a' })).toEqual(textResult('No element matches "#a".', true));
    page.page.locate = () => ({ error: 'hidden', count: 3 });
    expect(await call('click', { selector: '.item' })).toEqual(textResult('None of the 3 elements matching ".item" is visible.', true));
    page.page.locate = () => ({ error: 'hidden', count: 1 });
    expect(await call('click', { selector: '#only' })).toEqual(textResult('The element matching "#only" is not visible.', true));
    page.page.locate = () => ({ error: "Invalid selector: '##' is not a valid selector" });
    expect(await call('click', { selector: '##' })).toEqual(textResult("Invalid selector: '##' is not a valid selector", true));
    expect(inputs(page)).toEqual([]);
  });

  it('押した位置にほかの要素が重なっていたら、そう添える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'button#go', 'div.overlay');
    expect(textOf(await call('click', { selector: '#go' }))).toBe('Clicked: button#go\n(another element, div.overlay, was covering the clicked position)');
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
    expect(textOf(await call('click', { selector: '#next' }))).toBe('Clicked: a#next\nThe page navigated to http://localhost:3000/next');
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
    expect(textOf(await call('click', { selector: '#back' }))).toContain(' (not allowed for Claude, so it can be neither read nor operated any further)');
  });

  it('押してページが許していない先へ移ったら、移った先はオリジンだけを伝える（URL の道筋・クエリは伏せる）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'button#back');
    page.debugger.handler = (method, params) => {
      // 履歴を戻るページのボタン（history.back）など、移る前に止められなかったもの
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') page.url = 'https://accounts.example.com/o/oauth2/auth?state=secret&code=abc';
      return {};
    };
    const result = textOf(await call('click', { selector: '#back' }));
    expect(result).toBe(
      'Clicked: button#back\nThe page navigated to https://accounts.example.com (not allowed for Claude, so it can be neither read nor operated any further)',
    );
    expect(result).not.toContain('secret');
  });

  it('x・y: その位置の要素を押す（枠はその位置のまわり 20px）', async () => {
    const { call, open, activities } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'canvas#board' });
    expect(textOf(await call('click', { x: 120, y: 80 }))).toBe('Clicked: canvas#board at x=120 y=80');
    expect(page.scriptsOf('point')[0]).toContain('const x = 120, y = 80;');
    expect(inputs(page)[1]).toEqual({ method: 'dispatchMouseEvent', type: 'mousePressed', x: 120, y: 80, button: 'left', clickCount: 1 });
    expect(activities()[1].box).toEqual({ x: 110, y: 70, width: 20, height: 20 });
  });

  it('selector も x・y も無い・x・y が有限の数でないときは断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    for (const args of [{}, { x: 1 }, { x: '1', y: 2 }, { x: Number.NaN, y: 2 }, { x: 1, y: Number.POSITIVE_INFINITY }, { selector: '  ' }]) {
      expect(await call('click', args), JSON.stringify(args)).toEqual(textResult('Provide selector, or x and y.', true));
    }
    expect(page.scripts).toEqual([]);
  });

  it('x・y が見えている範囲の外・要素が無いときは断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ error: 'outside', width: 800, height: 600 });
    expect(await call('click', { x: 900, y: 10 })).toEqual(textResult('x=900 y=10 is outside the visible area (800×600).', true));
    page.page.point = () => ({ error: 'none' });
    expect(await call('click', { x: 5, y: 5 })).toEqual(textResult('There is no element at x=5 y=5.', true));
    expect(inputs(page)).toEqual([]);
  });

  it('別オリジンの iframe（許す先）の中: 別プロセスで動いていれば、その iframe のセッションに、iframe の中の位置で送る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: true, src: 'http://127.0.0.1:5173/widget', frame: { x: 300, y: 200 }, description: 'iframe#w' });
    answerCdp(page, {}, { C9: 'http://localhost:4000/other', C1: 'http://127.0.0.1:5173/widget/page' });
    addChildFrame(page, 'C9');
    addChildFrame(page, 'C1');
    expect(textOf(await call('click', { x: 350, y: 260 }))).toBe('Clicked: x=350 y=260 (inside cross-origin iframe http://127.0.0.1:5173/widget/page)');
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
    expect(textOf(await call('click', { x: 350, y: 260 }))).toBe('Clicked: x=350 y=260 (inside cross-origin iframe http://127.0.0.1:5173/widget)');
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
    expect(textOf(refused)).toMatch(/^Cannot click x=10 y=10 because it is inside an iframe not allowed for Claude \(https:\/\/pay\.example\.com.*\)\.$/);
    page.page.point = () => ({ cross: true, src: null, frame: null, description: 'iframe' });
    expect(await call('click', { x: 10, y: 10 })).toEqual(textResult('Cannot click x=10 y=10 because it is inside an iframe not allowed for Claude (no src).', true));
    // src が URL として読めなければ、別プロセスの iframe を探さない
    page.page.point = () => ({ cross: true, src: 'widget.html', frame: null, description: 'iframe' });
    expect(await call('click', { x: 10, y: 10 })).toEqual(textResult('Cannot click x=10 y=10 because it is inside an iframe not allowed for Claude (widget.html).', true));
    expect(page.debugger.sent('Target.getTargets')).toHaveLength(1);
    expect(inputs(page)).toEqual([]);
  });
});

describe('許していない先の iframe の中（不具合の確かめ）', () => {
  it('click の x・y: 許していない先の iframe の今の URL は、オリジンだけを伝える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: true, src: 'https://pay.example.com/checkout', frame: { x: 0, y: 0 }, description: 'iframe#pay' });
    answerCdp(page, {}, { C1: 'https://pay.example.com/confirm?token=secret' });
    addChildFrame(page, 'C1');
    const refused = await call('click', { x: 10, y: 10 });
    expect(refused).toEqual(textResult('Cannot click x=10 y=10 because it is inside an iframe not allowed for Claude (https://pay.example.com).', true));
    expect(inputs(page)).toEqual([]);
  });

  it('type: フォーカスのある、許していない先の iframe の今の URL は、オリジンだけを伝える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.focus = () => 'https://pay.example.com/card';
    answerCdp(page, {}, { C1: 'https://pay.example.com/card/3ds?session=secret' });
    addChildFrame(page, 'C1');
    const refused = await call('type', { text: '4242' });
    expect(refused).toEqual(textResult('Cannot type because the focus is inside an iframe not allowed for Claude (https://pay.example.com).', true));
    expect(inputs(page)).toEqual([]);
  });
});

describe('人がタブで許した、許す先の外のオリジンと iframe', () => {
  // 開く確認のフックが聞き（人に確認した印を控える）、Claude が開く。そのタブで、そのオリジンを許したことになる
  const permitAndOpen = async (ctx: ReturnType<typeof setup>, url: string) => {
    await ctx.control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('navigate'), input: { url } });
    expect(textOf(await ctx.call('navigate', { url }))).toMatch(/^Opened: /);
  };

  it('別オリジンの iframe には効かない: 許したオリジンの iframe でも、ほかのページの中なら読まない・押さない・打たない', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/');
    await permitAndOpen(ctx, 'https://pay.example.com/');
    await ctx.call('navigate', { url: 'http://localhost:3000/' });
    page.page.point = () => ({ cross: true, src: 'https://pay.example.com/checkout', frame: { x: 0, y: 0 }, description: 'iframe#pay' });
    expect((await ctx.call('click', { x: 10, y: 10 })).isError).toBe(true);
    page.page.focus = () => 'https://pay.example.com/card';
    expect((await ctx.call('type', { text: '4242' })).isError).toBe(true);
    expect(inputs(page)).toEqual([]);
    page.page.text = () => ({ title: 'トップ', url: 'http://localhost:3000/', parts: [{ frame: null, text: '本文' }] });
    answerCdp(page, { 'Runtime.evaluate': () => ({ result: { value: '決済の中身' } }) }, { C1: 'https://pay.example.com/checkout' });
    addChildFrame(page, 'C1');
    expect(textOf(await ctx.call('get_text'))).not.toContain('決済の中身');
  });

  it('許したページの中の、同じオリジンの iframe はツリーも読む。別オリジンの iframe は読まない', async () => {
    const ctx = setup();
    const page = ctx.open('http://localhost:3000/');
    await permitAndOpen(ctx, 'https://example.com/');
    const node = (id: string, name: string) => ({ nodeId: id, ignored: false, role: { value: 'heading' }, name: { value: name } });
    answerCdp(page, {
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'F0', url: 'https://example.com/' },
          childFrames: [{ frame: { id: 'F1', url: 'https://example.com/frame' } }, { frame: { id: 'F2', url: 'https://ads.example.org/' } }],
        },
      }),
      'Accessibility.getFullAXTree': (params) => ({ nodes: [node(String(params?.frameId), `見出し ${String(params?.frameId)}`)] }),
    });
    expect(textOf(await ctx.call('get_accessibility_tree'))).toBe(
      ['URL: https://example.com/', '- heading "見出し F0"', '--- inside iframe (https://example.com/frame) ---', '- heading "見出し F1"'].join('\n'),
    );
    expect(page.debugger.sent('Accessibility.getFullAXTree').map((c) => c.params?.frameId)).toEqual(['F0', 'F1']);
  });
});

describe('入力（type）', () => {
  it('selector: 欄を押してから文字を入れる。submit で最後に Enter も押す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 10, y: 20, width: 100, height: 20 }, 'input#name');
    expect(await call('type', { selector: '#name', text: 'たなか', submit: true })).toEqual(textResult('Typed into input#name and pressed Enter'));
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
    expect(await call('type', { text: 'abc' })).toEqual(textResult('Typed into the focused element'));
    expect(inputs(page)).toEqual([{ method: 'insertText', text: 'abc' }]);
    page.debugger.commands.length = 0;
    expect(await call('type', { text: 123 })).toEqual(textResult('Typed into the focused element'));
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
    expect(textOf(refused)).toMatch(/^Cannot type because the focus is inside an iframe not allowed for Claude \(https:\/\/pay\.example\.com.*\)\.$/);
    expect(inputs(page)).toEqual([]);
  });
});

describe('キー（press_key）', () => {
  it('キーと一緒に押すキーを CDP で送る。Shift なら文字も入れる', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('press_key', { key: 'Enter', modifiers: ['shift'] })).toEqual(textResult('Pressed shift+Enter'));
    expect(inputs(page)).toEqual([
      { method: 'dispatchKeyEvent', type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8, text: '\r', unmodifiedText: '\r' },
      { method: 'dispatchKeyEvent', type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 },
    ]);
  });

  it('Ctrl・⌘ と一緒なら文字を入れない（rawKeyDown）。知らない修飾キーは数えない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(textOf(await call('press_key', { key: 'a', modifiers: ['control', 'meta', 'hyper', 3] }))).toBe('Pressed control+meta+hyper+a');
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
    expect(await call('press_key', { key: 'Hyper' })).toEqual(textResult('Unknown key: Hyper', true));
    expect(await call('press_key', {})).toEqual(textResult('Provide key.', true));
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
    expect(await call('scroll', {})).toEqual(textResult('Provide selector, or deltaX or deltaY.', true));
    expect(await call('scroll', { deltaY: 0, deltaX: '10' })).toEqual(textResult('Provide selector, or deltaX or deltaY.', true));
    expect(page.scripts).toEqual([]);
  });

  it('selector: その要素が見える位置まで動かし、動いた入れ物と位置を返す。当たらなければ断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.scroll = (code) => (code.includes('"#footer"') ? { x: 0, y: 640, where: 'page' } : null);
    expect(await call('scroll', { selector: '#footer' })).toEqual(textResult('Scrolled (scroll position of the page: x=0 y=640)'));
    const code = page.scriptsOf('scroll')[0];
    expect(code).toContain("target.scrollIntoView({ block: 'center', inline: 'nearest' });");
    expect(code).toContain('const dx = 0, dy = 0;');
    expect(await call('scroll', { selector: '#none' })).toEqual(textResult('No element matches "#none".', true));
  });

  it('deltaX・deltaY: その分だけ動かす（数でないものは 0）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.scroll = () => ({ x: 0, y: 300, where: 'inner scroll container' });
    expect(await call('scroll', { deltaY: 300, deltaX: 'x' })).toEqual(textResult('Scrolled (scroll position of the inner scroll container: x=0 y=300)'));
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
    expect(await call('wait_for', { state: 'hidden' })).toEqual(textResult('Provide selector or text.', true));
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
    expect(await call('wait_for', { selector: '#done' })).toEqual(textResult('"#done" appeared (300 ms)'));
    const code = page.scriptsOf('wait')[0];
    expect(code).toContain('const state = "visible";');
    expect(code).toContain('el = (__all("#done")[0] || {}).el || null;');
    expect(code).not.toContain('const want');
  });

  it('hidden: 消えるまで待つ。text: ページに出る文字で待つ（selector もあれば、要素が無いときだけ文字で探す）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.wait = () => true;
    expect(textOf(await call('wait_for', { selector: '#spinner', state: 'hidden' }))).toMatch(/^"#spinner" disappeared \(\d+ ms\)$/);
    expect(page.scriptsOf('wait')[0]).toContain('const state = "hidden";');
    expect(textOf(await call('wait_for', { text: '保存しました' }))).toMatch(/^"保存しました" appeared/);
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
    expect(short).toMatchObject({ text: '"#never" did not appear within 1000 ms.', error: true });
    expect(short.ms).toBeGreaterThan(1000);
    expect(short.ms).toBeLessThan(1300);
    expect((await waited({ text: 'まだ', state: 'hidden', timeoutMs: 1000 })).text).toBe('"まだ" did not disappear within 1000 ms.');
    const long = await waited({ selector: '#never', timeoutMs: 99_999 });
    expect(long.text).toBe('"#never" did not appear within 30000 ms.');
    expect(long.ms).toBeLessThan(31_000);
    expect((await waited({ selector: '#never', timeoutMs: -5 })).text).toBe('"#never" did not appear within 0 ms.');
    const fallback = await waited({ selector: '#never', timeoutMs: '5' });
    expect(fallback.text).toBe('"#never" did not appear within 10000 ms.');
    expect((await waited({ selector: '#never', timeoutMs: Number.NaN })).text).toBe('"#never" did not appear within 10000 ms.');
    expect(fallback.ms).toBeGreaterThan(10_000);
    expect(fallback.ms).toBeLessThan(10_500);
  });
});

describe('表示幅（set_viewport）', () => {
  it('画面に幅を送り、描き直したあとのページの大きさを返す', async () => {
    const { call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    page.page.viewport = () => ({ width: 390, height: 844, dpr: 3 });
    expect(await call('set_viewport', { width: 'mobile' })).toEqual(textResult('Set the viewport to mobile (page width 390px, height 844px)'));
    await call('set_viewport', { width: 'tablet' });
    await call('set_viewport', { width: 'full' });
    expect(sentOn(IpcChannel.BrowserViewport)).toEqual([
      { sessionId: 'S1', width: 390 },
      { sessionId: 'S1', width: 768 },
      { sessionId: 'S1', width: 0 },
    ]);
  });

  it('Object の持ち物の名前（toString・constructor・__proto__）は、表示幅として受け付けない', async () => {
    const { call, open, sentOn } = setup();
    open('http://localhost:3000/');
    for (const width of ['toString', 'constructor', '__proto__']) {
      expect(await call('set_viewport', { width }), width).toEqual(textResult(`width must be full, mobile or tablet: ${width}`, true));
    }
    expect(sentOn(IpcChannel.BrowserViewport)).toEqual([]);
  });

  it('知らない幅・幅が無いときは、画面に送らない', async () => {
    const { call, open, sentOn } = setup();
    open('http://localhost:3000/');
    expect(await call('set_viewport', { width: 'desktop' })).toEqual(textResult('width must be full, mobile or tablet: desktop', true));
    expect(await call('set_viewport', {})).toEqual(textResult('Provide width.', true));
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
    expect(await run('x'.repeat(25_000))).toBe(`"${'x'.repeat(19_999)}\n…(5002 more characters omitted)`);
    expect(page.evaluated.map((code) => code.split('\n').at(-1))).toEqual(Array(7).fill('document.title'));
  });

  // ページの中で動かす（実行するコードを、偽の location と document の上で本当に動かす）。move.url: 動いたときにタブが開いているページ
  // （getURL。確かめたあと、動くまでの間に移動が確定した）/ move.location: ページの中の location（既定は move.url。読み込みに失敗したページは
  // chrome-error のページ）/ move.log: 投げたものを、Chromium と同じくコンソールに出すか（ページが window.onerror で true を返すと出ない）/
  // move.after: 投げたあとに、ページがすること（移った先のページがコンソールに出す など）
  type Move = { url: string; location?: string; title?: string; log?: boolean; after?: () => void };
  const runIn = (page: ReturnType<ReturnType<typeof setup>['open']>, move: Move) => {
    page.evaluate = (code) => {
      page.url = move.url;
      const where = new URL(move.location ?? move.url);
      try {
        return runInNewContext(code, { location: { protocol: where.protocol, host: where.host, href: where.href }, document: { title: move.title ?? '' } });
      } catch (error) {
        if (move.log !== false) logConsole(page, 'error', `Uncaught ${String(error)}`);
        move.after?.();
        throw new Error('Script failed to execute');
      }
    };
  };
  const NOT_RUN = (where: string) => textResult(`The page moved to another origin (${where}) before the script ran, so the script was not run.`, true);
  const UNKNOWN = (where: string) =>
    textResult(
      `The page moved to a page not allowed for Claude (${where}) while the script was running or just before it, so it is not known whether the script ran. Check the page (for example, with list_tabs) before running it again.`,
      true,
    );

  it('確かめたページから別のオリジンへ移ったあとに動くときは、移った先のページでは動かさない（ポート違い・http から https も別のオリジン）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/a');
    runIn(page, { url: 'https://evil.example/', title: '外のページ' });
    expect(await call('evaluate', { expression: 'document.title' })).toEqual(NOT_RUN('https://evil.example'));
    page.url = 'http://localhost:3000/a';
    runIn(page, { url: 'http://localhost:3001/', title: '別のポート' });
    expect(await call('evaluate', { expression: 'document.title' })).toEqual(NOT_RUN('http://localhost:3001'));
    const local = open('http://myapp.local/');
    runIn(local, { url: 'https://myapp.local/', title: 'https のページ' });
    expect(await call('evaluate', { expression: 'document.title' })).toEqual(NOT_RUN('https://myapp.local'));
  });

  it('止めたあと、今のページが許していない先なら、ページのコンソールの文は返さない（オリジンだけ）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/a');
    // 移った先のページが window.onerror で目印を隠し、自分の文をコンソールに出す
    runIn(page, { url: 'https://evil.example/', log: false, after: () => logConsole(page, 'error', '外のページの秘密の文') });
    let result = await call('evaluate', { expression: 'document.title' });
    expect(result).toEqual(UNKNOWN('https://evil.example'));
    // 式が localhost で動いて投げ、そのあとに移った先もエラーを出す
    page.url = 'http://localhost:3000/a';
    page.evaluate = () => {
      logConsole(page, 'error', 'Uncaught Error: 式のエラー');
      page.url = 'https://evil.example/login?token=secret';
      logConsole(page, 'error', '外のページの秘密の文', 'https://evil.example/login?token=secret', 3);
      throw new Error('Script failed to execute');
    };
    result = await call('evaluate', { expression: 'boom()' });
    expect(result).toEqual(UNKNOWN('https://evil.example'));
    expect(textOf(result)).not.toContain('秘密');
    // タブが閉じられた
    page.url = 'http://localhost:3000/a';
    page.evaluate = () => {
      page.destroyed = true;
      throw new Error('Script failed to execute');
    };
    expect(await call('evaluate', { expression: 'x' })).toEqual(textResult('The tab was closed while the script was running, so it is not known whether the script ran.', true));
  });

  it('目印が無く、許す先の別のオリジンへ移っていたら、動かなかったとは言わず、式のエラーに移った先を添える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/a');
    page.evaluate = () => {
      page.url = 'http://localhost:3001/done';
      logConsole(page, 'error', 'Uncaught Error: 送ったあとのエラー');
      throw new Error('Script failed to execute');
    };
    expect(await call('evaluate', { expression: 'submit()' })).toEqual(
      textResult('Execution failed: Uncaught Error: 送ったあとのエラー\n(The page moved to http://localhost:3001 while the script was running or just before it.)', true),
    );
    page.url = 'http://localhost:3000/a';
    page.evaluate = () => {
      page.url = 'http://localhost:3001/done';
      throw new Error('Script failed to execute');
    };
    expect(await call('evaluate', { expression: 'submit()' })).toEqual(
      textResult('Execution failed: Script failed to execute\n(The page moved to http://localhost:3001 while the script was running or just before it.)', true),
    );
  });

  it('タブの URL は確かめたオリジンのままでも、ページの中が違った（読み込みに失敗したページ・移って戻った）ときは、そのことを伝える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/a');
    const SAME = textResult(
      'The page in the current tab changed before the script ran (for example, it shows an error page because http://localhost:3000 could not be loaded, or it moved to another origin and back), so the script was not run. Reload it or open the page again with navigate if needed.',
      true,
    );
    runIn(page, { url: 'http://localhost:3000/a', location: 'chrome-error://chromewebdata/' });
    expect(await call('evaluate', { expression: 'document.title' })).toEqual(SAME);
    runIn(page, { url: 'http://localhost:3000/a', location: 'https://evil.example/' });
    expect(await call('evaluate', { expression: 'document.title' })).toEqual(SAME);
  });

  it('空のページ（about:blank）へ移っていたら、そう書く（オリジンの無いページを "null" と書かない）。タブが閉じる前に止めていれば、動かなかったと伝える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/a');
    runIn(page, { url: 'about:blank' });
    expect(await call('evaluate', { expression: 'document.title' })).toEqual(NOT_RUN('about:blank'));
    // 止めた目印がコンソールに出たあとに、タブが閉じられた
    page.url = 'http://localhost:3000/a';
    runIn(page, { url: 'https://evil.example/', after: () => (page.destroyed = true) });
    expect(await call('evaluate', { expression: 'document.title' })).toEqual(
      textResult('The page moved to another origin and the tab was closed before the script ran, so the script was not run.', true),
    );
  });

  it('コンソールの記録が上限で前から削られても、動かしている間に出たエラーだけを返す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    for (let i = 0; i < 200; i++) logConsole(page, 'error', `前のエラー ${i}`);
    page.evaluate = () => {
      logConsole(page, 'error', 'Uncaught Error: 新しいエラー');
      throw new Error('Script failed to execute');
    };
    expect(await call('evaluate', { expression: 'x' })).toEqual(textResult('Execution failed: Uncaught Error: 新しいエラー', true));
  });

  it('先頭で比べる文は、式の意味を変えない（最後の値・ブロックとラベル・行末の注釈・宣言だけ・else・use strict・#!）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/a');
    runIn(page, { url: 'http://localhost:3000/a', title: '題' });
    const run = async (expression: string) => {
      const result = await call('evaluate', { expression });
      return result.isError ? textOf(result) : textOf(result);
    };
    expect(await run('{a:1}')).toBe('1');
    expect(await run('1 // 行末の注釈')).toBe('1');
    expect(await run('var x = 1;')).toBe('undefined');
    // else で始まる式は、比べる文の if の続きにならない（式だけで動かしたときと同じく、書き方の誤り）
    expect(await run('else document.title')).toMatch(/^Execution failed: Uncaught SyntaxError/);
    // 'use strict' で始まる式は、strict のまま動く（宣言していない名前への代入はエラー）
    expect(await run("'use strict';\nundeclared = 1;\n'動いた'")).toMatch(/^Execution failed: Uncaught ReferenceError/);
    expect(await run('"use strict"; document.title')).toBe('"題"');
    // 先頭の注釈と、前に並ぶ directive を読み飛ばして見分ける。文字列のあとに式が続くもの（.length・改行して + 1）は directive ではない
    expect(await run("/* 注釈 */ 'use strict';\nundeclared = 1;\n'動いた'")).toMatch(/^Execution failed: Uncaught ReferenceError/);
    expect(await run("// 注釈\n'a'; 'use strict'; undeclared = 1; '動いた'")).toMatch(/^Execution failed: Uncaught ReferenceError/);
    expect(await run("'use strict'\nundeclared = 1;\n'動いた'")).toMatch(/^Execution failed: Uncaught ReferenceError/);
    expect(await run("'use strict'.length; undeclared = 1; '動いた'")).toBe('"動いた"');
    expect(await run("'use strict'\n+ 1; undeclared = 1; '動いた'")).toBe('"動いた"');
    expect(await run("'not strict'; 'use strict' + ''; undeclared = 1; '動いた'")).toBe('"動いた"');
    // #! の行（hashbang）で始まる式も動く。比べる文は、その行のあとに置く（行の終わりは \n・\r・\u2028・\u2029 のどれでも）
    expect(await run('#!/usr/bin/env node\ndocument.title')).toBe('"題"');
    expect(await run('#!x\rdocument.title')).toBe('"題"');
    expect(await run('#!x\u2028document.title')).toBe('"題"');
    expect(await run('#!だけ')).toBe('undefined');
  });

  it('#! の行の中に、比べる文が入ってしまわない（移った先では、#! の次の行の式も動かさない）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/a');
    for (const expression of ['#!x', '#!x\rdocument.title', '#!x\r\ndocument.title', '#!x\u2029document.title']) {
      page.url = 'http://localhost:3000/a';
      runIn(page, { url: 'https://evil.example/', title: '外のページ' });
      expect(await call('evaluate', { expression })).toEqual(NOT_RUN('https://evil.example'));
    }
  });

  // 確認のフックだけを動かす（ツールはまだ呼ばない）
  const gateOnly = (control: ReturnType<typeof setup>['control'], expression: string, sessionId = 'S1') =>
    control.handle(sessionId, BROWSER_GATE_REQUEST, { tool: browserToolId('evaluate'), input: { expression } });
  const CHANGED = (from: string, to: string) =>
    textResult(`The page changed after tanacode checked it for this call (from ${from} to ${to}), so the script was not run. Call evaluate again to run it on the current page.`, true);
  const NO_PAGE = textResult('No page was open in the current tab when tanacode checked this call, so the script was not run. Call evaluate again to run it on the current page.', true);
  const NO_RECORD = textResult(
    'tanacode has no record of checking this call (its permission hook did not run, or could not reach tanacode), so the script was not run. Call evaluate again. If this keeps happening, ask the user to restart Claude Code in this session (the hook is added when it starts).',
    true,
  );

  it('確認のフックが答えたときのページから、動かす前に別のオリジンへ移っていたら、動かさない（同じ式の呼び出しに結びつける）', async () => {
    const { call, control, open } = setup();
    const page = open('http://localhost:3000/a');
    page.evaluate = () => '動いた';
    // フックが見たのは localhost のページ（確認なし）。動かす前に、許す先の別のオリジン（*.local）へ移った
    expect(JSON.parse(textOf(await gateOnly(control, 'document.title')))).toEqual({ local: true, url: 'http://localhost:3000/a' });
    page.url = 'http://myapp.local/';
    expect(await call('evaluate', { expression: 'document.title' }, 'S1', { gate: false })).toEqual(CHANGED('http://localhost:3000', 'http://myapp.local'));
    expect(page.evaluated).toEqual([]);
    // 人が確認で許したページ（フックが見た *.local）のままなら、動かす。同じオリジンの中の移動もよい
    await gateOnly(control, 'document.title');
    page.url = 'http://myapp.local/next';
    expect(textOf(await call('evaluate', { expression: 'document.title' }, 'S1', { gate: false }))).toBe('"動いた"');
  });

  it('控えは 1 回で使い切る。控えが無い（フックが動かなかった）呼び出しは動かさない。別の式・別のセッションの控えは使わない', async () => {
    const { call, control, open } = setup();
    const page = open('http://localhost:3000/a');
    page.evaluate = () => '動いた';
    open('http://localhost:4000/', { sessionId: 'S2' }).evaluate = () => '動いた';
    await gateOnly(control, 'x()');
    expect(textOf(await call('evaluate', { expression: 'x()' }, 'S1', { gate: false }))).toBe('"動いた"');
    expect(await call('evaluate', { expression: 'x()' }, 'S1', { gate: false })).toEqual(NO_RECORD);
    await gateOnly(control, 'other()');
    expect(await call('evaluate', { expression: 'x()' }, 'S1', { gate: false })).toEqual(NO_RECORD);
    await gateOnly(control, 'y()', 'S2');
    expect(await call('evaluate', { expression: 'y()' }, 'S1', { gate: false })).toEqual(NO_RECORD);
    expect(textOf(await call('evaluate', { expression: 'y()' }, 'S2', { gate: false }))).toBe('"動いた"');
  });

  it('控えは期限で消えず、メニューでオフにしても消えない（断る側に倒す）。フックのときにタブが無い・空なら断る', async () => {
    const { call, control, open } = setup();
    const page = open('http://localhost:3000/a');
    page.evaluate = () => '動いた';
    await gateOnly(control, 'late()');
    page.url = 'http://myapp.local/';
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(await call('evaluate', { expression: 'late()' }, 'S1', { gate: false })).toEqual(CHANGED('http://localhost:3000', 'http://myapp.local'));
    page.url = 'http://localhost:3000/a';
    await gateOnly(control, 'off()');
    control.turnOff();
    page.url = 'http://myapp.local/';
    expect(await call('evaluate', { expression: 'off()' }, 'S1', { gate: false })).toEqual(CHANGED('http://localhost:3000', 'http://myapp.local'));
    // フックのときに、このセッションのタブが無かった・空のタブだった
    const ctx = setup();
    await gateOnly(ctx.control, 'none()');
    const later = ctx.open('http://localhost:3000/');
    later.evaluate = () => '動いた';
    expect(await ctx.call('evaluate', { expression: 'none()' }, 'S1', { gate: false })).toEqual(NO_PAGE);
    later.url = 'about:blank';
    await gateOnly(ctx.control, 'blank()');
    later.url = 'http://localhost:3000/';
    expect(await ctx.call('evaluate', { expression: 'blank()' }, 'S1', { gate: false })).toEqual(NO_PAGE);
  });

  it('控えは、呼び出しの ID（Claude Code がフックと MCP の両方に渡す）で結びつける。同じ式でも、別の呼び出しの控えは使わない', async () => {
    const { call, control, open } = setup();
    const page = open('http://localhost:3000/a');
    page.evaluate = () => '動いた';
    const gateWithId = (expression: string, toolUseId: string) => control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('evaluate'), input: { expression }, toolUseId });
    // 同じ式を 2 つ並べて呼んだ（本体とサブエージェントなど）。1 つめのフックは localhost、2 つめは *.local のページを見た
    await gateWithId('x()', 'toolu_a');
    page.url = 'http://myapp.local/';
    await gateWithId('x()', 'toolu_b');
    // 1 つめの呼び出しは、自分の控え（localhost）と比べて断る。式で引くと、新しい 2 つめの控えを使ってしまう
    expect(await call('evaluate', { expression: 'x()' }, 'S1', { gate: false, toolUseId: 'toolu_a' })).toEqual(CHANGED('http://localhost:3000', 'http://myapp.local'));
    expect(textOf(await call('evaluate', { expression: 'x()' }, 'S1', { gate: false, toolUseId: 'toolu_b' }))).toBe('"動いた"');
    // ID のある呼び出しは、ほかの ID の控えを使わない（式が同じでも）
    await gateWithId('y()', 'toolu_c');
    expect(await call('evaluate', { expression: 'y()' }, 'S1', { gate: false, toolUseId: 'toolu_d' })).toEqual(NO_RECORD);
    // ID の控えの式と、呼び出しの式が違えば断る
    await gateWithId('z()', 'toolu_e');
    expect(await call('evaluate', { expression: 'other()' }, 'S1', { gate: false, toolUseId: 'toolu_e' })).toEqual(NO_RECORD);
    // ID の無い呼び出し（ID を渡さない中継）は、式で引く。ID の無い控え（ID を渡さないフック）は、ID のある呼び出しでも式で引く
    await gateWithId('w()', 'toolu_f');
    expect(textOf(await call('evaluate', { expression: 'w()' }, 'S1', { gate: false, toolUseId: null }))).toBe('"動いた"');
    await gateOnly(control, 'v()');
    expect(textOf(await call('evaluate', { expression: 'v()' }, 'S1', { gate: false, toolUseId: 'toolu_g' }))).toBe('"動いた"');
  });

  it('同じ式の控えが 2 つあれば、新しい方を使う。控えは 1 つのセッションで 20 個まで（押し出された呼び出しは、控えが無いので断る）', async () => {
    const { call, control, open } = setup();
    const page = open('http://localhost:3000/a');
    page.evaluate = () => '動いた';
    await gateOnly(control, 'x()');
    page.url = 'http://myapp.local/';
    await gateOnly(control, 'x()');
    expect(textOf(await call('evaluate', { expression: 'x()' }, 'S1', { gate: false }))).toBe('"動いた"');
    // 古い方は残る（次の呼び出しも、フックがまた見るので、新しい控えが使われる）
    expect(await call('evaluate', { expression: 'x()' }, 'S1', { gate: false })).toEqual(CHANGED('http://localhost:3000', 'http://myapp.local'));
    await gateOnly(control, 'first()');
    for (let i = 0; i < 20; i++) await gateOnly(control, `more${i}()`);
    expect(await call('evaluate', { expression: 'first()' }, 'S1', { gate: false })).toEqual(NO_RECORD);
    expect(textOf(await call('evaluate', { expression: 'more0()' }, 'S1', { gate: false }))).toBe('"動いた"');
  });

  it('同じオリジンの中で移ったあとは動かす。文の並びも、最後の値を返す（ページで動かすときと同じ）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/a');
    runIn(page, { url: 'http://localhost:3000/b', title: '次のページ' });
    expect(textOf(await call('evaluate', { expression: 'document.title' }))).toBe('"次のページ"');
    page.url = 'http://localhost:3000/a';
    expect(textOf(await call('evaluate', { expression: 'const a = 2;\nlet b = a * 3;\nb + 1' }))).toBe('7');
    // 既定のポートは、オリジンにもページの host にも付かない
    const other = open('https://myapp.local/');
    runIn(other, { url: 'https://myapp.local/x', title: 'ローカル' });
    expect(textOf(await call('evaluate', { expression: 'document.title' }))).toBe('"ローカル"');
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
      textResult("Execution failed: Uncaught TypeError: Cannot read properties of null (reading 'click')\nUncaught (in promise) だめ", true),
    );
    page.evaluate = () => {
      throw new Error('Script failed to execute');
    };
    expect(await call('evaluate', { expression: 'x' })).toEqual(textResult('Execution failed: Script failed to execute', true));
    page.evaluate = () => Promise.reject('こわれた');
    expect(await call('evaluate', { expression: 'x' })).toEqual(textResult('Execution failed: こわれた', true));
    expect(await call('evaluate', {})).toEqual(textResult('Provide expression.', true));
  });
});

describe('CDP のつなぎ方', () => {
  it('つなげなければ、理由を返す（Error でないものも）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.debugger.attachError = new Error('Another debugger is already attached to the target');
    expect(await call('get_accessibility_tree')).toEqual(
      textResult('Could not get ready to control the page (Another debugger is already attached to the target).', true),
    );
    page.debugger.attachError = 'だめ';
    expect(await call('get_accessibility_tree')).toEqual(textResult('Could not get ready to control the page (だめ).', true));
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
    expect(textOf(await call('click', { selector: '#go' }))).toBe('Clicked: button#go "送る"');
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
    expect(textOf(await call('get_text'))).toContain('--- inside iframe (http://localhost:3000/frame) ---\n中');
    page.debugger.detachNow();
    page.debugger.commands.length = 0;
    expect(textOf(await call('get_text'))).toBe('Title: T\nURL: http://localhost:3000/\n\n本文');
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
    expect(textOf(await call('get_text'))).toBe('Title: T\nURL: http://localhost:3000/\n\n本文');
    expect(page.debugger.sent('Runtime.evaluate').map((c) => c.child)).toEqual(['C1', 'C2', 'C3', 'C4']);
  });
});
