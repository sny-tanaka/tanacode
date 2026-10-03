import { useEffect, useRef, useState } from 'react';
import type { SessionSummary, WorktreeLeftovers } from '@shared/ipc';
import { errorMessage } from '../errorMessage';

// worktree のセッションをアーカイブ・一覧から削除するときの確認。worktree を残すか消すかを選ぶ（既定は残す）。
// 消す前に、worktree に残っているもの（未コミットの変更・未追跡のファイル・プッシュしていないコミット・デフォルトブランチに
// 入っていないコミット）を並べる。action: archive はアーカイブ、remove は一覧からの削除
export function WorktreeDialog({
  session,
  action,
  onConfirm,
  onClose,
}: {
  session: SessionSummary;
  action: 'archive' | 'remove';
  // removeWorktree: worktree も消す。終わるまでダイアログは閉じない（失敗したら理由を出す）
  onConfirm: (removeWorktree: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const worktree = session.worktree!;
  // undefined: 読んでいる / null: 読めなかった
  const [leftovers, setLeftovers] = useState<WorktreeLeftovers | null | undefined>(undefined);
  const [busy, setBusy] = useState<'keep' | 'remove' | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const verb = action === 'archive' ? 'アーカイブ' : '一覧から削除';
  const title = session.title ?? '新しいセッション';

  useEffect(() => {
    let alive = true;
    window.tanacode.sessions.worktreeLeftovers(session.id).then(
      (value) => alive && setLeftovers(value),
      () => alive && setLeftovers(null),
    );
    return () => {
      alive = false;
    };
  }, [session.id]);

  const confirm = async (remove: boolean) => {
    setBusy(remove ? 'remove' : 'keep');
    try {
      await onConfirm(remove);
      onClose();
    } catch (error) {
      window.alert(`${remove ? 'worktree を削除できませんでした' : `${verb}できませんでした`}: ${errorMessage(error)}`);
      setBusy(null);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="quick-open worktree-dialog"
        ref={dialog}
        role="dialog"
        aria-label={`worktree のセッションを${verb}`}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') close();
        }}
      >
        <div className="worktree-dialog-head">
          <h2>
            「{title}」を{verb}
          </h2>
          <p>
            このセッションは worktree <code>.claude/worktrees/{worktree.name}</code>（ブランチ <code>{worktree.branch}</code>）で動いています。
            worktree を残すか、削除するかを選んでください。
          </p>
        </div>
        <div className="worktree-dialog-body">
          <LeftoverList leftovers={leftovers} />
          <ul className="worktree-dialog-notes">
            <li>
              削除しても、未コミットの変更と未追跡のファイルは <code>refs/tanacode/backup/{worktree.name}</code> に控えを残します。
            </li>
            <li>まだどこにも入っていないコミットは、ブランチごと残します。マージ済みのブランチだけ消します。</li>
            <li>gitignore されたファイル（worktree の中で書き換えた .env など）は、控えに入りません。</li>
            {action === 'archive' && <li>削除したセッションをアーカイブから戻すと、残したブランチから worktree を作り直します。</li>}
          </ul>
        </div>
        <div className="worktree-dialog-foot">
          <button className="ghost-button" disabled={!!busy} onClick={close}>
            キャンセル
          </button>
          <div className="spacer" />
          <button className="ghost-button danger" disabled={!!busy} onClick={() => void confirm(true)}>
            {busy === 'remove' ? '削除しています…' : `worktree を削除して${verb}`}
          </button>
          <button className="send-button" disabled={!!busy} onClick={() => void confirm(false)} autoFocus>
            {busy === 'keep' ? `${verb}しています…` : `worktree を残して${verb}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function LeftoverList({ leftovers }: { leftovers: WorktreeLeftovers | null | undefined }) {
  if (leftovers === undefined) return <p className="worktree-dialog-status">残っているものを調べています…</p>;
  if (leftovers === null) return <p className="worktree-dialog-status">残っているものを調べられませんでした</p>;
  if (!leftovers.exists) return <p className="worktree-dialog-status">worktree のフォルダはもうありません（ブランチの扱いは同じです）</p>;
  const rows = [
    { label: '未コミットの変更', count: leftovers.uncommitted },
    { label: '未追跡のファイル', count: leftovers.untracked },
    { label: 'プッシュしていないコミット', count: leftovers.unpushed },
    leftovers.defaultBranch && leftovers.unmerged !== null
      ? { label: `${leftovers.defaultBranch} に入っていないコミット`, count: leftovers.unmerged }
      : null,
  ].filter((row) => row !== null);
  const left = rows.filter((row) => row.count > 0);
  if (left.length === 0) return <p className="worktree-dialog-status ok">残っている変更やコミットはありません</p>;
  return (
    <ul className="worktree-leftovers">
      {left.map((row) => (
        <li key={row.label}>
          <span>{row.label}</span>
          <span className="worktree-leftover-count">{row.count} 件</span>
        </li>
      ))}
    </ul>
  );
}
