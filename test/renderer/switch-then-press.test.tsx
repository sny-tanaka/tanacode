// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card, Checklist } from '@shared/checklist';
import type { GitState, SearchResult, SessionSummary } from '@shared/ipc';
import type { WalkthroughCommentDraft } from '@shared/walkthrough-comment';
import { CardPane } from '../../src/renderer/src/checklist/CardPane';
import { ClaudePane } from '../../src/renderer/src/chat/ClaudePane';
import { EMPTY_CHAT } from '../../src/renderer/src/chat/chatState';
import { CANCEL_PICKER_SCRIPT } from '../../src/renderer/src/preview/picker';
import { PreviewPane } from '../../src/renderer/src/preview/PreviewPane';
import { ScmPanel } from '../../src/renderer/src/scm/ScmPanel';
import { useGitState } from '../../src/renderer/src/scm/useGitState';
import { SearchPanel } from '../../src/renderer/src/search/SearchPanel';
import { NewSessionPane } from '../../src/renderer/src/sessions/NewSessionPane';
import { WorktreeDialog } from '../../src/renderer/src/sessions/WorktreeDialog';
import { CommentDialog } from '../../src/renderer/src/walkthrough/CommentDialog';
import './dom';
import { mockApi } from './mock-api';

// 対象（セッション・フォルダ・カードなど）を切り替えた直後に、ボタンを押す。
// 対象 A で押して返事を待っている間に対象 B へ切り替えても、B のボタンは押せて、押せば B の ID で呼ぶ。
// あとから A の返事が届いても、B の表示（処理中の印・書きかけ・状態）は変えない

// 返事を、テストから好きなときに返せる約束
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// 呼ばれるたびに約束を作り、対象の ID ごとに控える。resolve で、その ID の返事を返す
function held<T>() {
  const pending = new Map<string, ReturnType<typeof deferred<T>>>();
  return {
    respond(id: string): Promise<T> {
      const d = deferred<T>();
      pending.set(id, d);
      return d.promise;
    },
    // 返事を返し、それを受けた続きの処理（読み直しなど）が終わるまで待つ
    resolve: (id: string, value: T) =>
      act(async () => {
        pending.get(id)!.resolve(value);
        await new Promise((r) => setTimeout(r, 0));
      }),
  };
}

const noop = () => {};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: `セッション ${id}`,
  cwd: `/work/${id}`,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  running: true,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
  parentId: null,
  ...over,
});

const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });

describe('ScmPanel（フォルダを切り替えた直後のプル）', () => {
  const repo = (branch: string): GitState => ({ isRepo: true, branch, upstream: null, ahead: 0, behind: 0, empty: false, entries: [], branchChanges: null });

  // App と同じ組み合わせ。git の状態は useGitState が読み、パネルはフォルダごとに作り直す（key）
  function Scm({ sessionId, cwd }: { sessionId: string; cwd: string }) {
    const git = useGitState(sessionId, cwd);
    return (
      <ScmPanel
        key={cwd}
        sessionId={sessionId}
        state={git.state}
        view="list"
        onViewChange={noop}
        onRefresh={git.refresh}
        onOpenDiff={noop}
        onOpenBranchDiff={noop}
        activeBranchPath={null}
        comments={[]}
        onShowComment={noop}
        onRemoveComment={noop}
      />
    );
  }

  function setup() {
    const runs = held<string | null>();
    const api = mockApi({
      'git.state': (id: never) => Promise.resolve(repo(`${id as string}-feature`)),
      'git.run': (id: never) => runs.respond(id),
    });
    api.install();
    return { api, runs };
  }

  // A のフォルダでプルを押し、返事を待っている間に B のフォルダへ切り替える
  async function pressThenSwitch() {
    const view = render(<Scm sessionId="A" cwd="/work/a" />);
    await screen.findByText('A-feature');
    fireEvent.click(button('プル'));
    view.rerender(<Scm sessionId="B" cwd="/work/b" />);
    await screen.findByText('B-feature');
  }

  it('切り替えた先のプルが押せて、切り替えた先の ID で動かす', async () => {
    const { api } = setup();
    await pressThenSwitch();
    expect(button('プル').disabled).toBe(false);
    expect(screen.queryByText('プル中…')).toBeNull();
    fireEvent.click(button('プル'));
    expect(api.argsOf('git.run')).toEqual([
      ['A', { kind: 'pull' }],
      ['B', { kind: 'pull' }],
    ]);
    expect(button('プル').disabled).toBe(true);
  });

  it('前のフォルダのプルが終わっても、切り替えた先のパネルを前のフォルダの git の状態で書き換えない', async () => {
    const { runs } = setup();
    await pressThenSwitch();
    fireEvent.click(button('プル'));
    await runs.resolve('A', null);
    expect(screen.queryByText('A-feature')).toBeNull();
    expect(screen.queryByText('B-feature')).not.toBeNull();
    // 切り替えた先のプルは、まだ続いている
    expect(button('プル').disabled).toBe(true);
  });
});

