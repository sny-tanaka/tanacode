import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude が、スマホ向けのページをアプリ内ブラウザで確かめる。アプリの browser-control.ts から、本物の webview の CDP まで。
// - set_viewport の device で、ページから見える大きさ・画素密度・タッチ対応が、その機種のものになり、画面の枠もその大きさになる。
//   読み込み直しても残り、width full で元に戻る
// - touch のタップ・なぞる・長押し・ピンチが、本物のタッチとポインターのイベントとしてページに届く
// - throttle で CPU を遅くすると、ページで測った時間が延び、通信を遅くすると、読み込みが遅れる。ツールバーに印が出て、人が押すと元に戻る
// - screenshot の save で、実機の画素の細かさの PNG が保存され、そのパスが返る

const FIRST = 'スマホの大きさで確かめてください';
const SECOND = '続けて確かめてください';
const DONE = '一通り確かめました';
const DONE_AGAIN = '続きを確かめました';
const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name: browserToolId(name), input }];
// ページの様子を読む（tag で、どの読み取りかを見分ける）
const read = (id: string, tag: string, expression: string): Block[] => tool(id, 'evaluate', { expression: `(async () => ({ tag: ${JSON.stringify(tag)}, ...(await ${expression}) }))()` });
const SIZE = '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touchPoints: navigator.maxTouchPoints, coarse: matchMedia("(pointer: coarse)").matches })';
// 決まった量の計算にかかる時間（3 回のうち、いちばん短いもの）
const WORK = 'Promise.resolve({ ms: Math.min(work(), work(), work()) })';
const FETCH = '(async () => { const t = performance.now(); await fetch("/ping?" + Math.random()); return { ms: performance.now() - t }; })()';
const EVENTS = 'Promise.resolve({ events: takeEvents() })';

