// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry, GitBranches, GitState, SearchResult } from '@shared/ipc';
import { Explorer, type ExplorerFileOps } from '../../src/renderer/src/explorer/Explorer';
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

    it('見出し・フォルダ・ファイルの行は Tab で止まり、Enter で押したのと同じに動く。行のボタンの Enter は、行の Enter にしない', () => {
      setup();
      const p = props({ view: 'tree' });
      render(<ScmPanel {...p} />);
      const changes = section('変更');
      const head = changes.querySelector<HTMLElement>('.scm-section-head')!;
      const dir = within(changes).getByTitle('src/lib');
      const file = within(changes).getByTitle('README.md');
      for (const row of [head, dir, file]) expect(row.tabIndex).toBe(0);
      fireEvent.keyDown(file, { key: 'Enter' });
      expect(p.onOpenDiff).toHaveBeenCalledWith('README.md', false);
      // 修飾キー付き・変換中の Enter は、行を押したことにしない
      fireEvent.keyDown(file, { key: 'Enter', metaKey: true });
      fireEvent.keyDown(file, { key: 'Enter', isComposing: true });
      expect(p.onOpenDiff).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(within(file).getByRole('button', { name: 'ステージする' }), { key: 'Enter' });
      expect(p.onOpenDiff).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(dir, { key: 'Enter' });
      expect(within(changes).queryByTitle('src/lib/util.ts')).toBeNull();
      fireEvent.keyDown(head, { key: 'Enter' });
      expect(within(changes).queryByTitle('README.md')).toBeNull();
      const branchHead = section('ブランチの変更').querySelector<HTMLElement>('.scm-section-head')!;
      expect(within(section('ブランチの変更')).queryByTitle(/docs\/guide\.md/)).not.toBeNull();
      fireEvent.keyDown(branchHead, { key: 'Enter' });
      expect(within(section('ブランチの変更')).queryByTitle(/docs\/guide\.md/)).toBeNull();
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

  describe('ワークスペースに追加したフォルダ', () => {
    const LIB = '/work/lib';
    const libDirs: Record<string, DirEntry[]> = {
      [LIB]: [
        { name: 'src', path: `${LIB}/src`, isDir: true },
        { name: 'index.ts', path: `${LIB}/index.ts`, isDir: false },
      ],
      [`${LIB}/src`]: [{ name: 'util.ts', path: `${LIB}/src/util.ts`, isDir: false }],
    };
    const setupLib = () => {
      const api = mockApi({ 'workspace.listDir': (_id: never, dir: never) => Promise.resolve(dirs[dir] ?? libDirs[dir]) });
      api.install();
      return api;
    };
    const libRow = () => screen.getByText('lib').closest<HTMLElement>('.tree-row')!;

    it('セッションのフォルダの下に、フォルダの名前の行と中身を並べる。中身は絶対パスで読み、絶対パスで開く', async () => {
      const api = setupLib();
      const p = props({ folders: [LIB] });
      render(<Explorer {...p} />);
      await screen.findByText('index.ts');
      await screen.findByText('README.md');
      expect(api.argsOf('workspace.listDir')).toEqual([
        ['A', ''],
        ['A', LIB],
      ]);
      // フォルダの行は、セッションのフォルダの行のあと
      const labels = [...document.querySelectorAll('.tree-row > .tree-label')].map((el) => el.textContent);
      expect(labels.indexOf('lib')).toBeGreaterThan(labels.indexOf('README.md'));
      expect(libRow().getAttribute('title')).toBe(LIB);
      fireEvent.click(screen.getAllByText('src')[1]);
      fireEvent.click(await screen.findByText('util.ts'));
      expect(p.onOpenFile).toHaveBeenCalledWith(`${LIB}/src/util.ts`);
      expect(api.argsOf('workspace.listDir').at(-1)).toEqual(['A', `${LIB}/src`]);
      // フォルダの行で、そのフォルダだけを畳む
      fireEvent.click(libRow());
      expect(screen.queryByText('index.ts')).toBeNull();
      expect(screen.queryByText('README.md')).not.toBeNull();
    });

    it('外すボタンは、そのフォルダを渡して呼び、行は畳まない。外せないとき（onRemoveFolder が無い）は出さない。セッションのフォルダの行には出さない', async () => {
      setupLib();
      const onRemoveFolder = vi.fn();
      const view = render(<Explorer {...props({ folders: [LIB, '/work/docs'], onRemoveFolder })} />);
      await screen.findByText('index.ts');
      const removes = screen.getAllByRole('button', { name: 'ワークスペースから外す' });
      expect(removes).toHaveLength(2);
      fireEvent.click(removes[0]);
      expect(onRemoveFolder.mock.calls).toEqual([[LIB]]);
      expect(screen.queryByText('index.ts')).not.toBeNull();
      fireEvent.click(removes[1]);
      expect(onRemoveFolder.mock.calls).toEqual([[LIB], ['/work/docs']]);
      expect(rootRow().querySelector('button')).toBeNull();
      view.rerender(<Explorer {...props({ folders: [LIB] })} />);
      expect(screen.queryByRole('button', { name: 'ワークスペースから外す' })).toBeNull();
    });

    it('ファイルの変更は、変わったフォルダのツリーだけで読み直す（追加したフォルダの変更は、そのフォルダからの相対パスで届く）', async () => {
      const api = setupLib();
      render(<Explorer {...props({ folders: [LIB] })} />);
      await screen.findByText('index.ts');
      fireEvent.click(screen.getAllByText('src')[1]);
      await screen.findByText('util.ts');
      const before = api.argsOf('workspace.listDir').length;
      act(() => api.emit('workspace.onFilesChanged', { root: LIB, paths: ['src/new.ts'] }));
      expect(api.argsOf('workspace.listDir').slice(before)).toEqual([['A', `${LIB}/src`]]);
      act(() => api.emit('workspace.onFilesChanged', { root: '/work/shop', paths: ['README.md'] }));
      expect(api.argsOf('workspace.listDir').slice(before + 1)).toEqual([['A', '']]);
      // 知らないフォルダの変更では読み直さない
      act(() => api.emit('workspace.onFilesChanged', { root: '/work/other', paths: ['index.ts'] }));
      expect(api.argsOf('workspace.listDir')).toHaveLength(before + 2);
    });

    it('開いたファイルが追加したフォルダの中なら、そのツリーで親フォルダを開いて選ぶ。Claude が読んだ印は絶対パスで引く', async () => {
      const api = setupLib();
      render(<Explorer {...props({ folders: [LIB], activePath: `${LIB}/src/util.ts`, knowledge: { [`${LIB}/src/util.ts`]: 'read' } })} />);
      const row = (await screen.findByText('util.ts')).closest<HTMLElement>('.tree-row')!;
      expect(row.classList.contains('active')).toBe(true);
      expect(row.querySelector('.tree-know.read')).not.toBeNull();
      // セッションのフォルダのツリーでは、絶対パスのファイルを探さない
      expect(api.argsOf('workspace.listDir')).toEqual([
        ['A', ''],
        ['A', LIB],
        ['A', `${LIB}/src`],
      ]);
    });
  });

  describe('右クリックのメニュー（ファイル操作）', () => {
    const LIB = '/work/lib';
    const libDirs: Record<string, DirEntry[]> = { [LIB]: [{ name: 'index.ts', path: `${LIB}/index.ts`, isDir: false }] };
    const fileOps = (over: Partial<ExplorerFileOps> = {}): ExplorerFileOps => ({
      beforeRename: vi.fn(async () => true),
      renamed: vi.fn(),
      hasUnsaved: vi.fn(() => false),
      trashed: vi.fn(),
      ...over,
    });
    const setupOps = (responses: Record<string, (...args: never[]) => unknown> = {}) => {
      const api = mockApi({ 'workspace.listDir': (_id: never, dir: never) => Promise.resolve(dirs[dir] ?? libDirs[dir]), ...responses });
      api.install();
      return api;
    };
    const rowOf = (name: string) => screen.getAllByText(name)[0].closest<HTMLElement>('.tree-row')!;
    const menuLabels = () => screen.getAllByRole('menuitem').map((b) => b.textContent);
    const pick = (label: string) => fireEvent.click(screen.getByRole('menuitem', { name: label }));
    const input = () => document.querySelector<HTMLInputElement>('.tree-input')!;

    it('行は Tab で止まり、Enter で押したのと同じに動く。⌃Enter で右クリックと同じメニューを開き、最初の項目にフォーカスする。↑↓ で移り、Esc で閉じて行に戻る', async () => {
      setupOps();
      const p = props({ fileOps: fileOps() });
      render(<Explorer {...p} />);
      await screen.findByText('README.md');
      const readme = rowOf('README.md');
      expect(readme.tabIndex).toBe(0);
      expect(rootRow().tabIndex).toBe(0);
      fireEvent.keyDown(readme, { key: 'Enter' });
      expect(p.onOpenFile).toHaveBeenCalledWith('README.md');
      fireEvent.keyDown(rowOf('src'), { key: 'Enter' });
      await screen.findByText('main.ts');
      // Tab で行に入る
      fireEvent.keyDown(document.body, { key: 'Tab' });
      readme.focus();
      expect(document.activeElement).toBe(readme);
      fireEvent.keyDown(readme, { key: 'Enter', ctrlKey: true });
      expect(menuLabels()).toEqual(['新規ファイル', '新規フォルダ', '名前を変更', 'ゴミ箱に入れる', 'パスをコピー', '相対パスをコピー', 'Finder で表示']);
      expect(readme.classList.contains('menu-target')).toBe(true);
      expect(p.onOpenFile).toHaveBeenCalledTimes(1);
      const items = screen.getAllByRole('menuitem');
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(window, { key: 'ArrowUp' });
      fireEvent.keyDown(window, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(items.at(-1));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(readme);
      // 項目を選んで、名前を入れる欄が出たときは、欄にフォーカスを残す
      fireEvent.keyDown(readme, { key: 'Enter', ctrlKey: true });
      pick('名前を変更');
      expect(document.activeElement).toBe(input());
      fireEvent.keyDown(input(), { key: 'Escape' });
      // フォルダそのものの行でも開ける
      fireEvent.keyDown(rootRow(), { key: 'Enter', ctrlKey: true });
      expect(menuLabels()).toEqual(['新規ファイル', '新規フォルダ', 'パスをコピー', 'Finder で表示']);
    });

    it('キーで開いたメニューの中では、Tab で外へ出ない（出ると Esc で行へ戻れない）', async () => {
      setupOps();
      render(<Explorer {...props({ fileOps: fileOps() })} />);
      await screen.findByText('README.md');
      fireEvent.keyDown(document.body, { key: 'Tab' });
      rowOf('README.md').focus();
      fireEvent.keyDown(rowOf('README.md'), { key: 'Enter', ctrlKey: true });
      expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab' })).toBe(false);
      expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })).toBe(false);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(document.activeElement).toBe(rowOf('README.md'));
    });

    it('右クリックで開いたままで、別の行で ⌃Enter を押すと、その行のメニューに開き直して、最初の項目にフォーカスする', async () => {
      setupOps();
      render(<Explorer {...props({ fileOps: fileOps() })} />);
      fireEvent.contextMenu(await screen.findByText('README.md'));
      expect(screen.getByRole('menu').contains(document.activeElement)).toBe(false);
      fireEvent.keyDown(document.body, { key: 'Tab' });
      rootRow().focus();
      fireEvent.keyDown(rootRow(), { key: 'Enter', ctrlKey: true });
      expect(menuLabels()).toEqual(['新規ファイル', '新規フォルダ', 'パスをコピー', 'Finder で表示']);
      expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[1]);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(document.activeElement).toBe(rootRow());
    });

    it('マウスで押した行には、フォーカスを残さない（押したあとの Enter で、行をもう一度押さない）', async () => {
      setupOps();
      const p = props({ fileOps: fileOps() });
      render(<Explorer {...p} />);
      await screen.findByText('README.md');
      // マウスで押すと、ブラウザは行（tabIndex 付き）にフォーカスを入れる。:focus-visible ではないので、離したときに外す
      // （押している間に外すと、ドラッグで文字を選べなくなる）
      const row = rowOf('README.md');
      fireEvent.pointerDown(row);
      row.focus();
      expect(document.activeElement).toBe(row);
      fireEvent.pointerUp(window);
      fireEvent.click(row);
      expect(document.activeElement).toBe(document.body);
      // スクリプトで戻したフォーカス（ダイアログを閉じたときなど）も、キーで入ったのでなければ、すぐ外す
      row.focus();
      expect(document.activeElement).toBe(document.body);
      fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
      expect(p.onOpenFile).toHaveBeenCalledTimes(1);
    });

    it('右クリックで開いたメニューは、項目にフォーカスを移さない', async () => {
      setupOps();
      render(<Explorer {...props({ fileOps: fileOps() })} />);
      fireEvent.contextMenu(await screen.findByText('README.md'));
      expect(screen.getByRole('menu').contains(document.activeElement)).toBe(false);
    });

    it('ファイルの行では、作る・変える・捨てる・コピー・Finder を出す。フォルダそのものの行では、名前の変更・ゴミ箱・相対パスを出さない。ファイル操作が無ければ、コピーと Finder だけ', async () => {
      setupOps();
      const view = render(<Explorer {...props({ fileOps: fileOps() })} />);
      fireEvent.contextMenu(await screen.findByText('README.md'));
      expect(menuLabels()).toEqual(['新規ファイル', '新規フォルダ', '名前を変更', 'ゴミ箱に入れる', 'パスをコピー', '相対パスをコピー', 'Finder で表示']);
      expect(rowOf('README.md').classList.contains('menu-target')).toBe(true);
      fireEvent.contextMenu(rootRow());
      expect(menuLabels()).toEqual(['新規ファイル', '新規フォルダ', 'パスをコピー', 'Finder で表示']);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      view.rerender(<Explorer {...props()} />);
      fireEvent.contextMenu(screen.getByText('README.md'));
      expect(menuLabels()).toEqual(['パスをコピー', '相対パスをコピー', 'Finder で表示']);
      // メニューの上での右クリックは、ブラウザのメニューを出さず、メニューも閉じない
      expect(fireEvent.contextMenu(screen.getByRole('menu'))).toBe(false);
      expect(screen.queryByRole('menu')).not.toBeNull();
      // 外を押すと閉じる
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('パスのコピーは絶対パスと、ツリーのフォルダからの相対パス。Finder には絶対パスを渡す（追加したフォルダでも）', async () => {
      const api = setupOps();
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      render(<Explorer {...props({ folders: [LIB], fileOps: fileOps() })} />);
      fireEvent.contextMenu(await screen.findByText('README.md'));
      pick('パスをコピー');
      fireEvent.contextMenu(screen.getByText('README.md'));
      pick('相対パスをコピー');
      fireEvent.contextMenu(await screen.findByText('index.ts'));
      pick('相対パスをコピー');
      fireEvent.contextMenu(screen.getByText('index.ts'));
      pick('Finder で表示');
      fireEvent.contextMenu(rootRow());
      pick('Finder で表示');
      expect(writeText.mock.calls).toEqual([['/work/shop/README.md'], ['README.md'], ['index.ts']]);
      expect(api.argsOf('workspace.revealFile')).toEqual([
        ['A', `${LIB}/index.ts`],
        ['A', '/work/shop'],
      ]);
    });

    it('新規ファイルは、ファイルの行なら入っているフォルダの中に名前を入れる行を出す。Enter で作って開く。Esc ではやめる', async () => {
      const api = setupOps({ 'workspace.createEntry': () => Promise.resolve('src/new.ts') });
      const p = props({ fileOps: fileOps() });
      render(<Explorer {...p} />);
      fireEvent.click(await screen.findByText('src'));
      fireEvent.contextMenu(await screen.findByText('main.ts'));
      pick('新規ファイル');
      fireEvent.keyDown(input(), { key: 'Escape' });
      expect(input()).toBeNull();
      fireEvent.contextMenu(screen.getByText('main.ts'));
      pick('新規ファイル');
      expect(document.activeElement).toBe(input());
      fireEvent.change(input(), { target: { value: 'new.ts' } });
      fireEvent.keyDown(input(), { key: 'Enter' });
      await settle();
      expect(api.argsOf('workspace.createEntry')).toEqual([['A', 'src', 'new.ts', 'file']]);
      expect(p.onOpenFile).toHaveBeenCalledWith('src/new.ts');
      expect(input()).toBeNull();
      expect(api.argsOf('workspace.listDir').at(-1)).toEqual(['A', 'src']);
    });

    it('作れなかったら、理由を欄の下に出して入れ直させる。新規フォルダは開かない', async () => {
      let fail = true;
      const api = setupOps({
        'workspace.createEntry': () => (fail ? Promise.reject(new Error('同じ名前のものがすでにあります: src')) : Promise.resolve('lib')),
      });
      const p = props({ fileOps: fileOps() });
      render(<Explorer {...p} />);
      fireEvent.contextMenu(rootRow());
      pick('新規フォルダ');
      fireEvent.change(input(), { target: { value: 'src' } });
      fireEvent.keyDown(input(), { key: 'Enter' });
      await settle();
      expect(screen.getByText('同じ名前のものがすでにあります: src')).not.toBeNull();
      expect(input().getAttribute('aria-invalid')).toBe('true');
      fail = false;
      fireEvent.change(input(), { target: { value: 'lib' } });
      fireEvent.keyDown(input(), { key: 'Enter' });
      await settle();
      expect(api.argsOf('workspace.createEntry')).toEqual([
        ['A', '', 'src', 'dir'],
        ['A', '', 'lib', 'dir'],
      ]);
      expect(input()).toBeNull();
      expect(p.onOpenFile).not.toHaveBeenCalled();
    });

    it('名前の変更は、その行で名前を入れる（拡張子の前までを選ぶ）。保存の確かめ（beforeRename）が通ったら変えて、タブに知らせる', async () => {
      const api = setupOps({ 'workspace.renameEntry': () => Promise.resolve('src/app.ts') });
      const ops = fileOps();
      render(<Explorer {...props({ fileOps: ops })} />);
      fireEvent.click(await screen.findByText('src'));
      fireEvent.contextMenu(await screen.findByText('main.ts'));
      pick('名前を変更');
      expect(input().value).toBe('main.ts');
      expect([input().selectionStart, input().selectionEnd]).toEqual([0, 4]);
      // 名前を変えずに決めたら、何もしない
      fireEvent.keyDown(input(), { key: 'Enter' });
      await settle();
      expect(input()).toBeNull();
      fireEvent.contextMenu(screen.getByText('main.ts'));
      pick('名前を変更');
      fireEvent.change(input(), { target: { value: 'app.ts' } });
      fireEvent.keyDown(input(), { key: 'Enter' });
      await settle();
      expect(ops.beforeRename).toHaveBeenCalledWith('src/main.ts');
      expect(api.argsOf('workspace.renameEntry')).toEqual([['A', 'src/main.ts', 'app.ts']]);
      expect(ops.renamed).toHaveBeenCalledWith('src/main.ts', 'src/app.ts');
      expect(input()).toBeNull();
    });

    it('名前を入れている欄を押しても、フォルダを開け閉めせず、ファイルも開かない', async () => {
      setupOps();
      const p = props({ fileOps: fileOps() });
      render(<Explorer {...p} />);
      fireEvent.click(await screen.findByText('src'));
      await screen.findByText('main.ts');
      fireEvent.contextMenu(screen.getByText('src'));
      pick('名前を変更');
      fireEvent.click(input());
      expect(screen.queryByText('main.ts')).not.toBeNull();
      expect(input().value).toBe('src');
      fireEvent.keyDown(input(), { key: 'Escape' });
      fireEvent.contextMenu(screen.getByText('main.ts'));
      pick('名前を変更');
      fireEvent.click(input());
      expect(p.onOpenFile).not.toHaveBeenCalled();
      expect(input().value).toBe('main.ts');
    });

    it('保存の確かめでやめたら、名前を変えない。欄から離れたときも決める', async () => {
      const api = setupOps();
      const ops = fileOps({ beforeRename: vi.fn(async () => false) });
      render(<Explorer {...props({ fileOps: ops })} />);
      fireEvent.contextMenu(await screen.findByText('README.md'));
      pick('名前を変更');
      fireEvent.change(input(), { target: { value: 'NOTES.md' } });
      fireEvent.blur(input());
      await settle();
      expect(ops.beforeRename).toHaveBeenCalledWith('README.md');
      expect(api.argsOf('workspace.renameEntry')).toEqual([]);
      expect(ops.renamed).not.toHaveBeenCalled();
      expect(input()).toBeNull();
    });

    it('ゴミ箱に入れる前に確かめる（保存していない変更があれば、そう書く）。入れたらタブに知らせる。やめたら入れない', async () => {
      const api = setupOps();
      const messages: string[] = [];
      let answer = false;
      vi.spyOn(window, 'confirm').mockImplementation((message) => {
        messages.push(String(message));
        return answer;
      });
      const ops = fileOps({ hasUnsaved: vi.fn((path: string) => path === 'src') });
      render(<Explorer {...props({ fileOps: ops })} />);
      fireEvent.contextMenu(await screen.findByText('README.md'));
      pick('ゴミ箱に入れる');
      await settle();
      expect(api.argsOf('workspace.trashEntry')).toEqual([]);
      answer = true;
      fireEvent.contextMenu(screen.getByText('src'));
      pick('ゴミ箱に入れる');
      await settle();
      expect(messages[0]).toBe('README.md をゴミ箱に入れますか？');
      expect(messages[1]).toContain('保存していない変更のあるタブは、開いたまま残します');
      expect(api.argsOf('workspace.trashEntry')).toEqual([['A', 'src']]);
      expect(ops.trashed).toHaveBeenCalledWith('src');
    });

    // Claude が読んだもの（Claude に許可した場所ではない）は、書き換えさせない。main も、作業フォルダと追加したフォルダの中しか書き換えない
    describe('Claude が読んだもの', () => {
      const REPO = '/work/oss';
      const OUTSIDE = '/notes/memo.md';
      const readDirs: Record<string, DirEntry[]> = {
        [REPO]: [{ name: 'index.ts', path: `${REPO}/index.ts`, isDir: false }],
      };
      const setupRead = () => {
        const api = mockApi({ 'workspace.listDir': (_id: never, dir: never) => Promise.resolve(dirs[dir] ?? readDirs[dir]) });
        api.install();
        const writeText = vi.fn(async (_text: string) => undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        return { api, writeText };
      };

      it('Claude が読んだリポジトリの行は、書き換えの項目を出さない（ファイル操作を渡していても）', async () => {
        const { writeText } = setupRead();
        render(<Explorer {...props({ readFolders: [REPO], fileOps: fileOps() })} />);
        fireEvent.contextMenu(await screen.findByText('oss'));
        expect(menuLabels()).toEqual(['パスをコピー', 'Finder で表示']);
        pick('パスをコピー');
        expect(writeText.mock.calls).toEqual([[REPO]]);
        fireEvent.click(screen.getByText('oss'));
        fireEvent.contextMenu(await screen.findByText('index.ts'));
        expect(menuLabels()).toEqual(['パスをコピー', '相対パスをコピー', 'Finder で表示']);
        // セッションのフォルダの行では、これまでどおり書き換えの項目を出す
        fireEvent.contextMenu(screen.getByText('README.md'));
        expect(menuLabels()).toContain('名前を変更');
      });

      it('フォルダ外のファイルの行は、絶対パスのコピーと Finder で表示だけ', async () => {
        const { api, writeText } = setupRead();
        const p = props({ readFiles: [OUTSIDE], fileOps: fileOps() });
        render(<Explorer {...p} />);
        const row = (await screen.findByText('memo.md')).closest<HTMLElement>('.tree-row')!;
        fireEvent.contextMenu(row);
        expect(menuLabels()).toEqual(['パスをコピー', 'Finder で表示']);
        expect(row.classList.contains('menu-target')).toBe(true);
        pick('パスをコピー');
        fireEvent.contextMenu(row);
        pick('Finder で表示');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(writeText.mock.calls).toEqual([[OUTSIDE]]);
        expect(api.argsOf('workspace.revealFile')).toEqual([['A', OUTSIDE]]);
        // 右クリックでは、ファイルを開かない
        expect(p.onOpenFile).not.toHaveBeenCalled();
      });
    });
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

  // 開いたまま見ているセッションが変わることがある（通知を押して、そのセッションに移ったときなど）
  describe('開いたまま別のセッションに変わったとき', () => {
    // ファイルの一覧の返事を、セッションごとに、テストから好きなときに返す
    const held = () => {
      const lists = new Map<string, ReturnType<typeof deferred<string[]>>>();
      const api = mockApi({
        'workspace.listFiles': (id: never) => {
          const list = deferred<string[]>();
          lists.set(id, list);
          return list.promise;
        },
      });
      api.install();
      return { api, resolve: (id: string) => act(async () => lists.get(id)!.resolve(files[id])) };
    };
    const shown = (names: string[]) => names.filter((name) => items().includes(name));

    it('変えた直後（変えた先のファイルを読み終える前）は、前のセッションのファイルを出さず、押しても開かない', async () => {
      const { resolve } = held();
      const onOpen = vi.fn();
      const view = render(<QuickOpen sessionId="A" onOpen={onOpen} onClose={vi.fn()} />);
      await resolve('A');
      expect(items()).toEqual(['app.ts', 'util.ts', 'README.md']);
      view.rerender(<QuickOpen sessionId="B" onOpen={onOpen} onClose={vi.fn()} />);
      expect(shown(['app.ts', 'util.ts', 'README.md'])).toEqual([]);
      fireEvent.keyDown(box(), { key: 'Enter' });
      document.querySelectorAll<HTMLElement>('.quick-open-item').forEach((item) => fireEvent.click(item));
      expect(onOpen).not.toHaveBeenCalled();
      await resolve('B');
      expect(items()).toEqual(['guide.md', 'package.json']);
    });

    it('前のセッションのファイルの一覧が、変えた先の一覧より遅れて届いても、変えた先の候補を書き換えない', async () => {
      const { api, resolve } = held();
      const onOpen = vi.fn();
      const view = render(<QuickOpen sessionId="A" onOpen={onOpen} onClose={vi.fn()} />);
      view.rerender(<QuickOpen sessionId="B" onOpen={onOpen} onClose={vi.fn()} />);
      expect(api.argsOf('workspace.listFiles')).toEqual([['A'], ['B']]);
      await resolve('B');
      await resolve('A');
      expect(items()).toEqual(['guide.md', 'package.json']);
      fireEvent.keyDown(box(), { key: 'Enter' });
      expect(onOpen).toHaveBeenCalledWith('docs/guide.md');
    });
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
