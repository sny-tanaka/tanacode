import type { WorktreePreparing } from '@shared/ipc';

// worktree の準備の段階の文言（セッション一覧・チャット・最初の指示の待ち）
export const PREPARING_LABEL: Record<WorktreePreparing, string> = {
  creating: 'worktree を作っています',
  restoring: 'worktree を作り直しています',
  copying: 'node_modules を複製しています',
  installing: 'npm install を実行しています',
};
