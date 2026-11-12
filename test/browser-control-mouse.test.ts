import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textResult } from '../src/main/mcp-bridge';
import { electronKeyCode, keySpec, mouseModifiers } from '../src/main/browser-control';
import { HOST } from './helpers/fake-electron';
import { addChildFrame, answerCdp, setup, textOf } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// アプリ内ブラウザの操作（src/main/browser-control.ts）のうち、マウスを乗せる（hover）・ドラッグ（drag）・修飾キー付きのクリック（click の modifiers）と、
// press_key で足したキー。ページの中のスクリプトと CDP は作り物が答え、送った CDP の命令と、Claude に返す文を確かめる

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  HOST.scripts.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

type Page = ReturnType<ReturnType<typeof setup>['open']>;

// locate（セレクタに当たる要素を探して見える位置まで動かす）の答え
const found = (rect: { x: number; y: number; width: number; height: number }, description = 'li#a "A"', covered: string | null = null) => ({
  rect,
  viewport: { width: 800, height: 600 },
  description,
  covered,
});

// マウス・ドラッグの CDP の命令（Input.*）を、送った順に
const inputs = (page: Page): Record<string, unknown>[] =>
  page.debugger.commands.filter((c) => c.method.startsWith('Input.')).map((c) => ({ method: c.method.replace(/^Input\./, ''), ...c.params, ...(c.child ? { child: c.child } : {}) }));

// 送った命令を短く（種類:x,y と、押しているボタン）
const brief = (page: Page): string[] =>
  inputs(page).map((i) => {
    if (i.method === 'setInterceptDrags') return `intercept:${String(i.enabled)}`;
    const at = `${String(i.type)}:${String(i.x)},${String(i.y)}`;
    return i.method === 'dispatchDragEvent' ? `drag ${at}` : `${at}${i.buttons === 1 ? ' (押したまま)' : ''}`;
  });

// keepHumanFocus（本物の入力のあと、人のフォーカスを戻す）を使った回数（アプリの画面で、今のフォーカスを覚えたスクリプトの数）
const focusGuards = () => HOST.scripts.filter((s) => s.includes('__tanacodeKeepFocus ??=')).length;

describe('マウスを乗せる（hover）', () => {
  it('selector: 枠を出してから、要素の真ん中へ本物のマウスを動かす（mouseMoved だけ。押さない）。人のフォーカスを守る', async () => {
    const { call, open, activities } = setup();
    const page = open('http://localhost:3000/');
    const rect = { x: 100, y: 50, width: 201, height: 40 };
    page.page.locate = () => found(rect, 'div#menu "メニュー"');
    expect(textOf(await call('hover', { selector: '#menu' }))).toBe(
      'Hovered over: div#menu "メニュー"\nThe mouse pointer stays there until the next mouse action, so take a screenshot or read the page now to see what the hover opened.',
    );
    expect(inputs(page)).toEqual([{ method: 'dispatchMouseEvent', type: 'mouseMoved', x: 201, y: 70 }]);
    // ページの中で合成するイベント（click の press）は送らない
    expect(page.scriptsOf('press')).toEqual([]);
    expect(focusGuards()).toBe(1);
    expect(activities()).toEqual([
      { sessionId: 'S1', active: true, label: 'マウスを乗せる', box: null },
      { sessionId: 'S1', active: true, label: null, box: rect },
      { sessionId: 'S1', active: true, label: null, box: null },
    ]);
  });

  it('x・y: その位置へ動かす。重なっている要素があれば添える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'canvas#c' });
    expect(textOf(await call('hover', { x: 30, y: 40 }))).toMatch(/^Hovered over: canvas#c at x=30 y=40\n/);
    expect(inputs(page)).toEqual([{ method: 'dispatchMouseEvent', type: 'mouseMoved', x: 30, y: 40 }]);
    page.debugger.commands.length = 0;
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'a#tip', 'div.overlay');
    expect(textOf(await call('hover', { selector: '#tip' }))).toContain('(another element, div.overlay, was covering the position)');
  });

  it('別オリジンの iframe（許す先・別プロセス）の中は、その iframe のセッションに、iframe の中の位置で送る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: true, src: 'http://127.0.0.1:5173/widget', frame: { x: 300, y: 200 }, description: 'iframe#w' });
    answerCdp(page, {}, { C1: 'http://127.0.0.1:5173/widget' });
    addChildFrame(page, 'C1');
    expect(textOf(await call('hover', { x: 350, y: 260 }))).toMatch(/^Hovered over: x=350 y=260 \(inside cross-origin iframe http:\/\/127\.0\.0\.1:5173\/widget\)/);
    expect(inputs(page)).toEqual([{ method: 'dispatchMouseEvent', type: 'mouseMoved', x: 50, y: 60, child: 'C1' }]);
  });

  it('selector も x・y も無い・許していない先の iframe の中・要素が無いときは動かさない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('hover', {})).toEqual(textResult('Provide selector, or x and y.', true));
    page.page.point = () => ({ cross: true, src: 'https://pay.example.com/checkout', frame: null, description: 'iframe#pay' });
    expect(textOf(await call('hover', { x: 10, y: 10 }))).toMatch(/^Cannot hover over x=10 y=10 because it is inside an iframe not allowed for Claude/);
    page.page.locate = () => ({ error: 'none' });
    expect(await call('hover', { selector: '#none' })).toEqual(textResult('No element matches "#none".', true));
    expect(inputs(page)).toEqual([]);
  });
});

