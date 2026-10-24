import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_DEVICES } from '../src/shared/browser-tools';
import { IpcChannel, type BrowserThrottleChange, type BrowserViewportChange } from '../src/shared/ipc';
import { textResult } from '../src/main/mcp-bridge';
import { FakeImage, HOST, images } from './helpers/fake-electron';
import { answerCdp, setup, textOf } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// アプリ内ブラウザの操作（src/main/browser-control.ts）のうち、スマホ向けのページを確かめるもの。
// 画面の大きさ（set_viewport の機種・数字）・タッチ（touch）・遅くする（throttle）・スクリーンショットの撮り直しと保存（screenshot）。
// CDP とアプリの画面は作り物が答え、送った CDP の命令と画面への知らせ、Claude に返す文を確かめる。本物の webview で動くかは test/e2e/browser-mobile.test.ts

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  images.buffers.length = 0;
  images.fromBuffer = new FakeImage(800, 2000, 'fullPage');
  HOST.webviewAt = { x: 0, y: 0 };
  HOST.zoom = 1;
  HOST.scripts.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

type Page = ReturnType<ReturnType<typeof setup>['open']>;

// CDP の命令のうち、名前が prefix で始まるもの（つなぐ準備の Target.setAutoAttach を除く）
const commands = (page: Page, prefix: string): ({ method: string } & Record<string, unknown>)[] =>
  page.debugger.commands.filter((c) => c.method.startsWith(prefix)).map((c) => ({ method: c.method, ...c.params }));
// 送ったタッチ（種類と指の位置）
const touches = (page: Page) =>
  page.debugger
    .sent('Input.dispatchTouchEvent')
    .map((c) => ({ type: c.params!.type, points: (c.params!.touchPoints as { x: number; y: number }[]).map((p) => [p.x, p.y]), ...(c.child ? { child: c.child } : {}) }));
// x・y の位置にある要素の答え（同じオリジンの、ふつうの要素）
const plain = (page: Page) => {
  page.page.point = () => ({ cross: false, src: null, frame: null, description: 'div' });
  return page;
};
const found = (rect: { x: number; y: number; width: number; height: number }) => ({ rect, viewport: { width: 393, height: 852 }, description: 'div#pad', covered: null });

