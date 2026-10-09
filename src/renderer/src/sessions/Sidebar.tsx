import { memo, useEffect, useMemo, useState } from 'react';
import type { ChecklistUnread } from '@shared/checklist';
import type { SessionSummary } from '@shared/ipc';
import { formatScheduleTime, type ScheduledMessage } from '@shared/scheduled';
import type { SettingsFile } from '@shared/settings-file';
import { inLockedOrder, sessionTree, type SessionTreeRow } from '@shared/session-order';
import type { SessionStatus } from '../chat/chatState';
import { needsAttention, scheduledOf } from '../chat/scheduled';
import { useSettingsFiles } from '../chat/settingsFiles';
import { AddIcon, ArchiveIcon, ChecklistIcon, DisclosureIcon, IconButton, LockIcon, ScheduleIcon, TrashIcon, UnarchiveIcon, UnlockIcon, WorktreeIcon } from '../icons';
import { liveChildrenOf } from './sessionTree';
import { sessionName } from './sessionLinks';
import { PREPARING_LABEL } from './worktree';
import { AccountPanel } from '../account/AccountPanel';

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

// 子セッションを畳んだ親（このマシンだけの表示設定なので localStorage に置く）。親の id を入れる。既定は開く
export const SESSION_COLLAPSED_KEY = 'tanacode.sessionCollapsed';

