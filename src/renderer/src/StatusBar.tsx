import type { PullRequestLink } from '@shared/chat';
import { t, type MessageKey } from '@shared/i18n';
import type { SessionWorktree } from '@shared/ipc';
import { WorktreeIcon } from './icons';
import type { SessionStatus } from './chat/chatState';
import { SystemStats } from './system/SystemStats';
import { ClaudeVersion } from './system/ClaudeVersion';
import { useCursor } from './editor/cursorStore';

// 点の色は global.css のトークン（くすませずそのまま使う）。warning は人の対応が必要な状態だけに使う。label は文言のキー
const STATUS: Record<SessionStatus, { label: MessageKey; color: string }> = {
  'not-started': { label: 'app.status.notStarted', color: 'var(--text-tertiary)' },
  starting: { label: 'app.status.starting', color: 'var(--blue)' },
  idle: { label: 'app.status.idle', color: 'var(--ok)' },
  running: { label: 'app.status.running', color: 'var(--claude)' },
  // 正常な終了はエラーではない。異常終了（終了コードが 0 以外）だけ danger
  exited: { label: 'app.status.exited', color: 'var(--text-tertiary)' },
};

type Props = {
  status: SessionStatus;
  exitCode: number | null;
  branch: string | null;
  // worktree のセッションなら、その worktree（ブランチ名に印を付ける）
  worktree?: SessionWorktree | null;
  // ブランチ名を押したとき（ソース管理を開く）
  onOpenScm: () => void;
  // このセッションの PR
  pr: PullRequestLink | null;
  // エディタのカーソル位置を出す（テキストのファイルを開いているとき）
  showCursor: boolean;
  language: string | null;
  // 入っている Claude Code のバージョン（undefined はまだ確かめていない、null は見つからない）
  claudeVersion: string | null | undefined;
};

// カーソル位置は 1 キーごとに変わるので、ここだけで読む
function CursorPosition() {
  const cursor = useCursor();
  return cursor && <span>Ln {cursor.line}, Col {cursor.column}</span>;
}

export function StatusBar({
  status,
  exitCode,
  branch,
  worktree = null,
  onOpenScm,
  pr,
  showCursor,
  language,
  claudeVersion,
}: Props) {
  const s = STATUS[status];
  const failed = status === 'exited' && exitCode !== null && exitCode !== 0;
  // 起動中・作業中は、ぐるぐると流れる文字にする
  const busy = status === 'running' || status === 'starting';
  return (
    <footer className="statusbar">
      <div className="status-item">
        <span className={`status-dot${busy ? ' running' : ''}`} style={busy ? undefined : { background: failed ? 'var(--danger)' : s.color }} />
        <span className={busy ? 'flow-text' : undefined}>{failed ? t('app.status.exitedWithCode', { code: exitCode }) : t(s.label)}</span>
      </div>
      <ClaudeVersion version={claudeVersion} />
      {branch && (
        <button
          className={`status-button${worktree ? ' with-icon' : ''}`}
          onClick={onOpenScm}
          data-tip={worktree ? `${t('app.status.worktree', { name: worktree.name, root: worktree.root })}\n${t('app.status.openScm')}` : t('app.status.openScm')}
        >
          {worktree && <WorktreeIcon size={12} />}
          {branch}
        </button>
      )}
      {pr && (
        <a className="status-link" href={pr.url} onClick={(e) => (e.preventDefault(), window.open(pr.url))} title={t('app.status.openPr', { repository: pr.repository, url: pr.url })}>
          PR #{pr.number}
        </a>
      )}
      <div className="spacer" />
      <SystemStats />
      {showCursor && <CursorPosition />}
      {language && <span>{language}</span>}
      {language && <span>UTF-8</span>}
    </footer>
  );
}