describe('ClaudePane（セッションを切り替えた直後の Remote Control）', () => {
  function Pane({ current }: { current: SessionSummary }) {
    return (
      <ClaudePane
        session={current}
        sessions={[session('A'), session('B')]}
        onSelectSession={noop}
        chat={{ ...EMPTY_CHAT, status: 'idle' }}
        screen={null}
        workflows={new Map()}
        subagents={new Map()}
        bashTasks={new Map()}
        contextTokens={null}
        statusLine={null}
        tasks={[]}
        activeTaskKey={null}
        onOpenTask={noop}
        onStopTask={noop}
        stoppingTasks={new Set()}
        terminalOpen={false}
        comments={[]}
        onCommentsChange={noop}
        onShowComment={noop}
        onOpenTerminal={noop}
        onShowContext={noop}
        onShowShell={noop}
        onToggleTerminal={noop}
        onOpenFile={noop}
        onResume={noop}
        onUnarchive={noop}
        onSend={noop}
        pending={null}
        sending={[]}
        onTakePending={() => null}
        scheduled={[]}
      />
    );
  }
  const toggle = () => screen.getByRole<HTMLButtonElement>('switch', { name: 'Remote Control' });

  it('切り替えた先のトグルが押せて、切り替えた先の ID で切り替える。前のセッションの返事で、切り替えた先の「切り替え中」を消さない', async () => {
    const switches = held<string | null>();
    const api = mockApi({ 'sessions.setRemoteControl': (id: never) => switches.respond(id) });
    api.install();
    const view = render(<Pane current={session('A')} />);
    fireEvent.click(toggle());
    expect(api.argsOf('sessions.setRemoteControl')).toEqual([['A', true]]);
    expect(toggle().disabled).toBe(true);
    view.rerender(<Pane current={session('B')} />);
    expect(toggle().disabled).toBe(false);
    fireEvent.click(toggle());
    expect(api.argsOf('sessions.setRemoteControl')).toEqual([
      ['A', true],
      ['B', true],
    ]);
    expect(toggle().disabled).toBe(true);
    // A の返事が届いても、B はまだ切り替えの途中
    await switches.resolve('A', null);
    expect(toggle().disabled).toBe(true);
    await switches.resolve('B', null);
    expect(toggle().disabled).toBe(false);
  });
});

