import { useState } from 'react';
import type { Checklist } from '@shared/checklist';
import type { SessionSummary } from '@shared/ipc';
import { canSee } from '@shared/session-tools';
import { errorMessage } from '../errorMessage';

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

  const copy = async () => {
    if (!to || !toList.trim()) return;
    setBusy(true);
    try {
      await window.tanacode.checklist.copy({ fromSession: session.id, listId: list.id, cardIds, toSession: to, toList: toList.trim(), notify });
      onClose();
    } catch (error) {
      window.alert(`コピーできませんでした: ${errorMessage(error)}`);
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="quick-open checklist-dialog"
        role="dialog"
        aria-label="別のセッションへコピー"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape' && !busy) onClose();
        }}
      >
        <div className="worktree-dialog-head">
          <h2>別のセッションへコピー</h2>
          <p>
            「{list.name}」の {cards.map((c) => `#${c.number}`).join('・')} を、タイトル・説明文・チェック・スレッドごとコピーします。元のカードは残ります。
          </p>
        </div>
        <div className="worktree-dialog-body">
          {targets.length === 0 ? (
            <p className="worktree-dialog-status">コピーできるセッションがありません（同じフォルダのセッションと、親子・兄弟のセッションに限ります）</p>
          ) : (
            <>
              <label className="checklist-field">
                <span>コピー先のセッション</span>
                <select value={to} onChange={(e) => setTo(e.target.value)} autoFocus>
                  {targets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title ?? '新しいセッション'}
                      {s.worktree ? `（${s.worktree.name}）` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="checklist-field">
                <span>コピー先のリスト（同じ名前のリストが無ければ作ります）</span>
                <input value={toList} onChange={(e) => setToList(e.target.value)} />
              </label>
              <label className="checklist-notify">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                コピー先の Claude に知らせる
              </label>
            </>
          )}
        </div>
        <div className="worktree-dialog-foot">
          <div className="spacer" />
          <button className="ghost-button" disabled={busy} onClick={onClose}>
            キャンセル
          </button>
          <button className="send-button" disabled={busy || !to || !toList.trim()} onClick={() => void copy()}>
            {busy ? 'コピーしています…' : 'コピー'}
          </button>
        </div>
      </div>
    </div>
  );
}
