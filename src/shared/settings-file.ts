// 登録した Claude Code の設定ファイル（settings.json と同じ形）。セッションごとに選ぶと、標準の設定（~/.claude/settings.json など）に重ねて Claude Code を起動する。
// 例: 接続先（ANTHROPIC_BASE_URL・API キー）や model を書いた ~/.claude/settings-litellm.json を登録して、Team プランのログインと切り替える。
// アプリが覚えるのは名前とパスだけで、ファイルの中身（API キーなど）は預からない
export type SettingsFile = {
  // 登録のときに振る ID。名前を変えても、セッションの記録が指す先は変わらない
  id: string;
  name: string;
  // 設定ファイルの絶対パス
  path: string;
  // 読めないときの理由（ファイルが無い・JSON として読めないなど）。読めれば null
  error: string | null;
  // 設定ファイルの model。あれば、モデルを選ばないときのモデルになる
  model: string | null;
};
