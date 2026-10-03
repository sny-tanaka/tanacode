import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { SessionSummary } from '@shared/ipc';
import type { SessionStatus } from '../chat/chatState';
import { mockApi } from '../../../../.storybook/mockApi';
import { SESSION_LOCK_KEY, Sidebar } from './Sidebar';

// セッション一覧。ロックしていなければ、更新のあったセッションが上に来る（実際は main が最終更新の新しい順に並べて渡す）。
// ロック中は並びを動かさない。下のボタンでセッションを更新して、並びが入れ替わるか（ロック中は動かないか）を確かめる

const BASE = 1_760_000_000_000;

const session = (n: number, title: string, cwd: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id: `s${n}`,
  title,
  cwd,
  archived: false,
  createdAt: BASE,
  updatedAt: BASE - n * 60_000,
  running: false,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
  ...patch,
});

const INITIAL: SessionSummary[] = [
  session(1, 'ログイン画面の直し', '/Users/me/work/cafe-menu', { running: true }),
  session(2, 'テストの追加', '/Users/me/work/tanacode', { unread: true }),
  session(3, 'README の更新', '/Users/me/work/tanacode'),
  // Claude がアプリ内ブラウザでユーザーに操作を頼んでいる（ask_user_to_act）。質問への回答待ちなどと同じ黄色の点
  session(9, '決済画面の確認', '/Users/me/work/cafe-menu', { running: true, attention: 'browser' }),
  // 標準以外の設定ファイルを重ねて動いているセッションは、行の末尾に設定ファイルの名前が出る（登録に無ければ「（登録なし）」）
  session(4, '依存の更新', '/Users/me/work/cafe-menu', { settingsFile: 'f1' }),
  session(6, '社内 API の確認', '/Users/me/work/notes', { settingsFile: 'f0' }),
  // worktree のセッションは、元のフォルダの名前と worktree の名前が並ぶ。準備の途中は、その段階を出す
  session(7, 'ログインの並行作業', '/Users/me/work/cafe-menu/.claude/worktrees/tc-1002-k3x9', {
    worktree: { name: 'tc-1002-k3x9', branch: 'worktree-tc-1002-k3x9', root: '/Users/me/work/cafe-menu', preparing: null },
  }),
  session(8, '検索の並行作業', '/Users/me/work/cafe-menu/.claude/worktrees/tc-1002-p7mz', {
    running: true,
    worktree: { name: 'tc-1002-p7mz', branch: 'worktree-tc-1002-p7mz', root: '/Users/me/work/cafe-menu', preparing: 'installing' },
  }),
  session(5, '古い調査', '/Users/me/work/notes', { archived: true }),
];

const noop = () => {};
const statusOf = (id: string): SessionStatus => (id === 's1' ? 'running' : 'idle');

// locked: 開いた時点でロックしているか。ロックの状態は localStorage に保つので、開く前にそろえる
function Demo({ locked }: { locked: boolean }) {
  useState(() => {
    if (locked) localStorage.setItem(SESSION_LOCK_KEY, JSON.stringify(INITIAL.map((s) => s.id)));
    else localStorage.removeItem(SESSION_LOCK_KEY);
  });
  const [sessions, setSessions] = useState(INITIAL);
  const [clock, setClock] = useState(BASE);
  const [selectedId, setSelectedId] = useState('s2');

  // main の list() と同じく、更新したものの updatedAt を進めて、最終更新の新しい順に並べて渡す
  const touch = (id: string) => {
    const now = clock + 60_000;
    setClock(now);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, updatedAt: now } : s)).sort((a, b) => b.updatedAt - a.updatedAt));
  };
  const add = () => {
    const now = clock + 60_000;
    setClock(now);
    setSessions((prev) => [session(prev.length + 10, '新しいセッション', '/Users/me/work/tanacode', { updatedAt: now }), ...prev]);
  };

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
      <div style={{ ['--w-sessions' as string]: '248px', height: 520, display: 'flex', border: '1px solid var(--border-subtle)' }}>
        <Sidebar
          sessions={sessions}
          selectedId={selectedId}
          statusOf={statusOf}
          onSelect={setSelectedId}
          onCreate={noop}
          onImport={noop}
          onArchive={noop}
          onUnarchive={noop}
          onRename={noop}
          onRemove={noop}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
        {INITIAL.filter((s) => !s.archived).map((s) => (
          <button key={s.id} className="ghost-button" onClick={() => touch(s.id)}>
            「{s.title}」を更新
          </button>
        ))}
        <button className="ghost-button" onClick={add}>
          セッションを新しく作る
        </button>
      </div>
    </div>
  );
}

const meta = {
  title: 'セッション/セッション一覧',
  component: Demo,
  parameters: { width: 560, background: '--bg-panel' },
  // 「依存の更新」は登録した設定ファイル（litellm）を重ねている。「社内 API の確認」の設定ファイル（f0）は登録に無い
  beforeEach: () =>
    mockApi({
      'settingsFiles.list': () =>
        Promise.resolve([{ id: 'f1', name: 'litellm', path: '/Users/me/.claude/settings-litellm.json', error: null, model: 'sonnet' }]),
    }),
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

// ロックしていない: 更新したセッションが上に来る
export const ロックなし: Story = { args: { locked: false } };

// ロック中: 更新しても並びは動かない（新しく作ったものだけ先頭に入る）
export const ロック中: Story = { args: { locked: true } };