describe('ドラッグ（drag）', () => {
  it('マウスのドラッグ: 押して、押したまま 5 回以上に分けて動かし、離す。HTML5 のドラッグを受け取る設定は、終えたら戻す', async () => {
    const { call, open, activities } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 90, y: 90, width: 20, height: 20 }, 'div#knob');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'div#track' });
    expect(textOf(await call('drag', { selector: '#knob', deltaX: 100, durationMs: 0 }))).toBe(
      'Dragged from div#knob to div#track at x=200 y=100 in 0 ms\n' +
        'The page did not start an HTML5 drag and drop, so it got only the pointer and mouse events of the drag (down, moves, up).',
    );
    expect(brief(page)).toEqual([
      'intercept:true',
      'mouseMoved:100,100',
      'mousePressed:100,100 (押したまま)',
      'mouseMoved:120,100 (押したまま)',
      'mouseMoved:140,100 (押したまま)',
      'mouseMoved:160,100 (押したまま)',
      'mouseMoved:180,100 (押したまま)',
      'mouseMoved:200,100 (押したまま)',
      'mouseReleased:200,100',
      'intercept:false',
    ]);
    expect(inputs(page).find((i) => i.type === 'mousePressed')).toEqual({ method: 'dispatchMouseEvent', type: 'mousePressed', x: 100, y: 100, button: 'left', buttons: 1, clickCount: 1 });
    // 押すときと離すときに、それぞれ人のフォーカスを戻す
    expect(focusGuards()).toBe(2);
    // 動かしている間、マウスの位置を枠で見せる
    expect(activities().filter((a) => a.box).map((a) => a.box)).toEqual([
      { x: 90, y: 90, width: 20, height: 20 },
      ...[120, 140, 160, 180, 200].map((x) => ({ x: x - 10, y: 90, width: 20, height: 20 })),
    ]);
  });

  it('既定は 300ms で、16ms ごとに動かす（19 回）。durationMs・holdMs は範囲の中だけ', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'div' });
    expect(textOf(await call('drag', { x: 10, y: 10, toX: 200, toY: 10 }))).toMatch(/^Dragged from div at x=10 y=10 to div at x=200 y=10 in 300 ms\n/);
    expect(inputs(page).filter((i) => i.type === 'mouseMoved' && i.buttons === 1)).toHaveLength(19);
    expect(await call('drag', { x: 10, y: 10, toX: 20, toY: 10, durationMs: 10_001 })).toEqual(textResult('durationMs must be a number from 0 to 10000: 10001', true));
    expect(await call('drag', { x: 10, y: 10, toX: 20, toY: 10, holdMs: -1 })).toEqual(textResult('holdMs must be a number from 0 to 5000: -1', true));
  });

  it('HTML5 のドラッグ＆ドロップ: ドラッグが始まったら（dragIntercepted）、残りを dragEnter・dragOver で送り、最後に drop してから離す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 90, y: 90, width: 20, height: 20 }, 'li#a "A"');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'li#c "C"' });
    const data = { items: [{ mimeType: 'text/plain', data: 'a' }], dragOperationsMask: -1 };
    answerCdp(page, {
      'Input.dispatchMouseEvent': (params) => {
        // 2 回動かしたところで、ページが dragstart を受けて、ドラッグが始まった
        if (params?.type === 'mouseMoved' && params.buttons === 1 && params.y === 120) page.debugger.message('Input.dragIntercepted', { data });
        return {};
      },
    });
    expect(textOf(await call('drag', { selector: '#a', toX: 100, toY: 200, durationMs: 0 }))).toBe(
      'Dragged from li#a "A" to li#c "C" at x=100 y=200 in 0 ms\nThe page started an HTML5 drag and drop (dragstart), so dragover and drop were sent along the way (where the page does not accept a drop, it gets no drop event: check the page to see the result).',
    );
    expect(brief(page)).toEqual([
      'intercept:true',
      'mouseMoved:100,100',
      'mousePressed:100,100 (押したまま)',
      'mouseMoved:100,120 (押したまま)',
      'drag dragEnter:100,140',
      'drag dragOver:100,140',
      'drag dragOver:100,160',
      'drag dragOver:100,180',
      'drag dragOver:100,200',
      'drag drop:100,200',
      'mouseReleased:100,200',
      'intercept:false',
    ]);
    // 受け取ったドラッグのデータを、そのまま返す
    expect(inputs(page).find((i) => i.type === 'drop')).toEqual({ method: 'dispatchDragEvent', type: 'drop', x: 100, y: 200, data });
  });

  it('最後の 1 回でドラッグが始まったら、終わりの位置で dragEnter・dragOver を送ってから drop する。ほかのセッションの知らせは見ない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'div' });
    answerCdp(page, {
      'Input.dispatchMouseEvent': (params) => {
        // 別プロセスの iframe のドラッグの知らせは、このドラッグのものではない
        if (params?.type === 'mouseMoved' && params.buttons === 1) page.debugger.emit('message', {}, 'Input.dragIntercepted', { data: { items: [] } }, 'C1');
        if (params?.type === 'mouseMoved' && params.x === 60) page.debugger.message('Input.dragIntercepted', { data: { items: [] } });
        return {};
      },
    });
    await call('drag', { x: 10, y: 10, deltaX: 50, durationMs: 0 });
    expect(brief(page).slice(-6)).toEqual(['mouseMoved:60,10 (押したまま)', 'drag dragEnter:60,10', 'drag dragOver:60,10', 'drag drop:60,10', 'mouseReleased:60,10', 'intercept:false']);
  });

  it('holdMs: 押してから、その間止めてから動かす。modifiers は、どのイベントにも付ける', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'div' });
    const at: number[] = [];
    answerCdp(page, {
      'Input.dispatchMouseEvent': (params) => {
        if (params?.type === 'mousePressed' || (params?.type === 'mouseMoved' && params.buttons === 1)) at.push(Date.now());
        return {};
      },
    });
    expect(textOf(await call('drag', { x: 10, y: 10, deltaY: 50, durationMs: 0, holdMs: 1000, modifiers: ['alt'] }))).toMatch(/^Dragged with alt from /);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(1000);
    expect(inputs(page).filter((i) => i.method === 'dispatchMouseEvent').every((i) => i.modifiers === 1)).toBe(true);
  });

  it('toSelector: 始めを見える位置まで動かしたあと、落とす先は動かさずに測る。見えている範囲の外なら断る（押さない）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = (code) =>
      code.includes('scrollIntoView') ? found({ x: 90, y: 90, width: 20, height: 20 }, 'li#a "A"') : found({ x: 290, y: 390, width: 20, height: 20 }, 'ul#done', 'li.ghost');
    expect(textOf(await call('drag', { selector: '#a', toSelector: '#done', durationMs: 0 }))).toBe(
      'Dragged from li#a "A" to ul#done in 0 ms\n' +
        'The page did not start an HTML5 drag and drop, so it got only the pointer and mouse events of the drag (down, moves, up).\n' +
        '(another element, li.ghost, was covering the drop position)',
    );
    const locates = page.scriptsOf('locate');
    expect(locates).toHaveLength(2);
    expect(locates[1]).not.toContain('scrollIntoView');
    expect(inputs(page).find((i) => i.type === 'mouseReleased')).toMatchObject({ x: 300, y: 400 });
    page.debugger.commands.length = 0;
    page.page.locate = (code) => (code.includes('scrollIntoView') ? found({ x: 90, y: 90, width: 20, height: 20 }) : found({ x: 290, y: 900, width: 20, height: 20 }, 'ul#done'));
    const refused = await call('drag', { selector: '#a', toSelector: '#done' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^The center of the element matching "#done" \(x=300 y=910\) is outside the visible area \(800×600\) after scrolling the start into view\./);
    expect(inputs(page).filter((i) => i.method === 'dispatchMouseEvent')).toEqual([]);
  });

  it('落とす先が無い・始めが無い・知らない修飾キーのときは断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('drag', { selector: '#a' })).toEqual(textResult('Provide where to drag to: toSelector, toX and toY, or deltaX or deltaY.', true));
    expect(await call('drag', { toX: 1, toY: 1 })).toEqual(textResult('Provide selector, or x and y.', true));
    expect(await call('drag', { x: 1, y: 1, deltaX: 5, modifiers: ['hyper'] })).toEqual(textResult('Unknown modifier: hyper (use shift, control, alt or meta).', true));
    page.page.point = () => ({ error: 'outside', width: 800, height: 600 });
    expect(await call('drag', { x: 1, y: 1, toX: 900, toY: 1 })).toEqual(textResult('x=1 y=1 is outside the visible area (800×600).', true));
    expect(inputs(page).filter((i) => i.method === 'dispatchMouseEvent')).toEqual([]);
  });

  it('別オリジンの iframe（別プロセス）の中は、その iframe のセッションに、中の位置で送る。始めと終わりが別のフレームなら断る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    // iframe の中身の左上は (300, 200)。中で (350, 260) → (390, 260)
    page.page.point = () => ({ cross: true, src: 'http://127.0.0.1:5173/widget', frame: { x: 300, y: 200 }, description: 'iframe#w' });
    answerCdp(page, {}, { C1: 'http://127.0.0.1:5173/widget' });
    addChildFrame(page, 'C1');
    await call('drag', { x: 350, y: 260, deltaX: 40, durationMs: 0 });
    const sent = inputs(page);
    expect(sent.every((i) => i.child === 'C1')).toBe(true);
    expect(sent.find((i) => i.type === 'mousePressed')).toMatchObject({ x: 50, y: 60 });
    expect(sent.find((i) => i.type === 'mouseReleased')).toMatchObject({ x: 90, y: 60 });
    page.debugger.commands.length = 0;
    // 終わりが iframe の外
    page.page.point = (code) =>
      code.includes('const x = 350,')
        ? { cross: true, src: 'http://127.0.0.1:5173/widget', frame: { x: 300, y: 200 }, description: 'iframe#w' }
        : { cross: false, src: null, frame: null, description: 'div#out' };
    expect(await call('drag', { x: 350, y: 260, toX: 10, toY: 10 })).toEqual(textResult('A drag inside a cross-origin iframe must start and end in the same iframe.', true));
    expect(inputs(page).filter((i) => i.method === 'dispatchMouseEvent')).toEqual([]);
  });

  it('許していない先の iframe の中へは落とさない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = (code) =>
      code.includes('const x = 10,') ? { cross: false, src: null, frame: null, description: 'li#a' } : { cross: true, src: 'https://pay.example.com/', frame: null, description: 'iframe#pay' };
    const refused = await call('drag', { x: 10, y: 10, toX: 300, toY: 300 });
    expect(textOf(refused)).toMatch(/^Cannot drag to x=300 y=300 because it is inside an iframe not allowed for Claude/);
    expect(inputs(page)).toEqual([]);
  });

  it('途中で失敗しても、ボタンを押したままにせず、受け取る設定も戻す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'div' });
    answerCdp(page, {
      'Input.dispatchMouseEvent': (params) => {
        if (params?.type === 'mouseMoved' && params.buttons === 1) throw new Error('Target closed');
        return {};
      },
    });
    expect((await call('drag', { x: 10, y: 10, deltaX: 50, durationMs: 0 })).isError).toBe(true);
    expect(brief(page).slice(-2)).toEqual(['mouseReleased:60,10', 'intercept:false']);
  });

  it('受け取る設定ができなくても（CDP が対応していない）、ドラッグは続ける', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'div' });
    answerCdp(page, {
      'Input.setInterceptDrags': () => {
        throw new Error("'Input.setInterceptDrags' wasn't found");
      },
    });
    expect(textOf(await call('drag', { x: 10, y: 10, deltaX: 50, durationMs: 0 }))).toMatch(/^Dragged from /);
    // 戻す設定は送らない
    expect(brief(page).filter((b) => b.startsWith('intercept'))).toEqual(['intercept:true']);
  });
});

