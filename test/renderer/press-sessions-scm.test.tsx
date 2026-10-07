// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry, GitBranches, GitState, SearchResult } from '@shared/ipc';
import { Explorer } from '../../src/renderer/src/explorer/Explorer';
import { ScmPanel } from '../../src/renderer/src/scm/ScmPanel';
import { QuickOpen } from '../../src/renderer/src/search/QuickOpen';
import { SearchPanel } from '../../src/renderer/src/search/SearchPanel';
import './dom';
import { mockApi } from './mock-api';

// ソース管理・エクスプローラー・検索（scm/・explorer/・search/）のボタン・入力を、ひとつ残らず押して、押した結果まで確かめる。
// 対象（セッション）を props で受け取る部品は、対象を変えて描き直した直後に押しても、変えた先に効くことも確かめる

// 返事を、テストから好きなときに返せる約束
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// 返事を受けたあとの処理（state の更新）まで進める
const settle = () => act(async () => {});
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ScmPanel（ソース管理）', () => {
  const state = (over: Partial<Extract<GitState, { isRepo: true }>> = {}): GitState => ({
    isRepo: true,
    branch: 'feature',
    upstream: 'origin/feature',
    ahead: 2,
    behind: 1,
    empty: false,
    entries: [
      { path: 'src/app.ts', index: 'M', worktree: ' ' },
      { path: 'src/lib/util.ts', index: ' ', worktree: 'M' },
      { path: 'src/lib/new.ts', index: '?', worktree: '?' },
      { path: 'README.md', index: ' ', worktree: 'M' },
    ],
    branchChanges: {
      base: { ref: 'main', mergeBase: 'abcdef1234567', kind: 'branch' },
      files: {
        'src/app.ts': { kind: 'modified', added: 3, removed: 1 },
        'docs/guide.md': { kind: 'added', added: 10, removed: 0 },
      },
    },
    ...over,
  });
  type Props = ComponentProps<typeof ScmPanel>;
  const props = (over: Partial<Props> = {}): Props => ({
    sessionId: 'A',
    state: state(),
    view: 'list',
    onViewChange: vi.fn(),
    onRefresh: vi.fn(),
    onOpenDiff: vi.fn(),
    onOpenBranchDiff: vi.fn(),
    activeBranchPath: null,
    comments: [],
    onShowComment: vi.fn(),
    onRemoveComment: vi.fn(),
    ...over,
  });
  const branches: GitBranches = { local: ['feature', 'main', 'fix/login'], remote: ['origin/main', 'origin/release'], defaultBranch: 'main' };
  const setup = (responses: Parameters<typeof mockApi>[0] = {}) => {
    const api = mockApi({ 'git.branches': () => Promise.resolve(branches), ...responses });
    api.install();
    return api;
  };
  const section = (title: string) => screen.getByText(title, { selector: '.scm-section-title' }).closest<HTMLElement>('.scm-section')!;
  const message = () => screen.getByPlaceholderText<HTMLTextAreaElement>(/^メッセージ（⌘Enter でコミット/);
  const branchButton = () => screen.getByTitle<HTMLButtonElement>('ブランチを切り替える');
  const menu = () => document.querySelector<HTMLElement>('.scm-branch-menu');
  const search = () => screen.getByPlaceholderText<HTMLInputElement>('ブランチを探す・新しい名前');

  describe('ブランチの切り替え', () => {
    it('ブランチのボタンで、このセッションのブランチの一覧を開き、もう一度押すと閉じる', async () => {
      const api = setup();
      render(<ScmPanel {...props()} />);
      fireEvent.click(branchButton());
      await settle();
      expect(api.argsOf('git.branches')).toEqual([['A']]);
      expect(menu()).not.toBeNull();
      // 同じ名前のローカルブランチがあるリモートブランチは出さない
      expect(within(menu()!).queryByRole('button', { name: /^origin\/main/ })).toBeNull();
      expect(within(menu()!).queryByRole('button', { name: /^origin\/release/ })).not.toBeNull();
      fireEvent.click(branchButton());
      expect(menu()).toBeNull();
      expect(api.argsOf('git.branches')).toHaveLength(1);
    });

    it('ローカルのブランチを押すと切り替え、終わったら git の状態を読み直す。今のブランチは押しても何もしない', async () => {
      const run = deferred<string | null>();
      const api = setup({ 'git.run': () => run.promise });
      const p = props();
      render(<ScmPanel {...p} />);
      fireEvent.click(branchButton());
      await settle();
      fireEvent.click(within(menu()!).getByRole('button', { name: /^feature/ }));
      expect(api.argsOf('git.run')).toEqual([]);
      expect(menu()).not.toBeNull();
      fireEvent.click(within(menu()!).getByRole('button', { name: 'main' }));
      expect(api.argsOf('git.run')).toEqual([['A', { kind: 'checkout', branch: 'main', mode: 'local' }]]);
      expect(menu()).toBeNull();
      expect(screen.queryByText('切り替え中…')).not.toBeNull();
      expect(p.onRefresh).not.toHaveBeenCalled();
      await act(async () => run.resolve(null));
      expect(screen.queryByText('切り替え中…')).toBeNull();
      expect(p.onRefresh).toHaveBeenCalledTimes(1);
    });

    it('リモートのブランチを押すと、リモートから切り替える', async () => {
      const api = setup();
      render(<ScmPanel {...props()} />);
      fireEvent.click(branchButton());
      await settle();
      fireEvent.click(within(menu()!).getByRole('button', { name: /^origin\/release/ }));
      expect(api.argsOf('git.run')).toEqual([['A', { kind: 'checkout', branch: 'origin/release', mode: 'remote' }]]);
    });

    it('打った文字で絞り込み、無い名前なら新しいブランチを作って切り替えられる', async () => {
      const api = setup();
      render(<ScmPanel {...props()} />);
      fireEvent.click(branchButton());
      await settle();
      fireEvent.change(search(), { target: { value: 'LOG' } });
      expect(search().value).toBe('LOG');
      expect(within(menu()!).queryByRole('button', { name: 'fix/login' })).not.toBeNull();
      expect(within(menu()!).queryByRole('button', { name: 'main' })).toBeNull();
      // 打ったあとは、デフォルトブランチへの切り替えは出さない
      expect(within(menu()!).queryByRole('button', { name: /最新のデフォルトブランチへ切り替える/ })).toBeNull();
      fireEvent.change(search(), { target: { value: 'topic/new' } });
      fireEvent.click(within(menu()!).getByRole('button', { name: '新しいブランチ「topic/new」を作って切り替える' }));
      expect(api.argsOf('git.run')).toEqual([['A', { kind: 'checkout', branch: 'topic/new', mode: 'create' }]]);
      expect(menu()).toBeNull();
    });

    it('Enter で、絞り込んだ最初のローカルブランチに切り替える。合うものが無ければ、その名前で作る。空白を含む名前では作らない', async () => {
      const api = setup();
      render(<ScmPanel {...props()} />);
      fireEvent.click(branchButton());
      await settle();
      fireEvent.change(search(), { target: { value: 'fi' } });
      fireEvent.keyDown(search(), { key: 'Enter', isComposing: true });
      expect(api.argsOf('git.run')).toEqual([]);
      fireEvent.keyDown(search(), { key: 'Enter' });
      expect(api.argsOf('git.run')).toEqual([['A', { kind: 'checkout', branch: 'fix/login', mode: 'local' }]]);
      await settle();
      fireEvent.click(branchButton());
      await settle();
      fireEvent.change(search(), { target: { value: 'a b' } });
      expect(within(menu()!).queryByRole('button', { name: /を作って切り替える/ })).toBeNull();
      fireEvent.keyDown(search(), { key: 'Enter' });
      expect(api.argsOf('git.run')).toHaveLength(1);
      fireEvent.change(search(), { target: { value: 'hotfix' } });
      fireEvent.keyDown(search(), { key: 'Enter' });
      expect(api.argsOf('git.run')[1]).toEqual(['A', { kind: 'checkout', branch: 'hotfix', mode: 'create' }]);
    });

    it('Esc で一覧を閉じる（ほかのキーでは閉じない）', async () => {
      setup();
      render(<ScmPanel {...props()} />);
      fireEvent.click(branchButton());
      await settle();
      fireEvent.keyDown(search(), { key: 'ArrowDown' });
      expect(menu()).not.toBeNull();
      fireEvent.keyDown(search(), { key: 'Escape' });
      expect(menu()).toBeNull();
    });
  });

  it('表示の切り替えボタンは、押すと切り替わる先（ツリー / 一覧）を渡す', () => {
    setup();
    const p = props();
    const view = render(<ScmPanel {...p} />);
    fireEvent.click(button('ツリーで表示'));
    expect(p.onViewChange).toHaveBeenLastCalledWith('tree');
    view.rerender(<ScmPanel {...p} view="tree" />);
    fireEvent.click(button('一覧で表示'));
    expect(p.onViewChange).toHaveBeenLastCalledWith('list');
  });

  it('プル・プッシュ・フェッチは、このセッションで動かし、動いている間は押せない。失敗したら理由を出す', async () => {
    const runs: ReturnType<typeof deferred<string | null>>[] = [];
    const api = setup({
      'git.run': () => {
        const d = deferred<string | null>();
        runs.push(d);
        return d.promise;
      },
    });
    const p = props();
    render(<ScmPanel {...p} />);
    expect(button('プル').getAttribute('data-tip')).toBe('origin/feature からプル');
    fireEvent.click(button('プル'));
    expect(screen.queryByText('プル中…')).not.toBeNull();
    expect(button('プル').disabled).toBe(true);
    expect(button('プッシュ').disabled).toBe(true);
    expect(button('フェッチ').disabled).toBe(true);
    await act(async () => runs[0].resolve(null));
    expect(button('プッシュ').disabled).toBe(false);
    fireEvent.click(button('プッシュ'));
    expect(screen.queryByText('プッシュ中…')).not.toBeNull();
    await act(async () => runs[1].resolve('rejected: non-fast-forward'));
    expect(screen.queryByText('rejected: non-fast-forward')).not.toBeNull();
    fireEvent.click(button('フェッチ'));
    // 次の操作を始めると、前の失敗の理由は消す
    expect(screen.queryByText('rejected: non-fast-forward')).toBeNull();
    expect(screen.queryByText('フェッチ中…')).not.toBeNull();
    await act(async () => runs[2].resolve(null));
    expect(api.argsOf('git.run')).toEqual([
      ['A', { kind: 'pull' }],
      ['A', { kind: 'push' }],
      ['A', { kind: 'fetch' }],
    ]);
    expect(p.onRefresh).toHaveBeenCalledTimes(3);
  });

  it('コミットのまだ無いリポジトリでは、プッシュできない', () => {
    setup();
    render(<ScmPanel {...props({ state: state({ empty: true, upstream: null }) })} />);
    expect(button('プッシュ').disabled).toBe(true);
    expect(button('プッシュ').getAttribute('data-tip')).toBe('origin にプッシュ（上流を設定）');
    expect(button('プル').disabled).toBe(false);
  });

  describe('コミット', () => {
    it('⌘Enter（Ctrl+Enter）で、書いたメッセージでコミットし、終わったらメッセージを空にする。Enter だけ・変換中では送らない', async () => {
      const api = setup();
      render(<ScmPanel {...props()} />);
      fireEvent.change(message(), { target: { value: 'ログインを直す' } });
      fireEvent.keyDown(message(), { key: 'Enter' });
      fireEvent.keyDown(message(), { key: 'Enter', metaKey: true, isComposing: true });
      expect(api.argsOf('git.run')).toEqual([]);
      fireEvent.keyDown(message(), { key: 'Enter', metaKey: true });
      expect(api.argsOf('git.run')).toEqual([['A', { kind: 'commit', message: 'ログインを直す', amend: false }]]);
      expect(screen.queryByText('コミット中…')).not.toBeNull();
      await settle();
      expect(message().value).toBe('');
      fireEvent.change(message(), { target: { value: '続き' } });
      fireEvent.keyDown(message(), { key: 'Enter', ctrlKey: true });
      expect(api.argsOf('git.run')[1]).toEqual(['A', { kind: 'commit', message: '続き', amend: false }]);
    });

    it('ステージした変更が無ければ、コミットせずに理由を出す', () => {
      const api = setup();
      render(<ScmPanel {...props({ state: state({ entries: [{ path: 'README.md', index: ' ', worktree: 'M' }] }) })} />);
      fireEvent.change(message(), { target: { value: 'まだ何も無い' } });
      fireEvent.keyDown(message(), { key: 'Enter', metaKey: true });
      expect(api.argsOf('git.run')).toEqual([]);
      expect(screen.queryByText('コミットする変更がステージされていません')).not.toBeNull();
    });

    it('「直前のコミットを修正」を選ぶと直前のメッセージを入れ、修正としてコミットする。終わったら選択を外す', async () => {
      const api = setup({ 'git.lastCommitMessage': () => Promise.resolve('前のメッセージ') });
      // ステージした変更が無くても、修正ならコミットできる
      render(<ScmPanel {...props({ state: state({ entries: [] }) })} />);
      const amend = screen.getByRole<HTMLInputElement>('checkbox', { name: '直前のコミットを修正' });
      fireEvent.click(amend);
      expect(amend.checked).toBe(true);
      await settle();
      expect(api.argsOf('git.lastCommitMessage')).toEqual([['A']]);
      expect(message().value).toBe('前のメッセージ');
      expect(button('コミット').getAttribute('data-tip')).toBe('直前のコミットを修正（⌘Enter）');
      fireEvent.change(message(), { target: { value: '前のメッセージ（直した）' } });
      fireEvent.keyDown(message(), { key: 'Enter', metaKey: true });
      expect(api.argsOf('git.run')).toEqual([['A', { kind: 'commit', message: '前のメッセージ（直した）', amend: true }]]);
      await settle();
      expect(amend.checked).toBe(false);
      expect(message().value).toBe('');
    });

    it('メッセージを書いてから「直前のコミットを修正」を選んでも、書いたものは消さない。外せば、ふつうのコミットに戻る', async () => {
      const api = setup({ 'git.lastCommitMessage': () => Promise.resolve('前のメッセージ') });
      render(<ScmPanel {...props()} />);
      fireEvent.change(message(), { target: { value: '書きかけ' } });
      const amend = screen.getByRole<HTMLInputElement>('checkbox', { name: '直前のコミットを修正' });
      fireEvent.click(amend);
      await settle();
      expect(api.argsOf('git.lastCommitMessage')).toEqual([]);
      expect(message().value).toBe('書きかけ');
      fireEvent.click(amend);
      expect(amend.checked).toBe(false);
      fireEvent.keyDown(message(), { key: 'Enter', metaKey: true });
      expect(api.argsOf('git.run')).toEqual([['A', { kind: 'commit', message: '書きかけ', amend: false }]]);
    });
  });

  describe('変更の一覧', () => {
    it('区分の見出しを押すと畳み、もう一度押すと開く', () => {
      setup();
      render(<ScmPanel {...props()} />);
      const staged = section('ステージ済みの変更');
      expect(within(staged).queryByTitle('src/app.ts')).not.toBeNull();
      fireEvent.click(staged.querySelector('.scm-section-head')!);
      expect(within(staged).queryByTitle('src/app.ts')).toBeNull();
      fireEvent.click(staged.querySelector('.scm-section-head')!);
      expect(within(staged).queryByTitle('src/app.ts')).not.toBeNull();
      const changes = section('変更');
      fireEvent.click(changes.querySelector('.scm-section-head')!);
      expect(within(changes).queryByTitle('README.md')).toBeNull();
    });

    it('区分の「すべて」のボタンは、その区分のすべてのファイルに効き、見出しは畳まない', () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
      const api = setup();
      render(<ScmPanel {...props()} />);
      const changes = section('変更');
      fireEvent.click(within(changes).getByRole('button', { name: 'すべてステージする' }));
      fireEvent.click(within(section('ステージ済みの変更')).getByRole('button', { name: 'すべてステージを取り消す' }));
      fireEvent.click(within(changes).getByRole('button', { name: 'すべて変更を破棄' }));
      expect(confirm).toHaveBeenLastCalledWith('3 件のファイル の変更を破棄しますか？（未追跡のファイルは削除されます。元に戻せません）');
      fireEvent.click(within(changes).getByRole('button', { name: 'すべて変更を破棄' }));
      expect(api.argsOf('git.run')).toEqual([
        ['A', { kind: 'stage', paths: ['src/lib/util.ts', 'src/lib/new.ts', 'README.md'] }],
        ['A', { kind: 'unstage', paths: ['src/app.ts'] }],
        ['A', { kind: 'discard', paths: ['src/lib/util.ts', 'src/lib/new.ts', 'README.md'] }],
      ]);
      expect(within(changes).queryByTitle('README.md')).not.toBeNull();
    });

    it('ツリーでは、フォルダの行を押すと畳み、もう一度押すと開く', () => {
      setup();
      render(<ScmPanel {...props({ view: 'tree' })} />);
      const changes = section('変更');
      // 子がフォルダ 1 つだけのフォルダは、1 行にまとめる
      const dir = within(changes).getByTitle('src/lib');
      expect(dir.textContent).toContain('src/lib');
      expect(within(changes).queryByTitle('src/lib/util.ts')).not.toBeNull();
      fireEvent.click(dir);
      expect(within(changes).queryByTitle('src/lib/util.ts')).toBeNull();
      expect(within(changes).queryByTitle('src/lib/new.ts')).toBeNull();
      expect(within(changes).queryByTitle('README.md')).not.toBeNull();
      fireEvent.click(dir);
      expect(within(changes).queryByTitle('src/lib/util.ts')).not.toBeNull();
    });

    it('ツリーのフォルダの行のボタンは、フォルダの下のすべてのファイルに効き、フォルダは畳まない', () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const api = setup();
      render(<ScmPanel {...props({ view: 'tree' })} />);
      const changes = section('変更');
      const dir = within(changes).getByTitle('src/lib');
      fireEvent.click(within(dir).getByRole('button', { name: 'ステージする（フォルダ内すべて）' }));
      fireEvent.click(within(dir).getByRole('button', { name: '変更を破棄（フォルダ内すべて）' }));
      expect(confirm).toHaveBeenCalledWith('2 件のファイル の変更を破棄しますか？（未追跡のファイルは削除されます。元に戻せません）');
      const stagedDir = within(section('ステージ済みの変更')).getByTitle('src');
      fireEvent.click(within(stagedDir).getByRole('button', { name: 'ステージを取り消す（フォルダ内すべて）' }));
      expect(api.argsOf('git.run')).toEqual([
        ['A', { kind: 'stage', paths: ['src/lib/util.ts', 'src/lib/new.ts'] }],
        ['A', { kind: 'discard', paths: ['src/lib/util.ts', 'src/lib/new.ts'] }],
        ['A', { kind: 'unstage', paths: ['src/app.ts'] }],
      ]);
      expect(within(changes).queryByTitle('src/lib/util.ts')).not.toBeNull();
    });

    it('ファイルの行は差分を開き、行のボタンはそのファイルだけに効く', () => {
      const api = setup();
      const p = props();
      render(<ScmPanel {...p} />);
      const changes = section('変更');
      fireEvent.click(within(changes).getByTitle('README.md'));
      expect(p.onOpenDiff).toHaveBeenCalledWith('README.md', false);
      fireEvent.click(within(section('ステージ済みの変更')).getByTitle('src/app.ts'));
      expect(p.onOpenDiff).toHaveBeenLastCalledWith('src/app.ts', true);
      fireEvent.click(within(within(changes).getByTitle('README.md')).getByRole('button', { name: 'ステージする' }));
      expect(api.argsOf('git.run')).toEqual([['A', { kind: 'stage', paths: ['README.md'] }]]);
      expect(p.onOpenDiff).toHaveBeenCalledTimes(2);
    });
  });

  describe('ブランチの変更', () => {
    it('見出しを押すと畳み、もう一度押すと開く', () => {
      setup();
      render(<ScmPanel {...props()} />);
      const branch = section('ブランチの変更');
      expect(branch.querySelector('.scm-section-head')!.getAttribute('title')).toBe('main から分岐したところ（abcdef1）から');
      expect(within(branch).queryByTitle('docs/guide.md（新規）')).not.toBeNull();
      fireEvent.click(branch.querySelector('.scm-section-head')!);
      expect(within(branch).queryByTitle('docs/guide.md（新規）')).toBeNull();
      expect(within(branch).queryByText('main から')).toBeNull();
      fireEvent.click(branch.querySelector('.scm-section-head')!);
      expect(within(branch).queryByTitle('docs/guide.md（新規）')).not.toBeNull();
    });

    it('ファイルの行を押すと、そのファイルのブランチの差分を開く（一覧でもツリーでも）', () => {
      setup();
      const p = props({ activeBranchPath: 'src/app.ts' });
      const view = render(<ScmPanel {...p} />);
      const branch = () => section('ブランチの変更');
      expect(within(branch()).getByTitle('src/app.ts（変更）').className).toContain('active');
      fireEvent.click(within(branch()).getByTitle('docs/guide.md（新規）'));
      expect(p.onOpenBranchDiff).toHaveBeenCalledWith('docs/guide.md');
      view.rerender(<ScmPanel {...p} view="tree" />);
      fireEvent.click(within(branch()).getByTitle('src/app.ts（変更）'));
      expect(p.onOpenBranchDiff).toHaveBeenLastCalledWith('src/app.ts');
      // ツリーのフォルダの行は、押すと畳む（差分は開かない）
      fireEvent.click(within(branch()).getByTitle('docs'));
      expect(within(branch()).queryByTitle('docs/guide.md（新規）')).toBeNull();
      expect(p.onOpenBranchDiff).toHaveBeenCalledTimes(2);
    });
  });

  it('同じフォルダの別のセッションに変えて描き直した直後に押すと、変えた先のセッションで動かす', async () => {
    const api = setup({ 'git.lastCommitMessage': () => Promise.resolve('B の前のメッセージ') });
    const first = props();
    const view = render(<ScmPanel {...first} />);
    const second = props({ sessionId: 'B' });
    view.rerender(<ScmPanel {...second} />);
    fireEvent.click(button('プッシュ'));
    await settle();
    fireEvent.click(button('フェッチ'));
    await settle();
    fireEvent.click(within(section('変更')).getByRole('button', { name: 'すべてステージする' }));
    await settle();
    fireEvent.click(screen.getByRole('checkbox', { name: '直前のコミットを修正' }));
    await settle();
    expect(message().value).toBe('B の前のメッセージ');
    fireEvent.keyDown(message(), { key: 'Enter', metaKey: true });
    await settle();
    fireEvent.click(branchButton());
    await settle();
    fireEvent.click(within(menu()!).getByRole('button', { name: 'main' }));
    await settle();
    expect(api.argsOf('git.lastCommitMessage')).toEqual([['B']]);
    expect(api.argsOf('git.branches')).toEqual([['B']]);
    expect(api.argsOf('git.run')).toEqual([
      ['B', { kind: 'push' }],
      ['B', { kind: 'fetch' }],
      ['B', { kind: 'stage', paths: ['src/lib/util.ts', 'src/lib/new.ts', 'README.md'] }],
      ['B', { kind: 'commit', message: 'B の前のメッセージ', amend: true }],
      ['B', { kind: 'checkout', branch: 'main', mode: 'local' }],
    ]);
    // 読み直すのも、変えた先のもの
    expect(first.onRefresh).not.toHaveBeenCalled();
    expect(second.onRefresh).toHaveBeenCalledTimes(5);
  });
});

