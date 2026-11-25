// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellSnapshot } from '@shared/ipc';
import { setRemoteMode } from '../../src/renderer/src/remote/mode';
import { ClaudeScreen, useClaudeScreenOutput } from '../../src/renderer/src/terminal/ClaudeScreen';
import { TerminalPanel } from '../../src/renderer/src/terminal/TerminalPanel';
import './dom';
import { mockApi } from './mock-api';

// スマホの画面のターミナル（Issue #464）。Mac の画面の大きさを変えず、見ている間だけ出力を受け取り、見え始めたときに今の画面を読み直す。
// jsdom では xterm が描けないので、xterm を、書いたもの・大きさ・打った文字の受け手を持つだけの偽物に差し替える

const xterm = vi.hoisted(() => {
  type Listener<T> = (value: T) => void;
  class FakeTerminal {
    static all: FakeTerminal[] = [];
    cols = 40;
    rows = 20;
    element: HTMLElement | null = null;
    written: string[] = [];
    resets = 0;
    disposed = false;
    private dataListeners: Listener<string>[] = [];
    private resizeListeners: Listener<{ cols: number; rows: number }>[] = [];
    constructor() {
      FakeTerminal.all.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    open(element: HTMLElement) {
      this.element = element;
    }
    onData(listener: Listener<string>) {
      this.dataListeners.push(listener);
      return { dispose() {} };
    }
    // 人が xterm で打ったことにする
    input(data: string) {
      this.dataListeners.forEach((listener) => listener(data));
    }
    onResize(listener: Listener<{ cols: number; rows: number }>) {
      this.resizeListeners.push(listener);
      return { dispose() {} };
    }
    // 本物と同じく、大きさが変わったら知らせる
    resize(cols: number, rows: number) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      this.resizeListeners.forEach((listener) => listener({ cols, rows }));
    }
    reset() {
      this.resets++;
      this.written = [];
    }
    onTitleChange() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    hasSelection() {
      return false;
    }
    write(data: string) {
      this.written.push(data);
    }
    focus() {}
    clear() {}
    dispose() {
      this.disposed = true;
    }
  }
  class FakeFitAddon {
    // 測ると、狭いスマホの幅になる（呼ばれたら、Mac の大きさが変わってしまう）
    fit = vi.fn();
  }
  class FakeWebLinksAddon {}
  return { FakeTerminal, FakeFitAddon, FakeWebLinksAddon };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xterm.FakeFitAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: xterm.FakeWebLinksAddon }));

if (!window.ResizeObserver)
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

let api: ReturnType<typeof mockApi>;
let shells: ShellSnapshot[];
let seq: number;
beforeEach(() => {
  xterm.FakeTerminal.all = [];
  shells = [];
  seq = 0;
  api = mockApi({
    'pty.snapshot': () => Promise.resolve({ cols: 132, rows: 43, screen: 'Mac の画面' }),
    'shell.create': () => Promise.resolve({ id: `sh${++seq}`, name: 'zsh' }),
    'shell.attach': () => Promise.resolve(shells),
  });
  api.install();
  localStorage.clear();
  setRemoteMode(true);
});
afterEach(() => {
  cleanup();
  setRemoteMode(false);
});

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe('スマホの画面: ターミナルモードの Claude の画面（ClaudeScreen）', () => {
  it('App が呼ぶ受け取りは、スマホの画面では出力を受けない（画面を出したときに読む）', () => {
    renderHook(() => useClaudeScreenOutput());
    api.emit('pty.onData', { sessionId: 's1', data: '見ていない間の出力' });
    expect(xterm.FakeTerminal.all).toHaveLength(0);
  });

  it('出したときに今の画面と大きさを読んで、Mac の桁数のまま描く。pty の大きさは変えず、Mac が変えた大きさに合わせる', async () => {
    const view = render(<ClaudeScreen sessionId="s1" />);
    await flush();
    const term = xterm.FakeTerminal.all[0];
    expect(api.argsOf('pty.snapshot')).toEqual([['s1']]);
    expect([term.cols, term.rows, term.resets, term.written]).toEqual([132, 43, 1, ['Mac の画面']]);
    act(() => api.emit('pty.onData', { sessionId: 's1', data: '続き' }));
    expect(term.written).toEqual(['Mac の画面', '続き']);
    act(() => api.emit('pty.onResized', { sessionId: 's1', cols: 100, rows: 30 }));
    expect([term.cols, term.rows]).toEqual([100, 30]);
    // ほかのセッションの大きさは、まだ xterm が無ければ何もしない
    act(() => api.emit('pty.onResized', { sessionId: 's9', cols: 10, rows: 5 }));
    expect(xterm.FakeTerminal.all).toHaveLength(1);
    view.unmount();
    expect(api.argsOf('pty.resize')).toEqual([]);
    expect(api.argsOf('pty.resetSize')).toEqual([]);
    expect(term.disposed).toBe(true);
  });

  it('補助キーで打てる。Ctrl を押したら、次に xterm で打った 1 文字を Ctrl 付きにする', async () => {
    render(<ClaudeScreen sessionId="s1" />);
    await flush();
    const term = xterm.FakeTerminal.all[0];
    fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    act(() => term.input('c'));
    act(() => term.input('c'));
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    fireEvent.click(screen.getByRole('button', { name: '^C' }));
    expect(api.argsOf('pty.write')).toEqual([
      ['s1', '\x1b'],
      ['s1', '\x03'],
      ['s1', 'c'],
      ['s1', '\x03'],
    ]);
  });

  it('写しが届く前に隠したら・写しが無ければ、書かない', async () => {
    let resolve: (value: null) => void = () => {};
    api = mockApi({ 'pty.snapshot': () => new Promise((r) => (resolve = r)) });
    api.install();
    const view = render(<ClaudeScreen sessionId="s1" />);
    view.unmount();
    resolve(null);
    await flush();
    expect(xterm.FakeTerminal.all[0].resets).toBe(0);
    api = mockApi({ 'pty.snapshot': () => Promise.resolve(null) });
    api.install();
    render(<ClaudeScreen sessionId="s1" />);
    await flush();
    expect(xterm.FakeTerminal.all[1].resets).toBe(0);
  });
});