describe('CardPane（カードを切り替えた直後の返信）', () => {
  const card = (id: string, number: number): Card => ({
    id,
    number,
    title: `カード ${id}`,
    body: '',
    checked: false,
    createdBy: 'human',
    createdAt: 0,
    updatedAt: 0,
    thread: [],
    readByHuman: 0,
    readByClaude: 0,
  });
  const cardA = card('card-a', 1);
  const cardB = card('card-b', 2);
  const list: Checklist = { id: 'list', name: '完了前チェック', description: '', nextNumber: 3, cards: [cardA, cardB], createdBy: 'human', createdAt: 0 };

  function setup() {
    const replies = held<void>();
    const api = mockApi({
      'checklist.apply': (_sessionId: never, op: never) => {
        const { type, cardId } = op as { type: string; cardId?: string };
        return type === 'card-reply' ? replies.respond(cardId!) : Promise.resolve();
      },
    });
    api.install();
    return { api, replies };
  }
  const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>('返信（Markdown。⌘Enter で送る）');
  const write = (text: string) => fireEvent.change(composer(), { target: { value: text } });

  // カード A に返信を送り、返事を待っている間にカード B へ切り替える
  function sendThenSwitch() {
    const view = render(<CardPane session={session('A')} sessions={[session('A')]} list={list} card={cardA} onClose={noop} />);
    write('A への返信');
    fireEvent.click(button('返信する'));
    view.rerender(<CardPane session={session('A')} sessions={[session('A')]} list={list} card={cardB} onClose={noop} />);
  }
  const replyOps = (api: ReturnType<typeof mockApi>) =>
    api.argsOf('checklist.apply').flatMap(([, op]) => ((op as { type: string }).type === 'card-reply' ? [op as { cardId: string; text: string }] : []));

  it('切り替えた先の返信のボタンが押せて、切り替えた先のカードに返信する', () => {
    const { api } = setup();
    sendThenSwitch();
    write('B への返信');
    expect(button('返信する').disabled).toBe(false);
    fireEvent.click(button('返信する'));
    expect(replyOps(api).map(({ cardId, text }) => [cardId, text])).toEqual([
      ['card-a', 'A への返信'],
      ['card-b', 'B への返信'],
    ]);
  });

  it('前のカードへの返信が終わっても、切り替えた先のカードの書きかけを消さない', async () => {
    const { replies } = setup();
    sendThenSwitch();
    write('B の書きかけ');
    await replies.resolve('card-a');
    expect(composer().value).toBe('B の書きかけ');
  });
});

describe('SearchPanel（検索の文字や対象を変えた直後）', () => {
  const found = (path: string): SearchResult => ({ files: [{ path, matches: [{ line: 1, column: 1, text: 'hit', matchStart: 0, matchLength: 3 }] }], truncated: false });
  // 検索は打ち終わって 250ms 待ってから
  const typed = (text: string) => {
    fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: text } });
    act(() => vi.advanceTimersByTime(250));
  };
  const summary = () => document.querySelector('.search-summary')!.textContent;

  function setup() {
    vi.useFakeTimers();
    const searches = new Map<string, ReturnType<typeof deferred<SearchResult>>>();
    const api = mockApi({
      'workspace.search': (id: never, query: never) => {
        const d = deferred<SearchResult>();
        searches.set(`${id as string}:${query as string}`, d);
        return d.promise;
      },
    });
    api.install();
    const resolve = (key: string, result: SearchResult) => act(async () => searches.get(key)!.resolve(result));
    return { api, resolve };
  }

  it('検索中に文字を変えると、変えた文字で検索し、前の文字の結果は出さない', async () => {
    const { api, resolve } = setup();
    render(<SearchPanel sessionId="A" onOpen={noop} />);
    typed('foo');
    typed('bar');
    expect(api.argsOf('workspace.search').map(([id, query]) => [id, query])).toEqual([
      ['A', 'foo'],
      ['A', 'bar'],
    ]);
    await resolve('A:foo', found('foo.ts'));
    expect(summary()).toBe('検索中…');
    expect(screen.queryByText('foo.ts')).toBeNull();
    await resolve('A:bar', found('bar.ts'));
    expect(screen.queryByText('bar.ts')).not.toBeNull();
  });

  it('検索中に文字を消すと「検索中…」を消し、前の文字の結果も出さない', async () => {
    const { resolve } = setup();
    render(<SearchPanel sessionId="A" onOpen={noop} />);
    typed('foo');
    expect(summary()).toBe('検索中…');
    typed('');
    expect(summary()).toBe('');
    await resolve('A:foo', found('foo.ts'));
    expect(summary()).toBe('');
    expect(screen.queryByText('foo.ts')).toBeNull();
  });

  it('同じフォルダの別のセッションに切り替えると、切り替えた先の ID で検索し直し、前のセッションの結果は出さない', async () => {
    const { api, resolve } = setup();
    const view = render(<SearchPanel sessionId="A" onOpen={noop} />);
    typed('foo');
    view.rerender(<SearchPanel sessionId="B" onOpen={noop} />);
    act(() => vi.advanceTimersByTime(250));
    expect(api.argsOf('workspace.search').map(([id]) => id)).toEqual(['A', 'B']);
    await resolve('A:foo', found('from-a.ts'));
    expect(screen.queryByText('from-a.ts')).toBeNull();
    await resolve('B:foo', found('from-b.ts'));
    expect(screen.queryByText('from-b.ts')).not.toBeNull();
  });
});

