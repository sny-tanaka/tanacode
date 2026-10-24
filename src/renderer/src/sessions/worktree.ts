import { t } from '@shared/i18n';
import type { SessionSummary, WorktreeBranchKeep, WorktreePreparing, WorktreeRemoval } from '@shared/ipc';

// worktree の準備の段階の文言（セッション一覧・チャット・最初の指示の待ち）
export const preparingLabel = (preparing: WorktreePreparing) => t(`sessions.preparing.${preparing}`);

// worktree のフォルダが、まだできていないときの、その段階（Claude Code が作っている・アプリが作り直している）。できていれば null。
// セッションの画面には、できる前に移る。できるまで、フォルダを読むもの（エクスプローラー・ソース管理・検索・ターミナル）は読まずに待つ
export function pendingFolder(session: Pick<SessionSummary, 'archived' | 'worktree'> | null): 'creating' | 'restoring' | null {
  const preparing = session && !session.archived ? session.worktree?.preparing : null;
  return preparing === 'creating' || preparing === 'restoring' ? preparing : null;
}

// worktree を消したあとに知らせること（控えと、残したブランチ）。消したブランチは、ほかに知らせることがあるときだけ添える。無ければ空
export function removalNotes(removal: WorktreeRemoval | null): string[] {
  if (!removal) return [];
  const kept = removal.branches.filter((b) => !b.deleted);
  if (!removal.backupRef && kept.length === 0) return [];
  const deleted = removal.branches.filter((b) => b.deleted).map((b) => b.name);
  return [
    ...(removal.backupRef ? [t('app.session.backupKept', { ref: removal.backupRef })] : []),
    ...kept.map((b) => t('app.session.branchKept', { branch: b.name, reason: keepReason(b.keep) })),
    ...(deleted.length > 0 ? [t('app.session.branchesDeleted', { branches: deleted.join(', ') })] : []),
  ];
}

// ブランチを残す理由（null は、消そうとして失敗した）
export const keepReason = (keep: WorktreeBranchKeep | null) => t(`sessions.worktreeDialog.keep.${keep ?? 'failed'}`);
