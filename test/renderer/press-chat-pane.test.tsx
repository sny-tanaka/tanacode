// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import type { PendingQuestion } from '@shared/questions';
import { ClaudePane } from '../../src/renderer/src/chat/ClaudePane';
import { insertIntoChat } from '../../src/renderer/src/chat/insertInput';
import { EMPTY_CHAT, type ChatItem, type ChatState } from '../../src/renderer/src/chat/chatState';
import { closeSettingsFilesDialog } from '../../src/renderer/src/chat/settingsFiles';
import type { ReviewComment } from '../../src/renderer/src/review/comments';
import './dom';
import { mockApi } from './mock-api';

// チャットのペイン（ClaudePane）のヘッダー・入力欄の下の選択欄・チャットの中の案内のボタンを押して、開いているセッションに効くかを確かめる。
// どのボタンも、描き直してほかのセッションに切り替えた直後に押したら、新しいセッションに効くか

// ペインはコメントの本文を作る関数（formatComments）を LineComments から読むので、Monaco も読み込まれる。ペインでは使わないので、空にして速くする
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
const S1 = summary('s1', { mode: 'manual' });
const S2 = summary('s2', { model: 'opus', effort: 'high', settingsFile: 'f1', remoteControl: true });
// フックが答えを待っている質問
const questionOf = (id: string, question: string): PendingQuestion => ({ id, questions: [{ question, header: '確認', multiSelect: false, options: [{ label: 'はい', description: '' }] }], answered: {} });
const USER: ChatItem = { kind: 'user', id: 'u1', text: 'ログインを直してください' };
const chatOf = (over: Partial<ChatState> = {}): ChatState => ({ ...EMPTY_CHAT, status: 'idle', items: [USER], ...over });

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
let alerts: string[];
let confirms: string[];
let confirmAnswer: boolean;
function install(responses: Parameters<typeof mockApi>[0] = {}) {
  api = mockApi({ 'settingsFiles.list': () => Promise.resolve([{ id: 'f1', name: 'LiteLLM', path: '/Users/me/.claude/litellm.json', error: null, model: null }]), ...responses });
  api.install();
}
beforeEach(() => {
  install();
  localStorage.removeItem('tanacode.compactMode');
  alerts = [];
  confirms = [];
  confirmAnswer = true;
  vi.spyOn(window, 'alert').mockImplementation((message) => void alerts.push(String(message)));
  vi.spyOn(window, 'confirm').mockImplementation((message) => {
    confirms.push(String(message));
    return confirmAnswer;
  });
});
afterEach(() => {
  cleanup();
  closeSettingsFilesDialog();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// IPC の返事を待つ
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const box = () => document.querySelector('.chat-input textarea') as HTMLTextAreaElement;
const selectByTitle = (prefix: string) => document.querySelector(`.chat-options select[title^="${prefix}"]`) as HTMLSelectElement;

describe('ヘッダー', () => {
  it('Remote Control のスイッチは、開いているセッションの切り替えを頼み、終わるまで押せない。描き直してセッションが変わったら、そのセッションのものを切り替える', async () => {
    let answer: (error: string | null) => void = noop;
    install({ 'sessions.setRemoteControl': () => new Promise((resolve) => (answer = resolve)) });
    const view = render(<ClaudePane {...props()} />);
    const toggle = () => screen.getByRole('switch', { name: 'Remote Control' }) as HTMLButtonElement;
    await settle();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle());
    expect(api.argsOf('sessions.setRemoteControl')).toEqual([['s1', true]]);
    expect(toggle().disabled).toBe(true);
    await act(async () => answer(null));
    expect(toggle().disabled).toBe(false);
    expect(alerts).toEqual([]);

    view.rerender(<ClaudePane {...props({ session: S2 })} />);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle());
    expect(api.argsOf('sessions.setRemoteControl').at(-1)).toEqual(['s2', false]);
    // 切り替えられなかったら、わけを出す
    await act(async () => answer('Claude Code が質問の答えを待っているため、今は切り替えられません'));
    expect(alerts).toEqual(['Claude Code が質問の答えを待っているため、今は切り替えられません']);
    expect(toggle().disabled).toBe(false);
  });

  it('「最適化圧縮」は、main に流れを始めさせる（/compact は送らない）。作業中・会話がまだ無いときは押せない', async () => {
    const onSend = vi.fn();
    const view = render(<ClaudePane {...props({ onSend })} />);
    const compact = () => screen.getByRole('button', { name: '最適化圧縮' }) as HTMLButtonElement;
    await act(async () => {});
    expect(api.argsOf('compact.get')).toEqual([['s1']]);
    fireEvent.click(compact());
    expect(api.argsOf('compact.start')).toEqual([['s1']]);
    expect(onSend).not.toHaveBeenCalled();
    view.rerender(<ClaudePane {...props({ onSend, chat: chatOf({ status: 'running' }) })} />);
    expect(compact().disabled).toBe(true);
    view.rerender(<ClaudePane {...props({ onSend, session: S2, chat: chatOf({ items: [] }) })} />);
    expect(compact().disabled).toBe(true);
    expect(api.argsOf('compact.start')).toHaveLength(1);
  });

  it('最適化圧縮が進んでいる間は、段階をツールチップに出して押せない。再開の文を待っている・取りやめたことは、ボタンの左に出す', async () => {
    render(<ClaudePane {...props()} />);
    const compact = () => screen.getByRole('button', { name: '最適化圧縮' }) as HTMLButtonElement;
    const status = (over: object) => act(async () => api.emit('compact.onChanged', { sessionId: 's1', status: { phase: null, failure: null, unavailable: null, ...over } }));
    await status({ phase: 'finalizing' });
    expect(compact().disabled).toBe(true);
    expect(compact().getAttribute('aria-busy')).toBe('true');
    expect(compact().getAttribute('data-tip')).toBe('最適化圧縮: 続きに要ることを、Claude がチェックリストに書いています');
    await status({ phase: 'waiting' });
    expect(screen.getByRole('status').textContent).toBe('再開の文を送るのを待っています');
    // ほかのセッションの知らせでは変えない
    await act(async () => api.emit('compact.onChanged', { sessionId: 's2', status: { phase: null, failure: 'busy', unavailable: null } }));
    expect(compact().disabled).toBe(true);
    await status({ failure: 'interrupted' });
    expect(compact().disabled).toBe(false);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('最適化圧縮を取りやめました');
    expect(alert.getAttribute('data-tip')).toBe('仕上げを中断したので、最適化圧縮を取りやめました。会話は消していません');
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('最適化圧縮の枠の中のスイッチで、このセッションの自動の最適化圧縮を切り替える。ツールチップに、始める大きさを出す', async () => {
    api = mockApi({ 'compact.get': () => Promise.resolve({ phase: null, failure: null, unavailable: null, autoPercent: 60, autoPaused: false }) });
    api.install();
    const view = render(<ClaudePane {...props()} />);
    const toggle = () => screen.getByRole('switch', { name: '自動の最適化圧縮' }) as HTMLButtonElement;
    await act(async () => {});
    // 指定の無いセッション（新しいセッション）はオン
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    // スイッチに文字は出さない（何のスイッチかは、ツールチップと読み上げの名前で伝える）
    expect(toggle().textContent).toBe('');
    expect(toggle().getAttribute('data-tip')).toContain('自動: コンテキストが 60% を超えたら、自動で最適化圧縮する');
    // 今すぐ始めるボタンと、同じ 1 つの枠に入っている
    const capsule = screen.getByRole('group', { name: '最適化圧縮' });
    expect(capsule.contains(toggle())).toBe(true);
    expect(capsule.contains(screen.getByRole('button', { name: '最適化圧縮' }))).toBe(true);
    expect(capsule.className).toBe('compact-capsule on');
    expect(toggle().getAttribute('data-tip')).toContain('オフにすると、Claude Code の自動の圧縮（要約）が動きます');
    fireEvent.click(toggle());
    expect(api.argsOf('sessions.setAutoCompact')).toEqual([['s1', false]]);
    view.rerender(<ClaudePane {...props({ session: { ...S1, autoCompact: false } })} />);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('group', { name: '最適化圧縮' }).className).toBe('compact-capsule');
    fireEvent.click(toggle());
    expect(api.argsOf('sessions.setAutoCompact')).toEqual([['s1', false], ['s1', true]]);
  });

  it('自動を休んでいるときは、枠の左に出す。オフのセッションでは出さない', async () => {
    render(<ClaudePane {...props()} />);
    await act(async () => api.emit('compact.onChanged', { sessionId: 's1', status: { phase: null, failure: null, unavailable: null, autoPercent: 80, autoPaused: true } }));
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('自動の最適化圧縮を休んでいます');
    expect(status.getAttribute('data-tip')).toContain('右のスイッチ（自動）を入れ直すと戻ります');
    cleanup();
    render(<ClaudePane {...props({ session: { ...S1, autoCompact: false } })} />);
    await act(async () => api.emit('compact.onChanged', { sessionId: 's1', status: { phase: null, failure: null, unavailable: null, autoPercent: 80, autoPaused: true } }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('「Claude にチェックリストを扱わせる」がオフのときは、最適化圧縮を押せず、理由をツールチップに出す', async () => {
    api = mockApi({ 'compact.get': () => Promise.resolve({ phase: null, failure: null, unavailable: 'checklist-off' }) });
    api.install();
    render(<ClaudePane {...props()} />);
    const compact = () => screen.getByRole('button', { name: '最適化圧縮' }) as HTMLButtonElement;
    await act(async () => {});
    expect(compact().disabled).toBe(true);
    expect(compact().getAttribute('data-tip')).toBe('メニューの「Claude にチェックリストを扱わせる」をオンにすると使えます');
    fireEvent.click(compact());
    expect(api.argsOf('compact.start')).toEqual([]);
    // 自動のスイッチも押せず、同じ理由を出す（オンの指定でも、オフに見せる）
    const toggle = screen.getByRole('switch', { name: '自動の最適化圧縮' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.getAttribute('data-tip')).toBe('メニューの「Claude にチェックリストを扱わせる」をオンにすると使えます');
  });

  it('発言の「ここまで戻す」は、開いているセッションでその発言まで巻き戻す。描き直してセッションが変わったら、そのセッションで巻き戻す。見つからなければ、わけを出す', async () => {
    install({ 'screen.rewind': (id: never) => Promise.resolve(id === 's1') });
    const view = render(<ClaudePane {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'ここまで戻す' }));
    view.rerender(<ClaudePane {...props({ session: S2, chat: chatOf({ items: [{ kind: 'user', id: 'u9', text: 'テストを足して' }] }) })} />);
    fireEvent.click(screen.getByRole('button', { name: 'ここまで戻す' }));
    expect(api.argsOf('screen.rewind')).toEqual([
      ['s1', 'ログインを直してください'],
      ['s2', 'テストを足して'],
    ]);
    await waitFor(() => expect(alerts).toEqual(['巻き戻し先の発言が見つかりませんでした。ターミナルで /rewind を操作してください。']));
    // 作業中は巻き戻せない
    view.rerender(<ClaudePane {...props({ session: S2, chat: chatOf({ status: 'running' }) })} />);
    expect(screen.queryByRole('button', { name: 'ここまで戻す' })).toBeNull();
  });

  it('起動を待っている発言の「取り消す」は、その発言と画像を入力欄に戻す（打ちかけの文字の前に）。取り下げられなかったら何もしない', async () => {
    let taken: { text: string; attachments: string[]; pastes: string[] } | null = { text: 'テストも足して', attachments: ['/tmp/attachments/0123abcd-shot.png'], pastes: [] };
    const onTakePending = vi.fn(() => taken);
    render(<ClaudePane {...props({ chat: chatOf({ status: 'starting', items: [] }), pending: { text: 'テストも足して', attachments: [], pastes: [] }, onTakePending })} />);
    fireEvent.change(box(), { target: { value: '書きかけ' } });
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
    expect(onTakePending).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('テストも足して\n書きかけ');
    expect(screen.getByText('画像 shot.png')).toBeTruthy();
    taken = null;
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
    expect(onTakePending).toHaveBeenCalledTimes(2);
    expect(box().value).toBe('テストも足して\n書きかけ');
  });

  it('起動中は「起動しています」を出し、main が起動に時間がかかっていると知らせたら、経過と Claude Code の標準エラーの末尾を出す', async () => {
    render(<ClaudePane {...props({ chat: chatOf({ status: 'starting', items: [] }) })} />);
    await settle();
    expect(document.querySelector('.chat-list')?.textContent).toContain('起動しています');
    act(() => api.emit('sessions.onProgress', { sessionId: 's1', activity: { phase: 'starting', elapsed: '12s', tokens: null, stderr: 'MCP server "slow": connecting' } }));
    const callout = document.querySelector('.chat-callout.slow-start');
    expect(callout?.textContent).toContain('Claude Code の起動に時間がかかっています（12秒）');
    expect(callout?.querySelector('pre')?.textContent).toBe('MCP server "slow": connecting');
    expect(document.querySelector('.chat-list')?.textContent).not.toContain('起動しています');
    // ほかのセッションの知らせでは変わらない。起動が終われば消す
    act(() => api.emit('sessions.onProgress', { sessionId: 's2', activity: null }));
    expect(document.querySelector('.chat-callout.slow-start')).not.toBeNull();
    act(() => api.emit('sessions.onProgress', { sessionId: 's1', activity: null }));
    expect(document.querySelector('.chat-callout.slow-start')).toBeNull();
  });

  it('送信中・順番待ちの親からの指示は、会話に出たときと同じく、親の見出しを付けて出す', () => {
    const parent = summary('parent-0001', { title: '親の作業' });
    render(
      <ClaudePane
        {...props({
          session: summary('s1', { parentId: parent.id }),
          sessions: [parent, S1],
          chat: chatOf({ unsent: [{ id: 'q1', text: 'テストも直して', pastes: [], images: 0, state: 'queued', parent: parent.id }] }),
        })}
      />,
    );
    const row = screen.getByText('テストも直して', { exact: false }).closest('.chat-user');
    expect(row?.classList.contains('from-parent')).toBe(true);
    expect(row?.textContent).toContain('親セッション「親の作業」からの指示');
    expect(row?.textContent).toContain('順番待ち');
  });

  it('答えを待っている質問は、カードで出し、入力欄は止める。答えると、その返事を渡す。待っていなければ出さない', async () => {
    const question = questionOf('p1', 'フックの質問ですか？');
    const view = render(<ClaudePane {...props({ question })} />);
    expect(screen.getByText('フックの質問ですか？')).toBeTruthy();
    expect(box().placeholder).toBe('上の選択肢から選んでください');
    fireEvent.click(screen.getByText('はい'));
    await settle();
    expect(api.argsOf('question.reply')).toEqual([['s1', 'p1', { kind: 'answer', answers: { 'フックの質問ですか？': 'はい' } }]]);
    view.rerender(<ClaudePane {...props({ question: null })} />);
    expect(screen.queryByText('フックの質問ですか？')).toBeNull();
  });

  it('質問や確認のカードが出たとき、最下部にいれば追いかける（カードの選択肢が、見えている範囲の下に隠れない）。上を読んでいる間は動かさない', () => {
    // カードは会話ログから来ない。会話・送信中・予約は変わらない（変わると、そちらの追いかけが動く）
    const base = props({ chat: chatOf({ status: 'running' }) });
    const view = render(<ClaudePane {...base} />);
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    let height = 1000;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 200 });
    list.scrollTop = 800;
    // カードの分だけ伸びる
    height = 1400;
    view.rerender(<ClaudePane {...base} question={questionOf('p1', 'どちらにしますか？')} />);
    expect(list.scrollTop).toBe(1400);
    // 上を読んでいる間に次のカードが出ても、動かさない（人がホイールで上へ動かした）
    fireEvent.wheel(list, { deltaY: -100 });
    list.scrollTop = 100;
    fireEvent.scroll(list);
    height = 1600;
    view.rerender(<ClaudePane {...base} question={questionOf('p2', '次はどれにしますか？')} />);
    expect(list.scrollTop).toBe(100);
  });

  // 一覧の高さ（中身・見えている範囲）を決める。scrollTop は、ブラウザと同じく 0 から（中身 − 見えている範囲）までに収める
  const sizeList = (list: HTMLElement, content: () => number, view = 200) => {
    let top = 0;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: content });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => view });
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => (top = Math.max(0, Math.min(value, content() - view))) });
  };

  it('最下部を追いかけている間に、下に隠れた選択肢を見ようと下へスクロールしても、「最新のメッセージへ」を出さずに最下部へ送る', () => {
    // 追いかけない伸び方で、カードの選択肢が見えている範囲の下に隠れたとき。見ようとして下へスクロールしたところで
    // 最下部から離れたことにすると、ボタンが選択肢の上に出て、選択肢の代わりにボタンを押してしまう
    render(<ClaudePane {...props()} />);
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    let height = 1000;
    sizeList(list, () => height);
    list.scrollTop = 800;
    fireEvent.scroll(list);
    height = 1300;
    list.scrollTop = 900;
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(1100);
    expect(screen.queryByRole('button', { name: '最新のメッセージへ' })).toBeNull();
  });

  it('追いかけたスクロールの知らせが、そのあと伸びてから届いても、追いかけをやめない', () => {
    // 追いかけ（scrollTop を変える）の知らせは、次に描くときに届く。CPU が忙しいと、その前に行が伸びて、届いたときには最下部から離れている
    render(<ClaudePane {...props()} />);
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    let height = 1000;
    sizeList(list, () => height);
    list.scrollTop = 800;
    height = 1300;
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(1100);
    expect(screen.queryByRole('button', { name: '最新のメッセージへ' })).toBeNull();
    // 人が上へスクロールしたら、追いかけをやめる
    fireEvent.wheel(list, { deltaY: -100 });
    list.scrollTop = 600;
    fireEvent.scroll(list);
    height = 1600;
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(600);
    expect(screen.queryByRole('button', { name: '最新のメッセージへ' })).toBeTruthy();
  });

  // 直す前: 一覧が縮んで位置が押し戻された知らせを、人が上へスクロールしたものと取り違えて、追いかけをやめていた。
  // CI の E2E（browser-shot）で、許可のカードの選択肢が下に隠れ、その上に「最新のメッセージへ」が出て、「Yes」を押せずに落ちていた
  it('一覧が縮んで押し戻された知らせが、そのあと伸びてから届いても、追いかけをやめない（人が上へスクロールしたのではない）', () => {
    render(<ClaudePane {...props()} />);
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    let height = 1000;
    sizeList(list, () => height);
    list.scrollTop = 800;
    fireEvent.scroll(list);
    // 上の行が縮む（最下部にいるので、位置が 700 に押し戻される）→ 知らせが届く前に、カードが伸びる
    height = 900;
    list.scrollTop = list.scrollTop + 0;
    expect(list.scrollTop).toBe(700);
    height = 1200;
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: '最新のメッセージへ' })).toBeNull();
  });

  it('人が上へスクロールしたとき（ホイール・上へ送るキー・スクロールバー）だけ、追いかけをやめる。下へのホイールや、入力欄で押したキーでは、やめない', () => {
    render(<ClaudePane {...props({ chat: chatOf({ items: [{ kind: 'user', id: 'u1', text: '質問' }] }) })} />);
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    let height = 1000;
    sizeList(list, () => height);
    const jump = () => screen.queryByRole('button', { name: '最新のメッセージへ' });
    // 最下部から 300px 上へ動いたところで、知らせを届ける。止まったら、人の操作の印を消す
    const pushedUp = () => {
      list.scrollTop = height - 200 - 300;
      fireEvent.scroll(list);
      fireEvent(list, new Event('scrollend'));
    };
    const backToBottom = () => {
      fireEvent.click(jump()!);
      list.scrollTop = height;
      fireEvent.scroll(list);
      fireEvent(list, new Event('scrollend'));
      expect(jump()).toBeNull();
    };
    list.scrollTop = 800;
    fireEvent.scroll(list);
    list.scrollTo = (() => {}) as typeof list.scrollTo;
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;

    // 人の操作でないもの・下へのホイール・入力欄で押したキーでは、最下部へ送り直す
    for (const before of [
      () => {},
      () => fireEvent.wheel(list, { deltaY: 100 }),
      () => fireEvent.keyDown(document.querySelector('.chat-input textarea, textarea')!, { key: 'PageUp' }),
      // 行の中（カードの選択肢など）を押したとき
      () => fireEvent.pointerDown(list.firstElementChild!),
    ]) {
      before();
      pushedUp();
      expect(list.scrollTop).toBe(800);
      expect(jump()).toBeNull();
    }

    // ホイールで上へ・上へ送るキー（入力欄の外）・スクロールバーを押したときは、やめる
    for (const before of [
      () => fireEvent.wheel(list, { deltaY: -100 }),
      () => fireEvent.keyDown(document.body, { key: 'PageUp' }),
      () => fireEvent.keyDown(document.body, { key: ' ', shiftKey: true }),
      () => fireEvent.pointerDown(list),
    ]) {
      before();
      pushedUp();
      expect(list.scrollTop).toBe(500);
      expect(jump()).toBeTruthy();
      backToBottom();
    }
    // 下へ送るキーのあとは、上へ動いても人のスクロールとは見なさない
    fireEvent.keyDown(document.body, { key: 'PageUp' });
    fireEvent.keyDown(document.body, { key: 'End' });
    pushedUp();
    expect(list.scrollTop).toBe(800);
  });

  it('行の中身や一覧の高さが変わったら（会話や画面は変わらない）、最下部にいれば追いかける。上を読んでいる間は動かさない', () => {
    // 大きさの変化の知らせを、テストから送る
    const callbacks: (() => void)[] = [];
    const observed = new Set<Element>();
    const original = window.ResizeObserver;
    window.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    } as unknown as typeof ResizeObserver;
    try {
      const view = render(<ClaudePane {...props()} />);
      const list = document.querySelector('.chat-list') as HTMLDivElement;
      // 一覧と、その行を見張る（あとから足した行も）
      expect(observed.has(list)).toBe(true);
      expect([...list.children].every((row) => observed.has(row))).toBe(true);
      let height = 1000;
      sizeList(list, () => height);
      list.scrollTop = 800;
      fireEvent.scroll(list);
      height = 1300;
      callbacks.forEach((callback) => callback());
      expect(list.scrollTop).toBe(1100);

      fireEvent.wheel(list, { deltaY: -100 });
      list.scrollTop = 500;
      fireEvent.scroll(list);
      height = 1500;
      callbacks.forEach((callback) => callback());
      expect(list.scrollTop).toBe(500);
      view.unmount();
      expect(observed.size).toBe(0);
    } finally {
      window.ResizeObserver = original;
    }
  });

  it('上へスクロールすると「最新のメッセージへ」を出し、押すと最下部へ送ってボタンを消す（動きを減らす設定なら、なめらかにしない）', () => {
    const items: ChatItem[] = Array.from({ length: 20 }, (_, i) => ({ kind: 'user', id: `u${i}`, text: `${i} 番目の質問` }));
    render(<ClaudePane {...props({ chat: chatOf({ items }) })} />);
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 200 });
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo as typeof list.scrollTo;
    let reduce = false;
    window.matchMedia = ((query: string) => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)' })) as typeof window.matchMedia;
    const jump = () => screen.queryByRole('button', { name: '最新のメッセージへ' });

    // 最下部（40px 以内）では出さない
    list.scrollTop = 780;
    fireEvent.scroll(list);
    expect(jump()).toBeNull();
    fireEvent.wheel(list, { deltaY: -100 });
    list.scrollTop = 100;
    fireEvent.scroll(list);
    fireEvent.click(jump()!);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'smooth' });
    expect(jump()).toBeNull();
    // 送っている途中の位置では、離れたことにしない
    fireEvent.scroll(list);
    expect(jump()).toBeNull();
    fireEvent(list, new Event('scrollend'));

    reduce = true;
    fireEvent.scroll(list);
    fireEvent.click(jump()!);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'auto' });
  });
});

