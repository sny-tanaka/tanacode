import type { ChatEvent } from '@shared/chat';
import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';
import type { DemoBackend } from '../backend';
import { ROOT } from '../data';
import { sleep, type Director } from '../director';
import { Claude, pastTurn, statusLine } from './claude';

// 動画 3「ワークフローの図解」: Claude が動かしたワークフローを、GitHub Actions の実行の画面のように見る。
// 指示 → ワークフローが入力欄の上のトレイに出る → 開くと概要のフロー図（点検 3 並列 → 修正 2 → 確認）が進むにつれて埋まる →
// 一覧からエージェントを選んで会話を見る → 概要に戻って完了を見届ける → Claude が結果をまとめる

export const WORKFLOW_SESSION = 'demo-workflow';

const PROMPT = 'メニューのページのアクセシビリティを点検して、見つかった問題を直して';
const WORKFLOW_TOOL = 'wf-tool';

export function setupWorkflow(backend: DemoBackend): void {
  const hour = 3600_000;
  backend.addSession('demo-tax', { title: 'メニューに税込価格を出す', updatedAt: Date.now() - 2 * hour });
  backend.addSession('demo-readme', { title: 'README のセットアップ手順を見直す', updatedAt: Date.now() - 5 * hour });
  backend.addSession(
    WORKFLOW_SESSION,
    { title: 'メニューのアクセシビリティを点検する' },
    pastTurn('past', 'メニューのページの構成を教えて', [['Read', 'src/App.tsx', 600], ['Read', 'src/components/MenuList.tsx', 600], ['Read', 'src/components/MenuCard.tsx', 600]], [
      '`App` が `MenuList` を置き、`MenuList` が品目ごとに `MenuCard` を並べる構成です。',
      '価格の整形は `src/lib/price.ts` にまとまっています。',
    ].join('\n'), 10 * 60_000),
  );
  backend.setStatusLine(WORKFLOW_SESSION, statusLine(12, 24_000));
}

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

class WorkflowPlayer {
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
function readerLog(step: number): ChatEvent[] {
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

export async function runWorkflow(backend: DemoBackend, d: Director): Promise<void> {
  const id = WORKFLOW_SESSION;
  const claude = new Claude(backend, id);
  const flow = new WorkflowPlayer(backend, id);
  const sent = new Promise<void>((resolve) => {
    backend.onUserMessage = (_sid, text) => {
      claude.user(text);
      resolve();
    };
  });
  const log = (step: number) => backend.setAgentLog(id, `${WORKFLOW_TOOL}:reader`, readerLog(step));

  // 1. 指示を送る
  await sleep(1000);
  await d.click('.chat-input textarea');
  await d.type('.chat-input textarea', PROMPT);
  await sleep(300);
  await d.click(d.byText('.send-button', '送信'));
  await sent;
  claude.startWorking();

  // 2. Claude がワークフローを起動する（入力欄の上のトレイに出る）
  await sleep(1500);
  claude.say('観点ごとに並列で点検し、見つかった問題を直すワークフローを動かします。');
  await sleep(500);
  backend.push(id, {
    type: 'tool-use',
    id: WORKFLOW_TOOL,
    name: 'Workflow',
    target: 'a11y-audit',
    input: 'a11y-audit',
    description: 'アクセシビリティを点検して直す',
    at: Date.now(),
  });
  log(0);
  flow.start('contrast');
  flow.start('reader');
  flow.start('keyboard');
  await sleep(600);
  backend.push(id, { type: 'tool-result', id: WORKFLOW_TOOL, isError: false, output: 'ワークフロー a11y-audit をバックグラウンドで開始しました', at: Date.now() });
  await sleep(400);
  claude.stopWorking();
  claude.say('点検・修正・確認の 3 段で進めます。終わったら結果をまとめます。');
  backend.push(id, { type: 'turn-end' });

  // 3. トレイの行を開くと、概要のフロー図が出る。サイドパネルもタスクに切り替わる
  await sleep(900);
  flow.tool('contrast', 'Read');
  log(1);
  await d.click(d.byText('.task-tray .task-row', 'a11y-audit'), { ms: 900 });
  flow.tool('reader', 'Read');
  flow.tool('keyboard', 'Read');
  log(2);
  await sleep(1200);
  flow.tool('contrast', 'Grep');
  flow.tool('reader', 'Grep');
  log(3);
  await sleep(1000);
  flow.finish('keyboard');
  flow.tool('reader', 'Read');
  log(4);
  await sleep(1200);
  flow.finish('contrast');
  await sleep(900);

  // 4. 一覧から「読み上げ」を選び、その会話を見る
  await d.click(d.byText('.task-agent', '読み上げ'), { ms: 800 });
  await sleep(1400);
  log(5);
  flow.finish('reader');
  await sleep(1600);
  // 点検が終わると修正が 2 並列で始まる
  flow.start('fix-card');
  flow.start('fix-css');
  await sleep(1000);

  // 5. 概要に戻る。修正が進み、確認に移る
  await d.click('.task-agent.task-overview', { ms: 800 });
  flow.tool('fix-card', 'Read');
  flow.tool('fix-css', 'Read');
  await sleep(1300);
  flow.tool('fix-card', 'Edit');
  flow.tool('fix-css', 'Edit');
  backend.writeFile('src/styles.css', backend.project.files['src/styles.css'].replace('#8a7f72', '#6f6458'));
  await sleep(1300);
  flow.finish('fix-css');
  await sleep(900);
  backend.writeFile(
    'src/components/MenuCard.tsx',
    backend.project.files['src/components/MenuCard.tsx'].replace(
      '<p className="price">',
      '<p className="price" aria-label={`税込 ${withTax(price)} 円（税抜 ${price} 円）`}>',
    ),
  );
  flow.finish('fix-card');
  await sleep(700);
  flow.start('verify');
  await sleep(900);
  flow.tool('verify', 'Read');
  await sleep(900);
  flow.tool('verify', 'Bash');
  await sleep(1400);
  flow.finish('verify');
  flow.complete();

  // 6. 完了の知らせを受けて、Claude が結果をまとめる
  await sleep(1200);
  backend.push(id, { type: 'notice', id: 'wf-done', text: 'ワークフロー a11y-audit が終わりました' });
  claude.startWorking();
  await sleep(1600);
  claude.stopWorking();
  claude.say(
    [
      'アクセシビリティの点検と修正が終わりました。',
      '',
      '- **コントラスト**: 税抜の文字色を濃くし、3.9:1 → 5.2:1 に',
      '- **読み上げ**: 価格に `aria-label` を付け、「税込 572 円（税抜 520 円）」と読まれるように',
      '- **キーボード操作**: 問題なし',
      '',
      '確認役のエージェントが、2 件とも直っていることと `npm test` が通ることを確かめています。',
    ].join('\n'),
  );
  backend.push(id, { type: 'turn-end' });
  backend.setStatusLine(id, statusLine(16, 31_000));
  await sleep(4000);
}
