import { memo } from 'react';
import { HookRuns } from './HookRuns';
import { hookSummary, type HookGroup } from './toolGroups';

type Props = { group: HookGroup; open: boolean; onToggle: (id: string) => void };

// ツールに付かない hooks を、畳んだ 1 行で出す。開くと（自動では開かない）1 件ずつの一覧が出る
export const HookGroupRow = memo(function HookGroupRow({ group, open, onToggle }: Props) {
  const summary = hookSummary(group);
  return (
    <div className="tool-group">
      <button className={`tool-group-head${open ? ' open' : ''}`} onClick={() => onToggle(group.id)} aria-expanded={open}>
        <span className="tool-group-chevron">▸</span>
        <span className="tool-group-count">{summary.count}</span>
        {summary.events.map((event) => (
          <span key={event} className="tool-group-part">
            · {event}
          </span>
        ))}
        {summary.blocked > 0 && <span className="tool-group-failed">· 止めた {summary.blocked}</span>}
        {summary.failed > 0 && <span className="tool-group-failed">· 失敗 {summary.failed}</span>}
        {summary.duration && <span className="tool-group-meta">· {summary.duration}</span>}
      </button>
      {open && (
        <div className="tool-group-list">
          <HookRuns runs={group.runs} />
        </div>
      )}
    </div>
  );
});
