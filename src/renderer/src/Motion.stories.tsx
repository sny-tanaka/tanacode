import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { TodoPanel } from './chat/TodoPanel';
import { ToolCard } from './chat/ToolCard';
import { DoneNote, WorkingNote } from './chat/WorkingNote';
import type { ChatItem } from './chat/chatState';
import { TaskTray } from './tasks/TaskTray';
import type { TaskEntry } from './tasks/taskList';

// 作業中・実行中にグラデーションを流す場所と、新しい行がふわっと出る動きを並べる。
// 左が止まっているとき、右が動いているとき。見本の要素はアプリと同じ class を付けたもの
type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const tool = (status: ToolItem['status']): ToolItem => ({
  kind: 'tool',
  id: `t-${status}`,
  name: 'Bash',
  target: 'npm run build',
  status,
  input: '',
  startedAt: 0,
  endedAt: status === 'running' ? undefined : 4200,
});

const noop = () => {};

function Pair({ title, idle, working }: { title: string; idle: ReactNode; working: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'center' }}>
        <div>{idle}</div>
        <div>{working}</div>
      </div>
    </div>
  );
}

function Input({ working }: { working: boolean }) {
  return (
    <div className={`chat-input${working ? ' working' : ''}`}>
      <div className="chat-input-row">
        <span className="chat-prompt">›</span>
        <textarea rows={2} placeholder="Claude Codeに指示する（⌘Enter で送信）" readOnly />
        <button className="send-button">送信</button>
      </div>
    </div>
  );
}

function Header({ working }: { working: boolean }) {
  return (
    <div className="claude-header" style={{ borderBottom: 'none' }}>
      <span className={`claude-mark${working ? ' working' : ''}`} />
      <span className="claude-title">ワークフローを IDE で開いたときのフロー図</span>
    </div>
  );
}

const lines = ['項目1: 雲は水蒸気が冷やされてできます。', '項目2: 雲の粒は髪の毛の 100 分の 1 ほどです。', '項目3: 積乱雲の高さは 10km を超えます。'];

// 「行を足す」で、新しい行がふわっと出る動きを見る
function Appear() {
  const [count, setCount] = useState(1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button className="ghost-button" style={{ alignSelf: 'flex-start' }} onClick={() => setCount((n) => (n >= lines.length ? 1 : n + 1))}>
        行を足す
      </button>
      <div className="chat-list" style={{ padding: 0, overflow: 'visible' }}>
        {lines.slice(0, count).map((line) => (
          <div key={line} className="markdown">
            <p>{line}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const task = (key: string, name: string, state: TaskEntry['state']): TaskEntry => ({
  ref: { kind: 'subagent', toolUseId: key },
  key,
  name,
  state,
  background: true,
  startedAt: Date.now() - 42_000,
  durationMs: state === 'running' ? null : 42_000,
  progress: 'ツール 5回 · 読込 lambda.tf',
});

const TODOS = ['背景と文字の色を差し替える', 'Storybook で見比べる', 'コミットする'];

// 「進める」で、タスクの完了・ターンの完了・ToDo の完了を 1 つずつ起こす
function Finish() {
  const [step, setStep] = useState(0);
  const tasks = [
    task('a', 'terraform 側の差分を軽量レビュー', step >= 1 ? 'done' : 'running'),
    task('b', 'Cognito メール BlastEngine 対応の実装', step >= 2 ? 'failed' : 'running'),
    task('c', 'E2E テストを流す', 'running'),
  ];
  const todos = TODOS.map((content, i) => ({
    content,
    status: (i < step - 2 ? 'completed' : i === step - 2 ? 'in_progress' : 'pending') as 'completed' | 'in_progress' | 'pending',
  }));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="ghost-button" onClick={() => setStep((s) => s + 1)}>
          進める
        </button>
        <button className="ghost-button" onClick={() => setStep(0)}>
          最初から
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
          <TaskTray tasks={tasks} activeKey={null} onOpen={noop} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ minHeight: 24 }}>{step < 3 ? <WorkingNote activity={{ phase: 'writing', elapsed: '12s', tokens: '1.2k' }} /> : step === 3 ? <DoneNote /> : null}</div>
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
            <TodoPanel todos={todos} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Catalog() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, fontSize: 12, color: 'var(--text-tertiary)' }}>
        <div>止まっているとき</div>
        <div>動いているとき</div>
      </div>
      <Pair title="ヘッダーのひし形" idle={<Header working={false} />} working={<Header working />} />
      <Pair title="作業中の表示" idle={<div className="chat-note">（作業中でなければ出ない）</div>} working={<WorkingNote activity={{ phase: 'writing', elapsed: '12s', tokens: '1.2k' }} />} />
      <Pair
        title="ツールカード（実行中は枠が流れる）"
        idle={<ToolCard item={tool('done')} subagent={undefined} bash={undefined} onOpenFile={noop} onOpenTask={null} />}
        working={<ToolCard item={tool('running')} subagent={undefined} bash={undefined} onOpenFile={noop} onOpenTask={null} />}
      />
      <Pair title="入力欄（作業中は、選んでいなくても枠が流れる）" idle={<Input working={false} />} working={<Input working />} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>新しい行（少し下からふわっと出る）</div>
        <Appear />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          完了の合図（タスク・ターン・ToDo。チェックを描いてから消える）
        </div>
        <Finish />
      </div>
    </div>
  );
}

const meta = {
  title: 'カタログ/動き',
  parameters: { width: 900, background: '--bg-panel' },
} satisfies Meta;

export default meta;

export const 一覧: StoryObj = { render: () => <Catalog /> };

export const 完了の合図: StoryObj = { render: () => <Finish /> };
