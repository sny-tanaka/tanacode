import { useEffect, useState } from 'react';
import { t } from '@shared/i18n';
import { IDLE_COMPACT_STATUS, type CompactFailure, type CompactPhase, type CompactStatus, type CompactUnavailable } from '@shared/optimized-compact';
import { CloseIcon, IconButton, OptimizedCompressIcon } from '../icons';
import { Toggle } from '../layout/Toggle';

const PHASE_TEXT = {
  finalizing: 'chat.pane.compactPhase.finalizing',
  clearing: 'chat.pane.compactPhase.clearing',
  resuming: 'chat.pane.compactPhase.resuming',
  waiting: 'chat.pane.compactPhase.waiting',
} as const satisfies Record<CompactPhase, string>;

const UNAVAILABLE_TEXT = {
  'checklist-off': 'chat.pane.compactUnavailable.checklistOff',
  'no-checklist': 'chat.pane.compactUnavailable.noChecklist',
} as const satisfies Record<CompactUnavailable, string>;

const FAILURE_TEXT = {
  interrupted: 'chat.pane.compactFailure.interrupted',
  prompted: 'chat.pane.compactFailure.prompted',
  'not-used': 'chat.pane.compactFailure.notUsed',
  interleaved: 'chat.pane.compactFailure.interleaved',
  'not-cleared': 'chat.pane.compactFailure.notCleared',
  exited: 'chat.pane.compactFailure.exited',
  busy: 'chat.pane.compactFailure.busy',
  'usage-limit': 'chat.pane.compactFailure.usageLimit',
} as const satisfies Record<CompactFailure, string>;

// セッションの最適化圧縮の状態（進んでいる段階・取りやめた理由・使えない理由）。流れは main が動かすので、画面は聞いて、変わったら受け取るだけ
export function useCompactStatus(sessionId: string | null): CompactStatus {
  const [status, setStatus] = useState<CompactStatus>(IDLE_COMPACT_STATUS);
  useEffect(() => {
    setStatus(IDLE_COMPACT_STATUS);
    if (!sessionId) return;
    let alive = true;
    void window.tanacode.compact.get(sessionId).then((value) => {
      if (alive && value) setStatus(value);
    });
    const off = window.tanacode.compact.onChanged((payload) => {
      if (payload.sessionId === sessionId) setStatus(payload.status);
    });
    return () => {
      alive = false;
      off();
    };
  }, [sessionId]);
  return status;
}

// チャットのヘッダーの「最適化圧縮」。1 つの枠に、今すぐ始めるボタン（左のアイコン）と、自動で始めるかのスイッチ（右）をまとめる。
// - ボタン: 押すと、Claude が続きに要ることをチェックリストに書き、アプリが会話を消して、チェックリストから再開させる
// - スイッチ: コンテキストが設定の大きさを超えたら、最適化圧縮を自動で始めるか（セッションごと）
// 使えないとき（「MCP → チェックリスト」がオフなど）は、どちらも押せず、同じ理由を出す。
// canStart: 始められる（待機中で、確認の画面が出ていない）/ status: main から届く状態（段階・取りやめた理由・始める大きさ・使えない理由）/
// auto: このセッションで「自動」がオンか
export function CompactButton({
  canStart,
  status,
  auto,
  onStart,
  onAutoChange,
}: {
  canStart: boolean;
  status: CompactStatus;
  auto: boolean;
  onStart: () => void;
  onAutoChange: (on: boolean) => void;
}) {
  const { phase, failure, unavailable, autoPaused, autoPercent } = status;
  // 取りやめた理由は、閉じるか、次に始めるまで出しておく
  const [dismissed, setDismissed] = useState<CompactFailure | null>(null);
  useEffect(() => {
    if (!failure) setDismissed(null);
  }, [failure]);
  const tip = phase ? t(PHASE_TEXT[phase]) : unavailable ? t(UNAVAILABLE_TEXT[unavailable]) : t('chat.pane.optimizedCompactTip');
  const shownFailure = !phase && failure && failure !== dismissed ? failure : null;
  const autoOn = auto && !unavailable;

  return (
    <div className="compact-button">
      {phase === 'waiting' && (
        <span className="compact-status" role="status" data-tip={t(PHASE_TEXT.waiting)}>
          {t('chat.pane.compactWaiting')}
        </span>
      )}
      {auto && autoPaused && !phase && !shownFailure && (
        <span className="compact-status" role="status" data-tip={t('chat.pane.autoCompactPausedTip')}>
          {t('chat.pane.autoCompactPaused')}
        </span>
      )}
      {shownFailure && (
        <span className="compact-status failed" role="alert" data-tip={t(FAILURE_TEXT[shownFailure])}>
          {t('chat.pane.compactFailed')}
          <button type="button" className="compact-status-close" aria-label={t('chat.pane.compactDismiss')} onClick={() => setDismissed(shownFailure)}>
            <CloseIcon size={12} />
          </button>
        </span>
      )}
      <div className={`compact-capsule${autoOn ? ' on' : ''}`} role="group" aria-label={t('chat.pane.optimizedCompact')}>
        <IconButton size="md" icon={OptimizedCompressIcon} label={t('chat.pane.optimizedCompact')} tip={tip} busy={!!phase} disabled={!canStart || !!unavailable} onClick={onStart} />
        <Toggle
          name={t('chat.pane.autoCompactName')}
          on={autoOn}
          disabled={!!unavailable}
          title={unavailable ? t(UNAVAILABLE_TEXT[unavailable]) : t('chat.pane.autoCompactTip', { percent: autoPercent })}
          onChange={onAutoChange}
        />
      </div>
    </div>
  );
}
