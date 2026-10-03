import type { SessionSummary } from '@shared/ipc';
import type { SessionStatus } from '../chat/chatState';

// 一覧の並び（子を親の直後に出す）は shared/session-order.ts の sessionTree

// Claude Code が動いていて、手が離せない状態か（作業中・操作待ち・バックグラウンドの完了待ち・起動中）。
// 子セッションを親と一緒にアーカイブするとき、確かめるかどうかに使う
export function isWorking(s: SessionSummary, status: SessionStatus): boolean {
  // worktree の準備の途中は、まだ Claude Code が動いていなくても起動中
  if (s.worktree?.preparing) return true;
  if (!s.running) return false;
  return status === 'running' || status === 'starting' || s.attention !== null || s.backgroundTasks > 0;
}

// アーカイブしていない子セッション
export function liveChildrenOf(sessions: SessionSummary[], id: string): SessionSummary[] {
  return sessions.filter((s) => s.parentId === id && !s.archived);
}
