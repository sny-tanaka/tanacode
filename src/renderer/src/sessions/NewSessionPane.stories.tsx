import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import type { SessionSummary } from '@shared/ipc';
import { mockApi } from '../../../../.storybook/mockApi';
import { NewSessionPane } from './NewSessionPane';

// 新規セッションの画面。アイコンと見出しを中央に置き、下にフォルダ・ブランチと入力欄を並べる

const noop = () => {};

const FOLDERS = ['/Users/me/work/tanacode', '/Users/me/work/cafe-menu', '/Users/me/work/old-experiment'];

const session = (id: string, title: string, cwd: string, archived = false): SessionSummary => ({
  id,
  title,
  cwd,
  archived,
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
});

// 入力欄に @ を打つと、選んだフォルダ（tanacode）のセッションが、ファイルより先に候補に出る（cafe-menu のセッションは出ない）
const SESSIONS = [
  session('3f2a9c1e-0000-4000-8000-000000000001', 'チャットの検索', '/Users/me/work/tanacode'),
  session('7b1d4e2f-0000-4000-8000-000000000002', 'ログイン画面の直し', '/Users/me/work/cafe-menu'),
  session('a9c3b5d7-0000-4000-8000-000000000003', '古い調査', '/Users/me/work/tanacode', true),
];

// width は、チャットの列の幅（アプリでは列の境目を動かして変える）
function Pane({ width }: { width: number }) {
  // 最近のフォルダ。「外す」を押すと、アプリと同じように一覧から消える
  const [folders, setFolders] = useState(FOLDERS);
  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg-panel)', ['--w-claude' as string]: `${width}px` }}>
      <NewSessionPane
        folders={folders}
        onForgetFolder={(dir) => setFolders((list) => list.filter((d) => d !== dir))}
        cwd="/Users/me/work/tanacode"
        onCwdChange={noop}
        sessions={SESSIONS}
        branch="develop"
        onOpenScm={noop}
        gitId="draft-1"
        onGitChanged={noop}
        comments={[]}
        onCommentsChange={noop}
        onShowComment={noop}
        onStart={() => Promise.resolve()}
        onCancel={noop}
      />
    </div>
  );
}

const meta = {
  title: 'セッション/新規セッション',
  component: Pane,
  parameters: { bare: true },
  args: { width: 480 },
} satisfies Meta<typeof Pane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 既定の幅: Story = {};

// チャットの列を広げたとき
export const 広い幅: Story = { args: { width: 900 } };

// 列を細くしたとき
export const 細い幅: Story = { args: { width: 340 } };

// 最近のフォルダのメニュー。行にマウスを乗せると、右端に「外す」が出る（使わなくなったフォルダを一覧から外せる）
export const 最近のフォルダを外せる: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTitle('/Users/me/work/tanacode'));
    await userEvent.hover(within(canvasElement).getByTitle('/Users/me/work/cafe-menu'));
  },
};

// ブランチの横の、最新のデフォルトブランチへ切り替えるボタン（アイコンだけ）にマウスを乗せたところ
export const 最新のデフォルトブランチへ: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByLabelText('最新のデフォルトブランチへ切り替える'));
  },
};

// 切り替えている間。アイコンが脈打ち、完了するまで送信できない
export const 切り替え中: Story = {
  beforeEach: () => {
    mockApi({ 'git.run': () => new Promise(() => {}) });
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByLabelText('最新のデフォルトブランチへ切り替える'));
  },
};

// 作業ツリーに変更が残っているなどで切り替えられなかったとき。git の理由を、ブランチの横に出す
export const 切り替えに失敗: Story = {
  beforeEach: () => {
    mockApi({ 'git.run': () => Promise.resolve('error: Your local changes would be overwritten by checkout.') });
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByLabelText('最新のデフォルトブランチへ切り替える'));
  },
};

const LITELLM = { id: 'f1', name: 'litellm', path: '/Users/me/.claude/settings-litellm.json', error: null, model: 'sonnet' };

// 設定ファイルの選択欄は、登録が 0 件でも入力欄の下に出る（「管理…」から最初の 1 件を登録する）
export const 設定ファイルが無い: Story = {
  beforeEach: () => {
    localStorage.removeItem('tanacode.newSessionOptions');
    mockApi({ 'settingsFiles.list': () => Promise.resolve([]) });
  },
};

// 登録した設定ファイルがあるとき（標準のままなので、色は付かない）
export const 設定ファイルを選べる: Story = {
  beforeEach: () => {
    localStorage.removeItem('tanacode.newSessionOptions');
    mockApi({ 'settingsFiles.list': () => Promise.resolve([LITELLM]) });
  },
};

// 前に選んだ設定ファイルが残っているとき。選択欄に色が付き、モデルの既定は設定ファイルの model になる
export const 設定ファイルを選んでいる: Story = {
  beforeEach: () => {
    localStorage.setItem('tanacode.newSessionOptions', JSON.stringify({ settingsFile: 'f1' }));
    mockApi({ 'settingsFiles.list': () => Promise.resolve([LITELLM]) });
    return () => localStorage.removeItem('tanacode.newSessionOptions');
  },
};

// 前に「worktree を使う」にチェックを入れていたとき。フォルダ・ブランチの横のチェックが入った状態で開く
export const worktreeで始める: Story = {
  beforeEach: () => {
    localStorage.setItem('tanacode.newSessionOptions', JSON.stringify({ worktree: true }));
    mockApi({ 'settingsFiles.list': () => Promise.resolve([]) });
    return () => localStorage.removeItem('tanacode.newSessionOptions');
  },
};

// 入力欄に @ を打ったところ。選んだフォルダ（tanacode）のセッションが、ファイルより先に候補に出る（アクティブなものが先）。
// 選ぶと @session:xxxxxxxx（名前）が入り、Claude はそのセッションを読める
export const セッションを候補に出す: Story = {
  beforeEach: () => {
    mockApi({ 'folders.listFiles': () => Promise.resolve(['README.md', 'src/main/session-manager.ts', 'src/renderer/src/sessions/Sidebar.tsx']) });
  },
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByRole('textbox'), '@');
  },
};
