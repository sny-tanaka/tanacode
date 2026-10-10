import { useEffect, useRef, useState } from 'react';
import type { Checklist } from '@shared/checklist';
import { t } from '@shared/i18n';
import type { SessionSummary } from '@shared/ipc';
import { canSee } from '@shared/session-tools';
import { errorMessage } from '../errorMessage';
import { sessionName } from '../sessions/sessionLinks';

// カードを別のセッションへコピーするダイアログ。選べるのは、同じフォルダ（worktree は元のフォルダ）と親子・兄弟のセッション
// （Claude がコピーできる範囲と同じ）。先に同じ名前のリストがあれば足し、無ければ作る
export function CopyDialog({
  session,
  sessions,
  list,
  cardIds,
  onClose,
}: {
  session: SessionSummary;
  sessions: SessionSummary[];
  list: Checklist;
  cardIds: string[];
  onClose: () => void;
}) {
  const targets = sessions.filter((s) => s.id !== session.id && !s.archived && canSee(session, s));
  const [to, setTo] = useState(targets[0]?.id ?? '');
  const [toList, setToList] = useState(list.name);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const cards = list.cards.filter((c) => cardIds.includes(c.id));

  // Escape で閉じるには、ダイアログの中にフォーカスが要る。コピー先を選ぶ欄があればそこへ、無ければダイアログそのものへ移す。
  // 閉じたら、開く前にいた場所に戻す
  const dialog = useRef<HTMLDivElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    (select.current ?? dialog.current)?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  const copy = async () => {
    if (!to || !toList.trim()) return;
    setBusy(true);
    try {
      await window.tanacode.checklist.copy({ fromSession: session.id, listId: list.id, cardIds, toSession: to, toList: toList.trim(), notify });
      onClose();
    } catch (error) {
      window.alert(t('checklist.copyDialog.failed', { error: errorMessage(error) }));
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="quick-open checklist-dialog"
        ref={dialog}
        role="dialog"
        aria-label={t('checklist.action.copyToSession')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape' && !busy) onClose();
        }}
      >
        <div className="worktree-dialog-head">
          <h2>{t('checklist.action.copyToSession')}</h2>
          <p>{t('checklist.copyDialog.description', { name: list.name, numbers: cards.map((c) => `#${c.number}`).join(t('checklist.copyDialog.numberSeparator')) })}</p>
        </div>
        <div className="worktree-dialog-body">
          {targets.length === 0 ? (
            <p className="worktree-dialog-status">{t('checklist.copyDialog.noTargets')}</p>
          ) : (
            <>
              <label className="checklist-field">
                <span>{t('checklist.copyDialog.toSession')}</span>
                <select ref={select} value={to} onChange={(e) => setTo(e.target.value)}>
                  {targets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {sessionName(s)}
                      {s.worktree ? t('checklist.copyDialog.worktree', { name: s.worktree.name }) : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="checklist-field">
                <span>{t('checklist.copyDialog.toList')}</span>
                <input value={toList} onChange={(e) => setToList(e.target.value)} />
              </label>
              <label className="checklist-notify">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                {t('checklist.copyDialog.notify')}
              </label>
            </>
          )}
        </div>
        <div className="worktree-dialog-foot">
          <div className="spacer" />
          <button className="ghost-button" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="send-button" disabled={busy || !to || !toList.trim()} onClick={() => void copy()}>
            {busy ? t('checklist.copyDialog.copying') : t('checklist.copyDialog.copy')}
          </button>
        </div>
      </div>
    </div>
  );
}
