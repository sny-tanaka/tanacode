import type { ChatEvent } from '@shared/chat';
import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';
import type { DemoBackend } from '../backend';
import { ROOT } from '../data';

// ワークフローの実行の作り物（章 7 で、子セッションが動かすアクセシビリティの点検）。
// 概要のフロー図（点検 3 並列 → 修正 2 → 確認）を、台本の進みに合わせて埋めていく

// ワークフローを始めたツールの呼び出しの ID
export const WORKFLOW_TOOL = 'wf-tool';

// ---- ワークフローの実行（時間とともに進める） ----

type AgentPlan = { id: string; label: string; phase: string; tools: number; result: string };

const PHASES = [
  { title: '点検', detail: '観点ごとの点検役を並列に動かす' },
  { title: '修正', detail: '見つかった問題を、ファイルが重ならないよう分けて直す' },
  { title: '確認', detail: '直した結果を、別のエージェントが確かめる' },
];

const AGENTS: AgentPlan[] = [
  { id: 'contrast', label: 'コントラスト', phase: '点検', tools: 6, result: '税抜の小さい文字（#8a7f72）が背景に対して 3.9:1 で、基準の 4.5:1 に足りません。' },
  { id: 'reader', label: '読み上げ', phase: '点検', tools: 8, result: '価格が「572」「税抜 520」と数字だけで読まれます。通貨と税込・税抜が伝わりません。' },
  { id: 'keyboard', label: 'キーボード操作', phase: '点検', tools: 5, result: 'メニューは読むだけで、操作できる要素はありません。問題なし。' },
  { id: 'fix-card', label: 'MenuCard.tsx の修正', phase: '修正', tools: 4, result: '価格に aria-label を付け、「税込 572 円（税抜 520 円）」と読まれるようにしました。' },
  { id: 'fix-css', label: 'styles.css の修正', phase: '修正', tools: 3, result: '税抜の文字色を #6f6458 にし、コントラストを 5.2:1 にしました。' },
  { id: 'verify', label: '確認役', phase: '確認', tools: 7, result: '2 件とも直っていることを確かめました。npm test も通ります。' },
];

export class WorkflowPlayer {
  private readonly agents = new Map<string, WorkflowAgent>();
  private seq = 0;
  private status: WorkflowRun['status'] = 'running';
  private readonly startedAt = Date.now();
  private durationMs: number | null = null;

  constructor(
    private readonly backend: DemoBackend,
    private readonly session: string,
  ) {}

  start(id: string): void {
    const plan = AGENTS.find((a) => a.id === id)!;
    this.agents.set(id, {
      agentId: id,
      label: plan.label,
      phase: plan.phase,
      model: 'claude-sonnet-5-5',
      state: 'running',
      toolCalls: 0,
      lastTool: null,
      promptPreview: null,
      resultPreview: null,
      tokens: null,
      durationMs: null,
      startSeq: this.seq++,
      endSeq: null,
    });
    this.emit();
  }

  tool(id: string, name: string): void {
    const a = this.agents.get(id)!;
    this.agents.set(id, { ...a, toolCalls: a.toolCalls + 1, lastTool: name });
    this.emit();
  }

  finish(id: string): void {
    const plan = AGENTS.find((a) => a.id === id)!;
    const a = this.agents.get(id)!;
    this.agents.set(id, { ...a, state: 'done', toolCalls: plan.tools, lastTool: null, resultPreview: plan.result, tokens: 18_000 + plan.tools * 2_400, durationMs: 20_000 + plan.tools * 4_000, endSeq: this.seq++ });
    this.emit();
  }

  complete(): void {
    this.status = 'completed';
    this.durationMs = Date.now() - this.startedAt;
    this.emit();
  }

  running(): number {
    return [...this.agents.values()].filter((a) => a.state === 'running').length;
  }

  private emit(): void {
    const agents = [...this.agents.values()];
    const run: WorkflowRun = {
      toolUseId: WORKFLOW_TOOL,
      runId: 'wf_a11y',
      name: 'a11y-audit',
      summary: 'メニューのページを観点ごとに並列で点検し、見つかった問題を直して確かめる',
      status: this.status,
      phases: PHASES,
      agents,
      startedAt: this.startedAt,
      durationMs: this.durationMs,
      totalTokens: agents.reduce((sum, a) => sum + (a.tokens ?? 9_000), 0),
      totalToolCalls: agents.reduce((sum, a) => sum + a.toolCalls, 0),
      resumed: false,
      resumedLater: false,
    };
    this.backend.setWorkflows(this.session, [run]);
    this.backend.update(this.session, { backgroundTasks: this.status === 'running' ? 1 : 0 });
  }
}

// 「読み上げ」のエージェントの会話（選んだときに見せる）。少しずつ伸ばす
export function readerLog(step: number): ChatEvent[] {
  const events: ChatEvent[] = [
    { type: 'user', id: 'r-u', text: 'メニューのページを、スクリーンリーダーでの読み上げの観点で点検してください。直さず、問題と場所だけを報告してください。' },
  ];
  const tools: [string, string, string?][] = [
    ['Read', 'src/components/MenuList.tsx'],
    ['Read', 'src/components/MenuCard.tsx'],
    ['Grep', 'aria-'],
    ['Read', 'src/lib/price.ts'],
  ];
  tools.slice(0, step).forEach(([name, target], i) => {
    const filePath = name === 'Read' ? `${ROOT}/${target}` : undefined;
    events.push({ type: 'tool-use', id: `r-t${i}`, name, target, filePath, input: target, at: 1000 * i });
    if (i < step - 1 || step > tools.length) events.push({ type: 'tool-result', id: `r-t${i}`, isError: false, filePath, at: 1000 * i + 700 });
  });
  if (step > tools.length) {
    events.push({
      type: 'assistant-text',
      id: 'r-t',
      text: [
        '読み上げで伝わらない箇所が 1 つあります。',
        '',
        '- `MenuCard.tsx` の価格: 「572」「税抜 520」と数字だけで読まれ、通貨と税込・税抜が伝わりません',
        '',
        '見出し（`h3`）と品目の並びは問題ありません。',
      ].join('\n'),
    });
  }
  return events;
}