describe('PreviewPane（セッションを切り替えた直後の「要素を選ぶ」）', () => {
  // Electron の <webview> の代わり。要素選び（pickerScript）の返事は、ページ（URL）ごとに好きなときに返す
  function fakeWebviews() {
    const picks = held<unknown>();
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const element = create(tag, options);
      if (tag !== 'webview') return element;
      const view = element as HTMLElement & { src: string };
      return Object.assign(view, {
        getURL: () => view.src,
        canGoBack: () => false,
        canGoForward: () => false,
        executeJavaScript: (code: string) => (code === CANCEL_PICKER_SCRIPT ? Promise.resolve() : picks.respond(view.src)),
      });
    }) as typeof document.createElement);
    return picks;
  }

  it('切り替えた先の「要素を選ぶ」が押せて、切り替えた先のページで選ぶ。前のページの返事で、切り替えた先の要素選びを止めない', async () => {
    const picks = fakeWebviews();
    const api = mockApi({ 'browser.asks': () => Promise.resolve([]) });
    api.install();
    const view = render(<PreviewPane sessionId="A" visible liveSessionIds={['A', 'B']} onClose={noop} />);
    act(() => {
      api.emit('browser.onOpen', { sessionId: 'A', url: 'http://localhost:3000/a' });
      api.emit('browser.onOpen', { sessionId: 'B', url: 'http://localhost:3000/b' });
    });
    fireEvent.click(button('要素を選ぶ'));
    expect(button('選ぶのをやめる').getAttribute('aria-pressed')).toBe('true');
    view.rerender(<PreviewPane sessionId="B" visible liveSessionIds={['A', 'B']} onClose={noop} />);
    expect(button('要素を選ぶ').disabled).toBe(false);
    fireEvent.click(button('要素を選ぶ'));
    expect(button('選ぶのをやめる').getAttribute('aria-pressed')).toBe('true');
    // A のページの要素選びは、切り替えたときにやめさせた（何も選ばずに終わる）
    await picks.resolve('http://localhost:3000/a', null);
    expect(button('選ぶのをやめる').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('ページの要素をクリックしてください（Esc でやめる）')).not.toBeNull();
  });
});

