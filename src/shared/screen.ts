// pty の画面から読み取った、ユーザーの操作が必要な状態

export type MenuOption = {
  // 選択肢の番号。複数選択の「Submit」行は番号を持たないので 'submit'
  id: string;
  label: string;
  description: string;
  // 画面上で ❯ が付いている（カーソルがある）
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
  // question: AskUserQuestion / permission: ツール実行の許可 / other: フォルダの信頼確認など
  kind: 'question' | 'permission' | 'other';
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

// prompt: 通常の入力欄が出ている / menu: 選択メニュー / rewind: 巻き戻し先の一覧（/rewind）/
// unknown: 認識できない対話画面（/config など）
export type ScreenState =
  | { kind: 'starting' }
  | { kind: 'prompt' }
  | { kind: 'menu'; menu: Menu }
  | { kind: 'rewind'; pointed: string }
  | { kind: 'unknown' };

// 権限モード（Shift+Tab で manual → acceptEdits → plan → auto の順に切り替わる）
export type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

// model / effort / mode: 画面に出ている現在の値（起動時のバナーや入力欄の周りの表示から読む）
export type ScreenInfo = {
  state: ScreenState;
  model: string | null;
  effort: string | null;
  mode: PermissionMode | null;
  // Claude Code の入力欄に入っている文字（巻き戻し直後は戻した発言が入る）。灰色の入力例は含まない
  draft: string;
  // 起動が終わって、打ち込んだ文字を受け付けられる（入力欄が出て少し経った）。起動し直すまで戻らない。
  // 入力欄が出る前に送った文字は Claude Code が取りこぼす（スラッシュコマンドは入力欄に打たれたまま送信されない）
  ready: boolean;
};

// 作業中の画面のタイマーの行（例:「✳ Shimmying… (5s · ↓ 225 tokens · thought for 2s)」）から読んだ進み具合。
// waiting: 応答がまだ何も来ていない / thinking: 考えている / writing: 応答を受け取っている（トークン数が増えている）/
// working: それ以外（ツールの実行中など）
export type Activity = {
  phase: 'waiting' | 'thinking' | 'writing' | 'working';
  // 経過時間（画面の表記のまま。例: 5s・1m 5s）
  elapsed: string | null;
  // 受け取ったトークン数（画面の表記のまま。例: 225・1.2k）
  tokens: string | null;
};

// 画面の 1 行。full は右端まで文字がある（折り返しで次の行に続いている）
export type ScreenLine = { text: string; full: boolean };
