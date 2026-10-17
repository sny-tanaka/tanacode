// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellSnapshot } from '@shared/ipc';
import { useInsertInput } from '../../src/renderer/src/chat/insertInput';
import { runInTerminal } from '../../src/renderer/src/terminal/runInTerminal';
import { TerminalPanel } from '../../src/renderer/src/terminal/TerminalPanel';
import './dom';
import { mockApi } from './mock-api';

// エディタの下のターミナルパネル（TerminalPanel）のタブ・ボタンを押して、効いたことを確かめる。
// jsdom では xterm が描けないので、xterm を、書いたもの・選んでいる文字を持つだけの偽物に差し替える

const xterm = vi.hoisted(() => {
  type Listener<T> = (value: T) => void;
  class FakeTerminal {
    static all: FakeTerminal[] = [];
    // これを書こうとすると投げる（画面を書き直せないときを確かめる）
    static failOn: string | null = null;
    // 次のタイトルの受け手を付けるときに、一度だけ投げる（引き継ぎの途中の、書き直しのあとで投げるときを確かめる）
    static failTitleOnce = false;
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
    private dataListeners: Listener<string>[] = [];
    onData(listener: Listener<string>) {
      this.dataListeners.push(listener);
      return { dispose() {} };
    }
    // 人が xterm で打ったことにする
    input(data: string) {
      this.dataListeners.forEach((listener) => listener(data));
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    onResize(_listener: Listener<{ cols: number; rows: number }>) {
      return { dispose() {} };
    }
    private titleListeners: Listener<string>[] = [];
    onTitleChange(listener: Listener<string>) {
      if (FakeTerminal.failTitleOnce) {
        FakeTerminal.failTitleOnce = false;
        throw new Error('受け手を付けられません');
      }
      this.titleListeners.push(listener);
      return { dispose() {} };
    }
    // シェルがタイトルを付けたことにする
    emitTitle(title: string) {
      this.titleListeners.forEach((listener) => listener(title));
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
      if (FakeTerminal.failOn !== null && data === FakeTerminal.failOn) throw new Error('書けません');
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
  xterm.FakeTerminal.failOn = null;
  xterm.FakeTerminal.failTitleOnce = false;
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

type PanelProps = { sessionId: string | null; onClose?: () => void };
function Panel({ sessionId, onClose = () => {} }: PanelProps) {
  return (
    <>
      <TerminalPanel sessionId={sessionId} open onOpen={() => {}} onClose={onClose} />
      <Inbox sessionId="s1" />
      <Inbox sessionId="s2" />
    </>
  );
}

const tabs = () => screen.queryAllByRole('tab');
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
  it('タブを押すと、そのシェルを出す', async () => {
    render(<Panel sessionId="s1" />);
    // 1 つも無ければ開く
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    await newShell();
    expect(tabNames()).toEqual(['zsh 1', 'zsh 2']);
    expect(selectedTab()).toBe(1);
    expect([shown(termOf(0)), shown(termOf(1))]).toEqual([false, true]);

    fireEvent.click(tabs()[0]);
    expect(selectedTab()).toBe(0);
    expect([shown(termOf(0)), shown(termOf(1))]).toEqual([true, false]);
  });

  it('× はタブを選ばずに、そのシェルを止める（終わったという知らせでタブを閉じる）', async () => {
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    await newShell();
    fireEvent.click(closeOf(0));
    expect(api.argsOf('shell.kill')).toEqual([['sh1']]);
    // 選んでいるタブは変えない
    expect(selectedTab()).toBe(1);
    act(() => api.emit('shell.onExit', { id: 'sh1', exitCode: 0 }));
    // 残ったのは sh2（タブの番号は並び順で付け直す）
    expect(tabNames()).toEqual(['zsh 1']);
    expect(termOf(0).disposed).toBe(true);
    expect(termOf(0).element!.isConnected).toBe(false);
    expect(shown(termOf(1))).toBe(true);
    fireEvent.click(closeOf(0));
    expect(api.argsOf('shell.kill')).toEqual([['sh1'], ['sh2']]);
  });

  // 動いている間の ×（止めて閉じる）は、下の「押しても効かない（不具合）」で確かめる
  it('アプリが開いたコマンドのタブ: ひとりでに終わってもタブは残し、終わったあとの × はタブを片付ける', async () => {
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    act(() => api.emit('shell.onOpened', { owner: 's1', id: 'task1', name: 'npm install', task: true }));
    expect(tabNames()).toEqual(['zsh 1', 'npm install（実行中）']);
    expect(selectedTab()).toBe(1);
    expect(closeOf(1).getAttribute('data-tip')).toBe('止めて閉じる');

    act(() => api.emit('shell.onExit', { id: 'task1', exitCode: 1 }));
    // 出力を見られるよう、終わってもタブは残す
    expect(tabNames()).toEqual(['zsh 1', 'npm install（失敗 1）']);
    expect(closeOf(1).getAttribute('data-tip')).toBe('このターミナルを閉じる');
    const task = termOf(1);
    fireEvent.click(closeOf(1));
    // もう止まっているので、タブを片付け、main に出力の控え（Claude が読むもの）を捨てさせる
    expect(api.argsOf('shell.kill')).toEqual([['task1']]);
    expect(tabNames()).toEqual(['zsh 1']);
    expect(task.disposed).toBe(true);
    expect(task.element!.isConnected).toBe(false);
  });

  it('Claude が打つために開いたシェル: 人が開いたシェルと同じタブとして出し、選ぶ。タイトルを追い、終わったらタブを閉じる', async () => {
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    act(() => api.emit('shell.onOpened', { owner: 's1', id: 'shell-9', name: 'zsh', task: false }));
    expect(tabNames()).toEqual(['zsh 1', 'zsh 2']);
    expect(selectedTab()).toBe(1);
    expect(closeOf(1).getAttribute('data-tip')).toBe('このターミナルを閉じる');
    const opened = termOf(1);
    act(() => opened.emitTitle('npm run dev'));
    expect(tabNames()).toEqual(['zsh 1', 'npm run dev']);
    // 出力は、そのタブの xterm に書く
    act(() => api.emit('shell.onData', { id: 'shell-9', data: 'ready' }));
    expect(opened.written).toEqual(['ready']);
    act(() => api.emit('shell.onExit', { id: 'shell-9', exitCode: 0 }));
    expect(tabNames()).toEqual(['zsh 1']);
    expect(opened.disposed).toBe(true);
  });
});

describe('TerminalPanel: 画面を読み込み直したあと（⌘R）', () => {
  // main が持っているターミナル（引き継ぐもの）
  const snapshot = (over: Partial<ShellSnapshot> & Pick<ShellSnapshot, 'owner' | 'id'>): ShellSnapshot => ({
    name: 'zsh',
    title: null,
    task: false,
    exitCode: null,
    cols: 80,
    rows: 24,
    screen: '',
    ...over,
  });

  it('動いているシェルを引き継ぎ、タブ・画面の中身・タイトル・終わったコマンドのタブを出し直す。引き継ぐ前に届いた出力は画面のあとに書き、終わったシェルは出さない', async () => {
    let attach!: (list: ShellSnapshot[]) => void;
    api = mockApi({
      'shell.attach': () => new Promise<ShellSnapshot[]>((resolve) => (attach = resolve)),
      'shell.create': () => Promise.resolve({ id: `sh${++seq}`, name: 'zsh' }),
    });
    api.install();
    const view = render(<Panel sessionId="s1" />);
    // 引き継ぐまでは、新しいシェルを開かない（引き継ぐものがあるかもしれない）
    await act(async () => {});
    expect(api.argsOf('shell.attach')).toEqual([[]]);
    expect(api.argsOf('shell.create')).toEqual([]);
    // main が画面を控えたあとの出力と、終わったシェル（引き継ぐ返事より先に届くことがある）
    act(() => api.emit('shell.onData', { id: 'shell-1', data: 'compiled\r\n' }));
    act(() => api.emit('shell.onExit', { id: 'shell-4', exitCode: 0 }));
    await act(async () =>
      attach([
        snapshot({ owner: 's1', id: 'shell-1', title: 'dev server', cols: 120, rows: 30, screen: 'npm run dev\r\nready\r\n' }),
        snapshot({ owner: 's2', id: 'shell-2', screen: 's2 の画面' }),
        snapshot({ owner: 's1', id: 'task-3', name: 'npm install', task: true, exitCode: 0, cols: 100, screen: 'added 10 packages' }),
        snapshot({ owner: 's1', id: 'shell-4' }),
      ]),
    );
    expect(tabNames()).toEqual(['dev server', 'npm install（完了）']);
    expect(api.argsOf('shell.create')).toEqual([]);
    const dev = termOf(0);
    expect([dev.cols, dev.rows]).toEqual([120, 30]);
    expect(dev.written).toEqual(['npm run dev\r\nready\r\n', 'compiled\r\n']);
    // 引き継いだあとの出力・タイトル・終わりは、ふだんどおり
    act(() => api.emit('shell.onData', { id: 'shell-1', data: 'reloaded\r\n' }));
    expect(dev.written.at(-1)).toBe('reloaded\r\n');
    act(() => dev.emitTitle('vite'));
    expect(tabNames()).toEqual(['vite', 'npm install（完了）']);
    // 打った文字は、引き継いだシェルに届く
    act(() => dev.input('q'));
    expect(api.argsOf('shell.write')).toEqual([['shell-1', 'q']]);
    // 終わったコマンドのタブの × は、片付ける
    fireEvent.click(closeOf(1));
    expect(api.argsOf('shell.kill')).toEqual([['task-3']]);
    expect(tabNames()).toEqual(['vite']);
    // ほかのセッションのシェルも、戻ると出る
    view.rerender(<Panel sessionId="s2" />);
    expect(tabNames()).toEqual(['zsh 1']);
    expect(xterm.FakeTerminal.all.find((t) => t.written.includes('s2 の画面'))).toBeTruthy();
    expect(api.argsOf('shell.create')).toEqual([]);
  });

  it('引き継ぐ頼みが一度断られたら、一度だけ頼み直す（動いているシェルを、見えないまま残さない）', async () => {
    let asked = 0;
    api = mockApi({
      'shell.attach': () => (++asked === 1 ? Promise.reject(new Error('まだ答えられません')) : Promise.resolve([snapshot({ owner: 's1', id: 'shell-1', screen: '前の画面' })])),
      'shell.create': () => Promise.resolve({ id: `sh${++seq}`, name: 'zsh' }),
    });
    api.install();
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    expect(api.argsOf('shell.attach')).toHaveLength(2);
    expect(api.argsOf('shell.create')).toEqual([]);
    expect(termOf(0).written).toEqual(['前の画面']);
  });

  it('画面を書き直せなかったシェルは、止めて片付け、ほかのシェルは引き継ぐ。パネルは、ふだんどおりシェルを開ける', async () => {
    xterm.FakeTerminal.failOn = 'こわれた画面';
    api = mockApi({
      'shell.attach': () =>
        Promise.resolve([snapshot({ owner: 's1', id: 'shell-1', screen: 'こわれた画面' }), snapshot({ owner: 's2', id: 'shell-2', screen: 's2 の画面' })]),
      'shell.create': () => Promise.resolve({ id: `sh${++seq}`, name: 'zsh' }),
    });
    api.install();
    const view = render(<Panel sessionId="s1" />);
    // s1 には引き継げたシェルが無いので、新しく開く
    await waitFor(() => expect(api.argsOf('shell.create').map(([owner]) => owner)).toEqual(['s1']));
    expect(api.argsOf('shell.kill')).toEqual([['shell-1']]);
    expect(termOf(0).disposed).toBe(true);
    expect(termOf(0).element!.isConnected).toBe(false);
    view.rerender(<Panel sessionId="s2" />);
    expect(tabNames()).toEqual(['zsh 1']);
    expect(xterm.FakeTerminal.all.some((t) => t.written.includes('s2 の画面'))).toBe(true);
  });

  it('書き直したあと（タイトルの受け手を付けるところ）で投げたシェルも、止めて xterm を片付ける。ほかのシェルは引き継ぐ', async () => {
    xterm.FakeTerminal.failTitleOnce = true;
    api = mockApi({
      'shell.attach': () =>
        Promise.resolve([
          snapshot({ owner: 's1', id: 'shell-1', screen: '前の画面' }),
          snapshot({ owner: 's1', id: 'task-2', name: 'npm install', task: true, exitCode: 0, screen: 'added 1 package' }),
        ]),
      'shell.create': () => Promise.resolve({ id: `sh${++seq}`, name: 'zsh' }),
    });
    api.install();
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['npm install（完了）']));
    expect(api.argsOf('shell.kill')).toEqual([['shell-1']]);
    const broken = termOf(0);
    expect(broken.disposed).toBe(true);
    expect(broken.element!.isConnected).toBe(false);
    // 片付けた xterm には、もう書かない
    act(() => api.emit('shell.onData', { id: 'shell-1', data: 'まだ出力' }));
    expect(broken.written).toEqual(['前の画面']);
  });

  it('引き継げなかったとき（main が答えられなかった）も、ふだんどおり新しいシェルを開く', async () => {
    api = mockApi({ 'shell.attach': () => Promise.reject(new Error('答えられません')), 'shell.create': () => Promise.resolve({ id: `sh${++seq}`, name: 'zsh' }) });
    api.install();
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    expect(api.argsOf('shell.create')).toHaveLength(1);
  });

  it('引き継ぐものが無ければ、ふだんどおり新しいシェルを開く', async () => {
    api = mockApi({ 'shell.attach': () => Promise.resolve([]), 'shell.create': () => Promise.resolve({ id: `sh${++seq}`, name: 'zsh' }) });
    api.install();
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    expect(api.argsOf('shell.create')).toHaveLength(1);
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

describe('TerminalPanel: パネルの高さ・閉じる', () => {
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

describe('TerminalPanel: チャットのコードブロックの「実行」（runInTerminal）', () => {
  it('閉じているパネルを開かせ、新しいシェルのタブでコマンドを動かす。見ていないセッションのものは動かさない', async () => {
    const onOpen = vi.fn();
    render(<TerminalPanel sessionId="s1" open={false} onOpen={onOpen} onClose={() => {}} />);
    expect(runInTerminal('s2', 'rm -rf dist')).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    expect(runInTerminal('s1', 'npm test')).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.argsOf('shell.write')).toEqual([['sh1', 'npm test\r']]));
  });
});

describe('TerminalPanel: セッションを切り替えた直後のボタン', () => {
  it('タブ・×・Claude へ送るは、切り替えた先のセッションに効く', async () => {
    const { rerender } = render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    act(() => termOf(0).select('s1 の出力'));

    rerender(<Panel sessionId="s2" />);
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

    // s1 に戻ると、s1 のシェルと選んでいた出力がそのまま残っている
    rerender(<Panel sessionId="s1" />);
    expect(tabNames()).toEqual(['zsh 1']);
    expect(shown(termOf(0))).toBe(true);
    fireEvent.click(sendButton());
    expect(inserted.at(-1)).toEqual({ sessionId: 's1', text: '```\ns1 の出力\n```' });
    fireEvent.click(closeOf(0));
    expect(api.argsOf('shell.kill').at(-1)).toEqual(['sh1']);
  });
});

describe('TerminalPanel: シェルを開いている途中にセッションを切り替えたとき', () => {
  // シェルを開く返事を、テストが好きなときに返す
  function slowCreate() {
    const creates: ((shell: { id: string; name: string }) => void)[] = [];
    api = mockApi({ 'shell.attach': () => Promise.resolve([]), 'shell.create': () => new Promise((resolve) => creates.push(resolve)) });
    api.install();
    return creates;
  }

  it('前のセッションのために開いたシェルは、出さずに止めて片付け、切り替えた先のシェルを開く。打った文字は、切り替えた先のシェルに届く', async () => {
    const creates = slowCreate();
    const { rerender } = render(<Panel sessionId="s1" />);
    await waitFor(() => expect(api.argsOf('shell.create')).toEqual([['s1', 80, 24]]));
    const first = termOf(0);
    rerender(<Panel sessionId="s2" />);
    await act(async () => creates[0]({ id: 'sh1', name: 'zsh' }));
    // s1 のシェルは、見えたまま残さず、止めて片付ける
    expect(api.argsOf('shell.kill')).toEqual([['sh1']]);
    expect(first.disposed).toBe(true);
    expect(first.element!.isConnected).toBe(false);
    expect(tabs()).toEqual([]);
    // 切り替えた先（s2）のシェルを開き、打った文字は s2 のシェルに届く
    await waitFor(() => expect(api.argsOf('shell.create').map(([owner]) => owner)).toEqual(['s1', 's2']));
    await act(async () => creates[1]({ id: 'sh2', name: 'zsh' }));
    expect(tabNames()).toEqual(['zsh 1']);
    const second = termOf(1);
    expect(shown(second)).toBe(true);
    act(() => second.input('ls'));
    expect(api.argsOf('shell.write')).toEqual([['sh2', 'ls']]);
    // s1 に戻ると、片付けたシェルのタブは無く、新しく開く
    rerender(<Panel sessionId="s1" />);
    await waitFor(() => expect(api.argsOf('shell.create').map(([owner]) => owner)).toEqual(['s1', 's2', 's1']));
  });

  it('シェルを開けなかったら、作った xterm を残さず、開き直しも繰り返さない', async () => {
    api = mockApi({ 'shell.attach': () => Promise.resolve([]), 'shell.create': () => Promise.reject(new Error('フォルダがありません')) });
    api.install();
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(api.argsOf('shell.create')).toHaveLength(1));
    await act(async () => {});
    expect(termOf(0).disposed).toBe(true);
    expect(termOf(0).element!.isConnected).toBe(false);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(api.argsOf('shell.create')).toHaveLength(1);
  });

  it('チャットのコードブロックの「実行」で開いていたシェルなら、コマンドは打たず、戻ったときにも打たない', async () => {
    const creates = slowCreate();
    const { rerender } = render(
      <>
        <TerminalPanel sessionId="s1" open={false} onOpen={() => {}} onClose={() => {}} />
      </>,
    );
    await act(async () => {});
    act(() => void runInTerminal('s1', 'npm test'));
    await waitFor(() => expect(api.argsOf('shell.create')).toHaveLength(1));
    rerender(<TerminalPanel sessionId="s2" open={false} onOpen={() => {}} onClose={() => {}} />);
    await act(async () => creates[0]({ id: 'sh1', name: 'zsh' }));
    expect(api.argsOf('shell.kill')).toEqual([['sh1']]);
    // s1 に戻ってパネルを開き、新しいシェルができても、コマンドは打たない
    rerender(<TerminalPanel sessionId="s1" open onOpen={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(api.argsOf('shell.create')).toHaveLength(2));
    await act(async () => creates[1]({ id: 'sh2', name: 'zsh' }));
    expect(tabNames()).toEqual(['zsh 1']);
    expect(api.argsOf('shell.write')).toEqual([]);
  });
});

describe('TerminalPanel: 一覧から消した・アーカイブしたセッションのシェル', () => {
  it('動いているセッション（と新規セッションの画面のフォルダ）に無い持ち主のシェルは、止めて xterm を片付ける。一覧をまだ読んでいない間（null）は何もしない', async () => {
    const panel = (sessionId: string, liveOwners: string[] | null) => (
      <TerminalPanel sessionId={sessionId} liveOwners={liveOwners} open onOpen={() => {}} onClose={() => {}} />
    );
    const { rerender } = render(panel('s1', null));
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    act(() => api.emit('shell.onOpened', { owner: 's1', id: 'task1', name: 'npm install', task: true }));
    act(() => api.emit('shell.onExit', { id: 'task1', exitCode: 0 }));
    rerender(panel('s2', null));
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    const [s1Shell, s1Task, s2Shell] = xterm.FakeTerminal.all;
    expect(api.argsOf('shell.kill')).toEqual([]);
    // s1 を消した（アーカイブも同じ。動いているセッションの一覧に無い）
    rerender(panel('s2', ['s2']));
    expect(api.argsOf('shell.kill')).toEqual([['sh1'], ['task1']]);
    expect([s1Shell.disposed, s1Task.disposed, s2Shell.disposed]).toEqual([true, true, false]);
    expect(s1Shell.element!.isConnected).toBe(false);
    expect(tabNames()).toEqual(['zsh 1']);
    // 片付けたシェルの終わりの知らせが、あとから届いても何もしない
    act(() => api.emit('shell.onExit', { id: 'sh1', exitCode: 129 }));
    expect(tabNames()).toEqual(['zsh 1']);
    expect(api.argsOf('shell.kill')).toHaveLength(2);
  });
});

// いまのコードでは落ちる（押しても効かない）。あるべき動きを書いておく
describe('TerminalPanel: 押しても効かない（不具合）', () => {
  it('動いているコマンドのタブの ×（「止めて閉じる」）は、止めたあとタブも閉じる', async () => {
    render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    act(() => api.emit('shell.onOpened', { owner: 's1', id: 'task1', name: 'npm install', task: true }));
    const task = termOf(1);
    expect(closeOf(1).getAttribute('data-tip')).toBe('止めて閉じる');
    fireEvent.click(closeOf(1));
    expect(api.argsOf('shell.kill')).toEqual([['task1']]);
    // main がコマンドを止め、終わったと知らせてくる
    act(() => api.emit('shell.onExit', { id: 'task1', exitCode: 129 }));
    expect(tabNames()).toEqual(['zsh 1']);
    expect(task.disposed).toBe(true);
    expect(task.element!.isConnected).toBe(false);
  });

  it('シェルを開いている途中のセッションに切り替えた直後は、前のセッションで選んでいた出力があっても「Claude へ送る」を押せない', async () => {
    let created = 0;
    // s1 のシェルはすぐ開き、s2 のシェルは開いている途中のまま（フォルダが無いなどで開けないときも同じ）
    api = mockApi({ 'shell.create': () => (++created === 1 ? Promise.resolve({ id: 'sh1', name: 'zsh' }) : new Promise(() => {})) });
    api.install();
    const { rerender } = render(<Panel sessionId="s1" />);
    await waitFor(() => expect(tabNames()).toEqual(['zsh 1']));
    act(() => termOf(0).select('s1 の出力'));
    expect(sendButton().disabled).toBe(false);

    rerender(<Panel sessionId="s2" />);
    await waitFor(() => expect(api.argsOf('shell.create')).toHaveLength(2));
    expect(tabs()).toEqual([]);
    // 押せるように見えるが、押しても何も貼られない
    fireEvent.click(sendButton());
    expect(inserted).toEqual([]);
    expect(sendButton().disabled).toBe(true);
  });
});