describe('入力欄の下の選択欄', () => {
  it('設定ファイルを変えると、会話があれば確かめてから、開いているセッションの設定を変える（モデルとエフォートは今の値を添える）。やめたら変えない', async () => {
    const view = render(<ClaudePane {...props()} />);
    await settle();
    confirmAnswer = false;
    fireEvent.change(selectByTitle('設定ファイル'), { target: { value: 'f1' } });
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('設定ファイルを「LiteLLM」に変えます');
    expect(api.argsOf('sessions.configure')).toEqual([]);
    confirmAnswer = true;
    fireEvent.change(selectByTitle('設定ファイル'), { target: { value: 'f1' } });
    expect(api.argsOf('sessions.configure')).toEqual([['s1', { model: null, effort: null, settingsFile: 'f1' }]]);

    // 会話がまだ無いセッションでは確かめない
    view.rerender(<ClaudePane {...props({ session: S2, chat: chatOf({ items: [] }) })} />);
    fireEvent.change(selectByTitle('設定ファイル'), { target: { value: '' } });
    expect(confirms).toHaveLength(2);
    expect(api.argsOf('sessions.configure').at(-1)).toEqual(['s2', { model: 'opus', effort: 'high', settingsFile: null }]);
  });

  it('モデルを選ぶと、開いているセッションのモデルを変える（エフォートと設定ファイルは今の値を添える）。描き直してセッションが変わったら、そのセッションのものを変える', () => {
    const view = render(<ClaudePane {...props()} />);
    fireEvent.change(selectByTitle('モデル'), { target: { value: 'sonnet' } });
    expect(api.argsOf('sessions.configure')).toEqual([['s1', { model: 'sonnet', effort: null, settingsFile: null }]]);
    view.rerender(<ClaudePane {...props({ session: S2 })} />);
    expect(selectByTitle('モデル').value).toBe('opus');
    fireEvent.change(selectByTitle('モデル'), { target: { value: 'haiku' } });
    expect(api.argsOf('sessions.configure').at(-1)).toEqual(['s2', { model: 'haiku', effort: 'high', settingsFile: 'f1' }]);
    // 作業中は変えられない
    view.rerender(<ClaudePane {...props({ session: S2, chat: chatOf({ status: 'running' }) })} />);
    expect(selectByTitle('モデル').disabled).toBe(true);
  });

  it('モデルを変えられなかったら、わけを出す', async () => {
    install({ 'sessions.configure': () => Promise.reject(new Error("Error invoking remote method 'sessions:configure': Error: 設定ファイルが読めません")) });
    render(<ClaudePane {...props()} />);
    fireEvent.change(selectByTitle('モデル'), { target: { value: 'opus' } });
    await waitFor(() => expect(alerts).toEqual(['変更できませんでした: 設定ファイルが読めません']));
  });

  it('エフォートを選ぶと、開いているセッションのエフォートを変える。エフォートの無いモデルでは選べない', () => {
    const view = render(<ClaudePane {...props()} />);
    fireEvent.change(selectByTitle('エフォート'), { target: { value: 'max' } });
    expect(api.argsOf('sessions.configure')).toEqual([['s1', { model: null, effort: 'max', settingsFile: null }]]);
    view.rerender(<ClaudePane {...props({ session: S2 })} />);
    expect(selectByTitle('エフォート').value).toBe('high');
    fireEvent.change(selectByTitle('エフォート'), { target: { value: 'low' } });
    expect(api.argsOf('sessions.configure').at(-1)).toEqual(['s2', { model: 'opus', effort: 'low', settingsFile: 'f1' }]);
    view.rerender(<ClaudePane {...props({ session: summary('s3', { model: 'haiku' }) })} />);
    expect(selectByTitle('エフォート').disabled).toBe(true);
    expect(selectByTitle('エフォート').selectedOptions[0].textContent).toBe('エフォートなし');
  });

  it('「モデル一覧を更新」で、Claude Code のモデル一覧を読み直して選択肢を替える。読めなかったら、わけを出す', async () => {
    const catalog = {
      updatedAt: 0,
      choices: [
        { value: 'opus', name: 'Opus 5', detail: '', disabled: false, efforts: ['low', 'high'] },
        { value: 'opus[1m]', name: 'Opus 5', detail: '', disabled: false, efforts: ['low', 'high'] },
        { value: 'claude-old', name: 'Old', detail: '更新が必要', disabled: true, efforts: [] },
      ],
    };
    let answer: (value: unknown) => void = noop;
    install({ 'models.refresh': () => new Promise((resolve) => (answer = resolve)) });
    // 動いているモデル（Claude Code が知らせた名前）は Opus 5
    const statusLine = { model: { id: 'claude-opus-5', name: 'Opus 5' }, effort: null, version: null, context: null, rateLimits: null, costUsd: null, transcriptPath: null, updatedAt: 0 };
    render(<ClaudePane {...props({ statusLine })} />);
    const options = (prefix: string) => [...selectByTitle(prefix).options].map((o) => [o.value, o.textContent, o.disabled]);
    // 控えの無いうちは、別名の一覧（Opus など）なので、動いているモデルを選べない
    expect(options('モデル')[0]).toEqual(['', 'Opus 5', false]);
    const refresh = screen.getByRole('button', { name: 'モデル一覧を更新' }) as HTMLButtonElement;
    fireEvent.click(refresh);
    expect(api.argsOf('models.refresh')).toEqual([[]]);
    expect(refresh.disabled).toBe(true);
    await act(async () => answer({ catalog }));
    expect(options('モデル')).toEqual([
      ['opus', 'Opus 5', false],
      ['opus[1m]', 'Opus 5 1M', false],
      ['claude-old', 'Old（要更新）', true],
    ]);
    expect(selectByTitle('モデル').value).toBe('opus');
    // エフォートも、そのモデルで選べるものになる
    expect(options('エフォート').map(([value]) => value)).toEqual(['', 'low', 'high']);
    fireEvent.click(refresh);
    await act(async () => answer({ error: 'モデル一覧の控えがありません' }));
    expect(alerts).toEqual(['モデルの一覧を読み込めませんでした: モデル一覧の控えがありません']);
    expect(refresh.disabled).toBe(false);
  });

  it('権限モードを選ぶと、開いているセッションのモードを切り替える。描き直してセッションが変わったら、そのセッションのものを切り替える。質問や確認が出ている間は選べない', () => {
    const view = render(<ClaudePane {...props()} />);
    expect(selectByTitle('権限モード').value).toBe('manual');
    fireEvent.change(selectByTitle('権限モード'), { target: { value: 'plan' } });
    view.rerender(<ClaudePane {...props({ session: { ...S2, mode: 'acceptEdits' } })} />);
    expect(selectByTitle('権限モード').value).toBe('acceptEdits');
    fireEvent.change(selectByTitle('権限モード'), { target: { value: 'auto' } });
    expect(api.argsOf('screen.setMode')).toEqual([
      ['s1', 'plan'],
      ['s2', 'auto'],
    ]);
    view.rerender(<ClaudePane {...props({ session: S2, question: questionOf('p1', 'どちらにしますか？') })} />);
    expect(selectByTitle('権限モード').disabled).toBe(true);
  });
});

