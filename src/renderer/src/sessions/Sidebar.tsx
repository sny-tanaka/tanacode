import { memo, useState } from 'react';
import type { SessionSummary } from '@shared/ipc';
import type { SessionStatus } from '../chat/chatState';
import { UsagePanel } from '../usage/UsagePanel';

type Props = {
  sessions: SessionSummary[];
  selectedId: string | null;
  statusOf: (id: string) => SessionStatus;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onImport: () => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onRemove: (id: string) => void;
};

// App はチャットのイベントなどで頻繁に描き直されるので、props が変わったときだけ描き直す
export const Sidebar = memo(function Sidebar({
  sessions,
  selectedId,
  statusOf,
  onSelect,
  onCreate,
  onImport,
  onArchive,
  onUnarchive,
  onRename,
  onRemove,
}: Props) {
  const [showArchived, setShowArchived] = useState(false);
  // 名前を変えている行
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const active = sessions.filter((s) => !s.archived);
  const archived = sessions.filter((s) => s.archived);

  const row = (s: SessionSummary) => {
    const activity = activityOf(s, statusOf(s.id));
    return (
      <div
        key={s.id}
        className={`session-row${s.id === selectedId ? ' active' : ''}${s.archived ? ' archived' : ''}`}
        onClick={() => onSelect(s.id)}
        title={s.cwd}
      >
        <span className={`session-indicator ${activity?.kind ?? ''}`} title={activity?.label} />
        <div className="session-text">
          {renaming?.id === s.id ? (
            <input
              className="session-rename"
              autoFocus
              value={renaming.title}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
              onBlur={(e) => {
                onRename(s.id, e.currentTarget.value);
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <span
              className="session-title"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setRenaming({ id: s.id, title: s.title ?? '' });
              }}
              title="ダブルクリックで名前を変更"
            >
              {s.title ?? '新しいセッション'}
            </span>
          )}
          <span className="session-sub">
            {activity?.label && (
              <>
                <span className={`session-state ${activity.kind}`}>{activity.label}</span>
                {' · '}
              </>
            )}
            {s.cwd.split('/').pop()}
          </span>
        </div>
        <button
          className="session-action"
          onClick={(e) => {
            e.stopPropagation();
            if (s.archived) onUnarchive(s.id);
            else onArchive(s.id);
          }}
          title={s.archived ? 'アクティブに戻す' : 'アーカイブ'}
        >
          {s.archived ? '戻す' : 'アーカイブ'}
        </button>
        {s.archived && (
          <button
            className="session-action danger"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`「${s.title ?? '新しいセッション'}」を一覧から削除しますか？\n（Claude Code の会話ログは残ります）`)) onRemove(s.id);
            }}
            title="一覧から削除"
          >
            削除
          </button>
        )}
      </div>
    );
  };

  return (
    <nav className="sidebar">
      <button className="new-session-button" onClick={onCreate}>
        <span className="new-session-plus">＋</span>新規セッション
      </button>
      <button className="import-session-button" onClick={onImport}>
        既存の会話を開く…
      </button>
      <div className="session-list">
        <div className="pane-heading">アクティブ</div>
        {active.length === 0 && <div className="session-empty">セッションはありません</div>}
        {active.map(row)}
        {archived.length > 0 && (
          <>
            <div className="pane-heading clickable" onClick={() => setShowArchived((v) => !v)}>
              <span className="tree-chevron">{showArchived ? '▾' : '▸'}</span>
              アーカイブ済み（{archived.length}）
            </div>
            {showArchived && archived.map(row)}
          </>
        )}
      </div>
      <UsagePanel />
    </nav>
  );
});

type Activity = { kind: 'waiting' | 'running' | 'background' | 'starting' | 'unread' | 'exited'; label: string };

// 一覧に出すセッションの状態。上ほど優先する（何もしていなければ null で、印も文言も出さない）
function activityOf(s: SessionSummary, status: SessionStatus): Activity | null {
  if (s.attention === 'question') return { kind: 'waiting', label: '質問への回答待ち' };
  if (s.attention === 'permission') return { kind: 'waiting', label: '実行の許可待ち' };
  if (s.attention === 'other') return { kind: 'waiting', label: '操作待ち' };
  const background = s.backgroundTasks > 0 ? `バックグラウンド ${s.backgroundTasks}件` : null;
  if (status === 'starting') return { kind: 'starting', label: '起動中' };
  if (status === 'running') return { kind: 'running', label: background ? `作業中（${background}）` : '作業中' };
  if (background) return { kind: 'background', label: `${background}の完了待ち` };
  if (s.unread) return { kind: 'unread', label: '新しい応答' };
  if (status === 'exited') return { kind: 'exited', label: '終了' };
  return null;
}