describe('修飾キー付きのクリック（click の modifiers）', () => {
  it('ページの中で押すときは、イベントに shiftKey などを付ける。結果に押したキーを添える', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'a#link "次へ"');
    expect(textOf(await call('click', { selector: '#link', modifiers: ['meta', 'shift'] }))).toBe('Clicked with meta+shift: a#link "次へ"');
    const press = page.scriptsOf('press');
    expect(press).toHaveLength(1);
    expect(press[0]).toContain('...{"shiftKey":true,"ctrlKey":false,"altKey":false,"metaKey":true}');
    expect(inputs(page)).toEqual([]);
  });

  it('修飾キーが無ければ、どれも false（前と同じ押し方）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'button#go');
    expect(textOf(await call('click', { selector: '#go' }))).toBe('Clicked: button#go');
    expect(page.scriptsOf('press')[0]).toContain('...{"shiftKey":false,"ctrlKey":false,"altKey":false,"metaKey":false}');
  });

  it('本物の押下では、Input.dispatchMouseEvent の modifiers のビット（alt 1・control 2・meta 4・shift 8）を付ける', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'li#row');
    expect(textOf(await call('click', { selector: '#row', modifiers: ['shift', 'meta'], real: true }))).toBe('Clicked with shift+meta: li#row (with a real mouse press, as requested)');
    expect(inputs(page).map((i) => `${String(i.type)}:${String(i.modifiers)}`)).toEqual(['mouseMoved:12', 'mousePressed:12', 'mouseReleased:12']);
    page.debugger.commands.length = 0;
    await call('click', { selector: '#row', modifiers: ['control'], button: 'right' });
    expect(inputs(page).map((i) => i.modifiers)).toEqual([2, 2, 2]);
  });

  it('⌘ でリンクが新しいタブで開いたら（background-tab）、Claude の操作なので前に出し、そのタブを今のタブにしたことを伝える', async () => {
    const { call, open, control, sentOn } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'a#link "次へ"');
    page.page.press = () => {
      control.openFromPage(page as never, 'http://localhost:3000/next', 'background-tab');
      return { real: null };
    };
    const result = textOf(await call('click', { selector: '#link', modifiers: ['meta'] }));
    expect(result).toContain('Clicked with meta: a#link "次へ"');
    expect(result).toContain('Opened in a new tab (tab 2): http://localhost:3000/next. Further actions apply to this tab');
    expect(sentOn<{ background: boolean }>('browser:new-tab').map((n) => n.background)).toEqual([false]);
  });

  it('mouseModifiers: 別名（cmd・ctrl・option など）をそろえ、重なりを除く。知らない名前・並びでないものは断る', () => {
    expect(mouseModifiers(undefined)).toEqual([]);
    expect(mouseModifiers(['Cmd', 'ctrl', 'Option', 'SHIFT', 'command', '⌘'])).toEqual(['meta', 'control', 'alt', 'shift']);
    expect(() => mouseModifiers(['toString'])).toThrow('Unknown modifier: toString (use shift, control, alt or meta).');
    expect(() => mouseModifiers([1])).toThrow('Unknown modifier: 1');
    expect(() => mouseModifiers('meta')).toThrow('modifiers must be a list of shift, control, alt and meta.');
  });

  it('知らない修飾キーなら押さない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 });
    expect(await call('click', { selector: '#a', modifiers: ['fn'] })).toEqual(textResult('Unknown modifier: fn (use shift, control, alt or meta).', true));
    expect(page.scriptsOf('press')).toEqual([]);
  });
});

