import { t } from '@shared/i18n';
import type { WorktreePreparing } from '@shared/ipc';

// worktree の準備の段階の文言（セッション一覧・チャット・最初の指示の待ち）。
// 読むたびに今の言語の文言を返す（読み込み時に文言を決めない）
export const PREPARING_LABEL: Record<WorktreePreparing, string> = {
  get creating() {
    return t('sessions.preparing.creating');
  },
  get restoring() {
    return t('sessions.preparing.restoring');
  },
  get copying() {
    return t('sessions.preparing.copying');
  },
  get installing() {
    return t('sessions.preparing.installing');
  },
};
