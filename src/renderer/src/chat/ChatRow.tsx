import { memo } from 'react';
import type { BashTask, TaskRef } from '@shared/task';
import type { WorkflowRuns } from '../workflow/useSessionWorkflows';
import { WorkflowCard } from '../workflow/WorkflowCard';
import { HookRuns } from './HookRuns';
import { ChatImages } from './ChatImages';
import { Markdown } from './Markdown';
import { SentFilesCard } from './SentFilesCard';
import { ToolCard } from './ToolCard';
import type { ChatItem } from './chatState';
import type { SubagentRuns } from './useSessionSubagents';

type Props = {
  item: ChatItem;
  workflows: WorkflowRuns;
  subagents: SubagentRuns;
  bashTasks: ReadonlyMap<string, BashTask>;
  onRewind: ((text: string) => void) | null;
  onOpenFile: (absPath: string, line?: number) => void;
  // サブエージェント・ワークフロー・バックグラウンドの Bash の中身を開く。null なら開けない（タスクの中身の表示の中など）
  onOpenTask: ((ref: TaskRef) => void) | null;
  // 本文のシェルのコードブロックを、ターミナルで実行する。無ければ実行ボタンを出さない
  onRunCommand?: (command: string) => void;
};

// タスクの一覧（Map）は、どれかのタスクが動くたびに新しくなる。行に関係するのは、そのツールのタスクだけなので、それだけを比べる
// （一覧の中の変わっていないタスクは、stableRuns で前と同じオブジェクトになっている）
export function sameTasks(a: TaskMaps, b: TaskMaps, ids: string[]): boolean {
  if (a.workflows === b.workflows && a.subagents === b.subagents && a.bashTasks === b.bashTasks) return true;
  return ids.every((id) => a.workflows.get(id) === b.workflows.get(id) && a.subagents.get(id) === b.subagents.get(id) && a.bashTasks.get(id) === b.bashTasks.get(id));
}

export type TaskMaps = Pick<Props, 'workflows' | 'subagents' | 'bashTasks'>;

function sameRow(a: Props, b: Props): boolean {
  return (
    a.item === b.item &&
    a.onRewind === b.onRewind &&
    a.onOpenFile === b.onOpenFile &&
    a.onOpenTask === b.onOpenTask &&
    a.onRunCommand === b.onRunCommand &&
    sameTasks(a, b, a.item.kind === 'tool' ? [a.item.id] : [])
  );
}

// チャットの 1 行。本体のチャットと、タスク（サブエージェントなど）の中身の表示で使う。
// 入力欄に打つたびにチャット全体が描き直されるので、中身が変わった行だけを描き直す
export const ChatRow = memo(function ChatRow({ item, workflows, subagents, bashTasks, onRewind, onOpenFile, onOpenTask, onRunCommand }: Props) {
  if (item.kind === 'user') {
    return (
      <div className="chat-user">
        <span className="chat-prompt">›</span>
        <div className="chat-user-body">
          {item.text && <span className="chat-user-text">{item.text}</span>}
          {item.images && <ChatImages keys={item.images} />}
        </div>
        {onRewind && item.text && !item.text.startsWith('/') && (
          <button
            className="chat-rewind"
            onClick={() => onRewind(item.text)}
            title="この発言の前まで会話やコードを戻す（/rewind）"
          >
            ここまで戻す
          </button>
        )}
      </div>
    );
  }
  if (item.kind === 'text') {
    return <Markdown text={item.text} onRunCommand={onRunCommand} />;
  }
  if (item.kind === 'notice') {
    if (!item.detail) return <div className="chat-notice">{item.text}</div>;
    return (
      <details className="chat-notice expandable">
        <summary>{item.text}</summary>
        <pre className="chat-notice-detail">{item.detail}</pre>
      </details>
    );
  }
  if (item.kind === 'info') {
    return <div className="chat-info">{item.text}</div>;
  }
  if (item.kind === 'shell') {
    return (
      <details className="chat-shell">
        <summary>
          <span className="chat-shell-prompt">!</span>
          <span className="chat-shell-command">{item.command}</span>
          {item.output && <span className="chat-shell-toggle">出力</span>}
        </summary>
        {item.output && <pre className="tool-pre">{item.output}</pre>}
      </details>
    );
  }
  if (item.kind === 'divider') {
    return <div className="chat-divider">{item.text}</div>;
  }
  if (item.kind === 'error') {
    return <div className={`chat-error${item.retrying ? ' retrying' : ''}`}>{item.text}</div>;
  }
  if (item.kind === 'hook') {
    return (
      <div className="chat-hooks">
        <span className="chat-hooks-label">フック</span>
        <HookRuns runs={item.runs} />
      </div>
    );
  }
  if (item.kind === 'thinking') {
    return (
      <details className="chat-thinking" open>
        <summary>思考</summary>
        <div className="chat-thinking-text">{item.text}</div>
      </details>
    );
  }
  if (item.answers) {
    return (
      <div className="chat-answers">
        <div className="chat-answers-label">質問への回答</div>
        {item.answers.map((a, i) => (
          <div key={i} className="chat-answer">
            <div className="chat-answer-question">
              {a.header && <span className="chat-answer-header">{a.header}</span>}
              {a.question}
            </div>
            <div className="chat-answer-value">→ {a.answer}</div>
          </div>
        ))}
      </div>
    );
  }
  if (item.sentFiles) {
    return <SentFilesCard files={item.sentFiles} failed={item.status === 'error'} onOpenFile={onOpenFile} />;
  }
  if (item.name === 'Workflow') {
    const run = workflows.get(item.id);
    return (
      <WorkflowCard
        run={run}
        fallbackName={item.target}
        onOpen={run && onOpenTask ? () => onOpenTask({ kind: 'workflow', toolUseId: item.id }) : null}
      />
    );
  }
  const subagent = subagents.get(item.id);
  const bash = bashTasks.get(item.id);
  const task: TaskRef | null = subagent ? { kind: 'subagent', toolUseId: item.id } : bash ? { kind: 'bash', toolUseId: item.id } : null;
  return (
    <ToolCard
      item={item}
      subagent={subagent}
      bash={bash}
      onOpenFile={onOpenFile}
      onOpenTask={task && onOpenTask ? () => onOpenTask(task) : null}
    />
  );
}, sameRow);
