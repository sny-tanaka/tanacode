import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code の設定のフォルダと状態のファイルの場所。Claude Code 自身と同じ決め方にする（アプリを CLAUDE_CONFIG_DIR 付きで
// 起動すると、アプリが起動する Claude Code もそれを受け継ぐので、アプリが読む場所もそろえる）。
// dir: プロファイルの設定のフォルダ（プロファイルの Claude Code には CLAUDE_CONFIG_DIR として渡す）。null は既定のプロファイルで、
// アプリの環境変数のまま。どれも呼んだときの環境変数とホームで決める（読み込んだときに決めない）

// 設定のフォルダ。dir が無ければ、CLAUDE_CONFIG_DIR が空でなければそこ、無ければ ~/.claude
export function claudeConfigDir(dir: string | null = null): string {
  return dir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
}

// 状態のファイル（.claude.json。ログインしたアカウント・/usage の控えなど）。設定のフォルダを指定していればその中、無ければホーム
export function claudeJsonPath(dir: string | null = null): string {
  return join(dir ?? (process.env.CLAUDE_CONFIG_DIR || homedir()), '.claude.json');
}

// フォルダ cwd の会話ログを置くフォルダ。Claude Code は cwd の英数字以外を '-' に置き換えた名前にする
export function projectLogDir(cwd: string, dir: string | null = null): string {
  return join(claudeConfigDir(dir), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}