describe('画面の大きさ（set_viewport の機種・数字）', () => {
  it('機種の名前: CDP で、その機種の大きさ・画素密度・タッチにし、画面には枠の大きさと機種の名前を送る', async () => {
    const { call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    page.page.viewport = () => ({ width: 393, height: 852, dpr: 3 });
    const result = await call('set_viewport', { device: 'iphone 15' });
    expect(commands(page, 'Emulation.')).toEqual([
      { method: 'Emulation.setDeviceMetricsOverride', width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
      { method: 'Emulation.setTouchEmulationEnabled', enabled: true, maxTouchPoints: 5 },
    ]);
    expect(sentOn<BrowserViewportChange>(IpcChannel.BrowserViewport)).toEqual([
      { sessionId: 'S1', width: 393, custom: { height: 852, deviceScaleFactor: 3, device: 'iPhone 15' } },
    ]);
    expect(textOf(result)).toBe(
      'Set the viewport to iPhone 15 393×852 @3x as a mobile device with touch support. The page now sees innerWidth 393, innerHeight 852 and devicePixelRatio 3. ' +
        'This applies to every tab of this session (also tabs opened later) and stays across reloads and navigations, until you call set_viewport with width full, mobile or tablet, or the user picks a width in the toolbar.',
    );
  });

  it('数字: 幅・高さ・画素密度をそのまま使う。タッチは mobile を渡したときだけ。高さを渡さなければ、枠の高さのまま（0）', async () => {
    const { call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    expect(textOf(await call('set_viewport', { width: 390, height: 844, deviceScaleFactor: 3 }))).toContain('Set the viewport to 390×844 @3x. ');
    await call('set_viewport', { width: 500 });
    await call('set_viewport', { width: 'mobile', deviceScaleFactor: 2, mobile: true });
    expect(commands(page, 'Emulation.setDeviceMetricsOverride')).toEqual([
      { method: 'Emulation.setDeviceMetricsOverride', width: 390, height: 844, deviceScaleFactor: 3, mobile: false },
      { method: 'Emulation.setDeviceMetricsOverride', width: 500, height: 0, deviceScaleFactor: 0, mobile: false },
      { method: 'Emulation.setDeviceMetricsOverride', width: 390, height: 0, deviceScaleFactor: 2, mobile: true },
    ]);
    expect(commands(page, 'Emulation.setTouchEmulationEnabled').map((c) => c.enabled)).toEqual([false, false, true]);
    expect(sentOn<BrowserViewportChange>(IpcChannel.BrowserViewport).map((c) => c.custom)).toEqual([
      { height: 844, deviceScaleFactor: 3, device: null },
      { height: 0, deviceScaleFactor: 0, device: null },
      { height: 0, deviceScaleFactor: 2, device: null },
    ]);
  });

  it('機種と数字を一緒に渡したら、数字のほうを使う（横向きにする など）', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(textOf(await call('set_viewport', { device: 'iPhone 15', width: 852, height: 393 }))).toContain('Set the viewport to iPhone 15 852×393 @3x as a mobile device');
    expect(commands(page, 'Emulation.setDeviceMetricsOverride')).toEqual([{ method: 'Emulation.setDeviceMetricsOverride', width: 852, height: 393, deviceScaleFactor: 3, mobile: true }]);
  });

  it('同じ大きさを当て直すときは、CDP に送らない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    await call('set_viewport', { device: 'Pixel 7' });
    await call('set_viewport', { device: 'Pixel 7' });
    await call('get_text');
    expect(commands(page, 'Emulation.')).toHaveLength(2);
  });

  it('知らない機種・範囲の外の数字は断り、画面にも CDP にも送らない。機種の名前の一覧を添える', async () => {
    const { call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('set_viewport', { device: 'Nokia 3310' })).toEqual(
      textResult(`Unknown device: Nokia 3310. Choose one of ${BROWSER_DEVICES.map((d) => d.name).join(', ')}, or pass width, height and deviceScaleFactor.`, true),
    );
    expect(await call('set_viewport', { width: 50 })).toEqual(textResult('width must be a number from 100 to 4000: 50', true));
    expect(await call('set_viewport', { width: 390, height: Number.NaN })).toEqual(textResult('height must be a number from 100 to 4000: NaN', true));
    expect(await call('set_viewport', { width: 390, deviceScaleFactor: 8 })).toEqual(textResult('deviceScaleFactor must be a number from 0.5 to 5: 8', true));
    expect(await call('set_viewport', { width: 390, mobile: 'yes' })).toEqual(textResult('mobile must be true or false: yes', true));
    expect(await call('set_viewport', { width: true })).toEqual(textResult('width must be full, mobile or tablet, or a number: true', true));
    expect(sentOn(IpcChannel.BrowserViewport)).toEqual([]);
    expect(commands(page, 'Emulation.')).toEqual([]);
  });

  it('full・mobile・tablet だけなら、前と同じく幅だけを変え、CDP はつながない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    await call('set_viewport', { width: 'mobile' });
    expect(page.debugger.attachCount).toBe(0);
  });

  it('セッションのどのタブにも当てる（あとで開いたタブにも）。full・mobile・tablet で、どのタブでもやめる', async () => {
    const { call, open, sentOn } = setup();
    const first = open('http://localhost:3000/');
    const second = open('http://localhost:3001/', { activate: false });
    await call('set_viewport', { device: 'iPad mini' });
    const later = open('http://localhost:3002/', { activate: false });
    // CDP をつないで少し待ってから当てる
    await vi.advanceTimersByTimeAsync(300);
    for (const page of [first, second, later]) {
      expect(commands(page, 'Emulation.setDeviceMetricsOverride'), page.url).toEqual([
        { method: 'Emulation.setDeviceMetricsOverride', width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
      ]);
    }
    // ほかのセッションのタブには当てない
    const other = open('http://localhost:3003/', { sessionId: 'S2' });
    expect(other.debugger.attachCount).toBe(0);
    await call('set_viewport', { width: 'tablet' });
    for (const page of [first, second, later]) {
      expect(commands(page, 'Emulation.').slice(-2), page.url).toEqual([
        { method: 'Emulation.clearDeviceMetricsOverride' },
        { method: 'Emulation.setTouchEmulationEnabled', enabled: false },
      ]);
    }
    expect(sentOn<BrowserViewportChange>(IpcChannel.BrowserViewport).at(-1)).toEqual({ sessionId: 'S1', width: 768 });
  });

  it('人がツールバーで表示幅を選んだら（resetViewport）、どのタブでもやめ、あとで開いたタブにも当てない', async () => {
    const { call, control, open } = setup();
    const page = open('http://localhost:3000/');
    await call('set_viewport', { device: 'iPhone SE' });
    control.resetViewport('S1');
    await vi.advanceTimersByTimeAsync(0);
    expect(commands(page, 'Emulation.').slice(-2).map((c) => c.method)).toEqual(['Emulation.clearDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled']);
    const later = open('http://localhost:3001/', { activate: false });
    await vi.advanceTimersByTimeAsync(300);
    expect(later.debugger.attachCount).toBe(0);
    // 知らないセッションでは何もしない
    control.resetViewport('S9');
  });

  it('当て直せなくても（CDP をつなげない）、読むツールは止めない。つなげるようになったら当て直す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.page.text = () => ({ title: 'ページ', url: 'http://localhost:3000/', parts: [{ frame: null, text: '本文' }] });
    await call('set_viewport', { device: 'iPhone 14' });
    page.debugger.detachNow();
    page.debugger.attachError = new Error('Another debugger is already attached');
    expect(textOf(await call('get_text'))).toContain('本文');
    page.debugger.attachError = null;
    await call('get_text');
    expect(commands(page, 'Emulation.setDeviceMetricsOverride')).toHaveLength(2);
  });

  it('mobile: false だけ（数字なし）は、幅だけの切り替えとして扱う。mobile: true だけなら、枠の大きさのままタッチの画面にする', async () => {
    const { call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    expect(textOf(await call('set_viewport', { width: 'full', mobile: false }))).toBe('Set the viewport to full (page width 800px, height 600px)');
    expect(page.debugger.attachCount).toBe(0);
    await call('set_viewport', { mobile: true });
    expect(commands(page, 'Emulation.setDeviceMetricsOverride')).toEqual([{ method: 'Emulation.setDeviceMetricsOverride', width: 0, height: 0, deviceScaleFactor: 0, mobile: true }]);
    expect(sentOn<BrowserViewportChange>(IpcChannel.BrowserViewport)).toEqual([
      { sessionId: 'S1', width: 0 },
      { sessionId: 'S1', width: 0, custom: { height: 0, deviceScaleFactor: 0, device: null } },
    ]);
  });

  it('CDP が外れて消えたら、次にそのタブを操作するときに当て直す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    await call('set_viewport', { device: 'iPhone 14' });
    page.debugger.detachNow();
    await call('get_text');
    expect(commands(page, 'Emulation.setDeviceMetricsOverride')).toHaveLength(2);
  });
});

