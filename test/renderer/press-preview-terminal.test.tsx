// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInsertInput } from '../../src/renderer/src/chat/insertInput';
import { TerminalPanel, type TerminalView } from '../../src/renderer/src/terminal/TerminalPanel';
import './dom';
import { mockApi } from './mock-api';

// エディタの下のターミナルパネル（TerminalPanel）のタブ・ボタンを押して、効いたことを確かめる。
// jsdom では xterm が描けないので、xterm を、書いたもの・選んでいる文字を持つだけの偽物に差し替える

const xterm = vi.hoisted(() => {
  type Listener<T> = (value: T) => void;
  class FakeTerminal {
    static all: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    written: string[] = [];
    disposed = false;
    focused = 0;
    private selection = '';
    private selectionListeners: Listener<void>[] = [];
    constructor() {
      FakeTerminal.all.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    open(element: HTMLElement) {
      this.element = element;
    }
    onData(_listener: Listener<string>) {
      return { dispose() {} };
    }
    onResize(_listener: Listener<{ cols: number; rows: number }>) {
      return { dispose() {} };
    }
    onTitleChange(_listener: Listener<string>) {
      return { dispose() {} };
    }
    onSelectionChange(listener: Listener<void>) {
      this.selectionListeners.push(listener);
      return { dispose() {} };
    }
    hasSelection() {
      return this.selection !== '';
    }
    getSelection() {
      return this.selection;
    }
    // 人がマウスで出力を選んだことにする
    select(text: string) {
      this.selection = text;
      this.selectionListeners.forEach((listener) => listener());
    }
    write(data: string) {
      this.written.push(data);
    }
    focus() {
      this.focused++;
    }
    clear() {}
    dispose() {
      this.disposed = true;
    }
  }
  class FakeFitAddon {
    fit() {}
  }
  class FakeWebLinksAddon {}
  return { FakeTerminal, FakeFitAddon, FakeWebLinksAddon };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xterm.FakeFitAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: xterm.FakeWebLinksAddon }));
type FakeTerminal = InstanceType<typeof xterm.FakeTerminal>;

// 大きさの変化を見張るもの（パネルの大きさに xterm を合わせる）。jsdom には無く、大きさも測らないので、知らせない
if (!window.ResizeObserver)
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

let api: ReturnType<typeof mockApi>;
let inserted: { sessionId: string; text: string }[];
let seq: number;
beforeEach(() => {
  xterm.FakeTerminal.all = [];
  inserted = [];
  seq = 0;
  api = mockApi({
    // シェルを開くと、sh1・sh2… の id を返す
    'shell.create': () => Promise.resolve({ id: `sh${++seq}`, name: 'zsh' }),
  });
  api.install();
  localStorage.clear();
});
afterEach(cleanup);

// チャットの入力欄の代わり（差し込みを受け取る側のフック）
function Inbox({ sessionId }: { sessionId: string }) {
  useInsertInput(sessionId, (text) => inserted.push({ sessionId, text }));
  return null;
}

type PanelProps = { sessionId: string | null; view?: TerminalView; claudeScreen?: boolean; onView?: (view: TerminalView) => void; onClose?: () => void };
function Panel({ sessionId, view = 'shell', claudeScreen = true, onView = () => {}, onClose = () => {} }: PanelProps) {
  return (
    <>
      <TerminalPanel sessionId={sessionId} claudeScreen={claudeScreen} open view={view} onView={onView} onClose={onClose} />
      <Inbox sessionId="s1" />
      <Inbox sessionId="s2" />
    </>
  );
}

const tabs = () => screen.getAllByRole('tab').filter((t) => !t.classList.contains('claude-screen-tab'));
const tabNames = () => tabs().map((t) => t.querySelector('span')!.textContent);
const selectedTab = () => tabs().findIndex((t) => t.getAttribute('aria-selected') === 'true');
const closeOf = (index: number) => tabs()[index].querySelector('[aria-label="このターミナルを閉じる"]') as HTMLButtonElement;
const sendButton = () => screen.getByLabelText('Claude へ送る') as HTMLButtonElement;
// シェルの id → そのシェルの xterm（作った順に sh1・sh2…）
const termOf = (index: number): FakeTerminal => xterm.FakeTerminal.all[index];
const shown = (term: FakeTerminal) => !(term.element as HTMLElement).hidden;

async function newShell() {
  const before = tabs().length;
  fireEvent.click(screen.getByLabelText('新しいターミナル'));
  await waitFor(() => expect(tabs()).toHaveLength(before + 1));
}

