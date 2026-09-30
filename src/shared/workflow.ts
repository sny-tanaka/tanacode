// Claude Code のワークフロー（Workflow ツール）の実行状況

// stopped: 実行が止まった・終わったときに、まだ動いていた（結果が返らなかった）
export type WorkflowAgentState = 'running' | 'done' | 'failed' | 'stopped';

export type WorkflowAgent = {
  agentId: string;
  // 実行中は分からないことがある（完了時の記録で埋まる）。そのときはプロンプトの冒頭を出す
  label: string | null;
  phase: string | null;
  model: string | null;
  state: WorkflowAgentState;
  toolCalls: number;
  lastTool: string | null;
  promptPreview: string | null;
  resultPreview: string | null;
  tokens: number | null;
  durationMs: number | null;
  // 開始・終了の順番（同じ実行のエージェントどうしの前後を比べるためだけの通し番号）。
  // 分からないとき・終わっていないときは null。フロー図で、並列に動いたか順に動いたかを見分けるのに使う
  startSeq: number | null;
  endSeq: number | null;
};

// running 以外は完了時の記録（workflows/<runId>.json）の status。stopped は Claude Code が先に終了した
export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'stopped' | (string & {});

export type WorkflowRun = {
  // 起動した Workflow ツールの tool_use ID（チャットのツールカードと対応付ける）
  toolUseId: string;
  runId: string;
  name: string;
  summary: string;
  status: WorkflowStatus;
  phases: { title: string; detail: string | null }[];
  agents: WorkflowAgent[];
  // このアプリで起動を見たときの時刻（過去の会話から読んだものは null）
  startedAt: number | null;
  durationMs: number | null;
  totalTokens: number | null;
  totalToolCalls: number | null;
  // 前に止まった・終わった実行を再開したもの（Workflow の resumeFromRunId。runId は前と同じ）
  resumed: boolean;
  // あとで再開された。この実行の記録は再開した実行に引き継がれ、このカードは再開した時点の状態のまま
  resumedLater: boolean;
};
