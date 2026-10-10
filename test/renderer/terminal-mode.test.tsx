// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import type { ScreenInfo } from '@shared/screen';
import { ClaudePane } from '../../src/renderer/src/chat/ClaudePane';
import { EMPTY_CHAT, type ChatState } from '../../src/renderer/src/chat/chatState';
import { insertIntoChat } from '../../src/renderer/src/chat/insertInput';
import type { ReviewComment } from '../../src/renderer/src/review/comments';
import { useClaudeScreenOutput } from '../../src/renderer/src/terminal/ClaudeScreen';
import { LEAVE_MS } from '../../src/renderer/src/terminal/claudeScreenTyping';
import { useTerminalMode } from '../../src/renderer/src/terminal/terminalMode';
import './dom';
import { mockApi } from './mock-api';

// ターミナルモード: Claude Code ペイン（ClaudePane）に、チャットと入力欄の代わりに Claude Code そのものの画面（ClaudeScreen）を出す。
// jsdom では xterm が描けないので、xterm を、書いたもの・置いた場所を持つだけの偽物に差し替える

const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static all: FakeTerminal[] = [];
    cols = 62;
    rows = 48;
    element: HTMLElement | null = null;
    written: string[] = [];
    disposed = false;
    focused = 0;
    constructor() {
      FakeTerminal.all.push(this);
    }
    loadAddon() {}
    open(element: HTMLElement) {
      this.element = element;
    }
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    write(data: string) {
      this.written.push(data);
    }
    focus() {
      this.focused++;
    }
    dispose() {
      this.disposed = true;
    }
  }
  class FakeFitAddon {
    fit() {}
  }
  return { FakeTerminal, FakeFitAddon };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xterm.FakeFitAddon }));
// ペインはコメントの本文を作る関数（formatComments）を LineComments から読むので、Monaco も読み込まれる。ペインでは使わないので、空にして速くする
vi.mock('../../src/renderer/src/editor/monaco', () => ({ monaco: {} }));

// 大きさの変化を見張るもの（ペインの大きさに xterm を合わせる）。jsdom には無く、大きさも測らないので、知らせない
if (!window.ResizeObserver)
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: `セッション ${id}`,
  cwd: '/Users/me/work/app',
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  running: false,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
  ...over,
});
const S1 = summary('s1');
const S2 = summary('s2');
const promptOf = (draft = ''): ScreenInfo => ({ state: { kind: 'prompt' }, model: null, effort: null, mode: 'manual', draft, ready: true });
const chatOf = (over: Partial<ChatState> = {}): ChatState => ({ ...EMPTY_CHAT, status: 'idle', items: [{ kind: 'user', id: 'u1', text: 'ログインを直してください' }], ...over });
const COMMENT: ReviewComment = { id: 'c1', path: 'src/tax.ts', startLine: 3, endLine: 3, quote: 'const rate = 0.1;', text: '税率は引数で受け取る' };

type Props = ComponentProps<typeof ClaudePane>;
const noop = () => {};
function props(over: Partial<Props> = {}): Props {
  return {
    session: S1,
    sessions: [S1, S2],
    onSelectSession: noop,
    chat: chatOf(),
    screen: promptOf(),
    workflows: new Map(),
    subagents: new Map(),
    bashTasks: new Map(),
    contextTokens: null,
    statusLine: null,
    tasks: [],
    activeTaskKey: null,
    onOpenTask: noop,
    onStopTask: noop,
    stoppingTasks: new Set(),
    terminalOpen: true,
    comments: [],
    onCommentsChange: noop,
    onShowComment: noop,
    onOpenTerminal: noop,
    onShowContext: noop,
    onShowShell: noop,
    onToggleTerminal: noop,
    onOpenFile: noop,
    onResume: noop,
    onUnarchive: noop,
    onSend: noop,
    pending: null,
    sending: [],
    onTakePending: () => null,
    scheduled: [],
    ...over,
  };
}

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  xterm.FakeTerminal.all = [];
  api = mockApi({ 'settingsFiles.list': () => Promise.resolve([]) });
  api.install();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const chatList = (root: HTMLElement) => root.querySelector<HTMLElement>('.chat-list-wrap')!;
const chatInput = (root: HTMLElement) => root.querySelector<HTMLElement>('.chat-input-wrap')!;
const screenHost = (root: HTMLElement) => root.querySelector<HTMLElement>('.claude-screen');
const termOf = (index: number) => xterm.FakeTerminal.all[index];
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

