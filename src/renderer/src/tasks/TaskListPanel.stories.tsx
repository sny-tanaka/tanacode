import type { Meta, StoryObj } from '@storybook/react-vite';
import { TaskListPanel } from './TaskListPanel';
import type { TaskEntry } from './taskList';

// サイドパネルの「タスク」。動いているバックグラウンドのものには「止める」のボタンが付く（本体の作業の中で動いているサブエージェントと、終わったものには付かない）
const now = Date.now();
const entry = (kind: TaskEntry['ref']['kind'], id: string, name: string, state: TaskEntry['state'], background: boolean, progress: string, ago: number): TaskEntry => ({
  ref: { kind, toolUseId: id },
  key: `${kind}:${id}`,
  name,
  state,
  background,
  startedAt: now - ago * 1000,
  durationMs: state === 'running' ? null : ago * 1000,
  progress,
});

const tasks: TaskEntry[] = [
  entry('bash', 'b1', 'dev サーバーを起動', 'running', true, 'ready in 412 ms', 95),
  entry('subagent', 'a1', 'Table のレスポンシブ実装を調査', 'running', true, 'ツール 6回 · Read src/parts/Table/index.tsx', 48),
  entry('workflow', 'w1', 'heavy-review-pipeline', 'running', true, 'エージェント 3/5（実行中 2）', 130),
  entry('subagent', 'a2', '型エラーの原因を調べる（この作業の中で動いている）', 'running', false, 'ツール 2回', 12),
  entry('bash', 'b2', 'npm test', 'done', true, '12 passed', 31),
  entry('bash', 'b3', 'ビルド', 'stopped', true, 'Building…', 20),
];

const meta = {
  title: 'タスク/一覧',
  parameters: { width: 320, background: '--bg-chrome' },
} satisfies Meta;

export default meta;

export const 止められるもの: StoryObj = {
  render: () => (
    <div style={{ height: 520, display: 'flex', flexDirection: 'column' }}>
      <TaskListPanel tasks={tasks} activeKey="bash:b1" onOpen={() => {}} onStop={() => {}} stopping={new Set()} />
    </div>
  ),
};

// 止める操作の最中（本家の /tasks の画面を操作するので数秒かかる）。押せず、ぐるぐるが回る
export const 止めている途中: StoryObj = {
  render: () => (
    <div style={{ height: 520, display: 'flex', flexDirection: 'column' }}>
      <TaskListPanel tasks={tasks} activeKey={null} onOpen={() => {}} onStop={() => {}} stopping={new Set(['subagent:a1'])} />
    </div>
  ),
};
