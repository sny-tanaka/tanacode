import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { BrowserMirrorFrame } from '../src/shared/ipc';
import { BrowserMirror, MIRROR_DONE_TIMEOUT_MS, MIRROR_MODES, sanitizeMirrorInput } from '../src/main/browser-mirror';

// スマホの画面に、アプリ内ブラウザのタブを映す（src/main/browser-mirror.ts。Issue #464）。CDP の debugger と webContents は作り物

class FakeDebugger extends EventEmitter {
  attached = true;
  sent: { method: string; params?: Record<string, unknown> }[] = [];
  fail = new Set<string>();
  isAttached() {
    return this.attached;
  }
  async sendCommand(method: string, params?: Record<string, unknown>) {
    this.sent.push({ method, params });
    if (this.fail.has(method)) throw new Error('failed');
    return {};
  }
  // ページが描き直したことにする
  frame(ackId: number, width = 390, height = 844) {
    this.emit('message', {}, 'Page.screencastFrame', { sessionId: ackId, data: `jpeg-${ackId}`, metadata: { deviceWidth: width, deviceHeight: height } });
  }
  methods() {
    return this.sent.map((s) => s.method);
  }
}

class FakeContents extends EventEmitter {
  debugger = new FakeDebugger();
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
}

function setup() {
  const tabs = new Map<string, FakeContents>([
    ['s1/tab-1', new FakeContents()],
    ['s1/tab-2', new FakeContents()],
  ]);
  const drawing: [string, string, boolean][] = [];
  const connected: string[] = [];
  const clock = { now: 1000 };
  const mirror = new BrowserMirror(
    {
      guest: (sessionId, tabId) => (tabs.get(`${sessionId}/${tabId}`) as unknown as WebContents) ?? null,
      connect: async (sessionId, tabId) => {
        connected.push(`${sessionId}/${tabId}`);
      },
      keepDrawing: (sessionId, tabId, on) => drawing.push([sessionId, tabId, on]),
    },
    () => clock.now,
  );
  const frames = new Map<string, BrowserMirrorFrame[]>();
  const sendTo = (clientId: string) => (frame: BrowserMirrorFrame) => frames.set(clientId, [...(frames.get(clientId) ?? []), frame]);
  return { tabs, drawing, connected, clock, mirror, frames, sendTo, tab: (id: string) => tabs.get(`s1/${id}`)! };
}

afterEach(() => vi.useRealTimers());