// タッチのイベントを、種類ごとに数えて残すページ（touchmove と pointermove は続いたものを 1 つにまとめる）
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>スマホのページ</title>
<style>body { margin: 0 } #pad { width: 240px; height: 240px; background: #8cf; touch-action: none }</style>
<div id="pad"></div>
<script>
  let events = [];
  window.takeEvents = () => { const out = events; events = []; return out; };
  const pad = document.getElementById('pad');
  for (const type of ['touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'pointerup', 'contextmenu']) {
    pad.addEventListener(type, (e) => {
      const last = events[events.length - 1];
      if (last && last.type === type && type.endsWith('move')) { last.count++; return; }
      const point = e.changedTouches ? e.changedTouches[0] : e;
      events.push({ type, trusted: e.isTrusted, touches: e.touches ? e.touches.length : null, pointerType: e.pointerType || null, x: Math.round(point.clientX), y: Math.round(point.clientY), count: 1 });
    });
  }
  window.work = () => { const t = performance.now(); let x = 0; for (let i = 0; i < 2e7; i++) x += Math.sqrt(i); window.sink = x; return performance.now() - t; };
</script>`;

type Read = Record<string, unknown> & { tag: string };

describe('Claude がスマホ向けのページを確かめる', () => {
  let app: E2EApp;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': req.url?.startsWith('/ping') ? 'text/plain' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.url?.startsWith('/ping') ? 'pong' : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    app = await E2EApp.launch({
      trusted: true,
      claudeSettings: { permissions: { allow: ['navigate', 'set_viewport', 'touch', 'throttle', 'evaluate'].map(browserToolId) } },
      conversations: () => [
        {
          match: FIRST,
          steps: [
            tool('toolu_open', 'navigate', { url }),
            read('toolu_size0', 'before', SIZE),
            tool('toolu_device', 'set_viewport', { device: 'iPhone 15' }),
            read('toolu_size1', 'device', SIZE),
            tool('toolu_tap', 'touch', { action: 'tap', selector: '#pad' }),
            read('toolu_tap_events', 'tap', EVENTS),
            tool('toolu_swipe', 'touch', { action: 'swipe', x: 40, y: 120, deltaX: 150 }),
            read('toolu_swipe_events', 'swipe', EVENTS),
            tool('toolu_long', 'touch', { action: 'long_press', x: 120, y: 120 }),
            read('toolu_long_events', 'long_press', EVENTS),
            tool('toolu_pinch', 'touch', { action: 'pinch', x: 120, y: 120, scale: 2 }),
            read('toolu_pinch_events', 'pinch', EVENTS),
            read('toolu_work0', 'work-normal', WORK),
            read('toolu_fetch0', 'fetch-normal', FETCH),
            tool('toolu_slow', 'throttle', { cpu: 6, network: 'slow-3g' }),
            read('toolu_work1', 'work-slow', WORK),
            read('toolu_fetch1', 'fetch-slow', FETCH),
            [{ type: 'text', text: DONE }],
            // ブラウザを閉じて見ていないとき（透明にして描かせたままのタブ）も、タッチが届く
            tool('toolu_tap_offstage', 'touch', { action: 'tap', x: 60, y: 70 }),
            read('toolu_tap_offstage_events', 'tap-offstage', EVENTS),
            read('toolu_work2', 'work-cleared', WORK),
            read('toolu_fetch2', 'fetch-cleared', FETCH),
            tool('toolu_shot', 'screenshot', { save: true }),
            tool('toolu_reload', 'navigate', { action: 'reload' }),
            read('toolu_size2', 'reloaded', SIZE),
            tool('toolu_full', 'set_viewport', { width: 'full' }),
            read('toolu_size3', 'full', SIZE),
            [{ type: 'text', text: DONE_AGAIN }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`browser-mobile-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  // evaluate で読んだもの（tag ごと）
  const reads = (): Record<string, Read> =>
    Object.fromEntries(
      app.api.toolResults.flatMap((text) => {
        try {
          const value = JSON.parse(text) as Read;
          return typeof value?.tag === 'string' ? [[value.tag, value]] : [];
        } catch {
          return [];
        }
      }),
    );
  // まとめたイベントの種類（同じ種類が続いたものは 1 つ）
  const kinds = (tag: string) => (reads()[tag]!.events as { type: string }[]).map((e) => e.type);

  it('機種の名前で、ページから見える大きさ・画素密度・タッチ対応がその機種のものになり、画面の枠もその大きさになる', async () => {
    await app.startSession(FIRST, { mode: 'manual' });
    await app.byText('.chat-list', DONE).waitFor();
    expect(reads().before).toMatchObject({ touchPoints: 0, coarse: false });
    expect(reads().device).toMatchObject({ width: 393, height: 852, dpr: 3, touchPoints: 5, coarse: true });
    const frame = await app.page.locator('.preview-body.sized .preview-frame').boundingBox();
    expect(frame && [Math.round(frame.width), Math.round(frame.height)]).toEqual([393, 852]);
    expect(await app.page.locator('.preview-width').inputValue()).toBe('custom');
    expect(await app.page.locator('.preview-width option:checked').textContent()).toBe('iPhone 15（393×852 @3x）');
  });

  it('タップ・なぞる・長押し・ピンチが、本物のタッチのイベントとして、さわった位置に届く', () => {
    const touched = (tag: string) => reads()[tag]!.events as { type: string; trusted: boolean; touches: number | null; pointerType: string | null; x: number; y: number }[];
    for (const tag of ['tap', 'swipe', 'long_press', 'pinch']) {
      expect(touched(tag).every((e) => e.trusted), tag).toBe(true);
      expect(touched(tag).filter((e) => e.type.startsWith('pointer')).every((e) => e.pointerType === 'touch'), tag).toBe(true);
    }
    expect(kinds('tap')).toEqual(expect.arrayContaining(['touchstart', 'touchend', 'pointerdown', 'pointerup']));
    // #pad（240×240）の真ん中
    expect(touched('tap').find((e) => e.type === 'touchstart')).toMatchObject({ x: 120, y: 120 });
    expect(kinds('swipe')).toEqual(expect.arrayContaining(['touchstart', 'touchmove', 'touchend']));
    expect(touched('swipe').find((e) => e.type === 'touchstart')).toMatchObject({ x: 40, y: 120 });
    expect(touched('swipe').find((e) => e.type === 'touchend')).toMatchObject({ x: 190, y: 120 });
    expect(kinds('long_press')).toContain('touchstart');
    // ピンチは 2 本の指
    expect(Math.max(...touched('pinch').map((e) => e.touches ?? 0))).toBe(2);
    expect(kinds('pinch')).toContain('touchmove');
    expect(app.api.toolResults.find((r) => r.startsWith('Pinched (scale 2'))).toBeDefined();
  });

  it('CPU を遅くすると測った時間が延び、通信を遅くすると読み込みが遅れる。ツールバーに印が出る', async () => {
    const ms = (tag: string) => reads()[tag]!.ms as number;
    expect(ms('work-slow')).toBeGreaterThan(ms('work-normal') * 2.5);
    // 低速 3G は、1 回のやりとりに 2 秒の遅れ
    expect(ms('fetch-slow')).toBeGreaterThan(1500);
    expect(ms('fetch-normal')).toBeLessThan(1000);
    await expect.poll(() => app.page.locator('.preview-throttle').textContent()).toBe('CPU 6× 遅く・低速 3G');
  });

  it('人がツールバーの印を押すと、元の速さに戻る。ブラウザを閉じて見ていないときも、タッチが届く', async () => {
    await app.page.click('.preview-throttle');
    await app.page.locator('.preview-throttle').waitFor({ state: 'detached' });
    await app.page.click('.preview-pane [aria-label="ブラウザを閉じる"]');
    await app.page.locator('.preview-pane.offstage').waitFor({ state: 'attached' });
    await app.send(SECOND);
    await app.byText('.chat-list', DONE_AGAIN).waitFor();
    expect(reads()['work-cleared']!.ms as number).toBeLessThan((reads()['work-slow']!.ms as number) / 2);
    expect(reads()['fetch-cleared']!.ms as number).toBeLessThan(1000);
    expect((reads()['tap-offstage']!.events as { type: string; x: number; y: number }[]).find((e) => e.type === 'touchstart')).toMatchObject({ x: 60, y: 70 });
  });

  it('screenshot の save で、実機の画素の細かさの PNG が保存され、そのパスが返る', () => {
    const result = app.api.toolResults.find((r) => r.includes('Saved to '));
    expect(result).toMatch(/Visible area, .*, image 393×852/);
    const path = /Saved to (\S+\.png) \((\d+)×(\d+)\)/.exec(result ?? '');
    expect(path).not.toBeNull();
    expect(dirname(path![1]!)).toBe(`${app.userData}/browser-screenshots`);
    expect(existsSync(path![1]!)).toBe(true);
    // PNG の頭（IHDR）の幅と高さ
    const png = readFileSync(path![1]!);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([393 * 3, 852 * 3]);
    expect([Number(path![2]), Number(path![3])]).toEqual([393 * 3, 852 * 3]);
  });

  it('機種の大きさは読み込み直しても残り、width full で元に戻る', async () => {
    expect(reads().reloaded).toMatchObject({ width: 393, height: 852, dpr: 3, touchPoints: 5 });
    expect(reads().full).toMatchObject({ touchPoints: 0, coarse: false });
    expect(reads().full!.width).not.toBe(393);
    await app.page.locator('.preview-body.sized').waitFor({ state: 'detached' });
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
