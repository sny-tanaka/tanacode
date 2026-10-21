// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import type { PendingQuestion } from '@shared/questions';
import { ClaudePane } from '../../src/renderer/src/chat/ClaudePane';
import { EMPTY_CHAT, type ChatState } from '../../src/renderer/src/chat/chatState';
import './dom';
import { mockApi } from './mock-api';

// チャットのペインで、ほかのセッションに切り替えたときに、前のセッションの途中の表示が残る不具合（いまのコードでは落ちる）

vi.mock('../../src/renderer/src/editor/monaco', () => ({ monaco: {} }));

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
const chatOf = (over: Partial<ChatState> = {}): ChatState => ({ ...EMPTY_CHAT, status: 'idle', ...over });

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
    terminalOpen: false,
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('セッションを切り替えたときの、前のセッションの途中の表示', () => {
  beforeEach(() => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  it('Remote Control を切り替えている途中にほかのセッションへ移ると、移った先のスイッチは、ぐるぐるを出さずに押せる', async () => {
    // 前のセッションの切り替え（/remote-control）は、終わるまで返事が来ない
    api = mockApi({ 'sessions.setRemoteControl': (id: never) => (id === 's1' ? new Promise(() => {}) : Promise.resolve(null)) });
    api.install();
    const view = render(<ClaudePane {...props()} />);
    const toggle = () => screen.getByRole('switch', { name: 'Remote Control' }) as HTMLButtonElement;
    fireEvent.click(toggle());
    expect(toggle().disabled).toBe(true);
    view.rerender(<ClaudePane {...props({ session: S2 })} />);
    await act(() => Promise.resolve());
    expect(toggle().disabled).toBe(false);
    expect(toggle().querySelector('.spinner')).toBeNull();
    fireEvent.click(toggle());
    expect(api.argsOf('sessions.setRemoteControl')).toEqual([
      ['s1', true],
      ['s2', true],
    ]);
  });

  it('Todo の欄を出したままほかのセッションへ移ると、移った先ですでに終わっている項目のチェックは、描き直しの動きをせずに出す', () => {
    api = mockApi();
    api.install();
    const view = render(
      <ClaudePane
        {...props({
          chat: chatOf({
            todos: [
              { content: '読む', status: 'completed' },
              { content: '直す', status: 'in_progress' },
            ],
          }),
        })}
      />,
    );
    // はじめに開いたときに終わっていた項目は、描き直さない
    expect(document.querySelector('.todo-item.completed .check-mark')!.classList.contains('animate')).toBe(false);
    view.rerender(
      <ClaudePane
        {...props({
          session: S2,
          chat: chatOf({
            todos: [
              { content: '設計する', status: 'completed' },
              { content: '試す', status: 'pending' },
            ],
          }),
        })}
      />,
    );
    expect(document.querySelector('.todo-item.completed .todo-text')!.textContent).toBe('設計する');
    expect(document.querySelector('.todo-item.completed .check-mark')!.classList.contains('animate')).toBe(false);
  });

  it('同じ質問を出している別のセッションへ移ると、前のセッションで入力欄に書きかけた文は、移った先のカードに残らない', () => {
    api = mockApi();
    api.install();
    const asking: PendingQuestion = {
      id: 'p1',
      questions: [{ question: 'どちらの案にしますか？', header: '方式', multiSelect: false, options: [{ label: 'A 案', description: '' }, { label: 'B 案', description: '' }] }],
      answered: {},
    };
    const view = render(<ClaudePane {...props({ question: asking })} />);
    const field = () => screen.getByLabelText('補足（選択肢を押すと一緒に送ります）') as HTMLTextAreaElement;
    fireEvent.change(field(), { target: { value: 'A 案を少し変えて' } });
    view.rerender(<ClaudePane {...props({ session: S2, question: asking })} />);
    expect(field().value).toBe('');
  });
});
