import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

// ~/.claude 以外を設定のフォルダにする Claude Code に、読ませない指示ファイル（設定の claudeMdExcludes。絶対パスの glob）。
// Claude Code は、作業フォルダから親をたどって <親>/.claude/CLAUDE.md をプロジェクトの指示として読む。設定のフォルダが ~/.claude で
// なくなると、ホームの下のフォルダでは ~/.claude/CLAUDE.md が「ホームというプロジェクトの指示」として拾われ、ほかのプロファイルの決まりが
// 混ざる。そのうえ、プロジェクトの CLAUDE.md が見つかった扱いになって、リポジトリの AGENTS.md が読まれなくなる（2.1.296 で実測。
// CLAUDE.md を外すと AGENTS.md が戻る。rules は同じ探し方をするものとして外していて、確かめていない）。
// 設定のフォルダが ~/.claude のときは、ユーザーの指示そのものなので外さない
export function foreignClaudeMdExcludes(dir: string | null = null): string[] {
  const standard = join(homedir(), '.claude');
  if (resolve(claudeConfigDir(dir)) === standard) return [];
  return [join(standard, 'CLAUDE.md'), join(standard, 'rules', '**')];
}