describe('タッチ（touch）', () => {
  it('タップ: 要素の真ん中に、アプリのウインドウの中の位置（webview の左上を足す）で、指を置いて離す。指の位置を画面に見せる', async () => {
    const { call, open, activities } = setup();
    const page = plain(open('http://localhost:3000/'));
    page.page.locate = () => found({ x: 0, y: 0, width: 240, height: 240 });
    HOST.webviewAt = { x: 1064.5, y: 160 };
    const result = await call('touch', { action: 'tap', selector: '#pad' });
    expect(textOf(result)).toBe('Tapped: div#pad');
    expect(touches(page)).toEqual([
      { type: 'touchStart', points: [[1184.5, 280]] },
      { type: 'touchEnd', points: [] },
    ]);
    expect(HOST.scripts).toHaveLength(1);
    expect(HOST.scripts[0]).toContain('webview[data-tab-id="tab-1"]');
    // 指の位置は、タブの中の位置で見せる（画面はタブの上に重ねる）
    expect(activities().filter((a) => a.touches)).toEqual([{ sessionId: 'S1', active: true, label: null, box: null, touches: [{ x: 120, y: 120 }] }]);
    // 終わったら、指の丸は消す
    expect(activities().at(-1)).toEqual({ sessionId: 'S1', active: true, label: null, box: null });
  });

  it('アプリの画面を拡大しているとき: webview の左上はそのまま。タブの中の位置は、大きさを決めたタブでだけ倍率で割る（実機で測った決まり）', async () => {
    const { call, open } = setup();
    const page = plain(open('http://localhost:3000/'));
    HOST.webviewAt = { x: 100, y: 50 };
    HOST.zoom = 1.25;
    await call('touch', { action: 'tap', x: 10, y: 20 });
    expect(touches(page)[0]).toEqual({ type: 'touchStart', points: [[110, 70]] });
    await call('set_viewport', { device: 'iPhone 15' });
    page.debugger.commands.length = 0;
    await call('touch', { action: 'tap', x: 10, y: 20 });
    expect(touches(page)[0]).toEqual({ type: 'touchStart', points: [[108, 66]] });
  });

  it('2 本指のタップ: 横に 40px 離して 2 本置く', async () => {
    const { call, open } = setup();
    const page = plain(open('http://localhost:3000/'));
    expect(textOf(await call('touch', { action: 'tap', x: 100, y: 100, fingers: 2 }))).toBe('Tapped with two fingers: div at x=100 y=100');
    expect(touches(page)[0]).toEqual({ type: 'touchStart', points: [[80, 100], [120, 100]] });
  });

  it('長押し: 指を置いたまま durationMs（既定 800 ミリ秒）待ってから離す', async () => {
    const { control, open } = setup();
    const page = plain(open('http://localhost:3000/'));
    const pending = control.handle('S1', 'touch', { action: 'long_press', x: 50, y: 60 });
    // 指を置く場所を見せてから（400 ミリ秒）、CDP をつないで（150 ミリ秒）置く
    await vi.advanceTimersByTimeAsync(600);
    expect(touches(page).map((t) => t.type)).toEqual(['touchStart']);
    await vi.advanceTimersByTimeAsync(700);
    expect(touches(page).map((t) => t.type)).toEqual(['touchStart']);
    await vi.advanceTimersByTimeAsync(150);
    expect(touches(page).map((t) => t.type)).toEqual(['touchStart', 'touchEnd']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(textOf(await pending)).toBe('Long-pressed for 800 ms: div at x=50 y=60');
  });

  it('なぞる: 16 ミリ秒ごとに少しずつ動かし、行き先で離す。deltaX・deltaY でも行き先を決められる。動かすあいだの指も見せる', async () => {
    const { call, open, activities } = setup();
    const page = plain(open('http://localhost:3000/'));
    const result = await call('touch', { action: 'swipe', x: 40, y: 120, deltaX: 150, durationMs: 160 });
    expect(textOf(result)).toBe('Swiped from x=40 y=120 to x=190 y=120 in 160 ms: div at x=40 y=120');
    const sent = touches(page);
    expect(sent[0]).toEqual({ type: 'touchStart', points: [[40, 120]] });
    expect(sent.filter((t) => t.type === 'touchMove')).toHaveLength(10);
    expect(sent.at(-2)).toEqual({ type: 'touchMove', points: [[190, 120]] });
    expect(sent.at(-1)).toEqual({ type: 'touchEnd', points: [] });
    expect(activities().filter((a) => a.touches).at(-1)?.touches).toEqual([{ x: 190, y: 120 }]);
    // 2 本指で、上へ
    await call('touch', { action: 'swipe', x: 100, y: 300, toX: 100, toY: 100, fingers: 2, durationMs: 0 });
    const moves = touches(page).slice(sent.length);
    expect(moves.filter((t) => t.type === 'touchMove')).toHaveLength(5);
    expect(moves.at(-2)).toEqual({ type: 'touchMove', points: [[80, 100], [120, 100]] });
  });

  it('ピンチ: 2 本の指を、広げる（scale が 1 より大きい）か寄せる（1 より小さい）', async () => {
    const { call, open } = setup();
    const page = plain(open('http://localhost:3000/'));
    expect(textOf(await call('touch', { action: 'pinch', x: 200, y: 200, scale: 2 }))).toBe('Pinched (scale 2: the fingers moved from 100px to 200px apart in 300 ms): div at x=200 y=200');
    let sent = touches(page);
    expect(sent[0]).toEqual({ type: 'touchStart', points: [[150, 200], [250, 200]] });
    expect(sent.at(-2)).toEqual({ type: 'touchMove', points: [[100, 200], [300, 200]] });
    page.debugger.commands.length = 0;
    expect(textOf(await call('touch', { action: 'pinch', x: 200, y: 200, scale: 0.5 }))).toContain('from 200px to 100px apart');
    sent = touches(page);
    expect(sent[0]).toEqual({ type: 'touchStart', points: [[100, 200], [300, 200]] });
    expect(sent.at(-2)).toEqual({ type: 'touchMove', points: [[150, 200], [250, 200]] });
  });

  it('入力の誤りは、指を置く前に断る', async () => {
    const { call, open } = setup();
    const page = plain(open('http://localhost:3000/'));
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'Provide action.'],
      [{ action: 'flick', x: 1, y: 1 }, 'action must be tap, long_press, swipe or pinch: flick'],
      [{ action: 'tap' }, 'Provide selector, or x and y.'],
      [{ action: 'tap', x: 1, y: 1, fingers: 3 }, 'fingers must be 1 or 2: 3'],
      [{ action: 'long_press', x: 1, y: 1, fingers: 2 }, 'fingers 2 is only for tap and swipe.'],
      [{ action: 'pinch', x: 1, y: 1, fingers: 2, scale: 2 }, 'fingers 2 is only for tap and swipe (pinch always uses two fingers).'],
      [{ action: 'swipe', x: 1, y: 1 }, 'swipe needs toX and toY, or deltaX or deltaY.'],
      [{ action: 'swipe', x: 1, y: 1, toX: 'left' }, 'toX must be a number: left'],
      [{ action: 'pinch', x: 1, y: 1 }, 'pinch needs scale (above 1 moves the fingers apart, below 1 moves them together).'],
      [{ action: 'pinch', x: 1, y: 1, scale: 50 }, 'scale must be a number from 0.1 to 10: 50'],
      [{ action: 'long_press', x: 1, y: 1, durationMs: 60_000 }, 'durationMs must be a number from 0 to 10000: 60000'],
    ];
    for (const [args, error] of cases) expect(await call('touch', args), JSON.stringify(args)).toEqual(textResult(error, true));
    expect(touches(page)).toEqual([]);
  });

  it('アプリの画面にタブが見つからなければ、送らずに断る', async () => {
    const { call, open } = setup();
    const page = plain(open('http://localhost:3000/'));
    HOST.webviewAt = null;
    expect(await call('touch', { action: 'tap', x: 1, y: 1 })).toEqual(textResult('Could not find this tab in the tanacode window, so the touch was not sent.', true));
    expect(touches(page)).toEqual([]);
  });

  it('タッチでページが移ったら、そう伝える', async () => {
    const { call, open } = setup();
    const page = plain(open('http://localhost:3000/'));
    page.debugger.handler = (method, params) => {
      if (method === 'Input.dispatchTouchEvent' && params?.type === 'touchEnd') page.url = 'http://localhost:3000/next';
      return {};
    };
    expect(textOf(await call('touch', { action: 'tap', x: 5, y: 5 }))).toBe('Tapped: div at x=5 y=5\nThe page navigated to http://localhost:3000/next');
  });
});

