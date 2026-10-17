// Claude Code が人の操作を待っているもの（質問・許可の確認）の形と、権限モード・作業の進み具合。
// 名前は、前に Claude Code の画面から読み取っていたころのまま（今は stream-json の要求と出力から作る）

export type MenuOption = {
  // 選択肢の番号。複数選択の「Submit」行は番号を持たないので 'submit'
  id: string;
  label: string;
  description: string;
  // 選んでいる（前は画面で ❯ が付いていたもの。今は使わず false）
  pointed: boolean;
  // 複数選択のチェック状態。単一選択では null
  checked: boolean | null;
  // AskUserQuestion の「Type something.」（選ぶと自由記述を入力できる）
  textInput: boolean;
  // AskUserQuestion の選択肢のプレビュー（比べるための図や文章。無ければ undefined）
  preview?: string;
};

// AskUserQuestion に渡された質問（会話ログの tool_use の input）。選択肢の中身はこちらを正とする
export type AskQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
};

export type Menu = {
  // question: AskUserQuestion / permission: ツール実行の許可（プランの承認を含む）
  kind: 'question' | 'permission';
  // AskUserQuestion で複数の質問があるときのタブ
  tabs: { label: string; answered: boolean }[];
  title: string;
  // 質問の上にある補足（実行しようとしているコマンドなど）
  context: string[];
  options: MenuOption[];
  multiSelect: boolean;
  hint: string;
  // 選択肢の右にプレビューの枠が並ぶ形（選択肢のどれかにプレビューがある AskUserQuestion）。
  // この形には自由記述（Type something）が無く、「Chat about this」は選択肢にならない
  previewLayout?: boolean;
};

// 権限モード（Shift+Tab で manual → acceptEdits → plan → auto の順に切り替わる）
export type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

// 作業の進み具合（stream-json の出力から作る。表記は Claude Code の画面のタイマーの行（例:「✳ Shimmying… (5s · ↓ 225 tokens)」）と同じ）。
// waiting: 応答がまだ何も来ていない / thinking: 考えている / writing: 応答を受け取っている（トークン数が増えている）/
// working: それ以外（ツールの実行中など）/ starting: 起動に時間がかかっている（initialize の返事を待っている。設計書 9 節）
export type Activity = {
  phase: 'starting' | 'waiting' | 'thinking' | 'writing' | 'working';
  // 経過時間（例: 5s・1m 5s）
  elapsed: string | null;
  // 受け取ったトークン数（例: 225・1.2k）
  tokens: string | null;
  // starting のときの、Claude Code の標準エラーの末尾（MCP サーバー・フックの出力や、止まっている理由が出ることがある）
  stderr?: string;
};