describe('BrowserMirror', () => {
  it('始めると、CDP をつなぎ、描かせ続けさせ、スマホの画素の大きさ・ふつうの画質で screencast を始める。止めると、やめて描かせるのもやめる', async () => {
    const t = setup();
    await expect(t.mirror.start('c1', 's1', 'tab-1', { width: 1170, height: 9000, saver: false }, t.sendTo('c1'))).resolves.toBe(true);
    expect(t.connected).toEqual(['s1/tab-1']);
    expect(t.drawing).toEqual([['s1', 'tab-1', true]]);
    expect(t.tab('tab-1').debugger.sent[0]).toEqual({ method: 'Page.startScreencast', params: { format: 'jpeg', quality: MIRROR_MODES.normal.quality, maxWidth: 1170, maxHeight: 2400, everyNthFrame: 1 } });
    expect(t.mirror.watching('c1')).toEqual({ sessionId: 's1', tabId: 'tab-1' });
    expect(t.mirror.count()).toBe(1);
    t.mirror.stop('c1');
    expect(t.tab('tab-1').debugger.methods()).toContain('Page.stopScreencast');
    expect(t.drawing.at(-1)).toEqual(['s1', 'tab-1', false]);
    expect(t.mirror.watching('c1')).toBeNull();
    // 止まったあとに届いた絵は送らない
    t.tab('tab-1').debugger.frame(1);
    expect(t.frames.get('c1')).toBeUndefined();
  });

  it('絵は、スマホが描き終えたと知らせ、決めた間隔がたってから次を受け取る（ack を遅らせる）。知らせてこなくても、時間で次へ進む', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.mirror.start('c1', 's1', 'tab-1', { width: 390, height: 844, saver: false }, t.sendTo('c1'));
    const dbg = t.tab('tab-1').debugger;
    dbg.frame(7);
    expect(t.frames.get('c1')).toEqual([{ data: 'jpeg-7', width: 390, height: 844 }]);
    expect(dbg.methods()).not.toContain('Page.screencastFrameAck');
    // 描き終えた。間隔（200ms）のうち 50ms たっていたら、残りの 150ms 待つ
    t.clock.now += 50;
    t.mirror.done('c1');
    vi.advanceTimersByTime(149);
    expect(dbg.methods()).not.toContain('Page.screencastFrameAck');
    vi.advanceTimersByTime(1);
    expect(dbg.sent.at(-1)).toEqual({ method: 'Page.screencastFrameAck', params: { sessionId: 7 } });
    // 知らせてこない
    dbg.frame(8);
    vi.advanceTimersByTime(MIRROR_DONE_TIMEOUT_MS);
    expect(dbg.sent.at(-1)).toEqual({ method: 'Page.screencastFrameAck', params: { sessionId: 8 } });
    // 待っていないときの知らせ・知らない接続は何もしない
    t.mirror.done('c1');
    t.mirror.done('ghost');
  });

  it('節約モードは、画質を下げ、間隔をあける', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.mirror.start('c1', 's1', 'tab-1', { width: 390, height: 844, saver: true }, t.sendTo('c1'));
    const dbg = t.tab('tab-1').debugger;
    expect(dbg.sent[0].params).toMatchObject({ quality: MIRROR_MODES.saver.quality });
    dbg.frame(1);
    t.mirror.done('c1');
    vi.advanceTimersByTime(MIRROR_MODES.saver.intervalMs - 1);
    expect(dbg.methods()).not.toContain('Page.screencastFrameAck');
    vi.advanceTimersByTime(1);
    expect(dbg.methods()).toContain('Page.screencastFrameAck');
  });

  it('1 つの接続が映すのは 1 つのタブ。同じタブを別の接続が映し始めたら、前の接続は止めて知らせる。切れた接続のものは止める', async () => {
    const t = setup();
    await t.mirror.start('c1', 's1', 'tab-1', { width: 390, height: 844, saver: false }, t.sendTo('c1'));
    await t.mirror.start('c1', 's1', 'tab-2', { width: 390, height: 844, saver: false }, t.sendTo('c1'));
    expect(t.tab('tab-1').debugger.methods()).toContain('Page.stopScreencast');
    expect(t.mirror.watching('c1')).toEqual({ sessionId: 's1', tabId: 'tab-2' });
    await t.mirror.start('c2', 's1', 'tab-2', { width: 390, height: 844, saver: false }, t.sendTo('c2'));
    expect(t.frames.get('c1')).toEqual([{ stopped: true }]);
    expect(t.mirror.watching('c1')).toBeNull();
    // 同じタブをまだ映しているあいだは、描かせ続けるのをやめない
    expect(t.drawing.filter(([, tab, on]) => tab === 'tab-2' && !on)).toEqual([]);
    t.mirror.keep(new Set(['c9']));
    expect(t.mirror.count()).toBe(0);
  });

  it('CDP をつなぐのを待っている間に止められた・次を頼まれたら、前のものは何も付けずにやめる（あとから映し始めない）', async () => {
    const t = setup();
    const first = t.mirror.start('c1', 's1', 'tab-1', { width: 390, height: 844, saver: false }, t.sendTo('c1'));
    t.mirror.stop('c1');
    expect(await first).toBe(false);
    expect(t.tab('tab-1').debugger.methods()).toEqual([]);
    expect(t.drawing).toEqual([]);
    expect(t.mirror.count()).toBe(0);
    const a = t.mirror.start('c1', 's1', 'tab-1', { width: 390, height: 844, saver: false }, t.sendTo('c1'));
    const b = t.mirror.start('c1', 's1', 'tab-2', { width: 390, height: 844, saver: false }, t.sendTo('c1'));
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(t.mirror.watching('c1')).toEqual({ sessionId: 's1', tabId: 'tab-2' });
    expect(t.drawing).toEqual([['s1', 'tab-2', true]]);
    // 待っている間に切れた接続も、映し始めない
    const c = t.mirror.start('c2', 's1', 'tab-1', { width: 390, height: 844, saver: false }, t.sendTo('c2'));
    t.mirror.keep(new Set(['c1']));
    expect(await c).toBe(false);
    // 待っている間にタブが閉じたら、映し始めない
    const d = t.mirror.start('c3', 's1', 'tab-1', { width: 390, height: 844, saver: false }, t.sendTo('c3'));
    t.tab('tab-1').destroyed = true;
    expect(await d).toBe(false);
    expect(t.mirror.count()).toBe(1);
  });

  it('タブが無い・screencast を始められないときは false。タブが閉じた・CDP が外れた（DevTools を開いた）ら止めて知らせる', async () => {
    const t = setup();
    await expect(t.mirror.start('c1', 's1', 'tab-9', { width: 390, height: 844, saver: false }, t.sendTo('c1'))).resolves.toBe(false);
    t.tab('tab-1').debugger.fail.add('Page.startScreencast');
    await expect(t.mirror.start('c1', 's1', 'tab-1', { width: 390, height: 844, saver: false }, t.sendTo('c1'))).resolves.toBe(false);
    expect(t.mirror.count()).toBe(0);
    await t.mirror.start('c1', 's1', 'tab-2', { width: 390, height: 844, saver: false }, t.sendTo('c1'));
    t.tab('tab-2').debugger.emit('detach');
    expect(t.frames.get('c1')?.at(-1)).toEqual({ stopped: true });
    await t.mirror.start('c2', 's1', 'tab-2', { width: 390, height: 844, saver: false }, t.sendTo('c2'));
    t.tab('tab-2').destroyed = true;
    t.tab('tab-2').emit('destroyed');
    expect(t.frames.get('c2')?.at(-1)).toEqual({ stopped: true });
    // 壊れた絵（番号・中身が無い）は送らない
    await t.mirror.start('c3', 's1', 'tab-1', { width: 390, height: 844, saver: false }, t.sendTo('c3'));
  });

  it('操作: タップはページの位置でマウスを押して離す。スクロール・文字・キーも送る。絵を受け取る前のタップ・スクロールは送らない', async () => {
    const t = setup();
    await t.mirror.start('c1', 's1', 'tab-1', { width: 390, height: 844, saver: false }, t.sendTo('c1'));
    const dbg = t.tab('tab-1').debugger;
    await t.mirror.input('c1', { type: 'tap', x: 0.5, y: 0.5 });
    expect(dbg.methods().filter((m) => m.startsWith('Input.'))).toEqual([]);
    dbg.frame(1, 400, 800);
    dbg.sent.length = 0;
    await t.mirror.input('c1', { type: 'tap', x: 0.5, y: 0.25 });
    expect(dbg.sent.map((s) => [s.params?.type, s.params?.x, s.params?.y])).toEqual([
      ['mouseMoved', 200, 200],
      ['mousePressed', 200, 200],
      ['mouseReleased', 200, 200],
    ]);
    dbg.sent.length = 0;
    await t.mirror.input('c1', { type: 'scroll', x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 });
    await t.mirror.input('c1', { type: 'text', text: 'こんにちは' });
    await t.mirror.input('c1', { type: 'key', key: 'Enter' });
    expect(dbg.sent).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 200, y: 400, deltaX: 0, deltaY: 400 } },
      { method: 'Input.insertText', params: { text: 'こんにちは' } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 } },
    ]);
    // 映していない接続の操作は送らない
    await t.mirror.input('ghost', { type: 'text', text: 'x' });
    expect(dbg.sent).toHaveLength(4);
  });
});

