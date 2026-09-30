import type { Meta, StoryObj } from '@storybook/react-vite';
import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';
import { WorkflowFlow } from './WorkflowFlow';

let seq = 0;
// start・end は開始・終了の順番（小さいほど先）。end が null なら動いている
const agent = (label: string, phase: string, start: number, end: number | null, extra: Partial<WorkflowAgent> = {}): WorkflowAgent => ({
  agentId: `a${++seq}`,
  label,
  phase,
  model: 'claude-sonnet-5',
  state: end === null ? 'running' : 'done',
  toolCalls: 12,
  lastTool: end === null ? 'Read' : null,
  promptPreview: null,
  resultPreview: null,
  tokens: 48_000,
  durationMs: end === null ? null : 95_000,
  startSeq: start,
  endSeq: end,
  ...extra,
});

const heavyReview: WorkflowRun = {
  toolUseId: 'toolu_heavy',
  runId: 'wf_heavy',
  name: 'heavy-review-pipeline',
  summary: 'ブランチの変更を観点ごとに並列でレビューし、指摘をまとめて監査する',
  status: 'completed',
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
    agent('aggregator', 'Aggregate', 8, 9, { model: 'claude-opus-5-5' }),
    agent('auditor', 'Audit', 10, 11, { model: 'claude-opus-5-5' }),
  ],
  startedAt: null,
  durationMs: 12 * 60_000,
  totalTokens: 410_000,
  totalToolCalls: 96,
  resumed: false,
  resumedLater: false,
};

const meta = {
  title: 'タスク/ワークフローのフロー図',
  component: WorkflowFlow,
  parameters: { width: 1100 },
  args: { run: heavyReview, onOpenAgent: () => {} },
  decorators: [(Story) => <div style={{ height: 520, display: 'flex', flexDirection: 'column' }}><Story /></div>],
} satisfies Meta<typeof WorkflowFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 完了: Story = {};

export const 実行中: Story = {
  args: {
    run: {
      ...heavyReview,
      status: 'running',
      durationMs: null,
      agents: [...heavyReview.agents.slice(0, 4), agent('aggregator', 'Aggregate', 8, null, { model: 'claude-opus-5-5' })],
    },
  },
};

// 本番実装とテスト設計は並んで動く（同じ列に縦に積む）
export const 並んで動くフェーズ: Story = {
  args: {
    run: {
      ...heavyReview,
      name: 'implement-and-verify',
      summary: '設計書どおりに実装し、並行してテストを設計してから検証する',
      phases: [
        { title: '本番実装', detail: '設計書どおりにコードを書く' },
        { title: 'テスト設計', detail: '受け入れ条件からテストを起こす' },
        { title: '検証', detail: 'テストを通し、差分を読み合わせる' },
      ],
      agents: [
        agent('implementer', '本番実装', 0, 3),
        agent('test-designer', 'テスト設計', 1, 2),
        agent('verifier', '検証', 4, 5),
      ],
    },
  },
};
