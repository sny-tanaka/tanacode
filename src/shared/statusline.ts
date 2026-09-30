// Claude Code が statusLine のコマンドに渡す JSON から読み取ったもの（応答のたびに更新される）

export type RateLimit = { percent: number; resetsAt: number | null };

export type StatusLineInfo = {
  model: { id: string; name: string } | null;
  version: string | null;
  context: { size: number; usedPercent: number; tokens: number } | null;
  rateLimits: { fiveHour: RateLimit | null; sevenDay: RateLimit | null } | null;
  costUsd: number | null;
  // 今の会話の会話ログ。/clear で新しい会話になると変わる
  transcriptPath: string | null;
  updatedAt: number;
};