describe('足したキー（press_key）', () => {
  it('keySpec: Insert・CapsLock・NumLock・ScrollLock・PrintScreen・テンキー・F13〜F24', () => {
    expect(keySpec('Insert')).toEqual({ key: 'Insert', code: 'Insert', keyCode: 45 });
    expect(keySpec('capslock')).toEqual({ key: 'CapsLock', code: 'CapsLock', keyCode: 20 });
    expect(keySpec('NumLock')).toEqual({ key: 'NumLock', code: 'NumLock', keyCode: 144 });
    expect(keySpec('ScrollLock')).toEqual({ key: 'ScrollLock', code: 'ScrollLock', keyCode: 145 });
    expect(keySpec('PrintScreen')).toEqual({ key: 'PrintScreen', code: 'PrintScreen', keyCode: 44 });
    expect(keySpec('Numpad0')).toEqual({ key: '0', code: 'Numpad0', keyCode: 96, text: '0', electron: 'num0' });
    expect(keySpec('Numpad9')).toEqual({ key: '9', code: 'Numpad9', keyCode: 105, text: '9', electron: 'num9' });
    expect(keySpec('NumpadAdd')).toEqual({ key: '+', code: 'NumpadAdd', keyCode: 107, text: '+', electron: 'numadd' });
    expect(keySpec('NumpadSubtract')?.electron).toBe('numsub');
    expect(keySpec('NumpadMultiply')?.electron).toBe('nummult');
    expect(keySpec('NumpadDivide')?.electron).toBe('numdiv');
    expect(keySpec('NumpadDecimal')?.electron).toBe('numdec');
    expect(keySpec('F13')).toEqual({ key: 'F13', code: 'F13', keyCode: 124 });
    expect(keySpec('f24')).toEqual({ key: 'F24', code: 'F24', keyCode: 135 });
    expect(keySpec('F25')).toBeNull();
    // テンキーは、上の段の数字（Digit）にしない
    expect(electronKeyCode(keySpec('Numpad5')!)).toBe('num5');
    expect(electronKeyCode(keySpec('5')!)).toBe('5');
    expect(electronKeyCode(keySpec('Insert')!)).toBe('Insert');
  });

  it('テンキーの数字は、ページそのものに、テンキーの名前で送り、文字も入れる', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('press_key', { key: 'Numpad5' })).toEqual(textResult('Pressed Numpad5'));
    expect(page.debugger.sent('Electron.sendInputEvent').map((c) => c.params)).toEqual([
      { type: 'keyDown', keyCode: 'num5', modifiers: [] },
      { type: 'char', keyCode: '5', modifiers: [] },
      { type: 'keyUp', keyCode: 'num5', modifiers: [] },
    ]);
  });
});

