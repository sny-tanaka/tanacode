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

const MERGED_PR = { state: 'merged', number: 42, base: 'main', url: 'https://github.com/me/cafe-menu/pull/42', after: 0 } as const;

const CLEAN: WorktreeLeftovers = {
  exists: true,
  branch: 'worktree-tc-1002-k3x9',
  uncommitted: 0,
  untracked: 0,
  unpushed: 0,
  contentIn: null,
  pr: MERGED_PR,
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

// 未コミットの変更・未追跡のファイル・プッシュしていないコミットが残っていて、PR はまだマージされていない
export const 残っているものがある: Story = {
  args: { leftovers: { ...CLEAN, uncommitted: 3, untracked: 1, unpushed: 2, pr: { ...MERGED_PR, state: 'open' } } },
};

// PR はマージ済みだが、そのあとに手元でコミットを足した
export const PRのあとのコミット: Story = {
  args: { leftovers: { ...CLEAN, unpushed: 1, pr: { ...MERGED_PR, after: 1 } } },
};

// PR を使わずに、手元でデフォルトブランチにスカッシュマージした
export const 中身が入っている: Story = {
  args: { leftovers: { ...CLEAN, contentIn: 'main', pr: { state: 'none' } } },
};

// PR がマージされずに閉じられた・PR が無い・gh で調べられない
export const PRが閉じられた: Story = {
  args: { leftovers: { ...CLEAN, pr: { ...MERGED_PR, state: 'closed' } } },
};
export const PRが無い: Story = {
  args: { leftovers: { ...CLEAN, pr: { state: 'none' } } },
};
export const PRを調べられない: Story = {
  args: { leftovers: { ...CLEAN, pr: { state: 'unknown' } } },
};

// 一覧から削除するとき
export const 一覧から削除: Story = {
  args: { action: 'remove', leftovers: { ...CLEAN, untracked: 4 } },
};

// worktree のフォルダを手で消していた
export const フォルダがもう無い: Story = {
  args: { leftovers: { ...CLEAN, exists: false } },
};
