import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ChatEvent } from '@shared/chat';
import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';
import { TaskPane } from './TaskPane';
import type { TaskEntry } from './taskList';

// サブエージェントの中身。会話ログを 1 秒ごとに読み直すので、読むたびに少しずつ進むログを返して、
// メインのチャットと同じく「N件の操作」に畳まれ、実行中のツールだけが下に出るのを見る
const use = (id: string, command: string, description: string): ChatEvent => ({
  type: 'tool-use',
  id,
  name: 'Bash',
  target: command,
  input: `# ${description}\n${command}`,
  description,
  at: 0,
});
const result = (id: string): ChatEvent => ({ type: 'tool-result', id, isError: false, output: 'ok', at: 1800 });

const STEPS: ChatEvent[][] = [
  [{ type: 'user', id: 'u', text: 'Table のレスポンシブ実装を調べて、ビューポートの判定の仕方をまとめて' }],
  [use('b1', 'rg -n "useMediaQuery" src', 'ビューポート判定フックの有無を検索')],
  [result('b1'), use('b2', 'ls src/parts/Table', 'TableWithPagination のファイル一覧を確認')],
  [result('b2'), use('b3', 'rg -n "mediaQueries.sp" src | wc -l', 'mediaQueries.sp 利用箇所の全体数を確認')],
  [result('b3'), { type: 'assistant-text', id: 't1', text: 'ビューポートの判定は `mediaQueries.sp` に集まっています。続けて表示の切り替え方を見ます。' }],
  [use('b4', 'rg -n "display: none" src/parts/Table', 'display 切り替えのパターンを確認')],
  [result('b4'), { type: 'assistant-text', id: 't2', text: '判定は CSS のメディアクエリだけで、JS のフックは使っていません。' }],
];

// Storybook の window.tanacode（何もしない差し替え）のうち、会話ログを読むところだけを進むログにする
let calls = 0;
let installed = false;
function installGrowingLog(): void {
  if (installed) return;
  installed = true;
  const api = window.tanacode as unknown as Record<string, unknown>;
  const agentLog = () => {
    calls += 1;
    return Promise.resolve(STEPS.slice(0, Math.min(STEPS.length, Math.ceil(calls / 2))).flat());
  };
  window.tanacode = new Proxy(api, {
    get: (target, key) => (key === 'tasks' ? { agentLog } : target[key as string]),
  }) as unknown as typeof window.tanacode;
}

const task: TaskEntry = {
  ref: { kind: 'subagent', toolUseId: 'agent-1' },
  key: 'subagent:agent-1',
  name: 'Table のレスポンシブ実装を調査',
  state: 'running',
  background: false,
  startedAt: Date.now(),
  durationMs: null,
  progress: '',
};

const meta = {
  title: 'タスク/サブエージェントの中身',
  parameters: { width: 720, background: '--bg-panel' },
} satisfies Meta;

export default meta;

export const 実行中: StoryObj = {
  render: () => {
    installGrowingLog();
    return (
      <div style={{ height: 520, display: 'flex' }}>
        <TaskPane sessionId="s" task={task} subagent={undefined} workflow={undefined} bash={undefined} onClose={() => {}} onOpenFile={() => {}} />
      </div>
    );
  },
};

// ワークフロー。左に「概要」と全エージェントの一覧がいつも出て、概要ならフロー図、エージェントならその中身が右に出る
let seq = 0;
const agent = (label: string, phase: string, start: number, end: number | null): WorkflowAgent => ({
  agentId: `w${++seq}`,
  label,
  phase,
  model: 'claude-sonnet-5',
  state: end === null ? 'running' : 'done',
  toolCalls: 12,
  lastTool: end === null ? 'Read' : null,
  promptPreview: null,
  resultPreview: end === null ? null : '指摘はありません。',
  tokens: 48_000,
  durationMs: end === null ? null : 95_000,
  startSeq: start,
  endSeq: end,
});

const run: WorkflowRun = {
  toolUseId: 'toolu_wf',
  runId: 'wf_1',
  name: 'heavy-review-pipeline',
  summary: 'ブランチの変更を観点ごとに並列でレビューし、指摘をまとめて監査する',
  status: 'running',
  phases: [
    { title: 'Fleet', detail: '観点ごとのレビュアーを並列に動かす' },
    { title: 'Aggregate', detail: '指摘を重複なくまとめ、重要度で並べる' },
    { title: 'Audit', detail: 'まとめた指摘が本当に正しいかを独立に確かめる' },
  ],
  agents: [
    agent('correctness', 'Fleet', 0, 5),
    agent('security', 'Fleet', 1, 6),
    agent('performance', 'Fleet', 2, 4),
    agent('readability', 'Fleet', 3, 7),
    agent('aggregator', 'Aggregate', 8, null),
  ],
  startedAt: Date.now() - 120_000,
  durationMs: null,
  totalTokens: 410_000,
  totalToolCalls: 96,
  resumed: false,
  resumedLater: false,
};

const workflowTask: TaskEntry = {
  ref: { kind: 'workflow', toolUseId: 'toolu_wf' },
  key: 'workflow:toolu_wf',
  name: 'heavy-review-pipeline',
  state: 'running',
  background: true,
  startedAt: Date.now() - 120_000,
  durationMs: null,
  progress: '',
};

export const ワークフロー: StoryObj = {
  parameters: { width: 1100 },
  render: () => {
    installGrowingLog();
    return (
      <div style={{ height: 560, display: 'flex' }}>
        <TaskPane sessionId="s" task={workflowTask} subagent={undefined} workflow={run} bash={undefined} onClose={() => {}} onOpenFile={() => {}} />
      </div>
    );
  },
};