describe('sanitizeMirrorInput', () => {
  it('形と値の範囲を確かめる（絵の外の位置・大きすぎる量・知らないキーは受けない）', () => {
    expect(sanitizeMirrorInput({ type: 'tap', x: 0.1, y: 1 })).toEqual({ type: 'tap', x: 0.1, y: 1 });
    expect(sanitizeMirrorInput({ type: 'tap', x: 1.1, y: 0 })).toBeNull();
    expect(sanitizeMirrorInput({ type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: -2 })).toEqual({ type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: -2 });
    expect(sanitizeMirrorInput({ type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 99 })).toBeNull();
    expect(sanitizeMirrorInput({ type: 'text', text: 'a' })).toEqual({ type: 'text', text: 'a' });
    expect(sanitizeMirrorInput({ type: 'text', text: '' })).toBeNull();
    expect(sanitizeMirrorInput({ type: 'text', text: 'a'.repeat(10001) })).toBeNull();
    expect(sanitizeMirrorInput({ type: 'key', key: 'Escape' })).toEqual({ type: 'key', key: 'Escape' });
    expect(sanitizeMirrorInput({ type: 'key', key: 'F5' })).toBeNull();
    expect(sanitizeMirrorInput({ type: 'key', key: 'toString' })).toBeNull();
    expect(sanitizeMirrorInput({ type: 'other' })).toBeNull();
    expect(sanitizeMirrorInput(null)).toBeNull();
  });
});
