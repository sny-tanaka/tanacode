// プランの利用枠（5 時間枠・週の枠）

export type UsageLimit = {
  // 例: 5時間 / 週
  label: string;
  // モデル別の週の枠のときの、モデルの表示名（サーバーが付けたもの。例: Fable・Sonnet）。全体の枠には無い
  model?: string;
  percent: number;
  // リセットの時刻（分からなければ null）
  resetsAt: number | null;
  // 前の値から残した枠の、その値を得た時刻（無ければ UsageLimits.updatedAt の値）。新しい知らせに無かった枠を、新しく見せない
  updatedAt?: number;
};

export type UsageLimits = {
  limits: UsageLimit[];
  // この値を得た時刻
  updatedAt: number;
  // statusline: アプリのセッションの応答から / usage: チャットのターンの終わりに聞いた get_usage から /
  // claude-cache: Claude Code が /usage を開いたときの控えから
  source: 'statusline' | 'usage' | 'claude-cache';
};
