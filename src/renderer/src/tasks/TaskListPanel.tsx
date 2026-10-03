import { memo, useEffect, useRef } from 'react';
import { formatDuration } from '../workflow/WorkflowCard';
import { elapsed, stoppable, useNow, type TaskEntry, type TaskState } from './taskList';
import { IconButton, StopIcon } from '../icons';
import { StatusDot } from '../layout/StatusDot';

const KIND_LABEL = { subagent: 'エージェント', workflow: 'ワークフロー', bash: 'Bash' } as const;
const STATE_LABEL: Record<TaskState, string> = { running: '実行中', done: '完了', failed: '失敗', stopped: '停止' };

type Props = {
  tasks: TaskEntry[];
  activeKey: string | null;
  onOpen: (task: TaskEntry) => void;
  // 動いているものを止める。stopping: 止めている途中のもの（key）
  onStop: (task: TaskEntry) => void;
  stopping: ReadonlySet<string>;
  // 見えている（サイドパネルでタスクを開いている）。隠れている間は経過時間を進めない
  visible?: boolean;
};

// このセッションのサブエージェント・ワークフロー・バックグラウンドの Bash の一覧（実行中も終わったものも）。
// 開くとエディタの場所に中身を出す
export const TaskListPanel = memo(function TaskListPanel({ tasks, activeKey, onOpen, onStop, stopping, visible = true }: Props) {
  const running = tasks.filter((t) => t.state === 'running');
  const finished = tasks.filter((t) => t.state !== 'running');
  const now = useNow(visible && running.length > 0);
  // 開いたタスクのカードが見えるところまでスクロールする（入力欄の上のトレイなど、ほかから開いたとき）
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visible) listRef.current?.querySelector('.task-card.active')?.scrollIntoView({ block: 'nearest' });
  }, [activeKey, visible]);
  if (tasks.length === 0) {
    return <div className="scm-empty">このセッションでは、まだサブエージェント・ワークフロー・バックグラウンドの Bash を動かしていません</div>;
  }
  const card = (task: TaskEntry) => {
    const ms = elapsed(task, now);
    return (
      <div key={task.key} className={`task-card${task.key === activeKey ? ' active' : ''}`} onClick={() => onOpen(task)} title="開いて中身を見る">
        <div className="task-card-head">
          <StatusDot state={task.state === 'running' ? 'running' : task.state === 'done' ? 'done' : 'error'} />
          <span className="task-kind">{KIND_LABEL[task.ref.kind]}</span>
          <span className={`task-card-state ${task.state}`}>{STATE_LABEL[task.state]}</span>
          <div className="spacer" />
          {ms !== null && <span className="task-time">{formatDuration(ms)}</span>}
          {stoppable(task) && (
            <IconButton
              icon={StopIcon}
              danger
              size="sm"
              className="task-stop"
              busy={stopping.has(task.key)}
              label={stopping.has(task.key) ? '止めています' : '止める'}
              tip={stopping.has(task.key) ? '止めています…' : undefined}
              onClick={(e) => {
                e.stopPropagation();
                onStop(task);
              }}
            />
          )}
        </div>
        <div className="task-card-name">{task.name}</div>
        {task.progress && <div className="task-card-progress">{task.progress}</div>}
      </div>
    );
  };
  return (
    <div className="task-list" ref={listRef}>
      <div className="task-list-group">
        <div className="task-list-head">
          実行中 <span className="scm-count">{running.length}</span>
        </div>
        {running.length === 0 ? <div className="scm-none">動いているものはありません</div> : running.map(card)}
      </div>
      {finished.length > 0 && (
        <div className="task-list-group">
          <div className="task-list-head">
            終わったもの <span className="scm-count">{finished.length}</span>
          </div>
          {finished.map(card)}
        </div>
      )}
    </div>
  );
});
