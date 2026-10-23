import { memo, useLayoutEffect } from 'react';
import type { BashTask, TaskRef } from '@shared/task';
import type { SessionLink } from '../sessions/sessionLinks';
import type { WorkflowRuns } from '../workflow/useSessionWorkflows';
import { ChatRow, PartialRow } from './ChatRow';
import { usePartial, type PartialSource } from './chatState';
import { HookGroupRow } from './HookGroupRow';
import { ToolGroupRow } from './ToolGroupRow';
import type { ChatRowItem } from './toolGroups';
import type { SubagentRuns } from './useSessionSubagents';

// 会話の行の一覧。チャット欄で打つたびに ClaudePane は描き直すが、行の一覧は、行や渡すものが変わったときだけ描き直す
// （会話が長いと、1 文字ごとに全部の行を回すことになる）
export const ChatRows = memo(function ChatRows({
  rows,
  openGroups,
  onToggleGroup,
  onRewind,
  onRunCommand,
  workflows,
  subagents,
  bashTasks,
  onOpenFile,
  sessionId,
  onOpenTask,
  sessions,
  onSelectSession,
  parentId,
}: {
  rows: ChatRowItem[];
  openGroups: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  onRewind: ((messageId: string) => void) | null;
  onRunCommand: ((command: string) => void) | undefined;
  workflows: WorkflowRuns;
  subagents: SubagentRuns;
  bashTasks: ReadonlyMap<string, BashTask>;
  onOpenFile: (absPath: string, line?: number) => void;
  sessionId: string;
  onOpenTask: (ref: TaskRef) => void;
  sessions: readonly SessionLink[];
  onSelectSession: (id: string) => void;
  parentId: string | null | undefined;
}) {
  return rows.map((row) =>
    row.kind === 'tool-group' ? (
      <ToolGroupRow
        key={row.id}
        group={row}
        open={openGroups.has(row.id)}
        onToggle={onToggleGroup}
        workflows={workflows}
        subagents={subagents}
        bashTasks={bashTasks}
        onOpenFile={onOpenFile}
        onOpenTask={onOpenTask}
        sessions={sessions}
        onSelectSession={onSelectSession}
      />
    ) : row.kind === 'hook-group' ? (
      <HookGroupRow key={row.id} group={row} open={openGroups.has(row.id)} onToggle={onToggleGroup} />
    ) : (
      <ChatRow
        key={`${row.kind}:${row.id}`}
        item={row}
        onRewind={onRewind}
        onRunCommand={onRunCommand}
        workflows={workflows}
        subagents={subagents}
        bashTasks={bashTasks}
        onOpenFile={onOpenFile}
        sessionId={sessionId}
        onOpenTask={onOpenTask}
        sessions={sessions}
        onSelectSession={onSelectSession}
        parentId={parentId}
      />
    ),
  );
});

// 書いている途中の文の行。応答中は最大 20Hz で変わるので、読み口から直接読み、この行だけを描き直す（ClaudePane も App も描き直さない）。
// onChange: 変わって描いたあと（伸びたら最下部を追いかける）
export const PartialRows = memo(function PartialRows({ source, sessionId, onChange }: { source: PartialSource; sessionId: string; onChange: () => void }) {
  const blocks = usePartial(source, sessionId);
  useLayoutEffect(() => onChange(), [blocks, onChange]);
  return blocks.map((block) => <PartialRow key={`partial:${block.id}`} block={block} />);
});
