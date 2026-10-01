import type { PullRequestLink } from '@shared/chat';
import type { SessionStatus } from './chat/chatState';
import { SystemStats } from './system/SystemStats';
import { ClaudeVersion } from './system/ClaudeVersion';
import { useCursor } from './editor/cursorStore';

// 点の色は global.css のトークン（くすませずそのまま使う）。warning は人の対応が必要な状態だけに使う
const STATUS = {
  'not-started': { label: 'Claude Code 未起動', color: 'var(--text-tertiary)' },
  starting: { label: 'Claude Code 起動中', color: 'var(--blue)' },
  idle: { label: 'Claude Code 待機中', color: 'var(--ok)' },
  running: { label: 'Claude Code 作業中', color: 'var(--claude)' },
  // 正常な終了はエラーではない。異常終了（終了コードが 0 以外）だけ danger
  exited: { label: 'Claude Code 終了', color: 'var(--text-tertiary)' },
} as const;

type Props = {
  previewOpen: boolean;
  onTogglePreview: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  status: SessionStatus;
  exitCode: number | null;
  branch: string | null;
  // ブランチ名を押したとき（ソース管理を開く）
  onOpenScm: () => void;
  // このセッションの PR
  pr: PullRequestLink | null;
  // エディタのカーソル位置を出す（テキストのファイルを開いているとき）
  showCursor: boolean;
  language: string | null;
  // 入っている Claude Code の版（undefined はまだ確かめていない、null は見つからない）
  claudeVersion: string | null | undefined;
};

// 「ブラウザ」ボタンの印。ブラウザを開くボタンだと一目で分かるようにする
function GlobeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13" />
      <path d="M8 1.5c1.9 1.8 2.9 4 2.9 6.5S9.9 12.7 8 14.5C6.1 12.7 5.1 10.5 5.1 8S6.1 3.3 8 1.5Z" />
    </svg>
  );
}

// カーソル位置は 1 キーごとに変わるので、ここだけで読む
function CursorPosition() {
  const cursor = useCursor();
  return cursor && <span>Ln {cursor.line}, Col {cursor.column}</span>;
}

export function StatusBar({
  previewOpen,
  onTogglePreview,
  terminalOpen,
  onToggleTerminal,
  status,
  exitCode,
  branch,
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
        <span className={busy ? 'flow-text' : undefined}>{failed ? `${s.label}（code ${exitCode}）` : s.label}</span>
      </div>
      <ClaudeVersion version={claudeVersion} />
      {branch && (
        <button className="status-button" onClick={onOpenScm} data-tip="ソース管理を開く">
          {branch}
        </button>
      )}
      {pr && (
        <a className="status-link" href={pr.url} onClick={(e) => (e.preventDefault(), window.open(pr.url))} title={`${pr.repository} のプルリクエストを開く\n${pr.url}`}>
          PR #{pr.number}
        </a>
      )}
      <div className="spacer" />
      <button
        className={`status-button with-icon${previewOpen ? ' on' : ''}`}
        onClick={onTogglePreview}
        data-tip={'アプリ内のブラウザを開く・閉じる\n開発中のページを開いて、要素を選んで Claude に直してもらえます'}
        data-tip-side="top"
      >
        <GlobeIcon />
        ブラウザ
      </button>
      <button className={`status-button${terminalOpen ? ' on' : ''}`} onClick={onToggleTerminal} data-tip="ターミナルを開く・閉じる（⌃`）" data-tip-side="top">
        ターミナル
      </button>
      <SystemStats />
      {showCursor && <CursorPosition />}
      {language && <span>{language}</span>}
      {language && <span>UTF-8</span>}
    </footer>
  );
}
