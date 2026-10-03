// Agent ツールで起動したサブエージェントの進み具合

export type SubagentState = 'running' | 'done' | 'failed' | 'stopped';

export type SubagentRun = {
  // 起動した Agent ツールの tool_use ID（チャットのツールカードと対応付ける）
  toolUseId: string;
  agentId: string | null;
  // Agent ツールの description（本家の /tasks の画面の見出し）。続きを頼んで再開したもの（SendMessage）は元のものから引き継ぐ。分からなければ null
  description: string | null;
  background: boolean;
  state: SubagentState;
  // このアプリで起動を見たときの時刻（過去の会話から読んだものは null）
  startedAt: number | null;
  model: string | null;
  toolCalls: number;
  // 直近のツール呼び出し（新しいものが最後）
  recent: { name: string; target: string }[];
  durationMs: number | null;
  tokens: number | null;
  // バックグラウンドで動いたものの結果（完了通知の <result>）
  result: string | null;
};