describe('TerminalPanel: シェルのタブ', () => {
  it('タブを押すと、そのシェルを出してシェルの表示にする', async () => {
    const onView = vi.fn();
    render(<Panel sessionId="s1" onView={onView} />);
    // 1 つも無ければ開く
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    await newShell();
    expect(tabNames()).toEqual(['zsh 1', 'zsh 2']);
    expect(selectedTab()).toBe(1);
    expect([shown(termOf(0)), shown(termOf(1))]).toEqual([false, true]);
    onView.mockClear();

    fireEvent.click(tabs()[0]);
    expect(selectedTab()).toBe(0);
    expect([shown(termOf(0)), shown(termOf(1))]).toEqual([true, false]);
    expect(onView).toHaveBeenCalledWith('shell');
  });

  it('Claude Code の画面を出しているときにシェルのタブを押すと、シェルの表示に戻す', async () => {
    const onView = vi.fn();
    const { rerender } = render(<Panel sessionId="s1" onView={onView} />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    rerender(<Panel sessionId="s1" view="claude" onView={onView} />);
    expect(selectedTab()).toBe(-1);
    expect(shown(termOf(0))).toBe(false);
    fireEvent.click(tabs()[0]);
    expect(onView).toHaveBeenLastCalledWith('shell');
  });

  it('× はタブを選ばずに、そのシェルを止める（終わったという知らせでタブを閉じる）', async () => {
    const onView = vi.fn();
    render(<Panel sessionId="s1" onView={onView} />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    await newShell();
    onView.mockClear();
    fireEvent.click(closeOf(0));
    expect(api.argsOf('shell.kill')).toEqual([['sh1']]);
    // 選んでいるタブは変えない
    expect(selectedTab()).toBe(1);
    expect(onView).not.toHaveBeenCalled();
    act(() => api.emit('shell.onExit', { id: 'sh1', exitCode: 0 }));
    // 残ったのは sh2（タブの番号は並び順で付け直す）
    expect(tabNames()).toEqual(['zsh 1']);
    expect(termOf(0).disposed).toBe(true);
    expect(termOf(0).element!.isConnected).toBe(false);
    expect(shown(termOf(1))).toBe(true);
    fireEvent.click(closeOf(0));
    expect(api.argsOf('shell.kill')).toEqual([['sh1'], ['sh2']]);
  });

  it('アプリが開いたコマンドのタブ: 動いている間の × は止め、終わったあとの × はタブを片付ける', async () => {
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    act(() => api.emit('shell.onOpened', { owner: 's1', id: 'task1', name: 'npm install' }));
    expect(tabNames()).toEqual(['zsh 1', 'npm install（実行中）']);
    expect(selectedTab()).toBe(1);
    expect(closeOf(1).getAttribute('data-tip')).toBe('止めて閉じる');
    fireEvent.click(closeOf(1));
    expect(api.argsOf('shell.kill')).toEqual([['task1']]);

    act(() => api.emit('shell.onExit', { id: 'task1', exitCode: 1 }));
    // 出力を見られるよう、終わってもタブは残す
    expect(tabNames()).toEqual(['zsh 1', 'npm install（失敗 1）']);
    const task = termOf(1);
    fireEvent.click(closeOf(1));
    expect(api.argsOf('shell.kill')).toEqual([['task1']]);
    expect(tabNames()).toEqual(['zsh 1']);
    expect(task.disposed).toBe(true);
    expect(task.element!.isConnected).toBe(false);
  });
});

describe('TerminalPanel: Claude へ送る', () => {
  it('出力を選んだときだけ押せて、選んだ出力をコードブロックにしてチャットの入力欄に貼る', async () => {
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    expect(sendButton().disabled).toBe(true);
    act(() => termOf(0).select('$ npm test\nFAIL  src/app.test.ts\n\n'));
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    expect(inserted).toEqual([{ sessionId: 's1', text: '```\n$ npm test\nFAIL  src/app.test.ts\n```' }]);
    act(() => termOf(0).select(''));
    expect(sendButton().disabled).toBe(true);
  });

  it('同じセッションでタブを替えたら、そのタブで選んでいるものを送る', async () => {
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    act(() => termOf(0).select('1 つ目のシェル'));
    await newShell();
    // 新しいタブでは何も選んでいない
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    act(() => termOf(1).select('2 つ目のシェル'));
    fireEvent.click(tabs()[0]);
    fireEvent.click(sendButton());
    expect(inserted.map((i) => i.text)).toEqual(['```\n1 つ目のシェル\n```']);
  });
});

describe('TerminalPanel: Claude Code の画面のタブ', () => {
  it('押すと Claude Code の画面とシェルを切り替える。新規セッションの画面（claudeScreen なし）では出さない', async () => {
    const onView = vi.fn();
    const { rerender } = render(<Panel sessionId="s1" onView={onView} />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    const screenTab = () => screen.getByLabelText('Claude Code の画面');
    expect(screenTab().getAttribute('aria-selected')).toBe('false');
    fireEvent.click(screenTab());
    expect(onView).toHaveBeenLastCalledWith('claude');

    rerender(<Panel sessionId="s1" view="claude" onView={onView} />);
    expect(screenTab().getAttribute('aria-selected')).toBe('true');
    // Claude Code の画面を、そのセッションの pty の大きさで出す
    expect(api.argsOf('pty.resize')).toEqual([['s1', 80, 24]]);
    expect(screen.queryByLabelText('Claude へ送る')).toBeNull();
    fireEvent.click(screenTab());
    expect(onView).toHaveBeenLastCalledWith('shell');

    rerender(<Panel sessionId="s1" claudeScreen={false} view="claude" onView={onView} />);
    expect(screen.queryByLabelText('Claude Code の画面')).toBeNull();
    // Claude Code の画面が無いところでは、シェルを出す
    expect(selectedTab()).toBe(0);
  });

  it('上の縁をドラッグしてパネルの高さを変え、離すと覚える（次に開いたときもその高さ）', async () => {
    // jsdom は押さえる（pointer capture）を持たない
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    const { container, unmount } = render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    const panel = container.querySelector('.terminal-panel') as HTMLElement;
    const edge = screen.getByRole('separator');
    expect(panel.style.height).toBe('280px');
    // 押していないときに動かしても変えない
    fireEvent.pointerMove(edge, { clientY: 100 });
    expect(panel.style.height).toBe('280px');

    fireEvent.pointerDown(edge, { clientY: 500, pointerId: 1 });
    expect(document.body.classList.contains('resizing-rows')).toBe(true);
    fireEvent.pointerMove(edge, { clientY: 400, pointerId: 1 });
    expect(panel.style.height).toBe('380px');
    // 低くても 120px、高くても画面の高さ - 200px
    fireEvent.pointerMove(edge, { clientY: 900, pointerId: 1 });
    expect(panel.style.height).toBe('120px');
    fireEvent.pointerMove(edge, { clientY: -2000, pointerId: 1 });
    expect(panel.style.height).toBe(`${window.innerHeight - 200}px`);
    fireEvent.pointerMove(edge, { clientY: 450, pointerId: 1 });
    expect(localStorage.getItem('tanacode.terminalHeight')).toBeNull();
    fireEvent.pointerUp(edge, { clientY: 450, pointerId: 1 });
    expect(document.body.classList.contains('resizing-rows')).toBe(false);
    expect(localStorage.getItem('tanacode.terminalHeight')).toBe('330');
    fireEvent.pointerMove(edge, { clientY: 100 });
    expect(panel.style.height).toBe('330px');

    unmount();
    const again = render(<Panel sessionId="s1" />);
    expect((again.container.querySelector('.terminal-panel') as HTMLElement).style.height).toBe('330px');
  });

  it('パネルを閉じるボタンで onClose を呼ぶ', async () => {
    const onClose = vi.fn();
    render(<Panel sessionId="s1" onClose={onClose} />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    fireEvent.click(screen.getByLabelText('パネルを閉じる'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('TerminalPanel: セッションを切り替えた直後のボタン', () => {
  it('タブ・×・Claude へ送る・Claude Code の画面は、切り替えた先のセッションに効く', async () => {
    const onView = vi.fn();
    const { rerender } = render(<Panel sessionId="s1" onView={onView} />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    act(() => termOf(0).select('s1 の出力'));

    rerender(<Panel sessionId="s2" onView={onView} />);
    // s2 のシェルを開く（s1 のシェルは動かしたまま隠す）
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    expect(api.argsOf('shell.create').map(([owner]) => owner)).toEqual(['s1', 's2']);
    expect([shown(termOf(0)), shown(termOf(1))]).toEqual([false, true]);
    // s2 のシェルでは何も選んでいない
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    act(() => termOf(1).select('s2 の出力'));
    fireEvent.click(sendButton());
    expect(inserted).toEqual([{ sessionId: 's2', text: '```\ns2 の出力\n```' }]);

    await newShell();
    fireEvent.click(tabs()[0]);
    expect([shown(termOf(0)), shown(termOf(1)), shown(termOf(2))]).toEqual([false, true, false]);
    fireEvent.click(closeOf(1));
    expect(api.argsOf('shell.kill')).toEqual([['sh3']]);

    fireEvent.click(screen.getByLabelText('Claude Code の画面'));
    rerender(<Panel sessionId="s2" view="claude" onView={onView} />);
    expect(api.argsOf('pty.resize').at(-1)).toEqual(['s2', 80, 24]);

    // s1 に戻ると、s1 のシェルと選んでいた出力がそのまま残っている
    rerender(<Panel sessionId="s1" onView={onView} />);
    expect(tabNames()).toEqual(['zsh 1']);
    expect(shown(termOf(0))).toBe(true);
    fireEvent.click(sendButton());
    expect(inserted.at(-1)).toEqual({ sessionId: 's1', text: '```\ns1 の出力\n```' });
    fireEvent.click(closeOf(0));
    expect(api.argsOf('shell.kill').at(-1)).toEqual(['sh1']);
  });
});
