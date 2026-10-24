import { useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import type { SessionSummary, WorktreeBranch, WorktreeLeftovers, WorktreePr } from '@shared/ipc';
import { errorMessage } from '../errorMessage';
import { tx } from '../i18n';
import { sessionName } from './sessionLinks';
import { keepReason } from './worktree';

// worktree のセッションをアーカイブ・一覧から削除するときの確認。worktree を残すか消すかを選ぶ（既定は残す）。
// 消す前に、worktree に残っているもの（未コミットの変更・未追跡のファイル・プッシュしていないコミット）と、ブランチから作った PR が
// マージ済みかを並べる。action: archive はアーカイブ、remove は一覧からの削除
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
  const title = sessionName(session);

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
      const params = { error: errorMessage(error) };
      window.alert(remove ? t('sessions.worktreeDialog.worktreeRemoveFailed', params) : t(`sessions.worktreeDialog.${action}Failed`, params));
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
        aria-label={t(`sessions.worktreeDialog.${action}Label`)}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') close();
        }}
      >
        <div className="worktree-dialog-head">
          <h2>{t(`sessions.worktreeDialog.${action}Title`, { title })}</h2>
          <p>
            {tx('sessions.worktreeDialog.about', {
              path: <code>.claude/worktrees/{worktree.name}</code>,
              branch: <code>{worktree.branch}</code>,
            })}
          </p>
        </div>
        <div className="worktree-dialog-body">
          <LeftoverList leftovers={leftovers} />
          <ul className="worktree-dialog-notes">
            <li>{tx('sessions.worktreeDialog.noteBackup', { ref: <code>refs/tanacode/backup/{worktree.name}</code> })}</li>
            <li>{t('sessions.worktreeDialog.noteBranch')}</li>
            <li>{t('sessions.worktreeDialog.noteIgnored')}</li>
            {action === 'archive' && <li>{t('sessions.worktreeDialog.noteRestore')}</li>}
          </ul>
        </div>
        <div className="worktree-dialog-foot">
          <button className="ghost-button" disabled={!!busy} onClick={close}>
            {t('common.cancel')}
          </button>
          <div className="spacer" />
          <button className="ghost-button danger" disabled={!!busy} onClick={() => void confirm(true)}>
            {busy === 'remove' ? t('sessions.worktreeDialog.removingWorktree') : t(`sessions.worktreeDialog.${action}RemoveWorktree`)}
          </button>
          <button className="send-button" disabled={!!busy} onClick={() => void confirm(false)} autoFocus>
            {busy === 'keep' ? t(`sessions.worktreeDialog.${action}Busy`) : t(`sessions.worktreeDialog.${action}KeepWorktree`)}
          </button>
        </div>
      </div>
    </div>
  );
}

