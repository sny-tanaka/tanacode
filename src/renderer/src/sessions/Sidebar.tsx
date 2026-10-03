import { memo, useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '@shared/ipc';
import type { SettingsFile } from '@shared/settings-file';
import { inLockedOrder } from '@shared/session-order';
import type { SessionStatus } from '../chat/chatState';
import { useSettingsFiles } from '../chat/settingsFiles';
import { AddIcon, ArchiveIcon, DisclosureIcon, IconButton, LockIcon, TrashIcon, UnarchiveIcon, UnlockIcon, WorktreeIcon } from '../icons';
import { PREPARING_LABEL } from './worktree';
import { UsagePanel } from '../usage/UsagePanel';

// 並びのロック（このマシンだけの表示設定なので localStorage に置く）。ロック中は、ロックした時点の id の並びを入れる
export const SESSION_LOCK_KEY = 'tanacode.sessionOrderLock';

function loadLock(): string[] | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SESSION_LOCK_KEY) ?? 'null');
    return Array.isArray(saved) && saved.every((id) => typeof id === 'string') ? saved : null;
  } catch {
    return null;
  }
}

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
  const settingsFiles = useSettingsFiles();
  // 名前を変えている行
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // ロック中の並び（null はロックしていない。そのときは、受け取った最終更新の新しい順のまま出す）
  const [lock, setLock] = useState<string[] | null>(loadLock);
  const ordered = useMemo(() => (lock ? inLockedOrder(sessions, lock) : sessions), [sessions, lock]);
  const active = ordered.filter((s) => !s.archived);
  const archived = ordered.filter((s) => s.archived);

  // ロックしたあとにできたセッションを並びに加え（先頭）、消えたセッションを外す。
  // 一覧を読み込む前（空）は外さない（保存した並びを失わないため）
  useEffect(() => {
    if (!lock || sessions.length === 0) return;
    const next = inLockedOrder(sessions, lock).map((s) => s.id);
    if (next.length !== lock.length || next.some((id, i) => id !== lock[i])) setLock(next);
  }, [sessions, lock]);

  useEffect(() => {
    try {
      if (lock) localStorage.setItem(SESSION_LOCK_KEY, JSON.stringify(lock));
      else localStorage.removeItem(SESSION_LOCK_KEY);
    } catch {
      // 保存できなくても、この起動のあいだはロックできる
    }
  }, [lock]);

  const row = (s: SessionSummary) => {
    const activity = activityOf(s, statusOf(s.id));
    return (
      <div
        key={s.id}
        className={`session-row reveal-host${s.id === selectedId ? ' active' : ''}${s.archived ? ' archived' : ''}`}
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
            {s.worktree ? (
              <span
                className="session-worktree"
                title={`worktree ${s.worktree.name}（ブランチ ${s.worktree.branch}）で動いています\n元のフォルダ: ${s.worktree.root}`}
              >
                {s.worktree.root.split('/').pop()}
                <WorktreeIcon size={12} />
                {s.worktree.name}
              </span>
            ) : (
              s.cwd.split('/').pop()
            )}
            {s.settingsFile && (
              <>
                {' · '}
                <SettingsFileName id={s.settingsFile} files={settingsFiles} />
              </>
            )}
          </span>
        </div>
        <IconButton
          icon={s.archived ? UnarchiveIcon : ArchiveIcon}
          size="sm"
          reveal
          label={s.archived ? 'アクティブに戻す' : 'アーカイブ'}
          onClick={(e) => {
            e.stopPropagation();
            if (s.archived) onUnarchive(s.id);
            else onArchive(s.id);
          }}
        />
        {s.archived && (
          <IconButton
            icon={TrashIcon}
            size="sm"
            reveal
            danger
            label="一覧から削除"
            onClick={(e) => {
              e.stopPropagation();
              // worktree のセッションは、worktree をどうするかを App のダイアログで聞く
              if (s.worktree || window.confirm(`「${s.title ?? '新しいセッション'}」を一覧から削除しますか？\n（Claude Code の会話ログは残ります）`)) onRemove(s.id);
            }}
          />
        )}
      </div>
    );
  };

  return (
    <nav className="sidebar">
      <button className="new-session-button" onClick={onCreate}>
        <span className="new-session-plus">
          <AddIcon size={14} />
        </span>
        新規セッション
      </button>
      <button className="import-session-button" onClick={onImport}>
        既存の会話を開く…
      </button>
      <div className="session-list">
        <div className="pane-heading session-heading">
          アクティブ
          <IconButton
            icon={lock ? LockIcon : UnlockIcon}
            size="sm"
            className="session-lock"
            pressed={!!lock}
            label="並びをロック"
            tip={
              lock
                ? '並びをロック中\nクリックで解除すると、最終更新の新しい順に戻ります'
                : '並びをロック\nロックすると、更新があっても並びが入れ替わりません'
            }
            onClick={() => setLock(lock ? null : sessions.map((s) => s.id))}
          />
        </div>
        {active.length === 0 && <div className="session-empty">セッションはありません</div>}
        {active.map(row)}
        {archived.length > 0 && (
          <>
            <div className="pane-heading clickable" onClick={() => setShowArchived((v) => !v)}>
              <DisclosureIcon open={showArchived} />
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
// 行の末尾に出す、セッションが重ねている設定ファイルの名前。登録から外されていたら「（登録なし）」
function SettingsFileName({ id, files }: { id: string; files: SettingsFile[] }) {
  const file = files.find((f) => f.id === id);
  return (
    <span
      className="session-settings-file"
      title={file ? `設定ファイル「${file.name}」を重ねています（${file.path}）` : '重ねている設定ファイルが、登録にありません'}
    >
      {file?.name ?? '（登録なし）'}
    </span>
  );
}

function activityOf(s: SessionSummary, status: SessionStatus): Activity | null {
  if (s.attention === 'question') return { kind: 'waiting', label: '質問への回答待ち' };
  if (s.attention === 'permission') return { kind: 'waiting', label: '実行の許可待ち' };
  if (s.attention === 'other') return { kind: 'waiting', label: '操作待ち' };
  if (s.worktree?.preparing) return { kind: 'starting', label: PREPARING_LABEL[s.worktree.preparing] };
  const background = s.backgroundTasks > 0 ? `バックグラウンド ${s.backgroundTasks}件` : null;
  if (status === 'starting') return { kind: 'starting', label: '起動中' };
  if (status === 'running') return { kind: 'running', label: background ? `作業中（${background}）` : '作業中' };
  if (background) return { kind: 'background', label: `${background}の完了待ち` };
  if (s.unread) return { kind: 'unread', label: '新しい応答' };
  if (status === 'exited') return { kind: 'exited', label: '終了' };
  return null;
}
