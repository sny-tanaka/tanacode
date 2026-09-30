import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { TodoItem } from '@shared/chat';
import { TodoPanel } from './TodoPanel';
import { WorkingNote } from './WorkingNote';

const meta = {
  title: 'チャット/作業中',
  component: WorkingNote,
  parameters: { background: '--bg-panel' },
} satisfies Meta<typeof WorkingNote>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 進み具合なし: Story = { args: { activity: null } };
export const 応答を待っている: Story = { args: { activity: { phase: 'waiting', elapsed: null, tokens: null } } };
export const 考えている: Story = { args: { activity: { phase: 'thinking', elapsed: '12s', tokens: null } } };
export const 応答を書いている: Story = { args: { activity: { phase: 'writing', elapsed: '1m 5s', tokens: '1.2k' } } };
export const ツールの実行中: Story = { args: { activity: { phase: 'working', elapsed: '48s', tokens: '3.4k' } } };
export const ToDoの名前: Story = { args: { label: '要件書を作成して発注中', activity: { phase: 'thinking', elapsed: '12s', tokens: null } } };

const TASKS: TodoItem[] = [
  { id: '1', content: '原因を調べる', activeForm: '原因を調査中', status: 'pending' },
  { id: '2', content: '修正する', activeForm: 'ToolCard.tsx を修正中', status: 'pending' },
  { id: '3', content: 'Storybook で確かめる', activeForm: 'Storybook で確認中', status: 'pending' },
];

// 「進める」で、TaskUpdate のように 1 つずつ作業中 → 完了にする。上の ToDo の欄と、末尾の「作業中…」の名前が変わる
function WithTodos() {
  const [step, setStep] = useState(0);
  const todos = TASKS.map((t, i) => ({ ...t, status: i < step ? 'completed' : i === step ? 'in_progress' : 'pending' }));
  const current = todos.find((t) => t.status === 'in_progress');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="ghost-button" onClick={() => setStep((s) => Math.min(s + 1, TASKS.length))}>
          進める
        </button>
        <button className="ghost-button" onClick={() => setStep(0)}>
          最初から
        </button>
      </div>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
        <TodoPanel todos={todos} />
      </div>
      <WorkingNote activity={{ phase: 'working', elapsed: `${12 + step * 20}s`, tokens: '1.2k' }} label={current?.activeForm} />
    </div>
  );
}

export const ToDoと一緒に: StoryObj = { render: () => <WithTodos /> };