function LeftoverList({ leftovers }: { leftovers: WorktreeLeftovers | null | undefined }) {
  if (leftovers === undefined) return <p className="worktree-dialog-status">{t('sessions.worktreeDialog.checking')}</p>;
  if (leftovers === null) return <p className="worktree-dialog-status">{t('sessions.worktreeDialog.checkFailed')}</p>;
  return (
    <>
      <Leftovers leftovers={leftovers} />
      {leftovers.branches.length > 0 && (
        <>
          <h3 className="worktree-dialog-subhead">{t('sessions.worktreeDialog.branches')}</h3>
          <ul className="worktree-branches">
            {leftovers.branches.map((branch) => (
              <BranchStatus key={branch.name} branch={branch} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Leftovers({ leftovers }: { leftovers: WorktreeLeftovers }) {
  if (!leftovers.exists) return <p className="worktree-dialog-status">{t('sessions.worktreeDialog.worktreeGone')}</p>;
  const rows = [
    { label: t('sessions.worktreeDialog.uncommitted'), count: leftovers.uncommitted },
    { label: t('sessions.worktreeDialog.untracked'), count: leftovers.untracked },
  ];
  const left = rows.filter((row) => row.count > 0);
  // submodule の中に失われるものがあると、削除は断られる（控えに入らないため）。調べられなければ（null）、そう出す
  const submodules =
    leftovers.submodules === null ? (
      <p className="worktree-dialog-status warn">{t('sessions.worktreeDialog.submodulesUnknown')}</p>
    ) : (
      leftovers.submodules.length > 0 && (
        <p className="worktree-dialog-status warn">
          {t('sessions.worktreeDialog.submodules', { paths: leftovers.submodules.join(', '), count: leftovers.submodules.length })}
        </p>
      )
    );
  if (left.length === 0) return submodules || <p className="worktree-dialog-status ok">{t('sessions.worktreeDialog.nothingLeft')}</p>;
  return (
    <>
      <ul className="worktree-leftovers">
        {left.map((row) => (
          <li key={row.label}>
            <span>{row.label}</span>
            <span className="worktree-leftover-count">{t('sessions.worktreeDialog.leftoverCount', { count: row.count })}</span>
          </li>
        ))}
      </ul>
      {submodules}
    </>
  );
}

// ブランチの役目（今のブランチ・起動したときのブランチ）と、消すか残すか。プッシュしていないコミットと、ブランチから作った PR も添える
function BranchStatus({ branch }: { branch: WorktreeBranch }) {
  const roles = [branch.current && t('sessions.worktreeDialog.branchCurrent'), branch.launched && t('sessions.worktreeDialog.branchLaunched')].filter(Boolean);
  const verdict = !branch.exists
    ? { text: t('sessions.worktreeDialog.branchMissing'), tone: '' }
    : branch.keep
      ? { text: t('sessions.worktreeDialog.branchWillKeep', { reason: keepReason(branch.keep) }), tone: ' warn' }
      : { text: t('sessions.worktreeDialog.branchWillDelete'), tone: ' ok' };
  return (
    <li className="worktree-branch">
      <div className="worktree-branch-head">
        <code>{branch.name}</code>
        {roles.map((role) => (
          <span key={String(role)} className="worktree-branch-role">
            {role}
          </span>
        ))}
        <span className={`worktree-branch-verdict${verdict.tone}`}>{verdict.text}</span>
      </div>
      {branch.unpushed > 0 && <p className="worktree-dialog-status warn">{t('sessions.worktreeDialog.unpushedCount', { count: branch.unpushed })}</p>}
      {/* 手元にしか無いコミットはあるが、中身はデフォルトブランチに入っている（手元でのスカッシュマージ・cherry-pick など） */}
      {branch.contentIn && <p className="worktree-dialog-status ok">{t('sessions.worktreeDialog.contentIn', { branch: branch.contentIn })}</p>}
      <PrStatus pr={branch.pr} />
    </li>
  );
}

// ブランチから作った PR がマージ済みか
function PrStatus({ pr }: { pr: WorktreePr }) {
  if (pr.state === 'unknown') return <p className="worktree-dialog-status">{t('sessions.worktreeDialog.prUnknown')}</p>;
  if (pr.state === 'none') return <p className="worktree-dialog-status">{t('sessions.worktreeDialog.prNone')}</p>;
  const name = t('sessions.worktreeDialog.prName', { number: pr.number, base: pr.base });
  if (pr.state === 'merged' && pr.after) {
    return <p className="worktree-dialog-status warn">{t('sessions.worktreeDialog.prMergedWithAfter', { name, count: pr.after })}</p>;
  }
  if (pr.state === 'merged') return <p className="worktree-dialog-status ok">{t('sessions.worktreeDialog.prMerged', { name })}</p>;
  if (pr.state === 'open') return <p className="worktree-dialog-status warn">{t('sessions.worktreeDialog.prOpen', { name })}</p>;
  return <p className="worktree-dialog-status warn">{t('sessions.worktreeDialog.prClosed', { name })}</p>;
}
