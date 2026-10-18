// tanacode や Claude Code の中のシェルでテストを流すと、そのセッションの環境変数（TANACODE_BROWSER_SOCKET・CLAUDE_CONFIG_DIR など）が
// テストと、テストが起動する claude に漏れる。漏れると、アプリの環境変数を写すテストが落ち、本物の claude を使うテスト（test/cli）は
// 使い捨てのホームではなく、そのセッションのプロファイルの設定のフォルダを使ってしまう。テストへの指定（KEEP）だけを残して消す
const KEEP = /^TANACODE_(CLAUDE_BIN|RECORD|AWK|E2E_)/;
// tanacode がチャットの claude に付ける変数（src/main/claude-session.ts の claudeEnv。FILE_CHECKPOINTING_ENV・CLASSIFIER_SUMMARY_ENV）。
// tanacode のチャットの中で流すと、ターミナルモードの claude には付けないことを確かめるテストが落ちる
const SESSION_ONLY = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_CLASSIFIER_SUMMARY']);

for (const key of Object.keys(process.env)) {
  if ((key.startsWith('TANACODE_') && !KEEP.test(key)) || SESSION_ONLY.has(key)) delete process.env[key];
}