describe('遅くする（throttle）', () => {
  it('CPU と通信を遅くし、画面に知らせる。読み込み直しても残ることと、やめ方を伝える', async () => {
    const { call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    const result = await call('throttle', { cpu: 4, network: 'slow-3g' });
    expect(commands(page, 'Emulation.setCPUThrottlingRate')).toEqual([{ method: 'Emulation.setCPUThrottlingRate', rate: 4 }]);
    expect(commands(page, 'Network.')).toEqual([{ method: 'Network.emulateNetworkConditions', offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 }]);
    expect(sentOn<BrowserThrottleChange>(IpcChannel.BrowserThrottle)).toEqual([{ sessionId: 'S1', tabId: 'tab-1', cpu: 4, network: 'slow-3g' }]);
    expect(textOf(result)).toBe(
      'Slowed down the current tab: CPU 4× slower, network slow-3g (latency 2000 ms, download 400 kbps, upload 400 kbps). ' +
        'It stays across reloads and navigations in this tab (reload with navigate action "reload" to measure the start of the page), ' +
        'until you turn it off with throttle (cpu 1, network off), the user turns it off in the toolbar, or the tab is closed. Turn it off when you are done.',
    );
  });

  it('渡さなかったほうは今のまま。変わったものだけを CDP に送る。両方やめたら、そう伝える', async () => {
    const { call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    await call('throttle', { network: 'offline' });
    expect(textOf(await call('throttle', { cpu: 6 }))).toContain('CPU 6× slower, network offline.');
    expect(textOf(await call('throttle', { network: 'off' }))).toContain('CPU 6× slower, network not slowed down.');
    expect(textOf(await call('throttle', { cpu: 1 }))).toBe('The current tab is no longer slowed down (CPU not slowed down, network not slowed down).');
    expect(commands(page, 'Emulation.setCPUThrottlingRate').map((c) => c.rate)).toEqual([6, 1]);
    expect(commands(page, 'Network.')).toEqual([
      { method: 'Network.emulateNetworkConditions', offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      { method: 'Network.emulateNetworkConditions', offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    ]);
    expect(sentOn<BrowserThrottleChange>(IpcChannel.BrowserThrottle).map(({ cpu, network }) => [cpu, network])).toEqual([
      [1, 'offline'],
      [6, 'offline'],
      [6, null],
      [1, null],
    ]);
  });

  it('入力の誤りは断り、CDP に送らない', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    expect(await call('throttle', {})).toEqual(textResult('Provide cpu or network.', true));
    expect(await call('throttle', { cpu: 0.5 })).toEqual(textResult('cpu must be a number from 1 to 20: 0.5', true));
    expect(await call('throttle', { cpu: 30 })).toEqual(textResult('cpu must be a number from 1 to 20: 30', true));
    expect(await call('throttle', { network: '5g' })).toEqual(textResult('network must be off, slow-3g, 3g, 4g, offline: 5g', true));
    expect(await call('throttle', { network: 'toString' })).toEqual(textResult('network must be off, slow-3g, 3g, 4g, offline: toString', true));
    expect(commands(page, 'Emulation.')).toEqual([]);
    expect(commands(page, 'Network.')).toEqual([]);
  });

  it('タブごと: 今のタブだけを遅くする', async () => {
    const { call, open } = setup();
    const first = open('http://localhost:3000/');
    await call('throttle', { cpu: 4 });
    const second = open('http://localhost:3001/');
    await call('throttle', { cpu: 2 });
    expect(commands(first, 'Emulation.setCPUThrottlingRate').map((c) => c.rate)).toEqual([4]);
    expect(commands(second, 'Emulation.setCPUThrottlingRate').map((c) => c.rate)).toEqual([2]);
  });

  it('人がツールバーでやめた（clearThrottle）', async () => {
    const { call, control, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    await call('throttle', { cpu: 4, network: '3g' });
    control.clearThrottle('S1', 'tab-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(commands(page, 'Emulation.setCPUThrottlingRate').at(-1)).toEqual({ method: 'Emulation.setCPUThrottlingRate', rate: 1 });
    expect(commands(page, 'Network.').at(-1)).toEqual({ method: 'Network.emulateNetworkConditions', offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    expect(sentOn<BrowserThrottleChange>(IpcChannel.BrowserThrottle).at(-1)).toEqual({ sessionId: 'S1', tabId: 'tab-1', cpu: 1, network: null });
    // 知らないタブでは何もしない
    control.clearThrottle('S1', 'tab-9');
  });

  it('CDP が外れたら遅くするのも消えるので、画面に知らせる', async () => {
    const { call, open, sentOn } = setup();
    const page = open('http://localhost:3000/');
    await call('throttle', { cpu: 4 });
    page.debugger.detachNow();
    expect(sentOn<BrowserThrottleChange>(IpcChannel.BrowserThrottle).at(-1)).toEqual({ sessionId: 'S1', tabId: 'tab-1', cpu: 1, network: null });
    // 遅くしていなければ、知らせない
    const count = sentOn(IpcChannel.BrowserThrottle).length;
    page.debugger.detachNow();
    expect(sentOn(IpcChannel.BrowserThrottle)).toHaveLength(count);
  });
});

describe('スクリーンショットの撮り直しと保存', () => {
  it('capturePage が例外になっても、少しの間、撮り直す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    let taken = 0;
    page.capture = async () => {
      if (++taken < 3) throw new Error('UnknownVizError');
      return page.shot;
    };
    expect(textOf(await call('screenshot'))).toBe('Visible area, http://localhost:3000/, image 800×600');
    expect(taken).toBe(3);
  });

  it('撮り直しても例外のままなら、CDP で撮る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    page.capture = async () => {
      throw new Error('UnknownVizError');
    };
    answerCdp(page, { 'Page.captureScreenshot': () => ({ data: Buffer.from('cdp').toString('base64') }) });
    images.fromBuffer = new FakeImage(800, 600, 'cdp');
    const result = await call('screenshot');
    expect(result.content[0]).toEqual({ type: 'image', data: Buffer.from('cdp:800x600').toString('base64'), mimeType: 'image/png' });
    expect(commands(page, 'Page.captureScreenshot')).toEqual([{ method: 'Page.captureScreenshot', format: 'png' }]);
  });

  it('画素密度を決めたタブは、先に CDP で撮る（その画素密度の大きさで撮れる）。Claude には CSS の px に縮めて返す', async () => {
    const { call, open, state } = setup();
    const page = open('http://localhost:3000/');
    page.page.viewport = () => ({ width: 393, height: 852, dpr: 3 });
    await call('set_viewport', { device: 'iPhone 15' });
    answerCdp(page, { 'Page.captureScreenshot': () => ({ data: Buffer.from('dense').toString('base64') }) });
    images.fromBuffer = new FakeImage(1179, 2556, 'dense');
    // 見比べる相手（画面の画素密度 2 で、同じ範囲を撮った絵。同じ色）
    page.capture = async () => {
      const rect = page.captures.at(-1);
      return rect ? new FakeImage(rect.width * 2, rect.height * 2) : new FakeImage(786, 1704);
    };
    expect(textOf(await call('screenshot'))).toBe('Visible area, http://localhost:3000/, image 393×852');
    expect(page.captures).toEqual([undefined]);
    // 要素: 見えている範囲をまるごと撮って、要素のまわりを画素密度倍の位置で切り出す（CDP の clip は使わない）。見比べるのは、その範囲どうし
    page.page.locate = () => found({ x: 100, y: 100, width: 50, height: 50 });
    const result = await call('screenshot', { selector: '#pad', save: true });
    expect(commands(page, 'Page.captureScreenshot').at(-1)).toEqual({ method: 'Page.captureScreenshot', format: 'png' });
    expect(textOf(result)).toContain('#pad (div#pad), http://localhost:3000/, image 66×66\nSaved to ');
    expect(textOf(result)).toContain('(198×198)');
    expect(page.captures.at(-1)).toEqual({ x: 92, y: 92, width: 66, height: 66 });
    // 切り出した位置も、画素密度倍（要素のまわり 8px から: 92 × 3）
    expect(Buffer.from((result.content[0] as { data: string }).data, 'base64').toString()).toBe('dense（276,276 を切り出した）（縮めた）:66x66');
    rmSync(state.screenshotDir, { recursive: true, force: true });
  });

  it('ページ全体を撮ったら（captureBeyondViewport でタッチ対応が外れる）、機種の大きさを当て直す', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    await call('set_viewport', { device: 'iPhone 15' });
    answerCdp(page, {
      'Page.getLayoutMetrics': () => ({ cssContentSize: { width: 393, height: 3000 }, cssLayoutViewport: { clientWidth: 393 } }),
      'Page.captureScreenshot': () => ({ data: Buffer.from('full').toString('base64') }),
    });
    await call('screenshot', { fullPage: true });
    expect(commands(page, 'Emulation.').map((c) => c.method)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
    ]);
  });

  it('画素密度を決めたタブを CDP で撮った絵が、画面の絵と合わなければ（崩れた絵）、画面の画素密度で撮り、保存するときはそう伝える', async () => {
    const { call, open, state } = setup();
    const page = open('http://localhost:3000/');
    page.page.viewport = () => ({ width: 393, height: 852, dpr: 3 });
    await call('set_viewport', { device: 'iPhone 15' });
    answerCdp(page, { 'Page.captureScreenshot': () => ({ data: Buffer.from('broken').toString('base64') }) });
    images.fromBuffer = new FakeImage(1179, 2556, 'broken', [0, 0, 0, 0]);
    page.shot = new FakeImage(393, 852, 'plain', [255, 0, 0, 255]);
    try {
      const result = await call('screenshot', { save: true });
      expect(result.content[0]).toEqual({ type: 'image', data: Buffer.from('plain:393x852').toString('base64'), mimeType: 'image/png' });
      expect(textOf(result)).toContain(
        "The saved image has the pixel density of this screen (1×), not the emulated 3×: on this screen, the capture at 3× did not match what is shown, so tanacode used the screen's capture.",
      );
      // 縦横の比が違う絵も、合わないとみなす
      images.fromBuffer = new FakeImage(1179, 1179, 'square', [255, 0, 0, 255]);
      page.shot = new FakeImage(786, 1704, 'plain', [255, 0, 0, 255]);
      const square = await call('screenshot');
      expect(Buffer.from((square.content[0] as { data: string }).data, 'base64').toString()).toBe('plain（縮めた）:393x852');
    } finally {
      rmSync(state.screenshotDir, { recursive: true, force: true });
    }
  });

  it('画素密度を決めたタブを CDP で撮れなければ、capturePage で撮る', async () => {
    const { call, open } = setup();
    const page = open('http://localhost:3000/');
    await call('set_viewport', { device: 'iPhone 15' });
    expect((await call('screenshot')).isError).toBeFalsy();
    expect(page.captures).toEqual([undefined]);
  });

  it('save: 撮ったままの大きさの PNG を保存し、パスと大きさを返す', async () => {
    const { call, open, state } = setup();
    const page = open('http://localhost:3000/');
    page.shot = new FakeImage(1600, 1200);
    page.page.viewport = () => ({ width: 800, height: 600, dpr: 2 });
    try {
      const result = await call('screenshot', { save: true });
      const saved = readdirSync(state.screenshotDir);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatch(/^screenshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}\.png$/);
      const path = `${state.screenshotDir}/${saved[0]}`;
      expect(readFileSync(path, 'utf8')).toBe('shot:1600x1200');
      expect(textOf(result)).toBe(
        `Visible area, http://localhost:3000/, image 800×600\nSaved to ${path} (1600×1200). Send it to the user with SendUserFile if they need to see it.`,
      );
    } finally {
      rmSync(state.screenshotDir, { recursive: true, force: true });
    }
  });

  it('save: 新しいもの 100 枚を残して、古いものから消す（ほかのファイルには触れない）', async () => {
    const { call, open, state } = setup();
    open('http://localhost:3000/');
    mkdirSync(state.screenshotDir, { recursive: true });
    for (let i = 0; i < 105; i++) writeFileSync(`${state.screenshotDir}/screenshot-2000-01-01T00-00-00-${String(i).padStart(3, '0')}Z-000000.png`, '');
    writeFileSync(`${state.screenshotDir}/memo.txt`, '');
    try {
      await call('screenshot', { save: true });
      const left = readdirSync(state.screenshotDir).sort();
      expect(left.filter((name) => name.startsWith('screenshot-'))).toHaveLength(100);
      expect(left).toContain('memo.txt');
      expect(left).not.toContain('screenshot-2000-01-01T00-00-00-005Z-000000.png');
      expect(left).toContain('screenshot-2000-01-01T00-00-00-006Z-000000.png');
      expect(left.filter((name) => !name.startsWith('screenshot-2000') && name !== 'memo.txt')).toHaveLength(1);
    } finally {
      rmSync(state.screenshotDir, { recursive: true, force: true });
    }
  });

  it('save: 保存できなければ、そう断る', async () => {
    const { call, open, state } = setup();
    open('http://localhost:3000/');
    // 保存先と同じ名前のファイルがあって、フォルダを作れない
    writeFileSync(state.screenshotDir, '');
    try {
      const result = await call('screenshot', { save: true });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(new RegExp(`^Took the screenshot, but could not save it in ${state.screenshotDir} \\(`));
    } finally {
      rmSync(state.screenshotDir, { force: true });
    }
    expect(existsSync(state.screenshotDir)).toBe(false);
  });
});