describe('Explorer（エクスプローラー）', () => {
  const dirs: Record<string, DirEntry[]> = {
    '': [
      { name: 'src', path: 'src', isDir: true },
      { name: 'README.md', path: 'README.md', isDir: false },
    ],
    src: [{ name: 'main.ts', path: 'src/main.ts', isDir: false }],
  };
  type Props = ComponentProps<typeof Explorer>;
  const props = (over: Partial<Props> = {}): Props => ({
    sessionId: 'A',
    root: '/work/shop',
    rootName: 'shop',
    activePath: null,
    changes: {},
    knowledge: {},
    gitMarks: {},
    onOpenFile: vi.fn(),
    ...over,
  });
  const setup = () => {
    const api = mockApi({ 'workspace.listDir': (_id: never, dir: never) => Promise.resolve(dirs[dir]) });
    api.install();
    return api;
  };
  const rootRow = () => screen.getByText('shop').closest<HTMLElement>('.tree-row')!;

  it('いちばん上のフォルダの行を押すと畳み、もう一度押すと開く（読み直さない）', async () => {
    const api = setup();
    render(<Explorer {...props()} />);
    await screen.findByText('README.md');
    expect(api.argsOf('workspace.listDir')).toEqual([['A', '']]);
    fireEvent.click(rootRow());
    expect(screen.queryByText('README.md')).toBeNull();
    expect(screen.queryByText('src')).toBeNull();
    fireEvent.click(rootRow());
    expect(screen.queryByText('README.md')).not.toBeNull();
    expect(api.argsOf('workspace.listDir')).toEqual([['A', '']]);
  });

  it('フォルダの行で中身を読んで開き、ファイルの行でそのファイルを開く', async () => {
    const api = setup();
    const p = props();
    render(<Explorer {...p} />);
    fireEvent.click(await screen.findByText('src'));
    await screen.findByText('main.ts');
    expect(api.argsOf('workspace.listDir')).toEqual([
      ['A', ''],
      ['A', 'src'],
    ]);
    fireEvent.click(screen.getByText('main.ts'));
    expect(p.onOpenFile).toHaveBeenCalledWith('src/main.ts');
  });

  it('同じフォルダの別のセッションに変えて描き直した直後に押すと、変えた先のセッションで読む', async () => {
    const api = setup();
    const first = props();
    const view = render(<Explorer {...first} />);
    await screen.findByText('README.md');
    const second = props({ sessionId: 'B' });
    view.rerender(<Explorer {...second} />);
    fireEvent.click(screen.getByText('src'));
    await screen.findByText('main.ts');
    expect(api.argsOf('workspace.listDir')).toEqual([
      ['A', ''],
      ['B', ''],
      ['B', 'src'],
    ]);
    fireEvent.click(screen.getByText('README.md'));
    expect(second.onOpenFile).toHaveBeenCalledWith('README.md');
    expect(first.onOpenFile).not.toHaveBeenCalled();
  });
});

