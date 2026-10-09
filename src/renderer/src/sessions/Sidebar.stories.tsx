import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { SessionSummary } from '@shared/ipc';
import type { ScheduledMessage } from '@shared/scheduled';
import type { SessionStatus } from '../chat/chatState';
import { mockApi } from '../../../../.storybook/mockApi';
import { SESSION_COLLAPSED_KEY, SESSION_LOCK_KEY, Sidebar } from './Sidebar';

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

// 予約したメッセージ。「README の更新」は今日の 18:30 に送る予約が 2 件、「社内 API の確認」は時刻に送れなかった予約がある
const today = (hours: number, minutes: number) => new Date(new Date().setHours(hours, minutes, 0, 0)).getTime();
const scheduled = (id: string, sessionId: string, at: number, state: ScheduledMessage['state'] = 'scheduled'): ScheduledMessage => ({
  id,
  sessionId,
  text: '朝のうちに、昨日の変更のテストを流してください。',
  attachments: [],
  at,
  createdAt: BASE,
  state,
  error: null,
});
const SCHEDULED: ScheduledMessage[] = [
  scheduled('m1', 's3', today(18, 30)),
  scheduled('m2', 's3', today(18, 30) + 24 * 3_600_000),
  scheduled('m3', 's6', today(9, 0), 'missed'),
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
          scheduled={SCHEDULED}
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
      'account.get': () => Promise.resolve({ email: 'me@example.com', organization: "me@example.com's Organization", plan: 'Claude Max' }),
    }),
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

// ロックしていない: 更新したセッションが上に来る
export const ロックなし: Story = { args: { locked: false } };

// ロック中: 更新しても並びは動かない（新しく作ったものだけ先頭に入る）
export const ロック中: Story = { args: { locked: true } };

// 親子のセッション。親の Claude が start_session で起動した子は、親の下にぶら下げて出す（子同士は新しい順）。
// 親の行の右のボタンで畳む・開く。畳んでいる間は子の数を出し、子が人を待っていれば黄色、作業中なら Claude の色にする。
// 親をアーカイブ済みにした子（「古い取りまとめの残り」）と、親を一覧から削除した子（「親のいない子」）は、いちばん上の段に出す
const FAMILY: SessionSummary[] = [
  session(20, '検索機能の取りまとめ', '/Users/me/work/tanacode', { running: true }),
  session(21, 'API の実装', '/Users/me/work/tanacode/.claude/worktrees/tc-1003-a1b2', {
    parentId: 's20',
    running: true,
    worktree: { name: 'tc-1003-a1b2', branch: 'worktree-tc-1003-a1b2', root: '/Users/me/work/tanacode', preparing: null },
  }),
  session(22, '画面の実装', '/Users/me/work/tanacode/.claude/worktrees/tc-1003-c3d4', {
    parentId: 's20',
    running: true,
    attention: 'question',
    worktree: { name: 'tc-1003-c3d4', branch: 'worktree-tc-1003-c3d4', root: '/Users/me/work/tanacode', preparing: null },
  }),
  session(23, 'テストの追加', '/Users/me/work/tanacode', { parentId: 's20', unread: true }),
  session(24, 'README の更新', '/Users/me/work/tanacode'),
  session(25, '古い取りまとめの残り', '/Users/me/work/cafe-menu', { parentId: 's27' }),
  session(26, '親のいない子', '/Users/me/work/cafe-menu', { parentId: 'gone' }),
  session(27, '古い取りまとめ', '/Users/me/work/cafe-menu', { archived: true }),
  session(28, '古い取りまとめの調査', '/Users/me/work/cafe-menu', { archived: true, parentId: 's27' }),
];
const familyStatus = (id: string): SessionStatus => (id === 's20' || id === 's21' ? 'running' : 'idle');

// collapsed: 開いた時点で「検索機能の取りまとめ」の子を畳んでいるか（畳んだ状態は localStorage に保つので、開く前にそろえる）
function Family({ collapsed }: { collapsed: boolean }) {
  useState(() => {
    localStorage.removeItem(SESSION_LOCK_KEY);
    if (collapsed) localStorage.setItem(SESSION_COLLAPSED_KEY, JSON.stringify(['s20']));
    else localStorage.removeItem(SESSION_COLLAPSED_KEY);
  });
  // 畳んだ親の子を選ぶと、親が開く（チャットのリンクから子へ移ったときに見えるように）ので、畳んだ状態では親子のないものを選んでおく
  const [selectedId, setSelectedId] = useState(collapsed ? 's24' : 's21');
  return (
    <div style={{ ['--w-sessions' as string]: '248px', height: 720, display: 'flex', border: '1px solid var(--border-subtle)' }}>
      <Sidebar
        sessions={FAMILY}
        selectedId={selectedId}
        statusOf={familyStatus}
        onSelect={setSelectedId}
        onCreate={noop}
        onImport={noop}
        onArchive={noop}
        onUnarchive={noop}
        onRename={noop}
        onRemove={noop}
        scheduled={[]}
      />
    </div>
  );
}

export const 親子: StoryObj<typeof Family> = { args: { collapsed: false }, render: (args) => <Family {...args} /> };

// 畳んだ状態: 親の行に子の数（3）が出る。子の 1 つが質問への回答待ちなので黄色
export const 親子_畳んだ状態: StoryObj<typeof Family> = { args: { collapsed: true }, render: (args) => <Family {...args} /> };
