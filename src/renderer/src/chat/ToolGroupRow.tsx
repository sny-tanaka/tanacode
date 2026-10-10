import { memo, useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import type { BashTask, TaskRef } from '@shared/task';
import { DisclosureIcon } from '../icons';
import { CheckMark } from '../layout/CheckMark';
import type { SessionLink } from '../sessions/sessionLinks';
import type { WorkflowRuns } from '../workflow/useSessionWorkflows';
import { ChatRow, sameTasks, showsSessions } from './ChatRow';
import { groupSummary, toolLine, type ToolGroup, type ToolItem } from './toolGroups';
import type { SubagentRuns } from './useSessionSubagents';

type Props = {
  group: ToolGroup;
  open: boolean;
  onToggle: (id: string) => void;
  workflows: WorkflowRuns;
  subagents: SubagentRuns;
  bashTasks: ReadonlyMap<string, BashTask>;
  onOpenFile: (absPath: string, line?: number) => void;
  onOpenTask: ((ref: TaskRef) => void) | null;
  // セッションのツールのカードで、対象のセッションの名前を出して移れるようにする（ChatRow と同じ）
  sessions?: readonly SessionLink[];
  onSelectSession?: (id: string) => void;
};

function sameGroup(a: Props, b: Props): boolean {
  return (
    a.group === b.group &&
    a.open === b.open &&
    a.onToggle === b.onToggle &&
    a.onOpenFile === b.onOpenFile &&
    a.onOpenTask === b.onOpenTask &&
    ((a.sessions === b.sessions && a.onSelectSession === b.onSelectSession) || !a.group.items.some(showsSessions)) &&
    sameTasks(a, b, a.group.tools.map((t) => t.id))
  );
}

// 終わった行を残しておく時間（CSS の tool-live-leave と合わせる）
const LEAVE_MS = 1800;

// 実行中から終わったものに変わったツール（の id）。しばらく残して、チェックを描いてから消す。
// 最初に描いた時点で終わっていたもの（会話ログの読み直しなど）は出さない。
// 終わった回の描画で行が一度でも消えると、出る動きとチェックが描き直しになるので、効果ではなく描くときに決める（TodoPanel と同じ）
function useLeaving(tools: ToolItem[]): ReadonlySet<string> {
  const wasRunning = useRef(new Set<string>());
  const finishedAt = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const now = Date.now();
  for (const t of tools) {
    if (t.status === 'running') wasRunning.current.add(t.id);
    else if (wasRunning.current.delete(t.id)) finishedAt.current.set(t.id, now);
  }
  for (const [id, at] of finishedAt.current) if (at + LEAVE_MS <= now) finishedAt.current.delete(id);
  // いちばん早く消える行に合わせて描き直す
  useEffect(() => {
    if (finishedAt.current.size === 0) return;
    const next = Math.min(...finishedAt.current.values()) + LEAVE_MS - Date.now();
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, next));
    return () => clearTimeout(timer);
  });
  return new Set(finishedAt.current.keys());
}

// 本文と本文の間のツールの呼び出しを、畳んだ 1 行（N件の操作 · 編集 5 …）で出す。
// 畳んでいる間は、実行中のツールをその下に 1 行ずつふわっと出し、終わったらチェックを描いてから消す。
// 開くと（自動では開かない）いつものカードが並ぶ
export const ToolGroupRow = memo(function ToolGroupRow({
  group,
  open,
  onToggle,
  workflows,
  subagents,
  bashTasks,
  onOpenFile,
  onOpenTask,
  sessions,
  onSelectSession,
}: Props) {
  const summary = groupSummary(group);
  const leaving = useLeaving(group.tools);
  const live = open ? [] : group.tools.filter((t) => t.status === 'running' || leaving.has(t.id));
  return (
    <div className="tool-group">
      <button className={`tool-group-head${open ? ' open' : ''}`} onClick={() => onToggle(group.id)} aria-expanded={open}>
        <DisclosureIcon open={open} />
        <span className="tool-group-count">{summary.count}</span>
        {summary.parts.map((part) => (
          <span key={part} className="tool-group-part">
            · {part}
          </span>
        ))}
        {summary.failed > 0 && <span className="tool-group-failed">· {t('chat.toolGroup.failed', { count: summary.failed })}</span>}
        {summary.duration && <span className="tool-group-meta">· {summary.duration}</span>}
      </button>
      {live.length > 0 && (
        <div className="tool-live">
          {live.map((tool) =>
            tool.status === 'running' ? (
              <div key={tool.id} className="tool-live-line">
                <span className="tool-dot running" />
                <span className="tool-live-text flow-text">{toolLine(tool)}</span>
              </div>
            ) : (
              <div key={tool.id} className="tool-live-line leaving">
                <CheckMark animate failed={tool.status === 'error'} slot={7} />
                <span className="tool-live-text">{toolLine(tool)}</span>
              </div>
            ),
          )}
        </div>
      )}
      {open && (
        <div className="tool-group-list">
          {group.items.map((item) => (
            <ChatRow
              key={`${item.kind}:${item.id}`}
              item={item}
              onRewind={null}
              workflows={workflows}
              subagents={subagents}
              bashTasks={bashTasks}
              onOpenFile={onOpenFile}
              onOpenTask={onOpenTask}
              sessions={sessions}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}, sameGroup);