describe('スマホの画面: ターミナルのパネル（TerminalPanel）', () => {
  const panel = (visible: boolean) => <TerminalPanel sessionId="s1" open visible={visible} onOpen={() => {}} onClose={() => {}} />;

  it('見ている間だけ出力を受け取る。見え始めたら今の画面と大きさを読み直し、Mac が変えた大きさにも合わせる', async () => {
    const view = render(panel(true));
    await waitFor(() => expect(screen.queryAllByRole('tab')).toHaveLength(1));
    const term = xterm.FakeTerminal.all[0];
    // スマホの画面からは、測らず、pty の大きさも変えない
    expect(api.argsOf('shell.resize')).toEqual([]);
    act(() => api.emit('shell.onData', { id: 'sh1', data: '見ている' }));
    expect(term.written).toEqual(['見ている']);
    act(() => api.emit('shell.onResized', { id: 'sh1', cols: 120, rows: 30 }));
    expect([term.cols, term.rows]).toEqual([120, 30]);
    act(() => api.emit('shell.onResized', { id: 'sh9', cols: 1, rows: 1 }));

    view.rerender(panel(false));
    act(() => api.emit('shell.onData', { id: 'sh1', data: '見ていない' }));
    act(() => api.emit('shell.onResized', { id: 'sh1', cols: 90, rows: 20 }));
    expect(term.written).toEqual(['見ている']);
    expect(term.cols).toBe(120);

    shells = [
      { owner: 's1', id: 'sh1', name: 'zsh', title: null, task: false, exitCode: null, cols: 90, rows: 20, screen: '今の画面' },
      { owner: 's1', id: 'sh7', name: 'zsh', title: null, task: false, exitCode: null, cols: 80, rows: 24, screen: 'まだ xterm が無い' },
    ];
    const attaches = api.argsOf('shell.attach').length;
    view.rerender(panel(true));
    await flush();
    expect(api.argsOf('shell.attach').length).toBe(attaches + 1);
    expect([term.written, term.cols, term.rows]).toEqual([['今の画面'], 90, 20]);
    expect(api.argsOf('shell.resize')).toEqual([]);
  });

  it('読み直しの返事が届く前に隠したら、書かない', async () => {
    const view = render(panel(false));
    await waitFor(() => expect(screen.queryAllByRole('tab')).toHaveLength(1));
    let resolve: (value: ShellSnapshot[]) => void = () => {};
    api = mockApi({ 'shell.attach': () => new Promise((r) => (resolve = r)) });
    api.install();
    view.rerender(panel(true));
    view.rerender(panel(false));
    resolve([{ owner: 's1', id: 'sh1', name: 'zsh', title: null, task: false, exitCode: null, cols: 90, rows: 20, screen: '遅れた画面' }]);
    await flush();
    expect(xterm.FakeTerminal.all[0].resets).toBe(0);
  });
});
