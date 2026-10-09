// プロファイル（Claude Code のアカウントごとの環境）。既定のプロファイル（id: default）は ~/.claude（CLAUDE_CONFIG_DIR）を使い、
// 足したプロファイルは、それぞれの Claude Code の設定のフォルダ（例: ~/.claude-work）を使う

export const DEFAULT_PROFILE_ID = 'default';

export type ProfileInfo = {
  id: string;
  name: string;
  // 色（#rrggbb）。アカウント欄の背景をうっすら染める
  color: string;
  // Claude Code の設定のフォルダ。null は既定のプロファイル（アプリの環境変数のまま。ふつうは ~/.claude）
  claudeDir: string | null;
};

// 画面に渡すプロファイルの様子。current: その画面のプロファイル /
// othersAttention: ほかのプロファイルに、見てほしいもの（確認待ち・新しい応答）があるか（どのプロファイルかは出さない）
export type ProfilesState = {
  profiles: ProfileInfo[];
  current: string;
  othersAttention: boolean;
};

// プロファイルを足すときに画面から渡すもの。claudeDir は絶対パスか ~/ で始まるパス
export type NewProfile = { name: string; color: string; claudeDir: string };

// 色の選択肢
export const PROFILE_COLORS = ['#6d9ccf', '#d4835c', '#5fb98a', '#9083cf', '#d3ae5e', '#d98a82'] as const;
