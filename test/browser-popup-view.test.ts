import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, NativeImage } from 'electron';
import { PopupView, sanitizePopupInput, sanitizePopupPlace, toKeyCode, type PopupFrame } from '../src/main/browser-popup-view';

// ポップアップの絵をタブに映す・人の操作を送る（src/main/browser-popup-view.ts）。別ウインドウと中身は、ここで作る小さな作り物

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

class FakeContents extends EventEmitter {
  readonly sentEvents: unknown[] = [];
  readonly calls: string[] = [];
  frame: ((image: NativeImage) => void) | null = null;
  sendInputEvent(event: unknown): void {
    this.sentEvents.push(event);
  }
  insertText(text: string): Promise<void> {
    this.calls.push(`insertText:${text}`);
    return Promise.resolve();
  }
  beginFrameSubscription(_onlyDirty: boolean, callback: (image: NativeImage) => void): void {
    this.calls.push('begin');
    this.frame = callback;
  }
  endFrameSubscription(): void {
    this.calls.push('end');
    this.frame = null;
  }
  invalidate(): void {
    this.calls.push('invalidate');
  }
  focus(): void {
    this.calls.push('focus');
  }
  copy(): void {
    this.calls.push('copy');
  }
  paste(): void {
    this.calls.push('paste');
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeContents();
  destroyed = false;
  shown = 0;
  bounds = { x: 0, y: 0, width: 800, height: 600 };
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getContentBounds() {
    return this.bounds;
  }
  setContentBounds(bounds: FakeWindow['bounds']): void {
    this.bounds = bounds;
  }
  getContentSize(): number[] {
    return [this.bounds.width, this.bounds.height];
  }
  show(): void {
    this.shown++;
  }
  focus(): void {}
}

// 画素の数が width×height の絵
function image(width: number, height: number, empty = false): NativeImage {
  return { isEmpty: () => empty, getSize: () => ({ width, height }), toBitmap: () => Buffer.alloc(width * height * 4) } as unknown as NativeImage;
}

function setup() {
  const win = new FakeWindow();
  const view = new PopupView(win as unknown as BrowserWindow, () => ({ x: 100, y: 50, width: 1200, height: 800 }));
  const frames: PopupFrame[] = [];
  const cursors: string[] = [];
  const watch = (place = { x: 10, y: 20, width: 300, height: 200 }) =>
    view.watch(
      place,
      (frame) => frames.push(frame),
      (cursor) => cursors.push(cursor),
    );
  return { win, view, frames, cursors, watch };
}

describe('映す', () => {
  it('映し始めたら、別ウインドウを映す場所（画面の上）と同じ位置・大きさにして、最初の絵を描かせる', () => {
    const { win, watch } = setup();
    watch();
    expect(win.bounds).toEqual({ x: 110, y: 70, width: 300, height: 200 });
    expect(win.webContents.calls).toEqual(['begin', 'invalidate']);
    // 続けて場所だけが変わっても、頼み直さない
    watch({ x: 0, y: 0, width: 320, height: 200 });
    expect(win.bounds).toEqual({ x: 100, y: 50, width: 320, height: 200 });
    expect(win.webContents.calls).toEqual(['begin', 'invalidate']);
  });

  it('画面が描き終えたと知らせるまで、次の絵は送らず、最新の 1 枚だけを持つ。知らせが来なければ、少したってから送る', () => {
    const { win, watch, view, frames } = setup();
    watch();
    const frame = win.webContents.frame!;
    frame(image(600, 400));
    frame(image(600, 401));
    frame(image(600, 402));
    expect(frames.map((f) => [f.height, f.scale])).toEqual([[400, 2]]);
    view.done();
    expect(frames.map((f) => f.height)).toEqual([400, 402]);
    vi.advanceTimersByTime(1000);
    frame(image(600, 403));
    expect(frames.map((f) => f.height)).toEqual([400, 402, 403]);
  });

  it('やめたら、絵を受けるのもやめ、持っていた絵も捨てる。空の絵は送らない', () => {
    const { win, watch, view, frames } = setup();
    watch();
    win.webContents.frame!(image(10, 10, true));
    expect(frames).toEqual([]);
    win.webContents.frame!(image(600, 400));
    win.webContents.frame!(image(600, 401));
    view.watch(null, null, null);
    view.done();
    expect(frames.map((f) => f.height)).toEqual([400]);
    expect(win.webContents.calls.at(-1)).toBe('end');
  });

  it('カーソルの形は、映している間だけ送る', () => {
    const { win, watch, view, cursors } = setup();
    win.webContents.emit('cursor-changed', {}, 'text');
    watch();
    win.webContents.emit('cursor-changed', {}, 'pointer');
    view.watch(null, null, null);
    win.webContents.emit('cursor-changed', {}, 'wait');
    expect(cursors).toEqual(['pointer']);
  });

  it('実物を開いたら、別ウインドウを出す。そのあとは、映す場所に合わせて動かさない（人が動かせるように）', () => {
    const { win, watch, view } = setup();
    view.reveal();
    expect([win.shown, view.revealed]).toEqual([1, true]);
    watch();
    expect(win.bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });
});

describe('操作を送る', () => {
  it('文字のキーは、keyDown と文字を送る。⌘・⌃ との組み合わせは、文字を送らない。名前の付いたキーは、Electron の名前にする', () => {
    const { win, view } = setup();
    view.input({ type: 'keyDown', key: 'a', modifiers: [] });
    view.input({ type: 'keyDown', key: 'a', modifiers: ['meta'] });
    view.input({ type: 'keyDown', key: 'ArrowLeft', modifiers: ['shift'] });
    view.input({ type: 'keyUp', key: 'Enter', modifiers: [] });
    expect(win.webContents.sentEvents).toEqual([
      { type: 'keyDown', keyCode: 'a', modifiers: [] },
      { type: 'char', keyCode: 'a', modifiers: [] },
      { type: 'keyDown', keyCode: 'a', modifiers: ['meta'] },
      { type: 'keyDown', keyCode: 'Left', modifiers: ['shift'] },
      { type: 'keyUp', keyCode: 'Enter', modifiers: [] },
    ]);
  });

  it('ホイールは向きを Chromium に合わせる。日本語の変換で確定した文字・編集・フォーカスも送る', () => {
    const { win, view } = setup();
    view.input({ type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: 120, modifiers: [] });
    view.input({ type: 'insertText', text: '日本語' });
    view.input({ type: 'edit', command: 'paste' });
    view.input({ type: 'focus' });
    expect(win.webContents.sentEvents).toEqual([{ type: 'mouseWheel', x: 1, y: 2, deltaX: -0, deltaY: -120, canScroll: true, modifiers: [] }]);
    expect(win.webContents.calls).toEqual(['insertText:日本語', 'paste', 'focus']);
  });

  it('閉じた別ウインドウには送らない', () => {
    const { win, view } = setup();
    win.destroyed = true;
    view.input({ type: 'focus' });
    view.reveal();
    expect([win.webContents.calls, win.shown]).toEqual([[], 0]);
  });
});

describe('画面から届いたものを確かめる', () => {
  it('キーの名前', () => {
    expect(['a', 'あ', ' ', 'Backspace', 'ArrowDown', 'Shift', 'F12', ''].map(toKeyCode)).toEqual(['a', 'あ', 'Space', 'Backspace', 'Down', null, null, null]);
  });

  it('操作の形が違うものは送らない。数は丸め、修飾キーは知っているものだけ残す', () => {
    expect(sanitizePopupInput(null)).toBeNull();
    expect(sanitizePopupInput({ type: 'mouseDown', x: 1, y: 2, button: 'back', modifiers: [] })).toBeNull();
    expect(sanitizePopupInput({ type: 'mouseMove', x: Number.NaN, y: 2 })).toBeNull();
    expect(sanitizePopupInput({ type: 'mouseUp', x: 1e9, y: 2.6, button: 'right', clickCount: 9, modifiers: ['alt', 'super'] })).toEqual({
      type: 'mouseUp',
      x: 10000,
      y: 3,
      button: 'right',
      clickCount: 3,
      modifiers: ['alt'],
    });
    expect(sanitizePopupInput({ type: 'keyDown', key: 'Shift' })).toBeNull();
    expect(sanitizePopupInput({ type: 'insertText', text: '' })).toBeNull();
    expect(sanitizePopupInput({ type: 'insertText', text: 'x'.repeat(10001) })).toBeNull();
    expect(sanitizePopupInput({ type: 'edit', command: 'print' })).toBeNull();
    expect(sanitizePopupInput({ type: 'edit', command: 'copy' })).toEqual({ type: 'edit', command: 'copy' });
    expect(sanitizePopupInput({ type: 'loadURL', url: 'file:///' })).toBeNull();
  });

  it('映す場所は、数が 4 つそろい、大きさが正のものだけ', () => {
    expect(sanitizePopupPlace({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(sanitizePopupPlace({ x: 1, y: 2, width: 0, height: 4 })).toBeNull();
    expect(sanitizePopupPlace({ x: '1', y: 2, width: 3, height: 4 })).toBeNull();
    expect(sanitizePopupPlace(null)).toBeNull();
  });
});
