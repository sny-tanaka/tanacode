import type { Meta, StoryObj } from '@storybook/react-vite';
import { mockApi } from '../../../../.storybook/mockApi';
import { NewSessionPane } from './NewSessionPane';

// 新規セッションの画面。アイコンと見出しを中央に置き、下にフォルダ・ブランチと入力欄を並べる

const noop = () => {};

// width は、チャットの列の幅（アプリでは列の境目を動かして変える）
function Pane({ width }: { width: number }) {
  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg-panel)', ['--w-claude' as string]: `${width}px` }}>
      <NewSessionPane
        folders={['/Users/me/work/tanacode', '/Users/me/work/cafe-menu']}
        cwd="/Users/me/work/tanacode"
        onCwdChange={noop}
        branch="develop"
        onOpenScm={noop}
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