describe('CommentDialog（載せている途中で閉じ、別のセッションで開き直した直後）', () => {
  const draft = (id: string, prNumber: number): WalkthroughCommentDraft => ({
    ok: true,
    prNumber,
    prUrl: `https://github.com/me/shop/pull/${prNumber}`,
    sha: 'abc1234',
    body: `${id} のウォークスルー`,
    postedUrl: null,
  });

  it('開き直した先の「載せる」が押せて、開き直した先の ID で載せる。前のセッションの返事は、開き直した先に出さない', async () => {
    const posts = held<string>();
    const draftComment = vi.fn((id: string) => Promise.resolve(draft(id, id === 'A' ? 1 : 2)));
    const postComment = vi.fn((id: string, _body: string, _attribution: boolean) => posts.respond(id));
    const walk = { draftComment, postComment };
    mockApi().install();
    // App と同じく、ダイアログは開いている間だけ描く（閉じると消え、開き直すと作り直す）
    const Dialog = ({ commenting }: { commenting: string | null }) => (commenting ? <CommentDialog sessionId={commenting} onClose={noop} api={walk} /> : null);
    const view = render(<Dialog commenting="A" />);
    await screen.findByText('PR #1 にコメントとして載せる');
    fireEvent.click(button('載せる'));
    expect(button('載せています…').disabled).toBe(true);
    view.rerender(<Dialog commenting={null} />);
    view.rerender(<Dialog commenting="B" />);
    await screen.findByText('PR #2 にコメントとして載せる');
    expect(button('載せる').disabled).toBe(false);
    fireEvent.click(button('載せる'));
    expect(postComment.mock.calls.map(([id, body]) => [id, body])).toEqual([
      ['A', 'A のウォークスルー'],
      ['B', 'B のウォークスルー'],
    ]);
    await posts.resolve('A', 'https://github.com/me/shop/pull/1#issuecomment-1');
    expect(screen.queryByText('載せました。')).toBeNull();
    expect(button('載せています…').disabled).toBe(true);
    await posts.resolve('B', 'https://github.com/me/shop/pull/2#issuecomment-2');
    expect(screen.queryByText('載せました。')).not.toBeNull();
  });
});

describe('WorktreeDialog（worktree を残すか消すかの確認）', () => {
  // 確認の途中は閉じられないので、別のセッションの確認に切り替えて押す経路が無い（それを確かめる）
  it('アーカイブの途中は閉じられず、終わってから閉じる', async () => {
    const done = deferred<void>();
    const onConfirm = vi.fn((_remove: boolean) => done.promise);
    const onClose = vi.fn();
    mockApi({ 'sessions.worktreeLeftovers': () => Promise.resolve(null) }).install();
    const worktree = { name: 'feature-x', branch: 'worktree-feature-x', root: '/work/A', preparing: null };
    render(<WorktreeDialog session={session('A', { worktree })} action="archive" onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(button('worktree を残してアーカイブ'));
    expect(onConfirm.mock.calls).toEqual([[false]]);
    expect(button('キャンセル').disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.overlay')!);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => done.resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('NewSessionPane（始めている途中でフォルダを変えた直後の送信）', () => {
  type Props = ComponentProps<typeof NewSessionPane>;
  const props = (cwd: string, overrides: Partial<Props> = {}): Props => ({
    folders: ['/work/a', '/work/b'],
    onForgetFolder: noop,
    cwd,
    onCwdChange: noop,
    sessions: [],
    branch: 'feature',
    onOpenScm: noop,
    gitId: `folder:${cwd}`,
    onGitChanged: noop,
    comments: [],
    onCommentsChange: noop,
    onShowComment: noop,
    onStart: () => Promise.resolve(),
    onCancel: null,
    ...overrides,
  });

  it('変えた先の送信が押せて、変えた先のフォルダで始める', async () => {
    const starts = held<void>();
    const onStart = vi.fn((cwd: string, _text: string, _attachments: string[], _options: unknown) => starts.respond(cwd));
    mockApi({ 'folders.info': () => Promise.resolve({ branch: 'feature' }) }).install();
    const view = render(<NewSessionPane {...props('/work/a', { onStart })} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A で始めてください' } });
    fireEvent.click(button('送信'));
    expect(button('送信').disabled).toBe(true);
    view.rerender(<NewSessionPane {...props('/work/b', { onStart })} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'B で始めてください' } });
    expect(button('送信').disabled).toBe(false);
    fireEvent.click(button('送信'));
    expect(onStart.mock.calls.map(([cwd, text]) => [cwd, text])).toEqual([
      ['/work/a', 'A で始めてください'],
      ['/work/b', 'B で始めてください'],
    ]);
  });
});
