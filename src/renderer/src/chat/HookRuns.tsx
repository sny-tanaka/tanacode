import { useState } from 'react';
import type { HookRun } from '@shared/chat';
import { CheckIcon, CloseIcon, InfoCircleIcon, StopIcon } from '../icons';

const OUTCOME = {
  success: { label: '成功', Mark: CheckIcon },
  blocked: { label: '止めた', Mark: StopIcon },
  error: { label: '失敗', Mark: CloseIcon },
  context: { label: 'Claude に情報を渡した', Mark: InfoCircleIcon },
} as const;

// hooks の実行の一覧。1 件ずつ小さく並べ、クリックでコマンドと出力を開く
export function HookRuns({ runs }: { runs: HookRun[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="hook-runs" onClick={(e) => e.stopPropagation()}>
      {runs.map((run, i) => (
        <div key={i} className={`hook-run ${run.outcome}`}>
          <button className="hook-chip" onClick={() => setOpen(open === i ? null : i)} title={run.command ?? run.name}>
            <HookMark outcome={run.outcome} />
            <span className="hook-event">{run.event}</span>
            <span className="hook-command">{run.command ?? run.name}</span>
            {run.durationMs !== null && <span className="hook-time">{formatMs(run.durationMs)}</span>}
          </button>
          {open === i && <HookDetail run={run} />}
        </div>
      ))}
    </div>
  );
}

function HookMark({ outcome }: { outcome: HookRun['outcome'] }) {
  const { Mark } = OUTCOME[outcome];
  return (
    <span className="hook-mark">
      <Mark size={12} />
    </span>
  );
}

function HookDetail({ run }: { run: HookRun }) {
  const facts = [
    OUTCOME[run.outcome].label,
    run.exitCode !== null ? `終了コード ${run.exitCode}` : null,
    run.durationMs !== null ? formatMs(run.durationMs) : null,
    run.name !== run.event ? run.name : null,
  ].filter(Boolean);
  return (
    <div className="hook-detail">
      <div className="hook-facts">{facts.join(' · ')}</div>
      {run.command && <pre className="tool-pre">{run.command}</pre>}
      {run.message && (
        <>
          <div className="tool-section-label">{run.outcome === 'context' ? 'Claude に渡した内容' : '理由'}</div>
          <pre className={`tool-pre${run.outcome === 'blocked' || run.outcome === 'error' ? ' error' : ''}`}>{run.message}</pre>
        </>
      )}
      {run.stdout && (
        <>
          <div className="tool-section-label">標準出力</div>
          <pre className="tool-pre">{run.stdout}</pre>
        </>
      )}
      {run.stderr && (
        <>
          <div className="tool-section-label">標準エラー</div>
          <pre className="tool-pre error">{run.stderr}</pre>
        </>
      )}
    </div>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}秒`;
}
