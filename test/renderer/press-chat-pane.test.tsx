// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import type { ScreenInfo, ScreenState } from '@shared/screen';
import { ClaudePane } from '../../src/renderer/src/chat/ClaudePane';
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
const S2 = summary('s2', { model: 'opus', effort: 'high', settingsFile: 'f1', remoteControl: true });
const screenOf = (state: ScreenState, over: Partial<ScreenInfo> = {}): ScreenInfo => ({ state, model: null, effort: null, mode: 'manual', draft: '', ready: true, ...over });
const PROMPT = screenOf({ kind: 'prompt' });
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
    screen: PROMPT,
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
let alerts: string[];
let confirms: string[];
let confirmAnswer: boolean;
function install(responses: Parameters<typeof mockApi>[0] = {}) {
  api = mockApi({ 'settingsFiles.list': () => Promise.resolve([{ id: 'f1', name: 'LiteLLM', path: '/Users/me/.claude/litellm.json', error: null, model: null }]), ...responses });
  api.install();
}
beforeEach(() => {
  install();
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

  it('「圧縮」は /compact を送る。作業中・発言がまだ無いときは押せない', () => {
    const onSend = vi.fn();
    const view = render(<ClaudePane {...props({ onSend })} />);
    const compact = () => screen.getByRole('button', { name: '圧縮' }) as HTMLButtonElement;
    fireEvent.click(compact());
    expect(onSend).toHaveBeenCalledWith('/compact', []);
    view.rerender(<ClaudePane {...props({ onSend, chat: chatOf({ status: 'running', items: [USER, { kind: 'user', id: 'u2', text: '/compact' }] }) })} />);
    // 圧縮の途中は、ぐるぐるを出して押せない
    expect(compact().disabled).toBe(true);
    expect(compact().getAttribute('aria-busy')).toBe('true');
    view.rerender(<ClaudePane {...props({ onSend, session: S2, chat: chatOf({ items: [] }) })} />);
    expect(compact().disabled).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('チャットの中の案内', () => {
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
    let taken: { text: string; attachments: string[] } | null = { text: 'テストも足して', attachments: ['/tmp/attachments/0123abcd-shot.png'] };
    const onTakePending = vi.fn(() => taken);
    render(<ClaudePane {...props({ chat: chatOf({ status: 'starting', items: [] }), pending: { text: 'テストも足して', attachments: [] }, onTakePending })} />);
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

  it('巻き戻し先を選んでいる間の「キャンセル」は、開いているセッションに Esc を送る。描き直してセッションが変わったら、そのセッションに送る', () => {
    const rewind = screenOf({ kind: 'rewind', pointed: '' });
    const view = render(<ClaudePane {...props({ screen: rewind })} />);
    expect(screen.getByText('巻き戻し先を選んでいます…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    view.rerender(<ClaudePane {...props({ screen: rewind, session: S2 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(api.argsOf('pty.write')).toEqual([
      ['s1', '\x1b'],
      ['s2', '\x1b'],
    ]);
  });

  it('チャットで操作できない画面の「閉じる」は、開いているセッションに Esc を送る。描き直してセッションが変わったら、そのセッションに送る', () => {
    const unknown = screenOf({ kind: 'unknown' });
    const onOpenTerminal = vi.fn();
    const view = render(<ClaudePane {...props({ screen: unknown, onOpenTerminal })} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    view.rerender(<ClaudePane {...props({ screen: unknown, onOpenTerminal, session: S2 })} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(api.argsOf('pty.write')).toEqual([
      ['s1', '\x1b'],
      ['s2', '\x1b'],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'ターミナルで操作' }));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
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
    // 動いているモデル（画面に出ている名前）は Opus 5
    render(<ClaudePane {...props({ screen: screenOf({ kind: 'prompt' }, { model: 'Opus 5' }) })} />);
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

  it('権限モードを選ぶと、開いているセッションのモードを切り替える。描き直してセッションが変わったら、そのセッションのものを切り替える。入力欄が出ていないときは選べない', () => {
    const view = render(<ClaudePane {...props()} />);
    expect(selectByTitle('権限モード').value).toBe('manual');
    fireEvent.change(selectByTitle('権限モード'), { target: { value: 'plan' } });
    view.rerender(<ClaudePane {...props({ session: S2, screen: screenOf({ kind: 'prompt' }, { mode: 'acceptEdits' }) })} />);
    fireEvent.change(selectByTitle('権限モード'), { target: { value: 'auto' } });
    expect(api.argsOf('screen.setMode')).toEqual([
      ['s1', 'plan'],
      ['s2', 'auto'],
    ]);
    view.rerender(<ClaudePane {...props({ session: S2, screen: screenOf({ kind: 'unknown' }) })} />);
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
    expect(api.argsOf('scheduled.add')).toEqual([['s1', '朝になったらテストを流して', [], now.getTime() + 60 * 60_000]]);
    expect(box().value).toBe('');

    view.rerender(<ClaudePane {...props({ session: S2 })} />);
    fireEvent.change(box(), { target: { value: '夜にまとめて' } });
    fireEvent.click(schedule());
    fireEvent.click(screen.getByText('30 分後'));
    await settle();
    expect(api.argsOf('scheduled.add').at(-1)).toEqual(['s2', '夜にまとめて', [], now.getTime() + 30 * 60_000]);
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
