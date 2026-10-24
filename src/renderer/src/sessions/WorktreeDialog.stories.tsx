import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionSummary, WorktreeBranch, WorktreeLeftovers } from '@shared/ipc';
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
  state: null,
  mode: null,
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

// 起動したときのブランチ（worktree-<名前>。今のブランチでもある）
const LAUNCHED: WorktreeBranch = {
  name: 'worktree-tc-1002-k3x9',
  launched: true,
  current: true,
  exists: true,
  unpushed: 0,
  contentIn: null,
  pr: MERGED_PR,
  keep: null,
};

const CLEAN: WorktreeLeftovers = {
  exists: true,
  uncommitted: 0,
  untracked: 0,
  submodules: [],
  branches: [LAUNCHED],
};

// 起動したときのブランチの状態を変えたもの
const launched = (patch: Partial<WorktreeBranch>, leftovers: Partial<WorktreeLeftovers> = {}): WorktreeLeftovers => ({
  ...CLEAN,
  ...leftovers,
  branches: [{ ...LAUNCHED, ...patch }],
});

// 子が worktree の中で git switch -c で作ったブランチ（今のブランチ）と、起動したときのブランチ
const created = (patch: Partial<WorktreeBranch>): WorktreeLeftovers => ({
  ...CLEAN,
  branches: [
    { ...LAUNCHED, name: 'fix/login-redirect', launched: false, ...patch },
    { ...LAUNCHED, current: false, pr: { state: 'none' } },
  ],
});

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
  args: { leftovers: launched({ unpushed: 2, keep: 'localOnly', pr: { ...MERGED_PR, state: 'open' } }, { uncommitted: 3, untracked: 1 }) },
};

// 子が git switch -c で作ったブランチの PR がマージ済み。どちらのブランチも消す
export const 作ったブランチのPRがマージ済み: Story = {
  args: { leftovers: created({}) },
};

// 子が作ったブランチに、PR に入っていないコミットがある。そのブランチは残し、起動したときのブランチは消す
export const 作ったブランチを残す: Story = {
  args: { leftovers: created({ unpushed: 1, keep: 'localOnly', pr: { ...MERGED_PR, after: 1 } }) },
};

// worktree で main に切り替えていた（幹のブランチは消さない）
export const 幹のブランチに切り替えた: Story = {
  args: { leftovers: created({ name: 'main', keep: 'trunk', pr: { state: 'none' } }) },
};

// submodule の中に、削除すると失われるもの（未コミットの変更・stash・プッシュしていないコミットなど）がある
export const submoduleの中に変更: Story = {
  args: { leftovers: { ...CLEAN, uncommitted: 1, submodules: ['lib', 'lib/nested'] } },
};

// submodule の中の stash だけが残っている（元のフォルダ側の数には出ない）
export const submoduleのstashだけ: Story = {
  args: { leftovers: { ...CLEAN, submodules: ['lib'] } },
};

// submodule の中を調べられなかった
export const submoduleを調べられない: Story = {
  args: { leftovers: { ...CLEAN, submodules: null } },
};

// PR はマージ済みだが、そのあとに手元でコミットを足した
export const PRのあとのコミット: Story = {
  args: { leftovers: launched({ unpushed: 1, keep: 'localOnly', pr: { ...MERGED_PR, after: 1 } }) },
};

// PR を使わずに、手元でデフォルトブランチにスカッシュマージした
export const 中身が入っている: Story = {
  args: { leftovers: launched({ contentIn: 'main', pr: { state: 'none' } }) },
};

// PR がマージされずに閉じられた・PR が無い・gh で調べられない
export const PRが閉じられた: Story = {
  args: { leftovers: launched({ pr: { ...MERGED_PR, state: 'closed' } }) },
};
export const PRが無い: Story = {
  args: { leftovers: launched({ pr: { state: 'none' } }) },
};
export const PRを調べられない: Story = {
  args: { leftovers: launched({ pr: { state: 'unknown' } }) },
};

// worktree のフォルダはもう無い（ブランチは手元に無い）
export const フォルダもブランチも無い: Story = {
  args: { leftovers: launched({ current: false, exists: false, pr: { state: 'none' } }, { exists: false }) },
};

// 一覧から削除するとき
export const 一覧から削除: Story = {
  args: { action: 'remove', leftovers: { ...CLEAN, untracked: 4 } },
};
