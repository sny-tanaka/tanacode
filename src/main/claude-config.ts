import { readFileSync, realpathSync } from 'node:fs';
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

// フォルダ cwd の会話ログを置くフォルダ。Claude Code は cwd の英数字以外を '-' に置き換えた名前にする。
// Claude Code の cwd はリンクを解いた実体のパス（/tmp で始めると /private/tmp）なので、こちらも解いてから名前にする。無いフォルダはそのまま
export function projectLogDir(cwd: string, dir: string | null = null): string {
  return join(claudeConfigDir(dir), 'projects', realCwd(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

// ~/.claude 以外を設定のフォルダにする Claude Code に、読ませない指示ファイル（設定の claudeMdExcludes。絶対パスの glob）。
// Claude Code は、作業フォルダから親をたどって <親>/.claude/CLAUDE.md をプロジェクトの指示として読む。設定のフォルダが ~/.claude で
// なくなると、ホームの下のフォルダでは ~/.claude/CLAUDE.md が「ホームというプロジェクトの指示」として拾われ、ほかのプロファイルの決まりが
// 混ざる。そのうえ、プロジェクトの CLAUDE.md が見つかった扱いになって、リポジトリの AGENTS.md が読まれなくなる（2.1.296 で実測。
// CLAUDE.md を外すと AGENTS.md が戻る）。~/.claude/rules/*.md も同じく「プロジェクトの決まり」として読まれ、CLAUDE.md だけを外しても残る
// （2.1.302 で実測。rules/** も外すと読まれない）。
// 設定のフォルダが ~/.claude のときは、ユーザーの指示そのものなので外さない
export function foreignClaudeMdExcludes(dir: string | null = null): string[] {
  const standard = join(homedir(), '.claude');
  if (resolve(claudeConfigDir(dir)) === standard) return [];
  return [join(standard, 'CLAUDE.md'), join(standard, 'rules', '**')];
}

// 設定の権限モードの既定（permissions.defaultMode）。Claude Code の設定の強さの順（--settings で渡すファイル → そのフォルダの
// .claude/settings.local.json → .claude/settings.json → 設定のフォルダの settings.json）に探し、最初に見つかったもの。無ければ null。
// flagFile: --settings で渡すファイル（登録した設定ファイルを合わせたもの。無ければ null）
export function settingsDefaultMode(cwd: string, flagFile: string | null, dir: string | null = null): string | null {
  const files = [flagFile, join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'), join(claudeConfigDir(dir), 'settings.json')];
  for (const file of files) {
    if (!file) continue;
    try {
      const settings = JSON.parse(readFileSync(file, 'utf8')) as { permissions?: { defaultMode?: unknown } };
      const mode = settings?.permissions?.defaultMode;
      if (typeof mode === 'string' && mode) return mode;
    } catch {
      // 無い・読めない設定は飛ばす
    }
  }
  return null;
}