describe('入力欄', () => {
  it('コードへのコメントの札を押すとそのコメントを見せ、「外す」で、そのコメントを除いた一覧に替える', () => {
    const comments: ReviewComment[] = [
      { id: 'c1', path: 'src/tax.ts', startLine: 3, endLine: 3, quote: '', text: '設定から読む' },
      { id: 'c2', path: 'src/cart.ts', startLine: 9, endLine: 9, quote: '', text: '名前を変える' },
    ];
    const onCommentsChange = vi.fn();
    const onShowComment = vi.fn();
    render(<ClaudePane {...props({ comments, onCommentsChange, onShowComment })} />);
    const chips = [...document.querySelectorAll<HTMLElement>('.comment-chip')];
    fireEvent.click(chips[0]);
    expect(onShowComment).toHaveBeenCalledWith(comments[0]);
    fireEvent.click(within(chips[0]).getByRole('button', { name: '外す' }));
    expect(onCommentsChange).toHaveBeenCalledWith([comments[1]]);
    expect(onShowComment).toHaveBeenCalledTimes(1);
  });

  it('時刻を指定して送信すると、開いているセッションに入力欄の文字を予約して、入力欄を空にする。描き直してセッションが変わったら、そのセッションに予約する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date(2026, 9, 7, 10, 20);
    vi.setSystemTime(now);
    const view = render(<ClaudePane {...props()} />);
    const schedule = () => screen.getByRole('button', { name: '時刻を指定して送信' }) as HTMLButtonElement;
    // 送る内容が無ければ押せない
    expect(schedule().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: '朝になったらテストを流して' } });
    fireEvent.click(schedule());
    fireEvent.click(screen.getByText('1 時間後'));
    await settle();
    expect(api.argsOf('scheduled.add')).toEqual([['s1', '朝になったらテストを流して', [], now.getTime() + 60 * 60_000, []]]);
    expect(box().value).toBe('');

    view.rerender(<ClaudePane {...props({ session: S2 })} />);
    fireEvent.change(box(), { target: { value: '夜にまとめて' } });
    fireEvent.click(schedule());
    fireEvent.click(screen.getByText('30 分後'));
    await settle();
    expect(api.argsOf('scheduled.add').at(-1)).toEqual(['s2', '夜にまとめて', [], now.getTime() + 30 * 60_000, []]);
  });

  it('Claude が自分に入れた予約は「Claude の予約」の印を付けて出す。取り消しても入力欄には戻さない（取り消すだけ）', async () => {
    const wakeup = { id: 'w1', sessionId: 's1', text: '子の状態を確かめる', attachments: [], pastes: [], at: Date.now() + 5 * 60_000, createdAt: 0, state: 'scheduled' as const, error: null, by: 'claude' as const };
    const human = { ...wakeup, id: 'm1', text: '人の予約', by: undefined };
    install({ 'scheduled.cancel': (id: unknown) => Promise.resolve(id === 'w1' ? wakeup : human) });
    render(<ClaudePane {...props({ scheduled: [wakeup, human] })} />);
    const rows = [...document.querySelectorAll<HTMLElement>('.chat-user.scheduled')];
    expect(rows.map((r) => r.classList.contains('by-claude'))).toEqual([true, false]);
    expect(within(rows[0]!).getByText('Claude の予約').getAttribute('data-tip')).toContain('Claude が自分に入れた予約です');
    expect(within(rows[1]!).queryByText('Claude の予約')).toBeNull();
    const cancel = (row: HTMLElement) => within(row.querySelector('.chat-scheduled-actions') as HTMLElement).getByRole('button', { name: '取り消す' });
    // Claude の予約の取り消しのツールチップは「取り消す」だけ（入力欄には戻らない）
    expect(cancel(rows[0]!).getAttribute('data-tip')).toBe('取り消す');
    expect(cancel(rows[1]!).getAttribute('data-tip')).toBe('予約をやめて入力欄に戻す');
    fireEvent.change(box(), { target: { value: '書きかけ' } });
    fireEvent.click(cancel(rows[0]!));
    await settle();
    expect(api.argsOf('scheduled.cancel')).toEqual([['w1']]);
    expect(box().value).toBe('書きかけ');
    fireEvent.click(cancel(rows[1]!));
    await settle();
    expect(box().value).toBe('人の予約\n書きかけ');
  });

  it('予約できなかったら、わけを出して入力欄の文字は残す', async () => {
    install({ 'scheduled.add': () => Promise.reject(new Error("Error invoking remote method 'scheduled:add': Error: 過去の時刻には予約できません")) });
    render(<ClaudePane {...props()} />);
    fireEvent.change(box(), { target: { value: 'あとで流して' } });
    fireEvent.click(screen.getByRole('button', { name: '時刻を指定して送信' }));
    fireEvent.click(screen.getByText('30 分後'));
    await waitFor(() => expect(alerts).toEqual(['予約できませんでした: 過去の時刻には予約できません']));
    expect(box().value).toBe('あとで流して');
  });
});

