import { useEffect, useRef, useState } from 'react';
import { CheckMark } from '../layout/CheckMark';
import { formatDuration } from '../workflow/WorkflowCard';
import { elapsed, useNow, type TaskEntry } from './taskList';

const KIND_LABEL = { subagent: 'エージェント', workflow: 'ワークフロー', bash: 'Bash' } as const;
// これより多いときは折りたたむ
const COLLAPSE_OVER = 3;
// 終わったタスクを、チェックを描いてから消すまでの時間（CSS の task-row-leave と合わせる）
const LEAVE_MS = 1800;

type Props = {
  // このセッションのタスク。出すのは実行中のものと、終わったばかりのもの（チェックを描いてから消え、サイドパネルの「タスク」に残る）
  tasks: TaskEntry[];
  activeKey: string | null;
  onOpen: (task: TaskEntry) => void;
};

// 入力欄の上に常に出す、動いているタスクの一覧。チャットが進んでも流れていかない
export function TaskTray({ tasks, activeKey, onOpen }: Props) {
  // collapsed: 見出しだけにする / expanded: 多いときも全部出す
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const leaving = useLeaving(tasks);
  const running = tasks.filter((t) => t.state === 'running').length;
  const now = useNow(running > 0);
  const rows = tasks.filter((t) => t.state === 'running' || leaving.has(t.key));
  if (rows.length === 0) return null;
  const shown = collapsed ? [] : expanded || rows.length <= COLLAPSE_OVER + 1 ? rows : rows.slice(0, COLLAPSE_OVER);
  return (
    <div className="task-tray">
      <button className="task-tray-head" onClick={() => setCollapsed((v) => !v)}>
        <span className="tree-chevron">{collapsed ? '▸' : '▾'}</span>
        タスク
        {running > 0 && <span className="task-tray-count running">実行中 {running}</span>}
      </button>
      {shown.map((task) => {
        const ms = elapsed(task, now);
        const left = task.state !== 'running';
        return (
          <div
            key={task.key}
            className={`task-row${task.key === activeKey ? ' active' : ''}${left ? ' leaving' : ''}`}
            onClick={() => onOpen(task)}
            title="開いて中身を見る"
          >
            {left ? (
              <CheckMark animate failed={task.state !== 'done'} slot={7} />
            ) : (
              <span className="tool-dot running" />
            )}
            <span className="task-kind">{KIND_LABEL[task.ref.kind]}</span>
            <span className="task-name">{task.name}</span>
            <span className="task-progress">{left ? LEFT_LABEL[task.state] : task.progress}</span>
            {ms !== null && <span className="task-time">{formatDuration(ms)}</span>}
          </div>
        );
      })}
      {!collapsed && shown.length < rows.length && (
        <button className="task-more" onClick={() => setExpanded(true)}>
          ほか {rows.length - shown.length} 件
        </button>
      )}
    </div>
  );
}

const LEFT_LABEL: Record<TaskEntry['state'], string> = { running: '', done: '完了', failed: '失敗', stopped: '停止' };

// 実行中から終わったものに変わったタスク（の key）。しばらく残して、チェックを描いてから消す
function useLeaving(tasks: TaskEntry[]): ReadonlySet<string> {
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const wasRunning = useRef<Set<string> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const running = new Set(tasks.filter((t) => t.state === 'running').map((t) => t.key));
    // 最初（開いた時点で終わっていたもの）は出さない
    const finished = wasRunning.current ? tasks.filter((t) => wasRunning.current!.has(t.key) && !running.has(t.key)).map((t) => t.key) : [];
    wasRunning.current = running;
    if (finished.length === 0) return;
    setLeaving((prev) => new Set([...prev, ...finished]));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setLeaving((prev) => new Set([...prev].filter((key) => !finished.includes(key))));
    }, LEAVE_MS);
    timers.current.add(timer);
  }, [tasks]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return leaving;
}