// Claude が操作するタブのページを、フォーカスがある扱いにする（focusPage）。そうしないと、ページはフォーカスの無いウインドウの扱いで、
// 欄の focus・blur・focusin・focusout が出ない（欄から出たときに処理が走るフォームが動かない）。イベントが届くことは
// test/e2e/browser-focus.test.ts が確かめる
describe('ページをフォーカスがある扱いにする（Emulation.setFocusEmulationEnabled）', () => {
  const focusCommands = (page: Page) => page.debugger.sent('Emulation.setFocusEmulationEnabled').map((c) => (c.params as { enabled: boolean }).enabled);

  it('入力する操作の前に 1 回だけ付ける（本物の押下より前）。読むだけのツールでは付けない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.text = () => ({ title: 'T', url: 'http://localhost:3000/', parts: [{ frame: null, text: '本文' }] });
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'input#code');
    await call('get_text');
    expect(focusCommands(page)).toEqual([]);
    expect(textOf(await call('click', { selector: '#code' }))).toBe('Clicked: input#code');
    expect(focusCommands(page)).toEqual([true]);
    await call('click', { selector: '#code', real: true });
    await call('type', { text: 'A01' });
    expect(focusCommands(page)).toEqual([true]);
    const methods = page.debugger.commands.map((c) => c.method);
    expect(methods.indexOf('Emulation.setFocusEmulationEnabled')).toBeLessThan(methods.indexOf('Input.dispatchMouseEvent'));
  });

  it('最後の入力する操作から 10 分たったら外す（隠れたタブを描き続けないため）。そのあとの操作で、また付ける', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'input#code');
    await call('click', { selector: '#code' });
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    // 途中の操作で、数え直す
    await call('type', { text: 'A' });
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(focusCommands(page)).toEqual([true]);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(focusCommands(page)).toEqual([true, false]);
    await call('click', { selector: '#code' });
    expect(focusCommands(page)).toEqual([true, false, true]);
  });

  it('CDP が外れたら（DevTools を開いた など。扱いも消える）、次の操作で付け直す。外れたあとは、外す命令を送らない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'input#code');
    await call('click', { selector: '#code' });
    page.debugger.detachNow();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(focusCommands(page)).toEqual([true]);
    await call('click', { selector: '#code' });
    expect(focusCommands(page)).toEqual([true, true]);
  });

  it('付けられなくても（CDP が断る）、操作は続ける', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.locate = () => found({ x: 0, y: 0, width: 10, height: 10 }, 'input#code');
    page.debugger.handler = (method) => {
      if (method === 'Emulation.setFocusEmulationEnabled') throw new Error('使えない命令です');
      return {};
    };
    expect(textOf(await call('click', { selector: '#code' }))).toBe('Clicked: input#code');
  });
});
