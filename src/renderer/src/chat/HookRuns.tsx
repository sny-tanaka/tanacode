import { useState } from 'react';
import type { HookRun } from '@shared/chat';
import { t } from '@shared/i18n';
import { CheckIcon, CloseIcon, InfoCircleIcon, StopIcon } from '../icons';

// 結果の印。結果の名前は outcomeLabel
const MARK = {
  success: CheckIcon,
  blocked: StopIcon,
  error: CloseIcon,
  context: InfoCircleIcon,
} as const;

const outcomeLabel = (outcome: HookRun['outcome']) => t(`chat.hookRuns.${outcome}`);

// hooks の実行の一覧。1 件ずつ小さく並べ、クリックでコマンドと出力を開く
export function HookRuns({ runs }: { runs: HookRun[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="hook-runs" onClick={(e) => e.stopPropagation()}>
      {runs.map((run, i) => (
        <div key={i} className={`hook-run ${run.outcome}`}>
          <button className="hook-chip" onClick={() => setOpen(open === i ? null : i)} title={run.command ?? run.name}>
            <HookChip run={run} />
          </button>
          {open === i && <HookDetail run={run} />}
        </div>
      ))}
    </div>
  );
}

// 1 件の見出し（結果の印・きっかけ・コマンド・かかった時間）。作業の書き出しでも使う
export function HookChip({ run }: { run: HookRun }) {
  return (
    <>
      <HookMark outcome={run.outcome} />
      <span className="hook-event">{run.event}</span>
      <span className="hook-command">{run.command ?? run.name}</span>
      {run.durationMs !== null && <span className="hook-time">{formatMs(run.durationMs)}</span>}
    </>
  );
}

function HookMark({ outcome }: { outcome: HookRun['outcome'] }) {
  const Mark = MARK[outcome];
  return (
    <span className="hook-mark">
      <Mark size={12} />
    </span>
  );
}

export function HookDetail({ run }: { run: HookRun }) {
  const facts = [
    outcomeLabel(run.outcome),
    run.exitCode !== null ? t('chat.hookRuns.exitCode', { code: run.exitCode }) : null,
    run.durationMs !== null ? formatMs(run.durationMs) : null,
    run.name !== run.event ? run.name : null,
  ].filter(Boolean);
  return (
    <div className="hook-detail">
      <div className="hook-facts">{facts.join(' · ')}</div>
      {run.command && <pre className="tool-pre">{run.command}</pre>}
      {run.message && (
        <>
          <div className="tool-section-label">{run.outcome === 'context' ? t('chat.hookRuns.contextSent') : t('chat.hookRuns.reason')}</div>
          <pre className={`tool-pre${run.outcome === 'blocked' || run.outcome === 'error' ? ' error' : ''}`}>{run.message}</pre>
        </>
      )}
      {run.stdout && (
        <>
          <div className="tool-section-label">{t('chat.hookRuns.stdout')}</div>
          <pre className="tool-pre">{run.stdout}</pre>
        </>
      )}
      {run.stderr && (
        <>
          <div className="tool-section-label">{t('chat.hookRuns.stderr')}</div>
          <pre className="tool-pre error">{run.stderr}</pre>
        </>
      )}
    </div>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : t('chat.duration.seconds', { count: (ms / 1000).toFixed(1) });
}
