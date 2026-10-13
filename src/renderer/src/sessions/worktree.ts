import { t } from '@shared/i18n';
import type { SessionSummary, WorktreePreparing } from '@shared/ipc';

// worktree の準備の段階の文言（セッション一覧・チャット・最初の指示の待ち）
export const preparingLabel = (preparing: WorktreePreparing) => t(`sessions.preparing.${preparing}`);

// worktree のフォルダが、まだできていないときの、その段階（Claude Code が作っている・アプリが作り直している）。できていれば null。
// セッションの画面には、できる前に移る。できるまで、フォルダを読むもの（エクスプローラー・ソース管理・検索・ターミナル）は読まずに待つ
export function pendingFolder(session: Pick<SessionSummary, 'archived' | 'worktree'> | null): 'creating' | 'restoring' | null {
  const preparing = session && !session.archived ? session.worktree?.preparing : null;
  return preparing === 'creating' || preparing === 'restoring' ? preparing : null;
}
