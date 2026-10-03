import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { TodoPanel } from './chat/TodoPanel';
import { ToolCard } from './chat/ToolCard';
import { ToolGroupRow } from './chat/ToolGroupRow';
import { WorkingNote } from './chat/WorkingNote';
import type { ChatItem } from './chat/chatState';
import type { ToolGroup } from './chat/toolGroups';
import { Busy } from './layout/Busy';
import { StatusBar } from './StatusBar';
import { TaskTray } from './tasks/TaskTray';
import type { TaskEntry } from './tasks/taskList';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';

// 進行中・処理中を表すところ。どれも「グラデーションのぐるぐる」と「グラデーションが流れる文字」にそろえている
type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
const noop = () => {};

const tool = (id: string, name: string, target: string, status: ToolItem['status']): ToolItem => ({
  kind: 'tool',
  id,
  name,
  target,
  status,
  input: '',
  startedAt: 0,
  endedAt: status === 'running' ? undefined : 4200,
});

const group: ToolGroup = {
  kind: 'tool-group',
  id: 'g',
  items: [tool('a', 'Read', 'src/App.tsx', 'done'), tool('b', 'Bash', 'npm run build', 'running')],
  tools: [tool('a', 'Read', 'src/App.tsx', 'done'), tool('b', 'Bash', 'npm run build', 'running')],
};

const tasks: TaskEntry[] = [
  { ref: { kind: 'subagent', toolUseId: 't1' }, key: 't1', name: 'terraform 側の差分を軽量レビュー', state: 'running', background: true, startedAt: Date.now() - 42_000, durationMs: null, progress: 'ツール 5回 · 読込 lambda.tf' },
];

function Place({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

function Catalog() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
      <Place title="セッション一覧">
        <div className="session-row" style={{ background: 'var(--bg-chrome)' }}>
          <span className="session-indicator running" />
          <div className="session-text">
            <span className="session-title">ワークフローのフロー図</span>
            <span className="session-sub">
              <span className="session-state running">作業中</span> · tanacode
            </span>
          </div>
        </div>
      </Place>
      <Place title="チャットの末尾">
        <WorkingNote activity={{ phase: 'thinking', elapsed: '8s', tokens: null }} />
      </Place>
      <Place title="ツールのまとまり（実行中）">
        <ToolGroupRow group={group} open={false} onToggle={noop} workflows={new Map()} subagents={new Map()} bashTasks={new Map()} onOpenFile={noop} onOpenTask={null} />
      </Place>
      <Place title="ツールカード（実行中）">
        <ToolCard item={tool('c', 'Bash', 'npm run typecheck', 'running')} subagent={undefined} bash={undefined} onOpenFile={noop} onOpenTask={null} />
      </Place>
      <Place title="入力欄の上のタスク">
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
          <TaskTray tasks={tasks} activeKey={null} onOpen={noop} onStop={noop} stopping={new Set()} />
        </div>
      </Place>
      <Place title="ToDo（進行中の項目）">
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
          <TodoPanel
            todos={[
              { content: '色を差し替える', status: 'completed' },
              { content: 'Storybook で見比べる', status: 'in_progress', activeForm: 'Storybook で見比べています' },
              { content: 'コミットする', status: 'pending' },
            ]}
          />
        </div>
      </Place>
      <Place title="読み込み・起動・git の操作">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          <Busy>Claude Code を起動しています…</Busy>
          <Busy>プッシュ中…</Busy>
        </div>
      </Place>
      <Place title="ステータスバー">
        <StatusBar
          status="running"
          exitCode={null}
          branch="develop"
          onOpenScm={() => {}}
          pr={null}
          showCursor={false}
          language={null}
          claudeVersion={VERIFIED_CLAUDE_CODE_VERSION}
        />
      </Place>
    </div>
  );
}

const meta = {
  title: 'カタログ/進行中の表示',
  parameters: { width: 1000, background: '--bg-panel' },
} satisfies Meta;

export default meta;

export const 一覧: StoryObj = { render: () => <Catalog /> };
