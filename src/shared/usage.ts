// プランの利用枠（5 時間枠・週の枠）

export type UsageLimit = {
  // 例: 5時間 / 週
  label: string;
  percent: number;
  // リセットの時刻（分からなければ null）
  resetsAt: number | null;
};

export type UsageLimits = {
  limits: UsageLimit[];
  // この値を得た時刻
  updatedAt: number;
  // statusline: アプリのセッションの応答から / claude-cache: Claude Code が /usage を開いたときの控えから
  source: 'statusline' | 'claude-cache';
};
