// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitState } from '@shared/ipc';
import { useGitState } from '../../src/renderer/src/scm/useGitState';
import { NewSessionPane } from '../../src/renderer/src/sessions/NewSessionPane';
import './dom';
import { mockApi } from './mock-api';

// 新規セッションの画面の「最新のデフォルトブランチへ切り替える」。切り替えの途中でフォルダを変えたとき、
// 前のフォルダの「切り替え中」や結果を、変えた先のフォルダに持ち越さない。
// git の状態（useGitState）も、前のフォルダの読み直しの返事を、変えた先のフォルダの状態として入れない

// 返事を、テストから好きなときに返せる約束
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let api: ReturnType<typeof mockApi>;
// git.run の呼び出しごとの返事（フォルダの ID → 返す約束）
let runs: Map<string, ReturnType<typeof deferred<string | null>>>;
beforeEach(() => {
  runs = new Map();
  api = mockApi({
    'folders.info': () => Promise.resolve({ branch: 'feature' }),
    'git.run': (id: never) => {
      const run = deferred<string | null>();
      runs.set(id, run);
      return run.promise;
    },
  });
  api.install();
});
afterEach(cleanup);

type Props = ComponentProps<typeof NewSessionPane>;
const props = (cwd: string, overrides: Partial<Props> = {}): Props => ({
  folders: ['/work/a', '/work/b'],
  onForgetFolder: () => {},
  cwd,
  onCwdChange: () => {},
  sessions: [],
  branch: 'feature',
  onOpenScm: () => {},
  gitId: `folder:${cwd}`,
  onGitChanged: () => {},
  comments: [],
  onCommentsChange: () => {},
  onShowComment: () => {},
  onStart: () => Promise.resolve(),
  onCancel: null,
  ...overrides,
});
const button = () => screen.getByRole<HTMLButtonElement>('button', { name: '最新のデフォルトブランチへ切り替える' });
const send = () => screen.getByRole<HTMLButtonElement>('button', { name: '送信' });

describe('NewSessionPane の、最新のデフォルトブランチへの切り替え', () => {
  it('押すと切り替え中になり、返事が来たら戻る。うまくいかなければ理由を出す', async () => {
    const onGitChanged = vi.fn();
    render(<NewSessionPane {...props('/work/a', { onGitChanged })} />);
    fireEvent.click(button());
    expect(api.argsOf('git.run')).toEqual([['folder:/work/a', { kind: 'switch-default' }]]);
    expect(button().disabled).toBe(true);
    await act(async () => runs.get('folder:/work/a')!.resolve('手元の main が分かれています'));
    expect(button().disabled).toBe(false);
    expect(screen.queryByText('手元の main が分かれています')).not.toBeNull();
    expect(onGitChanged).toHaveBeenCalledTimes(1);
  });

  it('切り替えの途中でフォルダを変えると、変えた先のボタンは押せて、送信も止めない', async () => {
    const view = render(<NewSessionPane {...props('/work/a')} />);
    fireEvent.click(button());
    expect(button().disabled).toBe(true);
    view.rerender(<NewSessionPane {...props('/work/b')} />);
    expect(button().disabled).toBe(false);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '始めてください' } });
    expect(send().disabled).toBe(false);
    // 変えた先でも切り替えられる
    fireEvent.click(button());
    expect(api.argsOf('git.run').map(([id]) => id)).toEqual(['folder:/work/a', 'folder:/work/b']);
    expect(button().disabled).toBe(true);
  });

  it('前のフォルダの切り替えが終わっても、その結果は変えた先のフォルダに出さない', async () => {
    const view = render(<NewSessionPane {...props('/work/a')} />);
    fireEvent.click(button());
    view.rerender(<NewSessionPane {...props('/work/b')} />);
    fireEvent.click(button());
    await act(async () => runs.get('folder:/work/a')!.resolve('リモートから 30 秒応答が無いため、止めました（git fetch）'));
    expect(screen.queryByText(/応答が無い/)).toBeNull();
    // 変えた先の切り替えは、まだ続いている
    expect(button().disabled).toBe(true);
    await act(async () => runs.get('folder:/work/b')!.resolve(null));
    expect(button().disabled).toBe(false);
  });

  it('切り替えの途中で前のフォルダに戻ると、まだ切り替え中のまま（同じフォルダで重ねて動かさない）', async () => {
    const view = render(<NewSessionPane {...props('/work/a')} />);
    fireEvent.click(button());
    view.rerender(<NewSessionPane {...props('/work/b')} />);
    // 開き直したフォルダは ID が変わる
    view.rerender(<NewSessionPane {...props('/work/a', { gitId: 'folder:/work/a#2' })} />);
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(api.argsOf('git.run')).toHaveLength(1);
    await act(async () => runs.get('folder:/work/a')!.resolve(null));
    expect(button().disabled).toBe(false);
  });
});

describe('useGitState', () => {
  it('読み直しの返事が来るまでにビューが変わったら、前のビューの結果は入れない（失敗も「リポジトリでない」にしない）', async () => {
    const states = new Map<string, ReturnType<typeof deferred<GitState>>>();
    api = mockApi({
      'git.state': (id: never) => {
        const state = deferred<GitState>();
        states.set(id, state);
        return state.promise;
      },
    });
    api.install();
    const view = renderHook(({ id }) => useGitState(id, `/work/${id}`), { initialProps: { id: 'a' } });
    const pending = states.get('a')!;
    view.rerender({ id: 'b' });
    await act(async () => pending.resolve({ isRepo: false }));
    expect(view.result.current.state).toBeNull();
    const repo = { isRepo: true, branch: 'main' } as GitState;
    await act(async () => states.get('b')!.resolve(repo));
    expect(view.result.current.state).toEqual(repo);
  });
});
