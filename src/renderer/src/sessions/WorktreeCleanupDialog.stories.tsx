import type { Meta, StoryObj } from '@storybook/react-vite';
import type { WorktreeCleanup, WorktreeRemoval } from '@shared/ipc';
import { mockApi } from '../../../../.storybook/mockApi';
import { TooltipLayer } from '../layout/Tooltip';
import { WorktreeCleanupDialog } from './WorktreeCleanupDialog';

// worktree の片付け。アーカイブ済みのセッションの、残っている worktree と、worktree を消す前の控えを並べて消す

const ROOT = '/Users/me/work/cafe-menu';

const FULL: WorktreeCleanup = {
  worktrees: [
    { id: 'a', title: 'ログインの並行作業', path: `${ROOT}/.claude/worktrees/tc-1018-wkkf`, branch: 'worktree-tc-1018-wkkf' },
    { id: 'b', title: 'メニューの並び替え', path: `${ROOT}/.claude/worktrees/tc-1022-crea`, branch: 'worktree-tc-1022-crea' },
  ],
  backups: [
    {
      root: ROOT,
      ref: 'refs/tanacode/backup/tc-1015-b8nj',
      date: Date.UTC(2026, 9, 15, 3, 12),
      subject: 'tanacode: worktree tc-1015-b8nj を消す前の控え',
      strays: false,
      session: { id: 'c', title: '価格の表示を直す' },
    },
    {
      root: ROOT,
      ref: 'refs/tanacode/backup/tc-1002-k3x9-2',
      date: Date.UTC(2026, 9, 2, 8, 40),
      subject: 'tanacode: worktree tc-1002-k3x9 を消す前の控え',
      strays: true,
      session: null,
    },
  ],
};

// 消すと、1 秒かけて終わる（途中の表示を見るため）。b は手元にしか無いコミットのあるブランチを残す
const REMOVALS: Record<string, WorktreeRemoval> = {
  a: { backupRef: null, branches: [{ name: 'worktree-tc-1018-wkkf', launched: true, current: true, deleted: true, keep: null }] },
  b: {
    backupRef: 'refs/tanacode/backup/tc-1022-crea',
    branches: [
      { name: 'feat/menu-sort', launched: false, current: true, deleted: false, keep: 'localOnly' },
      { name: 'worktree-tc-1022-crea', launched: true, current: false, deleted: true, keep: null },
    ],
  },
};

function Dialog(_: { list: WorktreeCleanup }) {
  return (
    <>
      <WorktreeCleanupDialog onClose={() => {}} />
      <TooltipLayer />
    </>
  );
}

const meta = {
  title: 'セッション/worktree の片付け',
  component: Dialog,
  parameters: { bare: true },
  args: { list: FULL },
  beforeEach: ({ args }) =>
    mockApi({
      'sessions.worktreeCleanup': () => Promise.resolve(args.list),
      'sessions.removeLeftWorktree': (id) => new Promise((resolve) => setTimeout(() => resolve(REMOVALS[String(id)]), 1000)),
      'sessions.deleteBackup': () => Promise.resolve(),
    }),
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// 残っている worktree と控えがある
export const 残っているものがある: Story = {};

// 残っている worktree は無く、控えだけがある
export const 控えだけ: Story = {
  args: { list: { worktrees: [], backups: FULL.backups } },
};

// 何も無い
export const 何も無い: Story = {
  args: { list: { worktrees: [], backups: [] } },
};