function loadCollapsed(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SESSION_COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

const NO_UNREAD: ChecklistUnread = {};

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
  // 時刻を指定して送信（予約）したメッセージ（すべてのセッションの分）
  scheduled: ScheduledMessage[];
  // セッションごとの、チェックリストの Claude からの未読の返信の数
  checklistUnread?: ChecklistUnread;
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
  scheduled,
  checklistUnread = NO_UNREAD,
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
  // 子セッションを畳んだ親
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(loadCollapsed);
  const toggleChildren = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // 親の下に子をぶら下げた並び（区分ごと）
  const activeRows = sessionTree(active, sessions, collapsed);
  const archivedRows = sessionTree(archived, sessions, collapsed);

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

  // 消えたセッションを、畳んだ親から外す（一覧を読み込む前は外さない）
  useEffect(() => {
    if (sessions.length === 0 || [...collapsed].every((id) => sessions.some((s) => s.id === id))) return;
    setCollapsed(new Set([...collapsed].filter((id) => sessions.some((s) => s.id === id))));
  }, [sessions, collapsed]);

  // 畳んだ親の子に移ったら（チャットのリンクから移ったときなど）、親を開いて見えるようにする
  useEffect(() => {
    const parentId = sessions.find((s) => s.id === selectedId)?.parentId;
    if (parentId && collapsed.has(parentId)) toggleChildren(parentId);
    // 選んだときだけ。選んだまま畳むことはできる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    try {
      if (collapsed.size > 0) localStorage.setItem(SESSION_COLLAPSED_KEY, JSON.stringify([...collapsed]));
      else localStorage.removeItem(SESSION_COLLAPSED_KEY);
    } catch {
      // 保存できなくても、この起動のあいだは畳める
    }
  }, [collapsed]);

  const row = ({ session: s, depth, children, parent }: SessionTreeRow) => {
    const activity = activityOf(s, statusOf(s.id));
    // 親と一緒にアーカイブされる子（アーカイブ済みの子は数えない）
    const archivedWith = s.archived ? 0 : liveChildrenOf(sessions, s.id).length;
    // 選んでいる子を畳んで隠している親（どこを見ているかが分かるよう、薄く色を付ける）
    const hidesSelected = collapsed.has(s.id) && children.some((c) => c.id === selectedId);
    return (
      <div
        key={s.id}
        className={`session-row reveal-host${depth === 1 ? ' child' : ''}${s.id === selectedId ? ' active' : ''}${hidesSelected ? ' active-within' : ''}${s.archived ? ' archived' : ''}`}
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
            <ScheduledMark messages={scheduledOf(scheduled, s.id)} />
            {/* 親の下に出せない子（親と区分が違うなど）は、親の名前を添える */}
            {depth === 0 && parent && (
              <>
                <span className="session-parent" title={`親セッション「${sessionName(parent)}」から起動した子セッション`}>
                  親: {sessionName(parent)}
                </span>
                {' · '}
              </>
            )}
            {s.worktree ? (
              <span
                className="session-worktree"
                title={`worktree ${s.worktree.name}（ブランチ ${s.worktree.branch}）で動いています\n元のフォルダ: ${s.worktree.root}`}
              >
                {/* 親の下の子は字下げで幅が狭いので、親と同じリポジトリなら元のフォルダの名前を省く（親の行に出ている） */}
                {!(depth === 1 && parent && (parent.worktree?.root ?? parent.cwd) === s.worktree.root) && s.worktree.root.split('/').pop()}
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
        {(checklistUnread[s.id] ?? 0) > 0 && (
          <span className="session-checklist-unread" data-tip={`チェックリストに Claude からの未読の返信 ${checklistUnread[s.id]} 件`}>
            <ChecklistIcon size={12} />
            {checklistUnread[s.id]}
          </span>
        )}
        {children.length > 0 && (
          <ChildrenToggle
            sessions={children}
            open={!collapsed.has(s.id)}
            statusOf={statusOf}
            onToggle={() => toggleChildren(s.id)}
          />
        )}
        <IconButton
          icon={s.archived ? UnarchiveIcon : ArchiveIcon}
          size="sm"
          reveal
          label={s.archived ? 'アクティブに戻す' : 'アーカイブ'}
          tip={archivedWith > 0 ? `アーカイブ\n子セッション ${archivedWith} 件も一緒にアーカイブします` : undefined}
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
        {activeRows.map(row)}
        {archived.length > 0 && (
          <>
            <div className="pane-heading clickable" onClick={() => setShowArchived((v) => !v)}>
              <DisclosureIcon open={showArchived} />
              アーカイブ済み（{archived.length}）
            </div>
            {showArchived && archivedRows.map(row)}
          </>
        )}
      </div>
      <AccountPanel />
    </nav>
  );
});

// 親の行の、子セッションを畳む・開くボタン。畳んでいる間は子の数を出し、子が人を待っていれば（作業中なら）その色にする
function ChildrenToggle({
  sessions,
  open,
  statusOf,
  onToggle,
}: {
  sessions: SessionSummary[];
  open: boolean;
  statusOf: (id: string) => SessionStatus;
  onToggle: () => void;
}) {
  const kinds = sessions.map((c) => activityOf(c, statusOf(c.id))?.kind);
  const waiting = kinds.filter((k) => k === 'waiting').length;
  const working = kinds.filter((k) => k === 'running' || k === 'starting' || k === 'background').length;
  const breakdown = [working > 0 && `作業中 ${working}`, waiting > 0 && `操作待ち ${waiting}`].filter(Boolean).join('・');
  const label = open ? '子セッションを畳む' : `子セッション ${sessions.length} 件を開く`;
  const tone = open ? '' : waiting > 0 ? ' waiting' : working > 0 ? ' running' : '';
  return (
    <button
      type="button"
      className={`session-children${open ? '' : ' folded'}${tone}`}
      aria-expanded={open}
      aria-label={label}
      data-tip={`子セッション ${sessions.length} 件${breakdown ? `（${breakdown}）` : ''}\nクリックで${open ? '畳む' : '開く'}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {!open && <span className="session-children-count">{sessions.length}</span>}
      <DisclosureIcon open={open} />
    </button>
  );
}

type Activity = { kind: 'waiting' | 'running' | 'background' | 'starting' | 'unread' | 'exited'; label: string };

// 一覧に出すセッションの状態。上ほど優先する（何もしていなければ null で、印も文言も出さない）
// 予約したメッセージがあれば、いちばん早い時刻（送れなかったものがあれば、そのこと）を出す
function ScheduledMark({ messages }: { messages: ScheduledMessage[] }) {
  if (messages.length === 0) return null;
  const trouble = messages.filter(needsAttention).length;
  const waiting = messages.filter((m) => !needsAttention(m));
  const others = messages.length - 1;
  const label = trouble > 0 ? '予約を送れませんでした' : `${formatScheduleTime(waiting[0]!.at)} に送信${others > 0 ? ` ほか ${others} 件` : ''}`;
  return (
    <>
      <span className={`session-scheduled${trouble > 0 ? ' trouble' : ''}`} title={`予約したメッセージ ${messages.length} 件`}>
        <ScheduleIcon size={12} />
        {label}
      </span>
      {' · '}
    </>
  );
}

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
  if (s.attention === 'browser') return { kind: 'waiting', label: 'ブラウザでの操作待ち' };
  if (s.worktree?.preparing) return { kind: 'starting', label: PREPARING_LABEL[s.worktree.preparing] };
  const background = s.backgroundTasks > 0 ? `バックグラウンド ${s.backgroundTasks}件` : null;
  if (status === 'starting') return { kind: 'starting', label: '起動中' };
  if (status === 'running') return { kind: 'running', label: background ? `作業中（${background}）` : '作業中' };
  if (background) return { kind: 'background', label: `${background}の完了待ち` };
  if (s.unread) return { kind: 'unread', label: '新しい応答' };
  if (status === 'exited') return { kind: 'exited', label: '終了' };
  return null;
}
