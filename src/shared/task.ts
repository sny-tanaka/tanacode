// バックグラウンドで動かした Bash（run_in_background）の実行状況

export type BashTaskState = 'running' | 'completed' | 'failed' | 'killed' | 'stopped';

export type BashTask = {
  // 起動した Bash ツールの tool_use ID（チャットのツールカードと対応付ける）
  toolUseId: string;
  // Claude Code のバックグラウンドタスク ID
  taskId: string;
  command: string;
  description: string | null;
  state: BashTaskState;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  // 出力ファイルの末尾（長いときは先頭を切る）
  output: string;
  truncated: boolean;
};

// 中身を見るタスク。サブエージェント・ワークフロー・バックグラウンドの Bash（どれも起動したツールの tool_use ID）
export type TaskRef = { kind: 'subagent' | 'workflow' | 'bash'; toolUseId: string };
// 会話ログを読むエージェント。ワークフローはエージェントごとに会話ログがある
export type AgentLogRef = { kind: 'subagent'; toolUseId: string } | { kind: 'workflow'; toolUseId: string; agentId: string };