describe('ターミナルモード: Claude Code の画面を出す', () => {
  it('チャットと入力欄を隠して、Claude Code の画面を出す。pty を画面の大きさにし、チャットに戻すと既定の大きさに戻す', () => {
    const { container, rerender } = render(<ClaudePane {...props({ terminalOpen: false })} />);
    expect(screenHost(container)).toBeNull();
    expect([chatList(container).hidden, chatInput(container).hidden]).toEqual([false, false]);
    expect(screen.getByLabelText('ターミナルモード').getAttribute('aria-pressed')).toBe('false');

    rerender(<ClaudePane {...props()} />);
    expect(screen.getByLabelText('ターミナルモード').getAttribute('aria-pressed')).toBe('true');
    expect([chatList(container).hidden, chatInput(container).hidden]).toEqual([true, true]);
    // 画面は、ヘッダーの下に置く（ヘッダーは残す）
    expect(container.querySelector('.claude-header')).not.toBeNull();
    expect(screenHost(container)!.contains(termOf(0).element)).toBe(true);
    expect(termOf(0).focused).toBe(1);
    expect(api.argsOf('pty.resize')).toEqual([['s1', 62, 48]]);
    expect(api.argsOf('pty.resetSize')).toEqual([]);

    rerender(<ClaudePane {...props({ terminalOpen: false })} />);
    expect(screenHost(container)).toBeNull();
    expect([chatList(container).hidden, chatInput(container).hidden]).toEqual([false, false]);
    expect(api.argsOf('pty.resetSize')).toEqual([['s1']]);
  });

  it('ヘッダーのボタンで切り替える（onToggleTerminal）', () => {
    const onToggleTerminal = vi.fn();
    render(<ClaudePane {...props({ onToggleTerminal })} />);
    fireEvent.click(screen.getByLabelText('ターミナルモード'));
    expect(onToggleTerminal).toHaveBeenCalledTimes(1);
  });

  it('セッションを切り替えると、前のセッションの pty を既定の大きさに戻し、移った先の画面を出す。戻ると、同じ画面をまた出す', () => {
    const { container, rerender } = render(<ClaudePane {...props()} />);
    rerender(<ClaudePane {...props({ session: S2 })} />);
    expect(api.argsOf('pty.resetSize')).toEqual([['s1']]);
    expect(api.argsOf('pty.resize').at(-1)).toEqual(['s2', 62, 48]);
    expect(termOf(0).element!.isConnected).toBe(false);
    expect(screenHost(container)!.contains(termOf(1).element)).toBe(true);

    rerender(<ClaudePane {...props()} />);
    // 作り直さない（それまでの出力を残す）
    expect(xterm.FakeTerminal.all).toHaveLength(2);
    expect(termOf(0).disposed).toBe(false);
    expect(screenHost(container)!.contains(termOf(0).element)).toBe(true);
  });

  it('チャットを見ている間・ほかのセッションを見ている間の出力も、画面に流しておく', () => {
    // App の代わり（アプリが動いている間、出力を受け取っておく）
    function Host(p: Props) {
      useClaudeScreenOutput();
      return <ClaudePane {...p} />;
    }
    const { container, rerender } = render(<Host {...props({ terminalOpen: false })} />);
    act(() => api.emit('pty.onData', { sessionId: 's1', data: 's1 の出力' }));
    act(() => api.emit('pty.onData', { sessionId: 's2', data: 's2 の出力' }));
    rerender(<Host {...props()} />);
    expect(termOf(0).written).toEqual(['s1 の出力']);
    expect(screenHost(container)!.contains(termOf(0).element)).toBe(true);
    // チャットに戻しても、画面は捨てない
    rerender(<Host {...props({ terminalOpen: false })} />);
    act(() => api.emit('pty.onData', { sessionId: 's1', data: 'つづき' }));
    expect(termOf(0).disposed).toBe(false);
    expect(termOf(0).written).toEqual(['s1 の出力', 'つづき']);
    expect(termOf(1).written).toEqual(['s2 の出力']);
  });

  it('アーカイブ済みのセッションには画面が無いので、チャットのまま', () => {
    const { container } = render(<ClaudePane {...props({ session: summary('s1', { archived: true }), chat: chatOf({ status: 'not-started' }) })} />);
    expect(screenHost(container)).toBeNull();
    expect(chatList(container).hidden).toBe(false);
    expect(api.argsOf('pty.resize')).toEqual([]);
  });
});

