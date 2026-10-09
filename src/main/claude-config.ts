import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code の設定のフォルダと状態のファイルの場所。Claude Code 自身と同じ決め方にする（アプリを CLAUDE_CONFIG_DIR 付きで
// 起動すると、アプリが起動する Claude Code もそれを受け継ぐので、アプリが読む場所もそろえる）。
// どれも呼んだときの環境変数とホームで決める（読み込んだときに決めない）

// 設定のフォルダ。CLAUDE_CONFIG_DIR が空でなければそこ、無ければ ~/.claude
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// 状態のファイル（.claude.json。ログインしたアカウント・/usage の控えなど）。CLAUDE_CONFIG_DIR があればその中、無ければホーム
export function claudeJsonPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
}

// フォルダ cwd の会話ログを置くフォルダ。Claude Code は cwd の英数字以外を '-' に置き換えた名前にする
export function projectLogDir(cwd: string): string {
  return join(claudeConfigDir(), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}