describe('QuickOpen（ファイル名で開く）', () => {
  const files: Record<string, string[]> = {
    A: ['src/app.ts', 'src/lib/util.ts', 'README.md'],
    B: ['docs/guide.md', 'package.json'],
  };
  const setup = () => {
    const api = mockApi({ 'workspace.listFiles': (id: never) => Promise.resolve(files[id]) });
    api.install();
    return api;
  };
  const box = () => screen.getByPlaceholderText<HTMLInputElement>('ファイル名で探す');
  const items = () => [...document.querySelectorAll('.quick-open-item')].map((el) => el.querySelector('.quick-open-name')!.textContent);

  it('候補を押すと、そのファイルを開いて閉じる', async () => {
    setup();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<QuickOpen sessionId="A" onOpen={onOpen} onClose={onClose} />);
    await settle();
    expect(items()).toEqual(['app.ts', 'util.ts', 'README.md']);
    fireEvent.click(button(/^util\.ts/));
    expect(onOpen).toHaveBeenCalledWith('src/lib/util.ts');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('枠の中を押しても閉じず、外を押すと閉じる', async () => {
    setup();
    const onClose = vi.fn();
    render(<QuickOpen sessionId="A" onOpen={vi.fn()} onClose={onClose} />);
    await settle();
    fireEvent.mouseDown(box());
    fireEvent.mouseDown(document.querySelector('.quick-open')!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector('.overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('打った文字で絞り込み、↑↓ で選んで Enter で開く。Esc で閉じる', async () => {
    setup();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<QuickOpen sessionId="A" onOpen={onOpen} onClose={onClose} />);
    await settle();
    fireEvent.change(box(), { target: { value: 'ts' } });
    expect(items()).toEqual(['app.ts', 'util.ts']);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(document.querySelector('.quick-open-item.selected')!.textContent).toContain('util.ts');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('src/app.ts');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('別のセッションに変えて描き直すと、変えた先のファイルを読み、押せば変えた先のファイルを開く', async () => {
    const api = setup();
    const onOpen = vi.fn();
    const view = render(<QuickOpen sessionId="A" onOpen={onOpen} onClose={vi.fn()} />);
    await settle();
    view.rerender(<QuickOpen sessionId="B" onOpen={onOpen} onClose={vi.fn()} />);
    await settle();
    expect(api.argsOf('workspace.listFiles')).toEqual([['A'], ['B']]);
    expect(items()).toEqual(['guide.md', 'package.json']);
    fireEvent.click(button(/^guide\.md/));
    expect(onOpen).toHaveBeenCalledWith('docs/guide.md');
  });
});

describe('SearchPanel（全文検索）', () => {
  const result: SearchResult = {
    files: [{ path: 'src/app.ts', matches: [{ line: 12, column: 3, text: '  const Foo = foo();', matchStart: 8, matchLength: 3 }] }],
    truncated: false,
  };
  const setup = () => {
    vi.useFakeTimers();
    const api = mockApi({ 'workspace.search': () => Promise.resolve(result) });
    api.install();
    return api;
  };
  // 検索は打ち終わって 250ms 待ってから
  const wait = () => act(async () => vi.advanceTimersByTime(250));

  it('「大文字と小文字を区別」「正規表現」を押すと、その指定で検索し直す。もう一度押すと外す', async () => {
    const api = setup();
    render(<SearchPanel sessionId="A" onOpen={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: 'Foo' } });
    await wait();
    const caseButton = button('大文字と小文字を区別');
    const regexButton = button('正規表現');
    expect(caseButton.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(caseButton);
    expect(caseButton.getAttribute('aria-pressed')).toBe('true');
    await wait();
    fireEvent.click(regexButton);
    expect(regexButton.getAttribute('aria-pressed')).toBe('true');
    await wait();
    fireEvent.click(caseButton);
    expect(caseButton.getAttribute('aria-pressed')).toBe('false');
    await wait();
    fireEvent.click(regexButton);
    await wait();
    expect(api.argsOf('workspace.search')).toEqual([
      ['A', 'Foo', { caseSensitive: false, regex: false }],
      ['A', 'Foo', { caseSensitive: true, regex: false }],
      ['A', 'Foo', { caseSensitive: true, regex: true }],
      ['A', 'Foo', { caseSensitive: false, regex: true }],
      ['A', 'Foo', { caseSensitive: false, regex: false }],
    ]);
    expect(screen.queryByText('1 ファイル · 1 件')).not.toBeNull();
  });

  it('何も打っていなければ、指定を変えても検索しない', async () => {
    const api = setup();
    render(<SearchPanel sessionId="A" onOpen={vi.fn()} />);
    fireEvent.click(button('大文字と小文字を区別'));
    fireEvent.click(button('正規表現'));
    await wait();
    expect(api.argsOf('workspace.search')).toEqual([]);
    expect(button('正規表現').getAttribute('aria-pressed')).toBe('true');
  });

  it('同じフォルダの別のセッションに変えて描き直した直後に押すと、変えた先のセッションで検索し直す', async () => {
    const api = setup();
    const view = render(<SearchPanel sessionId="A" onOpen={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: 'Foo' } });
    await wait();
    view.rerender(<SearchPanel sessionId="B" onOpen={vi.fn()} />);
    fireEvent.click(button('正規表現'));
    await wait();
    expect(api.argsOf('workspace.search')).toEqual([
      ['A', 'Foo', { caseSensitive: false, regex: false }],
      ['B', 'Foo', { caseSensitive: false, regex: true }],
    ]);
  });

  it('見つかった行を押すと、そのファイルのその行を開く', async () => {
    setup();
    const onOpen = vi.fn();
    render(<SearchPanel sessionId="A" onOpen={onOpen} />);
    fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: 'Foo' } });
    await wait();
    fireEvent.click(document.querySelector('.search-match')!);
    expect(onOpen).toHaveBeenCalledWith('src/app.ts', 12);
  });
});
