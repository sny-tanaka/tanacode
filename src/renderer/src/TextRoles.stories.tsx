import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { TodoPanel } from './chat/TodoPanel';
import { BranchIcon, FilesIcon, SearchIcon, TasksIcon } from './layout/icons';
import { TaskListPanel } from './tasks/TaskListPanel';
import type { TaskEntry } from './tasks/taskList';

// 文字の色の役割（heading / primary / secondary / tertiary）が出る場所を並べる。
// 見本の要素はアプリと同じ class を付けたもの（本物の部品があるものは本物を使う）
function Section({ title, children, background = '--bg-chrome' }: { title: string; children: ReactNode; background?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{title}</div>
      <div style={{ background: `var(${background})`, border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

const task = (key: string, name: string, state: TaskEntry['state'], durationMs: number, progress: string): TaskEntry => ({
  ref: { kind: key.startsWith('w') ? 'workflow' : 'subagent', toolUseId: key },
  key,
  name,
  state,
  background: true,
  startedAt: null,
  durationMs,
  progress,
});

const tasks = [
  task('s1', 'terraform 側の差分を軽量レビュー', 'running', 42_000, 'ツール 5回 · 読込 lambda.tf'),
  task('w1', 'design-and-audit', 'done', 740_000, 'エージェント 3/3'),
  task('s2', 'Cognito メール BlastEngine 対応の実装', 'done', 98_000, 'ツール 11回'),
];

function Catalog() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 20 }}>
      <Section title="アクティビティバー（動いていないアイコン）">
        <div className="activity-bar" style={{ height: 'auto', borderRight: 'none', flexDirection: 'row' }}>
          <button className="on" aria-label="エクスプローラー">
            <FilesIcon />
          </button>
          <button aria-label="検索">
            <SearchIcon />
          </button>
          <button aria-label="ソース管理">
            <BranchIcon />
          </button>
          <button aria-label="タスク">
            <TasksIcon />
          </button>
        </div>
      </Section>
      <Section title="エクスプローラー（選択中の行）">
        <div style={{ padding: '6px 0' }}>
          <div className="tree-row" style={{ paddingLeft: 16 }}>package.json</div>
          <div className="tree-row active" style={{ paddingLeft: 16 }}>README.md</div>
          <div className="tree-row" style={{ paddingLeft: 16 }}>tsconfig.json</div>
        </div>
      </Section>
      <Section title="エディタのタブ（選択中）">
        <div className="editor-tabs">
          <div className="editor-tab active">README.md</div>
          <div className="editor-tab">package.json</div>
        </div>
      </Section>
      <Section title="タスクの一覧（完了・N秒・カードのタイトル）">
        <div style={{ padding: 8 }}>
          <TaskListPanel tasks={tasks} activeKey="w1" onOpen={() => {}} />
        </div>
      </Section>
      <Section title="ToDo（終わった項目）" background="--bg-panel">
        <TodoPanel
          todos={[
            { content: '背景と文字の色を差し替える', status: 'completed' },
            { content: 'Storybook で見比べる', status: 'in_progress', activeForm: 'Storybook で見比べています' },
            { content: 'コミットする', status: 'pending' },
          ]}
        />
      </Section>
      <Section title="ファイルを開く（選択中の候補）" background="--bg-surface">
        <div style={{ padding: 6 }}>
          <div className="quick-open-item selected">src/renderer/src/global.css</div>
          <div className="quick-open-item">src/renderer/src/App.tsx</div>
        </div>
      </Section>
    </div>
  );
}

const meta = {
  title: 'カタログ/文字の役割',
  parameters: { width: 1200 },
} satisfies Meta;

export default meta;

export const 一覧: StoryObj = { render: () => <Catalog /> };
