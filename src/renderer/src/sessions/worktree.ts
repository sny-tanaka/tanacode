import { t } from '@shared/i18n';
import type { WorktreePreparing } from '@shared/ipc';

// worktree の準備の段階の文言（セッション一覧・チャット・最初の指示の待ち）
export const preparingLabel = (preparing: WorktreePreparing) => t(`sessions.preparing.${preparing}`);
