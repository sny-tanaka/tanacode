import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionSummary, WorktreeLeftovers } from '@shared/ipc';
import { mockApi } from '../../../../.storybook/mockApi';
import { TooltipLayer } from '../layout/Tooltip';
import { WorktreeDialog } from './WorktreeDialog';

// worktree のセッションをアーカイブ・一覧から削除するときの確認。worktree に残っているものを並べ、残すか削除するかを選ぶ（既定は残す）

const SESSION: SessionSummary = {
  id: 's1',
  title: 'ログインの並行作業',
  cwd: '/Users/me/work/cafe-menu/.claude/worktrees/tc-1002-k3x9',
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  running: true,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: { name: 'tc-1002-k3x9', branch: 'worktree-tc-1002-k3x9', root: '/Users/me/work/cafe-menu', preparing: null },
};

const CLEAN: WorktreeLeftovers = {
  exists: true,
  branch: 'worktree-tc-1002-k3x9',
  uncommitted: 0,
  untracked: 0,
  unpushed: 0,
  unmerged: 0,
  defaultBranch: 'main',
};

// leftovers: 残っているもの（null は調べられなかった）。選ぶと 1 秒かけて終わる（削除の途中の表示を見るため）
function Dialog({ action }: { action: 'archive' | 'remove'; leftovers: WorktreeLeftovers | null }) {
  return (
    <>
      <WorktreeDialog
        session={SESSION}
        action={action}
        onConfirm={() => new Promise((resolve) => setTimeout(resolve, 1000))}
        onClose={() => {}}
      />
      <TooltipLayer />
    </>
  );
}

const meta = {
  title: 'セッション/worktree の削除の確認',
  component: Dialog,
  parameters: { bare: true },
  args: { action: 'archive', leftovers: CLEAN },
  beforeEach: ({ args }) => mockApi({ 'sessions.worktreeLeftovers': () => Promise.resolve(args.leftovers) }),
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// 何も残っていない
export const 何も残っていない: Story = {};

// 未コミットの変更・未追跡のファイル・プッシュしていないコミット・main に入っていないコミットが残っている
export const 残っているものがある: Story = {
  args: { leftovers: { ...CLEAN, uncommitted: 3, untracked: 1, unpushed: 2, unmerged: 2 } },
};

// 一覧から削除するとき
export const 一覧から削除: Story = {
  args: { action: 'remove', leftovers: { ...CLEAN, untracked: 4 } },
};

// worktree のフォルダを手で消していた
export const フォルダがもう無い: Story = {
  args: { leftovers: { ...CLEAN, exists: false } },
};