describe('ターミナルモード: 画面の下の知らせ', () => {
  it('Claude Code が終了したら、画面の下に「再開」を出す', () => {
    const onResume = vi.fn();
    const { container, rerender } = render(<ClaudePane {...props({ onResume })} />);
    expect(container.querySelector('.claude-screen-notes')).toBeNull();
    rerender(<ClaudePane {...props({ onResume, chat: chatOf({ status: 'exited', exitCode: 1 }) })} />);
    const notes = container.querySelector<HTMLElement>('.claude-screen-notes')!;
    expect(notes.textContent).toContain('Claude Code が終了しました（code 1）');
    fireEvent.click(notes.querySelector('button')!);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('コードへのコメントは画面の下に出し、「入力欄に貼る」で Claude Code の入力欄に貼って外す（送るのは、人が画面で Enter を押したとき）', () => {
    const onCommentsChange = vi.fn();
    const onShowComment = vi.fn();
    const { container } = render(<ClaudePane {...props({ comments: [COMMENT], onCommentsChange, onShowComment })} />);
    const notes = container.querySelector<HTMLElement>('.claude-screen-notes')!;
    fireEvent.click(notes.querySelector('.comment-chip')!);
    expect(onShowComment).toHaveBeenCalledWith(COMMENT);
    fireEvent.click(screen.getByRole('button', { name: '入力欄に貼る' }));
    const [[sessionId, data]] = api.argsOf('pty.write') as [string, string][];
    expect(sessionId).toBe('s1');
    expect(data.startsWith('\x1b[200~')).toBe(true);
    expect(data.endsWith('\x1b[201~')).toBe(true);
    expect(data).toContain('[1] src/tax.ts:3\n```\nconst rate = 0.1;\n```\n税率は引数で受け取る');
    // Enter は送らない
    expect(data).not.toContain('\r');
    expect(onCommentsChange).toHaveBeenCalledWith([]);
  });

  it('起動の途中・終了している間は、コメントを貼れない', () => {
    const button = () => screen.getByRole('button', { name: '入力欄に貼る' }) as HTMLButtonElement;
    const { rerender } = render(<ClaudePane {...props({ comments: [COMMENT], chat: chatOf({ status: 'starting' }) })} />);
    expect(button().disabled).toBe(true);
    rerender(<ClaudePane {...props({ comments: [COMMENT], chat: chatOf({ status: 'running' }) })} />);
    expect(button().disabled).toBe(false);
    rerender(<ClaudePane {...props({ comments: [COMMENT], chat: chatOf({ status: 'exited', exitCode: 0 }) })} />);
    expect(button().disabled).toBe(true);
  });
});

describe('ターミナルモード: 入力欄への差し込み（「Claude へ送る」など）', () => {
  it('見えていないチャットの入力欄ではなく、Claude Code の入力欄に貼る。画像は、パスを貼ってから空白を送る', async () => {
    vi.useFakeTimers();
    const { container } = render(<ClaudePane {...props()} />);
    act(() => insertIntoChat('s1', '```\n出力\n```'));
    expect(api.argsOf('pty.write')).toEqual([['s1', paste('```\n出力\n```')]]);
    expect(container.querySelector<HTMLTextAreaElement>('.chat-input textarea')!.value).toBe('');

    act(() => insertIntoChat('s1', '選んだ要素', ['/tmp/shot.png']));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(api.argsOf('pty.write').slice(1)).toEqual([
      ['s1', paste('/tmp/shot.png')],
      ['s1', ' '],
      ['s1', paste('選んだ要素')],
    ]);
    // 貼ったら、続きを打てるよう画面にフォーカスを戻す
    expect(termOf(0).focused).toBe(3);
  });

  it('チャットを出しているとき・Claude Code に貼れないとき（起動の途中・終了している）は、チャットの入力欄に入れる', () => {
    const { container, rerender } = render(<ClaudePane {...props({ terminalOpen: false })} />);
    const textarea = () => container.querySelector<HTMLTextAreaElement>('.chat-input textarea')!;
    act(() => insertIntoChat('s1', 'チャットへ'));
    expect(textarea().value).toBe('チャットへ');
    rerender(<ClaudePane {...props({ chat: chatOf({ status: 'starting' }) })} />);
    act(() => insertIntoChat('s1', '起動中'));
    rerender(<ClaudePane {...props({ chat: chatOf({ status: 'exited', exitCode: 0 }) })} />);
    act(() => insertIntoChat('s1', '終了中'));
    expect(textarea().value).toBe('チャットへ\n起動中\n終了中');
    expect(api.argsOf('pty.write')).toEqual([]);
  });
});

describe('ターミナルモード: Claude Code の入力欄の書きかけ', () => {
  it('画面を出している間は、チャットの入力欄に移さない。チャットに戻すと移し、Claude Code の入力欄は消す', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<ClaudePane {...props({ screen: promptOf('打ちかけ') })} />);
    const textarea = () => container.querySelector<HTMLTextAreaElement>('.chat-input textarea')!;
    act(() => vi.advanceTimersByTime(60_000));
    expect(textarea().value).toBe('');
    expect(api.argsOf('pty.write')).toEqual([]);

    rerender(<ClaudePane {...props({ terminalOpen: false, screen: promptOf('打ちかけ') })} />);
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(textarea().value).toBe('打ちかけ');
    expect(api.argsOf('pty.write')).toEqual([['s1', '\x15\x15']]);
  });
});

describe('ターミナルモードを覚える（useTerminalMode）', () => {
  it('はじめはチャット。切り替えたら、次に起動したときもそのまま', () => {
    const first = renderHook(() => useTerminalMode());
    expect(first.result.current[0]).toBe(false);
    act(() => first.result.current[1](true));
    expect(first.result.current[0]).toBe(true);
    first.unmount();

    const second = renderHook(() => useTerminalMode());
    expect(second.result.current[0]).toBe(true);
    act(() => second.result.current[1]((on) => !on));
    expect(second.result.current[0]).toBe(false);
    second.unmount();
    expect(renderHook(() => useTerminalMode()).result.current[0]).toBe(false);
  });
});
