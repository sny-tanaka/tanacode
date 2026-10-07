// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredSession, SessionSummary, WorktreeLeftovers } from '@shared/ipc';
import { ImportDialog } from '../../src/renderer/src/sessions/ImportDialog';
import { NewSessionPane } from '../../src/renderer/src/sessions/NewSessionPane';
import { SESSION_COLLAPSED_KEY, SESSION_LOCK_KEY, Sidebar } from '../../src/renderer/src/sessions/Sidebar';
import { WorktreeDialog } from '../../src/renderer/src/sessions/WorktreeDialog';
import './dom';
import { mockApi } from './mock-api';

// セッションまわりの画面（sessions/）のボタン・入力を、ひとつ残らず押して、押した結果まで確かめる。
// 対象（セッション・フォルダ）を props で受け取る部品は、対象を変えて描き直した直後に押しても、変えた先に効くことも確かめる

// 返事を、テストから好きなときに返せる約束
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 返事を受けたあとの処理（state の更新）まで進める
const settle = () => act(async () => {});

const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: `セッション ${id}`,
  cwd: `/work/${id}`,
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
  parentId: null,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ImportDialog（既存の Claude Code の会話を取り込む）', () => {
  const found: DiscoveredSession[] = [
    { claudeSessionId: 'c-1', cwd: '/Users/me/shop', title: 'カートの不具合を直す', updatedAt: Date.UTC(2026, 0, 2) },
    { claudeSessionId: 'c-2', cwd: '/Users/me/blog', title: '記事の下書き', updatedAt: Date.UTC(2026, 0, 1) },
  ];
  const setup = () => {
    const api = mockApi({ 'sessions.discover': () => Promise.resolve(found) });
    api.install();
    const onImport = vi.fn();
    const onClose = vi.fn();
    render(<ImportDialog onImport={onImport} onClose={onClose} />);
    return { api, onImport, onClose };
  };
  const box = () => screen.getByPlaceholderText<HTMLInputElement>('既存の Claude Code の会話を探す（タイトル・フォルダ）');

  it('探した会話を並べ、押すとその会話を取り込んで閉じる', async () => {
    const { onImport, onClose } = setup();
    expect(screen.queryByText('探しています…')).not.toBeNull();
    await screen.findByText('記事の下書き');
    // ホームのフォルダは ~ にして出す
    expect(screen.queryByText(/~\/blog/)).not.toBeNull();
    fireEvent.click(button(/記事の下書き/));
    expect(onImport).toHaveBeenCalledWith(found[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('打った文字で、タイトルかフォルダが合うものだけにする。合うものが無ければそう出す', async () => {
    setup();
    await screen.findByText('記事の下書き');
    fireEvent.change(box(), { target: { value: 'SHOP' } });
    expect(box().value).toBe('SHOP');
    expect(screen.queryByText('カートの不具合を直す')).not.toBeNull();
    expect(screen.queryByText('記事の下書き')).toBeNull();
    fireEvent.change(box(), { target: { value: '下書き' } });
    expect(screen.queryByText('記事の下書き')).not.toBeNull();
    expect(screen.queryByText('カートの不具合を直す')).toBeNull();
    fireEvent.change(box(), { target: { value: 'どこにも無い' } });
    expect(screen.queryByText('取り込める会話はありません')).not.toBeNull();
  });

  it('Esc で閉じる（ほかのキーでは閉じない）。枠の中を押しても閉じず、外を押すと閉じる', async () => {
    const { onClose } = setup();
    await screen.findByText('記事の下書き');
    fireEvent.keyDown(box(), { key: 'a' });
    fireEvent.mouseDown(box());
    fireEvent.mouseDown(document.querySelector('.import-dialog')!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector('.overlay')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('WorktreeDialog（worktree のセッションのアーカイブ・一覧からの削除の確認）', () => {
  const worktree = (name: string) => ({ name, branch: `worktree-${name}`, root: '/work/repo', preparing: null });
  const leftovers = (over: Partial<WorktreeLeftovers> = {}): WorktreeLeftovers => ({
    exists: true,
    branch: 'worktree-x',
    uncommitted: 2,
    untracked: 0,
    unpushed: 1,
    contentIn: null,
    pr: { state: 'none' },
    ...over,
  });
  type Props = ComponentProps<typeof WorktreeDialog>;
  const props = (over: Partial<Props> = {}): Props => ({
    session: session('A', { worktree: worktree('feature-a') }),
    action: 'archive',
    onConfirm: vi.fn(() => Promise.resolve()),
    onClose: vi.fn(),
    ...over,
  });

  it('このセッションの worktree に残っているものを調べて出す', async () => {
    const api = mockApi({ 'sessions.worktreeLeftovers': () => Promise.resolve(leftovers()) });
    api.install();
    render(<WorktreeDialog {...props()} />);
    expect(screen.queryByText('残っているものを調べています…')).not.toBeNull();
    await screen.findByText('未コミットの変更');
    expect(api.argsOf('sessions.worktreeLeftovers')).toEqual([['A']]);
    expect(screen.queryByText('2 件')).not.toBeNull();
    expect(screen.queryByText('プッシュしていないコミット')).not.toBeNull();
    expect(screen.queryByText('未追跡のファイル')).toBeNull();
  });

  it('「worktree を残して」は残す指定で確かめ、終わったら閉じる。終わるまでボタンは押せない', async () => {
    mockApi({ 'sessions.worktreeLeftovers': () => Promise.resolve(leftovers()) }).install();
    const done = deferred<void>();
    const p = props({ onConfirm: vi.fn(() => done.promise) });
    render(<WorktreeDialog {...p} />);
    fireEvent.click(button('worktree を残してアーカイブ'));
    expect(p.onConfirm).toHaveBeenCalledWith(false);
    expect(button('アーカイブしています…').disabled).toBe(true);
    expect(button('worktree を削除してアーカイブ').disabled).toBe(true);
    expect(button('キャンセル').disabled).toBe(true);
    expect(p.onClose).not.toHaveBeenCalled();
    await act(async () => done.resolve());
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('「worktree を削除して」は消す指定で確かめる。失敗したら理由を出し、また押せるようにして閉じない', async () => {
    mockApi({ 'sessions.worktreeLeftovers': () => Promise.resolve(leftovers()) }).install();
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const done = deferred<void>();
    const p = props({ action: 'remove', onConfirm: vi.fn(() => done.promise) });
    render(<WorktreeDialog {...p} />);
    fireEvent.click(button('worktree を削除して一覧から削除'));
    expect(p.onConfirm).toHaveBeenCalledWith(true);
    expect(button('削除しています…').disabled).toBe(true);
    await act(async () => done.reject(new Error("Error invoking remote method 'sessions:remove': Error: worktree が使用中です")));
    expect(alert).toHaveBeenCalledWith('worktree を削除できませんでした: worktree が使用中です');
    expect(button('worktree を削除して一覧から削除').disabled).toBe(false);
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it('残す指定が失敗したときは、アーカイブできなかったことを出す', async () => {
    mockApi({ 'sessions.worktreeLeftovers': () => Promise.resolve(leftovers()) }).install();
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const p = props({ onConfirm: vi.fn(() => Promise.reject(new Error('止められません'))) });
    render(<WorktreeDialog {...p} />);
    fireEvent.click(button('worktree を残してアーカイブ'));
    await settle();
    expect(alert).toHaveBeenCalledWith('アーカイブできませんでした: 止められません');
    expect(button('worktree を残してアーカイブ').disabled).toBe(false);
  });

  it('キャンセル・Esc・枠の外で閉じる。枠の中を押しても、変換中の Esc でも閉じない', async () => {
    mockApi({ 'sessions.worktreeLeftovers': () => Promise.resolve(null) }).install();
    const p = props();
    render(<WorktreeDialog {...p} />);
    await screen.findByText('残っているものを調べられませんでした');
    const dialog = screen.getByRole('dialog', { name: 'worktree のセッションをアーカイブ' });
    fireEvent.mouseDown(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector('.overlay')!);
    expect(p.onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(button('キャンセル'));
    expect(p.onClose).toHaveBeenCalledTimes(3);
    expect(p.onConfirm).not.toHaveBeenCalled();
  });

  it('別のセッションの確認に変えて描き直した直後に押すと、変えた先のセッションを調べ、変えた先の確認に効く', async () => {
    const api = mockApi({
      'sessions.worktreeLeftovers': (id: never) => Promise.resolve(leftovers({ uncommitted: id === 'A' ? 2 : 0, unpushed: 0 })),
    });
    api.install();
    const first = props();
    const view = render(<WorktreeDialog {...first} />);
    await screen.findByText('未コミットの変更');
    const second = props({ session: session('B', { title: 'B の作業', worktree: worktree('feature-b') }), action: 'remove' });
    view.rerender(<WorktreeDialog {...second} />);
    fireEvent.click(button('worktree を削除して一覧から削除'));
    expect(second.onConfirm).toHaveBeenCalledWith(true);
    expect(first.onConfirm).not.toHaveBeenCalled();
    expect(api.argsOf('sessions.worktreeLeftovers')).toEqual([['A'], ['B']]);
    expect(screen.queryByText('「B の作業」を一覧から削除')).not.toBeNull();
    expect(screen.queryByText('.claude/worktrees/feature-b')).not.toBeNull();
    await settle();
    expect(screen.queryByText('残っている変更やコミットはありません')).not.toBeNull();
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(first.onClose).not.toHaveBeenCalled();
  });
});

describe('NewSessionPane（新規セッションの画面）', () => {
  type Props = ComponentProps<typeof NewSessionPane>;
  const props = (over: Partial<Props> = {}): Props => ({
    folders: ['/work/a', '/work/b'],
    onForgetFolder: vi.fn(),
    cwd: '/work/a',
    onCwdChange: vi.fn(),
    sessions: [],
    branch: 'feature',
    onOpenScm: vi.fn(),
    gitId: 'folder:/work/a',
    onGitChanged: vi.fn(),
    comments: [],
    onCommentsChange: vi.fn(),
    onShowComment: vi.fn(),
    onStart: vi.fn(() => Promise.resolve()),
    onCancel: null,
    ...over,
  });
  const select = (title: RegExp) => screen.getByTitle<HTMLSelectElement>(title);
  const MODEL = /^モデル（--model/;
  const EFFORT = /^エフォート（--effort/;
  const MODE = /^権限モード（--permission-mode/;
  const SETTINGS = /^設定ファイル（標準の設定に重ねて/;
  // 最初の指示を打って送る（送ると始めている間は送れないので、1 回描くごとに 1 回）。onStart の引数を返す
  const send = (p: Props, text = '始めてください') => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
    fireEvent.click(button('送信'));
    expect(p.onStart).toHaveBeenCalledTimes(1);
    return (p.onStart as ReturnType<typeof vi.fn>).mock.calls[0];
  };
  // 描いて、フォルダの情報などを読み終えるまで待つ
  const mount = async (p: Props) => {
    const view = render(<NewSessionPane {...p} />);
    await settle();
    return view;
  };
  const remote = () => screen.getByRole('switch', { name: 'Remote Control' });
  const worktree = () => screen.getByRole<HTMLInputElement>('checkbox', { name: 'worktree を使う' });
  const DEFAULTS = { model: null, effort: null, settingsFile: null, mode: null, remoteControl: true, worktree: false };

  beforeEach(() => {
    mockApi({ 'folders.info': () => Promise.resolve({ root: '/work/a', name: 'a', branch: 'feature' }) }).install();
  });

  it('Remote Control・worktree・権限モードを変えると、始めるときの指定に入り、次に開いたときも残る', async () => {
    const p = props();
    await mount(p);
    expect(remote().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(remote());
    expect(remote().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(worktree());
    expect(worktree().checked).toBe(true);
    fireEvent.change(select(MODE), { target: { value: 'plan' } });
    expect(select(MODE).value).toBe('plan');
    expect(send(p)).toEqual(['/work/a', '始めてください', [], { ...DEFAULTS, mode: 'plan', remoteControl: false, worktree: true }]);
    cleanup();
    // 開き直しても、前に選んだものから始まる。戻すと、戻した指定で始める
    const again = props();
    await mount(again);
    expect(remote().getAttribute('aria-checked')).toBe('false');
    expect(worktree().checked).toBe(true);
    expect(select(MODE).value).toBe('plan');
    fireEvent.click(remote());
    fireEvent.click(worktree());
    fireEvent.change(select(MODE), { target: { value: '' } });
    expect(send(again)[3]).toEqual(DEFAULTS);
  });

  it('モデルとエフォートを選ぶと始めるときの指定に入り、エフォートを選べないモデルに変えると、エフォートの指定を外す', async () => {
    const p = props();
    await mount(p);
    fireEvent.change(select(MODEL), { target: { value: 'opus' } });
    fireEvent.change(select(EFFORT), { target: { value: 'high' } });
    expect(select(EFFORT).value).toBe('high');
    expect(send(p)[3]).toEqual({ ...DEFAULTS, model: 'opus', effort: 'high' });
    cleanup();
    const again = props();
    await mount(again);
    expect(select(MODEL).value).toBe('opus');
    fireEvent.change(select(MODEL), { target: { value: 'haiku' } });
    expect(select(EFFORT).disabled).toBe(true);
    expect(select(EFFORT).value).toBe('');
    // 既定のモデルに戻すと、エフォートはまた選べる（外した指定は戻らない）
    fireEvent.change(select(MODEL), { target: { value: '' } });
    expect(select(EFFORT).disabled).toBe(false);
    expect(select(EFFORT).value).toBe('');
    fireEvent.change(select(MODEL), { target: { value: 'haiku' } });
    expect(send(again)[3]).toEqual({ ...DEFAULTS, model: 'haiku', effort: null });
  });

  it('設定ファイルを選ぶと始めるときの指定に入り、モデルとエフォートは、その設定ファイルの既定に戻す', async () => {
    mockApi({
      'folders.info': () => Promise.resolve({ root: '/work/a', name: 'a', branch: 'feature' }),
      'settingsFiles.list': () => Promise.resolve([{ id: 'litellm', name: 'LiteLLM', path: '/h/.claude/settings-litellm.json', error: null, model: 'sonnet' }]),
    }).install();
    const p = props();
    await mount(p);
    await screen.findByRole('option', { name: 'LiteLLM' });
    fireEvent.change(select(MODEL), { target: { value: 'opus' } });
    fireEvent.change(select(EFFORT), { target: { value: 'max' } });
    expect(screen.queryByRole('option', { name: '既定のモデル' })).not.toBeNull();
    fireEvent.change(select(SETTINGS), { target: { value: 'litellm' } });
    expect(select(SETTINGS).value).toBe('litellm');
    expect(select(MODEL).value).toBe('');
    expect(select(EFFORT).value).toBe('');
    // 既定のモデルは、設定ファイルのモデル
    expect(screen.queryByRole('option', { name: '既定（sonnet）' })).not.toBeNull();
    expect(send(p)[3]).toEqual({ ...DEFAULTS, settingsFile: 'litellm' });
  });

  it('モデル一覧を更新すると、読み直した一覧を選べるようにする。読めなければ理由を出し、一覧はそのまま', async () => {
    const results: unknown[] = [
      { catalog: { choices: [{ value: 'claude-test-9', name: 'Test 9', detail: '', disabled: false, efforts: ['low'] }], updatedAt: 0 } },
      { error: 'ネットワークに届きません' },
    ];
    const api = mockApi({
      'folders.info': () => Promise.resolve({ root: '/work/a', name: 'a', branch: 'feature' }),
      'models.refresh': () => Promise.resolve(results.shift()),
    });
    api.install();
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const p = props();
    await mount(p);
    expect(screen.queryByRole('option', { name: 'Test 9' })).toBeNull();
    fireEvent.click(button('モデル一覧を更新'));
    await settle();
    expect(api.argsOf('models.refresh')).toHaveLength(1);
    expect(screen.queryByRole('option', { name: 'Test 9' })).not.toBeNull();
    // 前の一覧（控えが無いときの Opus など）は出さない
    expect(screen.queryByRole('option', { name: 'Opus' })).toBeNull();
    fireEvent.click(button('モデル一覧を更新'));
    await settle();
    expect(api.argsOf('models.refresh')).toHaveLength(2);
    expect(alert).toHaveBeenCalledWith('モデルの一覧を読み込めませんでした: ネットワークに届きません');
    expect(screen.queryByRole('option', { name: 'Test 9' })).not.toBeNull();
    fireEvent.change(select(MODEL), { target: { value: 'claude-test-9' } });
    expect(send(p)[3]).toEqual({ ...DEFAULTS, model: 'claude-test-9' });
  });

  describe('フォルダの選択', () => {
    const chip = () => document.querySelector<HTMLButtonElement>('.folder-picker > button')!;
    const menu = () => document.querySelector<HTMLElement>('.folder-menu');

    it('押すと最近のフォルダを開き、選ぶとそのフォルダに変えて閉じる。もう一度押すと閉じる', async () => {
      const p = props();
      await mount(p);
      expect(menu()).toBeNull();
      fireEvent.click(chip());
      expect(menu()).not.toBeNull();
      // 選んでいるフォルダに印を付ける
      expect(within(menu()!).getByTitle('/work/a').className).toContain('selected');
      expect(within(menu()!).getByTitle('/work/b').className).not.toContain('selected');
      fireEvent.click(chip());
      expect(menu()).toBeNull();
      fireEvent.click(chip());
      fireEvent.click(within(menu()!).getByTitle('/work/b'));
      expect(p.onCwdChange).toHaveBeenCalledWith('/work/b');
      expect(menu()).toBeNull();
    });

    it('外すボタンで、そのフォルダを最近のフォルダから外す（フォルダは変えない）', async () => {
      const p = props();
      await mount(p);
      fireEvent.click(chip());
      fireEvent.click(button('b を最近のフォルダから外す'));
      expect(p.onForgetFolder).toHaveBeenCalledWith('/work/b');
      expect(p.onCwdChange).not.toHaveBeenCalled();
    });

    it('「別のフォルダを選ぶ…」はダイアログで選んだフォルダに変える。選ばずに閉じたら変えない', async () => {
      const picks: (string | null)[] = ['/work/c', null];
      const api = mockApi({
        'folders.info': () => Promise.resolve({ root: '/work/a', name: 'a', branch: 'feature' }),
        'folders.pick': () => Promise.resolve(picks.shift()),
      });
      api.install();
      const p = props();
      await mount(p);
      fireEvent.click(chip());
      fireEvent.click(button('別のフォルダを選ぶ…'));
      expect(menu()).toBeNull();
      await settle();
      expect(api.argsOf('folders.pick')).toHaveLength(1);
      expect(p.onCwdChange).toHaveBeenCalledWith('/work/c');
      fireEvent.click(chip());
      fireEvent.click(button('別のフォルダを選ぶ…'));
      await settle();
      expect(api.argsOf('folders.pick')).toHaveLength(2);
      expect(p.onCwdChange).toHaveBeenCalledTimes(1);
    });

    it('最近のフォルダが無ければ、押すとすぐダイアログで選ぶ', async () => {
      const api = mockApi({ 'folders.pick': () => Promise.resolve('/work/new') });
      api.install();
      const p = props({ folders: [], cwd: null, gitId: null, branch: undefined });
      await mount(p);
      expect(chip().textContent).toBe('フォルダを選ぶ');
      fireEvent.click(chip());
      await settle();
      expect(menu()).toBeNull();
      expect(api.argsOf('folders.pick')).toHaveLength(1);
      expect(p.onCwdChange).toHaveBeenCalledWith('/work/new');
    });
  });

  it('最新のデフォルトブランチへの切り替えが失敗したら、理由を出し、git の状態を読み直す', async () => {
    const api = mockApi({
      'folders.info': () => Promise.resolve({ root: '/work/a', name: 'a', branch: 'feature' }),
      'git.run': () => Promise.reject(new Error("Error invoking remote method 'git:run': Error: origin に届きません")),
    });
    api.install();
    const p = props();
    await mount(p);
    fireEvent.click(button('最新のデフォルトブランチへ切り替える'));
    await settle();
    expect(api.argsOf('git.run')).toEqual([['folder:/work/a', { kind: 'switch-default' }]]);
    expect(screen.queryByText('origin に届きません')).not.toBeNull();
    expect(p.onGitChanged).toHaveBeenCalledTimes(1);
    expect(button('最新のデフォルトブランチへ切り替える').disabled).toBe(false);
  });

  it('フォルダを変えて描き直した直後に送ると、変えた先のフォルダで始め、変えた先のフォルダを選んでいる印にする', async () => {
    const api = mockApi({ 'folders.info': (cwd: never) => Promise.resolve({ root: cwd, name: 'x', branch: 'feature' }) });
    api.install();
    const first = props();
    const view = await mount(first);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'テストを足して' } });
    const second = props({ cwd: '/work/b', gitId: 'folder:/work/b' });
    view.rerender(<NewSessionPane {...second} />);
    fireEvent.click(button('送信'));
    expect(second.onStart).toHaveBeenCalledWith('/work/b', 'テストを足して', [], DEFAULTS);
    expect(first.onStart).not.toHaveBeenCalled();
    expect(api.argsOf('folders.info')).toEqual([['/work/a'], ['/work/b']]);
    fireEvent.click(document.querySelector('.folder-picker > button')!);
    const menu = document.querySelector<HTMLElement>('.folder-menu')!;
    expect(within(menu).getByTitle('/work/b').className).toContain('selected');
    expect(within(menu).getByTitle('/work/a').className).not.toContain('selected');
  });
});

describe('Sidebar（セッションの一覧）', () => {
  type Props = ComponentProps<typeof Sidebar>;
  const props = (sessions: SessionSummary[], over: Partial<Props> = {}): Props => ({
    sessions,
    selectedId: null,
    statusOf: () => 'idle',
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onImport: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onRename: vi.fn(),
    onRemove: vi.fn(),
    scheduled: [],
    ...over,
  });
  const row = (title: string) => screen.getByText(title).closest<HTMLElement>('.session-row')!;
  const titles = () => [...document.querySelectorAll('.session-row .session-title')].map((el) => el.textContent);

  beforeEach(() => {
    mockApi().install();
  });

  it('名前の変更中に入力欄を押しても、その行を選ばない（変更は続けられる）', () => {
    const p = props([session('A'), session('B')]);
    render(<Sidebar {...p} />);
    fireEvent.doubleClick(screen.getByText('セッション A'));
    const input = document.querySelector<HTMLInputElement>('input.session-rename')!;
    expect(input.value).toBe('セッション A');
    fireEvent.click(input);
    expect(p.onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('input.session-rename')).toBe(input);
    fireEvent.change(input, { target: { value: '新しい名前' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onRename).toHaveBeenCalledWith('A', '新しい名前');
    expect(document.querySelector('input.session-rename')).toBeNull();
  });

  it('子セッションのボタンで畳む・開く。押しても親の行は選ばず、畳んだことは覚えておく', () => {
    const p = props([session('P', { title: '親' }), session('C', { title: '子', parentId: 'P' })]);
    render(<Sidebar {...p} />);
    expect(titles()).toEqual(['親', '子']);
    const fold = button('子セッションを畳む');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fold);
    expect(titles()).toEqual(['親']);
    expect(p.onSelect).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(SESSION_COLLAPSED_KEY)!)).toEqual(['P']);
    const open = button('子セッション 1 件を開く');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(open);
    expect(titles()).toEqual(['親', '子']);
    expect(localStorage.getItem(SESSION_COLLAPSED_KEY)).toBeNull();
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  it('アーカイブ済みのセッションを一覧から削除する。確かめて、やめたら消さない', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const p = props([session('A'), session('Z', { title: '古い作業', archived: true })]);
    render(<Sidebar {...p} />);
    expect(screen.queryByText('古い作業')).toBeNull();
    fireEvent.click(screen.getByText(/アーカイブ済み（1）/));
    const remove = within(row('古い作業')).getByRole('button', { name: '一覧から削除' });
    fireEvent.click(remove);
    expect(confirm).toHaveBeenCalledWith('「古い作業」を一覧から削除しますか？\n（Claude Code の会話ログは残ります）');
    expect(p.onRemove).not.toHaveBeenCalled();
    fireEvent.click(remove);
    expect(p.onRemove).toHaveBeenCalledWith('Z');
    // 押しても、その行は選ばない
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  it('worktree のセッションは、ここでは確かめずに一覧からの削除に回す（worktree をどうするかは App のダイアログで聞く）', () => {
    const confirm = vi.spyOn(window, 'confirm');
    const p = props([session('W', { title: 'worktree の作業', archived: true, worktree: { name: 'w', branch: 'worktree-w', root: '/work/repo', preparing: null } })]);
    render(<Sidebar {...p} />);
    fireEvent.click(screen.getByText(/アーカイブ済み（1）/));
    fireEvent.click(within(row('worktree の作業')).getByRole('button', { name: '一覧から削除' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(p.onRemove).toHaveBeenCalledWith('W');
  });

  it('並びをロックすると、更新があっても並びを変えず、外すと最終更新の順に戻す', () => {
    const p = props([session('A'), session('B')]);
    const view = render(<Sidebar {...p} />);
    const lock = button('並びをロック');
    expect(lock.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(lock);
    expect(lock.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem(SESSION_LOCK_KEY)!)).toEqual(['A', 'B']);
    // B が更新されて先頭に来ても、ロックした並びのまま
    view.rerender(<Sidebar {...p} sessions={[session('B'), session('A')]} />);
    expect(titles()).toEqual(['セッション A', 'セッション B']);
    fireEvent.click(lock);
    expect(lock.getAttribute('aria-pressed')).toBe('false');
    expect(titles()).toEqual(['セッション B', 'セッション A']);
    expect(localStorage.getItem(SESSION_LOCK_KEY)).toBeNull();
  });

  it('一覧が変わって描き直した直後に押しても、その行のセッションに効く', () => {
    const p = props([session('A'), session('B')]);
    const view = render(<Sidebar {...p} />);
    // 同じ位置に、別のセッションが来る
    view.rerender(<Sidebar {...p} sessions={[session('C'), session('A', { archived: true })]} />);
    const first = document.querySelector<HTMLElement>('.session-row')!;
    fireEvent.click(within(first).getByRole('button', { name: 'アーカイブ' }));
    expect(p.onArchive).toHaveBeenCalledWith('C');
    fireEvent.click(screen.getByText(/アーカイブ済み（1）/));
    fireEvent.click(within(row('セッション A')).getByRole('button', { name: 'アクティブに戻す' }));
    expect(p.onUnarchive).toHaveBeenCalledWith('A');
    fireEvent.click(first);
    expect(p.onSelect).toHaveBeenCalledWith('C');
    // ロックは、描き直したあとの一覧の並びでかける
    fireEvent.click(button('並びをロック'));
    expect(JSON.parse(localStorage.getItem(SESSION_LOCK_KEY)!)).toEqual(['C', 'A']);
  });
});
