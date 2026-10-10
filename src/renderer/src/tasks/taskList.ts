import { useCallback, useEffect, useState } from 'react';
import { t } from '@shared/i18n';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask, BashTaskState, TaskRef } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import type { ChatItem } from '../chat/chatState';
import { toolLabel } from '../chat/toolLabel';
import { useSessionValues } from '../sessionValues';
import { stableRuns } from './stableRuns';

// バックグラウンドの Bash の状態の名前
export const bashStateLabel = (state: BashTaskState) => t(`tasks.bashState.${state}`);

// 前からの表の形（チャットのツールカードが使っている）。読んだときの言語で返すよう、値は getter にする。
// ToolCard を bashStateLabel に替えたら消す
export const BASH_STATE_LABEL: Readonly<Record<BashTaskState, string>> = {
  get running() {
    return bashStateLabel('running');
  },
  get completed() {
    return bashStateLabel('completed');
  },
  get failed() {
    return bashStateLabel('failed');
  },
  get killed() {
    return bashStateLabel('killed');
  },
  get stopped() {
    return bashStateLabel('stopped');
  },
};

export type TaskState = 'running' | 'done' | 'failed' | 'stopped';

// タスクの状態の名前（サイドパネル・入力欄の上のトレイ・中身の見出し）
export const taskStateLabel = (state: TaskState) => t(`tasks.state.${state}`);

// サブエージェント・ワークフロー・バックグラウンドの Bash をまとめて扱うための形
export type TaskEntry = {
  ref: TaskRef;
  key: string;
  name: string;
  state: TaskState;
  background: boolean;
  startedAt: number | null;
  durationMs: number | null;
  // 進み具合の一言（直前のツール・エージェント数・出力の最後の行など）
  progress: string;
};

export const taskKey = (ref: TaskRef) => `${ref.kind}:${ref.toolUseId}`;

// 人が止められるもの。動いているバックグラウンドのもの（サブエージェントは、本体の作業の中で動いているものを除く）
export const stoppable = (task: TaskEntry) => task.state === 'running' && task.background;

export function buildTasks(
  items: ChatItem[],
  subagents: ReadonlyMap<string, SubagentRun>,
  workflows: ReadonlyMap<string, WorkflowRun>,
  bash: ReadonlyMap<string, BashTask>,
): TaskEntry[] {
  const tools = new Map(items.filter((i) => i.kind === 'tool').map((i) => [i.id, i]));
  const entries: TaskEntry[] = [];
  for (const run of subagents.values()) {
    const ref: TaskRef = { kind: 'subagent', toolUseId: run.toolUseId };
    const last = run.recent[run.recent.length - 1];
    entries.push({
      ref,
      key: taskKey(ref),
      name: tools.get(run.toolUseId)?.target || t('tasks.list.untitledSubagent'),
      state: run.state,
      background: run.background,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      progress: [t('tasks.list.toolCalls', { count: run.toolCalls }), run.state === 'running' && last ? `${toolLabel(last.name)} ${last.target}` : null].filter(Boolean).join(' · '),
    });
  }
  for (const run of workflows.values()) {
    const ref: TaskRef = { kind: 'workflow', toolUseId: run.toolUseId };
    const running = run.agents.filter((a) => a.state === 'running').length;
    const done = run.agents.filter((a) => a.state === 'done').length;
    entries.push({
      ref,
      key: taskKey(ref),
      name: run.name,
      state: run.status === 'running' ? 'running' : run.status === 'completed' ? 'done' : run.status === 'failed' ? 'failed' : 'stopped',
      background: true,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      progress: running
        ? t('tasks.list.agentsRunning', { done, total: run.agents.length, count: running })
        : t('tasks.list.agents', { done, total: run.agents.length }),
    });
  }
  for (const task of bash.values()) {
    const ref: TaskRef = { kind: 'bash', toolUseId: task.toolUseId };
    const lastLine = task.output.trimEnd().split('\n').pop() ?? '';
    entries.push({
      ref,
      key: taskKey(ref),
      name: task.description ?? task.command,
      state: task.state === 'running' ? 'running' : task.state === 'completed' ? 'done' : task.state === 'failed' ? 'failed' : 'stopped',
      background: true,
      startedAt: task.startedAt,
      durationMs: task.startedAt && task.endedAt ? task.endedAt - task.startedAt : null,
      progress: task.state === 'running' ? lastLine : task.exitCode !== null ? t('tasks.bash.exitCode', { code: task.exitCode }) : '',
    });
  }
  return entries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

// セッションごとのバックグラウンドの Bash。キーは起動した Bash ツールの tool_use ID
// 描き直すのは選択中のセッションが変わったときだけ
export function useSessionBash(selectedId: string | null): {
  bashOf: (sessionId: string | null) => ReadonlyMap<string, BashTask>;
  load: (sessionId: string) => void;
} {
  const { valueOf, update } = useSessionValues<ReadonlyMap<string, BashTask>, ReadonlyMap<string, BashTask>>(selectedId, NO_TASKS);
  const set = useCallback((sessionId: string, list: BashTask[]) => update(sessionId, (prev) => stableRuns(prev, list)), [update]);
  useEffect(() => window.tanacode.tasks.onBashChanged(({ sessionId, tasks: list }) => set(sessionId, list)), [set]);
  const load = useCallback((sessionId: string) => void window.tanacode.tasks.bash(sessionId).then((list) => set(sessionId, list)), [set]);
  return { bashOf: valueOf, load };
}
const NO_TASKS: ReadonlyMap<string, BashTask> = new Map();

// 実行中のタスクの経過時間を出すため、1 秒ごとに今の時刻を返す
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    // 動いていない間の古い時刻のまま、最初の 1 秒を描かないよう、動き出したらすぐ今の時刻にする
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function elapsed(task: TaskEntry, now: number): number | null {
  if (task.durationMs !== null) return task.durationMs;
  return task.startedAt && task.state === 'running' ? Math.max(0, now - task.startedAt) : null;
}