describe('貼り付けた長い文の札', () => {
  const LOG = Array.from({ length: 30 }, (_, i) => `ログの ${i + 1} 行目`).join('\n');
  const paste = (text: string) => fireEvent.paste(box(), { clipboardData: { files: [], getData: () => text } });
  const chips = (root: string) => [...document.querySelectorAll(`${root} .paste-chip-head`)].map((e) => e.textContent);
  const sendButton = () => screen.getByRole('button', { name: '送信' }) as HTMLButtonElement;

  it('入力欄に貼り付けた長い文は札になり、送ると、打った文とは別に（札として）渡して、入力欄を空にする', () => {
    const onSend = vi.fn();
    render(<ClaudePane {...props({ onSend })} />);
    fireEvent.change(box(), { target: { value: 'このログを見てください' } });
    paste(LOG);
    expect(box().value).toBe('このログを見てください');
    expect(chips('.chat-input')).toEqual(['ログの 1 行目']);
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith('このログを見てください', [], [LOG]);
    expect(box().value).toBe('');
    expect(chips('.chat-input')).toEqual([]);
  });

  it('打った文が無く、札だけでも送れる・予約できる', async () => {
    const onSend = vi.fn();
    render(<ClaudePane {...props({ onSend })} />);
    paste(LOG);
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith('', [], [LOG]);
    paste(LOG);
    fireEvent.click(screen.getByRole('button', { name: '時刻を指定して送信' }));
    fireEvent.click(screen.getByText('30 分後'));
    await settle();
    expect(api.argsOf('scheduled.add').at(-1)?.slice(0, 3)).toEqual(['s1', '', []]);
    expect(api.argsOf('scheduled.add').at(-1)?.[4]).toEqual([LOG]);
    expect(chips('.chat-input')).toEqual([]);
  });

  it('ほかのパネルから差し込んだ文（ターミナルの出力・アプリ内ブラウザで選んだ要素）も、長ければ札に、短ければ文字にする', () => {
    render(<ClaudePane {...props()} />);
    act(() => insertIntoChat('s1', '短い出力'));
    act(() => insertIntoChat('s1', LOG));
    // ほかのセッションへの差し込みは、入れない
    act(() => insertIntoChat('s2', LOG));
    expect(box().value).toBe('短い出力');
    expect(chips('.chat-input')).toEqual(['ログの 1 行目']);
  });

  it('札は、セッションを切り替えても、そのセッションの書きかけとして残る', () => {
    const view = render(<ClaudePane {...props()} />);
    paste(LOG);
    view.rerender(<ClaudePane {...props({ session: S2 })} />);
    expect(chips('.chat-input')).toEqual([]);
    view.rerender(<ClaudePane {...props()} />);
    expect(chips('.chat-input')).toEqual(['ログの 1 行目']);
  });

  it('送った発言・送信中・順番待ち・起動待ち・予約の行に、札を畳んで出す。起動待ち・予約を取り消すと、札も入力欄に戻る', async () => {
    const pending = { text: '起動したら見て', attachments: [], pastes: [LOG] };
    const scheduled = [{ id: 'm1', sessionId: 's1', text: 'あとで見て', attachments: [], pastes: [LOG], at: Date.now() + 60_000, createdAt: 0, state: 'scheduled' as const, error: null }];
    install({ 'scheduled.cancel': () => Promise.resolve(scheduled[0]) });
    render(
      <ClaudePane
        {...props({
          chat: chatOf({
            items: [{ kind: 'user', id: 'u1', text: 'このログを見て', pastes: [LOG] }],
            unsent: [
              { id: 'q1', text: '順番待ちの文', pastes: [LOG], images: 0, state: 'queued' },
              { id: 'q2', text: '送信中の文', pastes: [LOG], images: 0, state: 'sending' },
            ],
          }),
          pending,
          onTakePending: () => pending,
          scheduled,
        })}
      />,
    );
    // 発言・順番待ち・送信中・起動待ち・予約
    expect(chips('.chat-list')).toEqual(Array(5).fill('ログの 1 行目'));
    expect(screen.getByText('順番待ちの文', { exact: false }).closest('.chat-user')?.textContent).toContain('順番待ち');
    expect(screen.getByText('送信中の文', { exact: false }).closest('.chat-user')?.textContent).toContain('送信中');
    // チャットの札には × が無く、押すと中身が出る
    expect(document.querySelector('.chat-list .paste-chip .icon-button')).toBeNull();
    fireEvent.click(document.querySelector('.chat-list .paste-chip-open')!);
    expect(screen.getByRole('dialog', { name: '貼り付けた文' }).querySelector('pre')?.textContent).toBe(LOG);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '閉じる' }));
    fireEvent.click(document.querySelector('.chat-user.pending:not(.scheduled) .chat-rewind')!);
    expect(box().value).toBe('起動したら見て');
    expect(chips('.chat-input')).toEqual(['ログの 1 行目']);
    fireEvent.click(within(document.querySelector('.chat-scheduled-actions') as HTMLElement).getByRole('button', { name: '取り消す' }));
    await settle();
    expect(box().value).toBe('あとで見て\n起動したら見て');
    expect(chips('.chat-input')).toEqual(['ログの 1 行目', 'ログの 1 行目']);
  });
});
