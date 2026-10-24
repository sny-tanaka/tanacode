import { useCallback, useEffect, useState } from 'react';
import { t } from '@shared/i18n';
import type { WorktreeBackup, WorktreeCleanup } from '@shared/ipc';
import { errorMessage } from '../errorMessage';
import { removalNotes } from './worktree';

// worktree の片付け。アーカイブ済みのセッションの、残っている worktree のフォルダ（画面からのアーカイブで残した・end_session の
// remove_worktree: false・親と一緒にアーカイブした子など）を並べて、1 つずつか、まとめて消す。消し方はアーカイブのときと同じ
// （removeWorktree。未コミットの変更は控えに残し、手元にしか無いコミットのあるブランチは残し、submodule の中に失われるものがあれば断る）。
// worktree を消す前の控え（refs/tanacode/backup/*）も並べ、1 つずつ消せる（中身が失われるので、確かめてから）
type RowState = { busy: true } | { busy: false; error: string | null; notes: string[]; done: boolean };
const isDone = (state: RowState | undefined) => !!state && !state.busy && state.done;

export function WorktreeCleanupDialog({ onClose }: { onClose: () => void }) {
  // undefined: 読んでいる
  const [list, setList] = useState<WorktreeCleanup | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const busy = Object.values(rows).some((row) => row.busy);

  // 読み直すときは、控えだけを入れ替える（消した worktree の行は、結果を読めるように閉じるまで残す）
  const load = useCallback(() => {
    window.tanacode.sessions.worktreeCleanup().then(
      (value) => {
        setList((prev) => (prev ? { worktrees: prev.worktrees, backups: value.backups } : value));
        setLoadError(null);
      },
      (error: unknown) => setLoadError(errorMessage(error)),
    );
  }, []);
  useEffect(load, [load]);

  const remove = async (id: string) => {
    setRows((r) => ({ ...r, [id]: { busy: true } }));
    try {
      const removal = await window.tanacode.sessions.removeLeftWorktree(id);
      setRows((r) => ({ ...r, [id]: { busy: false, error: null, notes: removalNotes(removal), done: true } }));
    } catch (error) {
      setRows((r) => ({ ...r, [id]: { busy: false, error: errorMessage(error), notes: [], done: false } }));
    }
    // 消すときに控えを作ったかもしれない
    load();
  };
  // まとめて消すときも 1 つずつ（git を一度に動かしすぎない）。消せないものがあっても、ほかは続ける
  const removeAll = async () => {
    for (const w of left) await remove(w.id);
  };
  const deleteBackup = async (backup: WorktreeBackup) => {
    if (!window.confirm(t('sessions.worktreeCleanup.confirmDeleteBackup', { ref: backup.ref }))) return;
    try {
      await window.tanacode.sessions.deleteBackup(backup.root, backup.ref);
    } catch (error) {
      window.alert(t('sessions.worktreeCleanup.deleteBackupFailed', { error: errorMessage(error) }));
    }
    load();
  };

  const close = () => {
    if (!busy) onClose();
  };
  // まだ消していない worktree
  const left = list?.worktrees.filter((w) => !isDone(rows[w.id])) ?? [];

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="quick-open worktree-dialog worktree-cleanup"
        role="dialog"
        aria-label={t('sessions.worktreeCleanup.label')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') close();
        }}
      >
        <div className="worktree-dialog-head">
          <h2>{t('sessions.worktreeCleanup.title')}</h2>
          <p>{t('sessions.worktreeCleanup.about')}</p>
        </div>
        <div className="worktree-dialog-body">
          {loadError !== null ? (
            <p className="worktree-dialog-status warn">{t('sessions.worktreeCleanup.loadFailed', { error: loadError })}</p>
          ) : list === undefined ? (
            <p className="worktree-dialog-status">{t('sessions.worktreeCleanup.loading')}</p>
          ) : (
            <>
              <h3 className="worktree-dialog-subhead">{t('sessions.worktreeCleanup.worktrees')}</h3>
              {list.worktrees.length === 0 ? (
                <p className="worktree-dialog-status ok">{t('sessions.worktreeCleanup.noWorktrees')}</p>
              ) : (
                <ul className="worktree-cleanup-list">
                  {list.worktrees.map((w) => (
                    <WorktreeRow key={w.id} title={w.title} path={w.path} state={rows[w.id]} disabled={busy} onRemove={() => void remove(w.id)} />
                  ))}
                </ul>
              )}
              {list.worktrees.length > 0 && <p className="worktree-dialog-notes">{t('sessions.worktreeCleanup.noteRemove')}</p>}
              <h3 className="worktree-dialog-subhead">{t('sessions.worktreeCleanup.backups')}</h3>
              {list.backups.length === 0 ? (
                <p className="worktree-dialog-status">{t('sessions.worktreeCleanup.noBackups')}</p>
              ) : (
                <ul className="worktree-cleanup-list">
                  {list.backups.map((b) => (
                    <li key={`${b.root}\0${b.ref}`} className="worktree-cleanup-item">
                      <div className="worktree-cleanup-main">
                        <code className="worktree-cleanup-title">{b.ref}</code>
                        <span className="worktree-cleanup-sub">
                          {new Date(b.date).toLocaleString()} · {b.root}
                        </span>
                        {b.session && <span className="worktree-cleanup-sub">{t('sessions.worktreeCleanup.backupFor', { title: b.session.title })}</span>}
                        <span className="worktree-cleanup-sub">{t('sessions.worktreeCleanup.backupShow', { ref: b.ref })}</span>
                      </div>
                      <button className="ghost-button danger" disabled={busy} onClick={() => void deleteBackup(b)}>
                        {t('sessions.worktreeCleanup.deleteBackup')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="worktree-dialog-foot">
          <div className="spacer" />
          {left.length > 1 && (
            <button className="ghost-button danger" disabled={busy} onClick={() => void removeAll()}>
              {t('sessions.worktreeCleanup.removeAll')}
            </button>
          )}
          <button className="send-button" disabled={busy} onClick={close} autoFocus>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorktreeRow({ title, path, state, disabled, onRemove }: { title: string; path: string; state: RowState | undefined; disabled: boolean; onRemove: () => void }) {
  const done = isDone(state);
  return (
    <li className="worktree-cleanup-item">
      <div className="worktree-cleanup-main">
        <span className="worktree-cleanup-title">{title}</span>
        <code className="worktree-cleanup-sub">{path}</code>
        {state && !state.busy && state.error !== null && (
          <p className="worktree-dialog-status warn">{t('sessions.worktreeCleanup.removeFailed', { error: state.error })}</p>
        )}
        {state &&
          !state.busy &&
          state.notes.map((note) => (
            <p key={note} className="worktree-dialog-status">
              {note}
            </p>
          ))}
      </div>
      {done ? (
        <span className="worktree-dialog-status ok">{t('sessions.worktreeCleanup.removed')}</span>
      ) : (
        <button className="ghost-button danger" disabled={disabled} onClick={onRemove}>
          {state?.busy ? t('sessions.worktreeCleanup.removing') : t('sessions.worktreeCleanup.remove')}
        </button>
      )}
    </li>
  );
}
