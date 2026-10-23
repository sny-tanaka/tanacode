import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { claudeConfigDir } from './claude-config';

// Claude がセッションのフォルダ（と追加したフォルダ）の外で読んだ・書いたファイルを、エクスプローラーに出す単位。
// git のリポジトリの中なら、そのリポジトリのいちばん上（folder）。どのリポジトリにも入っていなければ、ファイルそのもの（file）
export type OutsideRead = { kind: 'folder' | 'file'; path: string };

// 出さない場所。excluded: この中のファイルは出さない（Claude Code の設定のフォルダと一時フォルダ）。
// home: このフォルダとその上は、リポジトリでもフォルダとしては出さない（ホームが dotfiles のリポジトリでも、ホーム全体を出さない）
export type OutsideRules = { excluded: string[]; home: string };

// claudeDir: プロファイルの設定のフォルダ（claudeConfigDir に渡すもの）。リンクの先（/tmp → /private/tmp など）も並べる。
// 一時フォルダは os.tmpdir()（macOS ではユーザーごとの /var/folders/…/T。実体は /private/var/folders/…/T）と /tmp
export function outsideRules(claudeDir: string | null = null): OutsideRules {
  const dirs = [claudeConfigDir(claudeDir), tmpdir(), '/tmp'];
  const excluded = new Set<string>();
  for (const dir of dirs) {
    excluded.add(normalize(dir));
    excluded.add(real(dir));
  }
  return { excluded: [...excluded], home: real(homedir()) };
}

// ファイル file（絶対パス）を出す単位。出さないものは null。
// cwd: セッションのフォルダ。それを含むリポジトリ（worktree のときの元のリポジトリなど）は、ホームと同じく、フォルダとしては出さない
// （元のリポジトリのファイルを 1 つ読んだだけで、作業フォルダごと元のリポジトリ全体をツリーに出して見張ることになるため）
export function outsideReadOf(file: string, rules: OutsideRules, cwd: string | null = null): OutsideRead | null {
  if (!isAbsolute(file)) return null;
  const path = normalize(file);
  if (rules.excluded.some((dir) => within(dir, path))) return null;
  const repo = repoRoot(dirname(path));
  if (repo && !within(repo, rules.home) && !(cwd && within(repo, cwd))) return { kind: 'folder', path: repo };
  return { kind: 'file', path };
}

// path が folder そのものか、その中
export function within(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// dir から上へたどって、最初に .git（フォルダか、worktree のファイル）があるフォルダ。ディスクのいちばん上は除く
function repoRoot(dir: string): string | null {
  for (let d = dir; dirname(d) !== d; d = dirname(d)) if (existsSync(join(d, '.git'))) return d;
  return null;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return normalize(path);
  }
}
