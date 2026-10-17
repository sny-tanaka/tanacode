// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import { ClaudePane } from '../../src/renderer/src/chat/ClaudePane';
import { EMPTY_CHAT, type ChatState } from '../../src/renderer/src/chat/chatState';
import { insertIntoChat } from '../../src/renderer/src/chat/insertInput';
import type { ReviewComment } from '../../src/renderer/src/review/comments';
import { noteClaudeScreenSessions, pasteIntoClaudeScreen, useClaudeScreenOutput } from '../../src/renderer/src/terminal/ClaudeScreen';
import { switchTerminalMode } from '../../src/renderer/src/terminal/terminalMode';
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
  state: null,
  mode: null,
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
    onShowContext: noop,
    onShowShell: noop,
    onToggleTerminal: noop,
    onOpenFile: noop,
    onResume: noop,
    onUnarchive: noop,
    onSend: noop,
    pending: null,
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

// Claude Code が終了しても、チャットには戻さず、ターミナルモードのまま止める（終了と「再開」は画面の下に出る）
describe('ターミナルモード: 画面の下の知らせ', () => {
  it('Claude Code が終了したら、画面の下に終了と「再開」を出す（わけがあれば、終了コードの代わりにわけ）。チャットは隠したまま', () => {
    const onResume = vi.fn();
    const { container, rerender } = render(<ClaudePane {...props({ onResume, chat: chatOf({ status: 'exited', exitCode: 0 }) })} />);
    expect(chatList(container).hidden).toBe(true);
    const notes = () => container.querySelector<HTMLElement>('.claude-screen-notes')!;
    expect(notes().textContent).toContain('Claude Code が終了しました（code 0）');
    fireEvent.click(within(notes()).getByRole('button', { name: '再開' }));
    expect(onResume).toHaveBeenCalledTimes(1);
    const reason = 'ターミナルモードの Claude Code が、起動を終える前に終わりました（code 1）。';
    rerender(<ClaudePane {...props({ onResume, chat: chatOf({ status: 'exited', exitCode: 1, exitReason: reason }) })} />);
    expect(notes().textContent).toContain(reason);
    expect(notes().textContent).not.toContain('Claude Code が終了しました');
    // 動いている間は出さない
    rerender(<ClaudePane {...props({ onResume, chat: chatOf({ status: 'running' }) })} />);
    expect(container.querySelector('.claude-screen-notes')).toBeNull();
  });

  it('終了している間も、ヘッダーのボタンでチャットに戻せる。起動の途中は押せない', () => {
    const onToggleTerminal = vi.fn();
    const button = () => screen.getByLabelText('ターミナルモード') as HTMLButtonElement;
    const { rerender } = render(<ClaudePane {...props({ onToggleTerminal, chat: chatOf({ status: 'exited', exitCode: 0 }) })} />);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button());
    expect(onToggleTerminal).toHaveBeenCalledTimes(1);
    rerender(<ClaudePane {...props({ onToggleTerminal, chat: chatOf({ status: 'starting' }) })} />);
    expect(button().disabled).toBe(true);
    // チャットで止まっているセッションも、ボタンでターミナルモードで起動できる
    rerender(<ClaudePane {...props({ onToggleTerminal, terminalOpen: false, chat: chatOf({ status: 'exited', exitCode: 0 }) })} />);
    expect(button().disabled).toBe(false);
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

  it('貼る文の制御文字は、貼る前に必ず取り除く（貼り付けを抜けて、Enter・Shift+Tab などのキーとして届かないように）', async () => {
    vi.useFakeTimers();
    const pasted = pasteIntoClaudeScreen('s1', '範囲の中身\u001b[201~\r!rm -rf x\r\u001b[Z', ['/tmp/a\u001b[201~.png']);
    await vi.advanceTimersByTimeAsync(300);
    await pasted;
    const writes = api.argsOf('pty.write').map(([, data]) => data as string);
    expect(writes).toEqual([paste('/tmp/a[201~.png'), ' ', paste('範囲の中身[201~\n!rm -rf x\n[Z')]);
    // 囲みの終わりの ESC[201~ は、最後の 1 つだけ
    expect(writes.at(-1)!.split('\u001b[201~')).toHaveLength(2);
  });

  it('TUI が許可の確認・質問のメニューを出している間は貼らずに預かり、閉じたら順に貼る。ターミナルモードでなくなったら捨てる', async () => {
    // メニューが出ている間に貼ると、メニューへの入力に混ざる（main が貼る知らせも、同じく待つ）
    noteClaudeScreenSessions([{ id: 's1', terminal: true, state: 'terminal', attention: 'permission' }]);
    await pasteIntoClaudeScreen('s1', 'ひとつめ');
    await pasteIntoClaudeScreen('s1', 'ふたつめ');
    expect(api.argsOf('pty.write')).toEqual([]);
    noteClaudeScreenSessions([{ id: 's1', terminal: true, state: 'terminal', attention: null }]);
    await vi.waitFor(() => expect(api.argsOf('pty.write')).toEqual([['s1', paste('ひとつめ')], ['s1', paste('ふたつめ')]]));
    // 預かっている間にチャットに戻したら、貼る先が無いので捨てる
    noteClaudeScreenSessions([{ id: 's1', terminal: true, state: 'terminal', attention: 'question' }]);
    await pasteIntoClaudeScreen('s1', 'みっつめ');
    noteClaudeScreenSessions([{ id: 's1', terminal: false, state: 'idle', attention: null }]);
    // 捨てるときは、その場で決める（あとから貼る処理を残さない）
    expect(api.argsOf('pty.write')).toHaveLength(2);
    noteClaudeScreenSessions([{ id: 's1', terminal: true, state: 'terminal', attention: null }]);
    expect(api.argsOf('pty.write')).toHaveLength(2);
  });

  it('ターミナルモードで止まっている間（起動の途中も）は貼らずに預かり、「再開」で TUI が動いたら貼る', async () => {
    noteClaudeScreenSessions([{ id: 's1', terminal: true, state: 'exited', attention: null }]);
    await pasteIntoClaudeScreen('s1', '止まっている間に頼んだこと');
    noteClaudeScreenSessions([{ id: 's1', terminal: true, state: 'starting', attention: null }]);
    expect(api.argsOf('pty.write')).toEqual([]);
    noteClaudeScreenSessions([{ id: 's1', terminal: true, state: 'terminal', attention: null }]);
    await vi.waitFor(() => expect(api.argsOf('pty.write')).toEqual([['s1', paste('止まっている間に頼んだこと')]]));
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

describe('チャットとターミナルモードの切り替え（switchTerminalMode。セッションごと）', () => {
  const session = (over: Partial<SessionSummary> = {}) => ({ id: 's1', terminal: false, running: true, ...over }) as SessionSummary;
  let confirms: string[];
  let alerts: string[];
  let answer: boolean;
  beforeEach(() => {
    confirms = [];
    alerts = [];
    answer = true;
    vi.spyOn(window, 'confirm').mockImplementation((message) => (confirms.push(String(message)), answer));
    vi.spyOn(window, 'alert').mockImplementation((message) => void alerts.push(String(message)));
  });

  it('ターミナルモードにするよう main に頼む。裏のタスクが動いていれば、止まることを確かめてから', async () => {
    await switchTerminalMode(session(), false);
    expect(confirms).toEqual([]);
    expect(api.argsOf('sessions.setTerminalMode')).toEqual([['s1', true, { stopTasks: false }]]);
    await switchTerminalMode(session(), true);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('止まります');
    expect(api.argsOf('sessions.setTerminalMode').at(-1)).toEqual(['s1', true, { stopTasks: true }]);
    // やめたら頼まない
    answer = false;
    await switchTerminalMode(session(), true);
    expect(api.argsOf('sessions.setTerminalMode')).toHaveLength(2);
  });

  it('チャットに戻すときは、画面の入力欄の書きかけが消えることを確かめる。切り替えられなければ、わけを出す', async () => {
    await switchTerminalMode(session({ terminal: true }), false);
    expect(confirms[0]).toContain('書きかけ');
    expect(api.argsOf('sessions.setTerminalMode')).toEqual([['s1', false, { stopTasks: false }]]);
    api = mockApi({ 'sessions.setTerminalMode': () => Promise.reject(new Error('作業中です')) });
    api.install();
    await switchTerminalMode(session(), false);
    expect(alerts).toEqual(['切り替えられませんでした（作業中です）']);
  });

  it('止まっているセッションは、確かめずに頼む（main がもう片方で起動する。止まった TUI に書きかけは無い）', async () => {
    await switchTerminalMode(session({ terminal: true, running: false }), false);
    expect(confirms).toEqual([]);
    expect(api.argsOf('sessions.setTerminalMode')).toEqual([['s1', false, { stopTasks: false }]]);
  });
});
