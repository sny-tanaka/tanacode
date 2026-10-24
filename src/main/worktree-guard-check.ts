import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { git } from './git';
import { branchesSafeToDelete, WORKTREES_DIR, worktreeSafeToRemove } from './worktree';

// worktree-guard（worktree-guard.ts）の awk が「確認を出させる」と決めたコマンドを、もう一度読み直して確かめる。
// 'pass' にするのは、コマンド全体が次の形だけでできているときに限る（それ以外は、awk の決めたとおり 'ask'）。
// - 消す操作: git branch -D <名前>…（-d と --force・--delete --force も）・git worktree remove [--force|-f] <パス>
// - 先頭に置いた 1 つの cd <パス>（引数は 1 つ）
// - つなぎは && ; 改行だけ。ほかのコマンド（echo・git status・git pull なども）が 1 つでも入れば ask
// - 名前・パスは書いたとおりの文字だけ（クォートは外す。$ ` * ? [ ] { } ~ @{ などがあれば ask）。git のグローバルオプション（-C など）も ask
// そのうえで、消す操作のどれもが、消して失うものが無いと git で確かめられたときだけ pass。
// - git branch -D: 手元にしか無いコミットが無い（worktree の片付けと同じ判定。worktree.ts の branchesSafeToDelete）
// - git worktree remove: tanacode が作った worktree（.claude/worktrees/ の下）で、失うものが無い（worktreeSafeToRemove）
// シェルの文法を広く読んで「許す形」を広く取ると、読み落としや、引数でコマンドを動かせるオプションから穴ができるので、
// 片付けのコマンドの形だけに絞る（誤検知が少し残るのは受け入れる）。
// 'pass' でも、フックは何も決めない（Claude Code のふだんの許可の決まりに任せる。allow は返さない。コマンドのほかの部分の確認まで
// 飛ばしてしまうため）

export type GuardVerdict = 'pass' | 'ask';

// 確かめを待つ上限（ミリ秒）。過ぎたら ask。gh の問い合わせ（github.ts。10 秒で打ち切る）を待てる長さにする
export const GUARD_DEADLINE_MS = 20_000;

// 読めない（受け付けない書き方がある）
class Unsupported extends Error {}

// 名前・パスに使えない文字（クォートの中にあっても、展開・別の意味になりうるもの）
const UNSAFE = /[$`*?[\]{}~\\\n]|@\{/;
// git branch -D で読む名前。refs/heads/<名前> として読めて、git branch -D がそれを消すと言い切れるものだけ
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/+-]+$/;

// コマンドの文字列を、&& ; 改行で区切ったコマンド（単語の並び）にする。受け付けるのは、書いたとおりの単語・単一引用符・
// 二重引用符（中に $ ` \ の無いもの）・単語の頭からのコメントだけ。ほかの記号（| & ( ) < > $ ` \ など）があれば Unsupported。
// 中身の無いコマンド（空の行・コメントだけの行・続いた区切り）は飛ばす
export function splitCommands(source: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (c === '#' && word === null) {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '\n' || c === ';') {
      endCommand();
      i++;
    } else if (source.startsWith('&&', i)) {
      endCommand();
      i += 2;
    } else if (c === "'" || c === '"') {
      const end = source.indexOf(c, i + 1);
      if (end < 0) throw new Unsupported('unterminated quote');
      const inner = source.slice(i + 1, end);
      if (c === '"' && /[$`\\]/.test(inner)) throw new Unsupported('expansion in double quotes');
      word = (word ?? '') + inner;
      i = end + 1;
    } else if (/[|&()<>$`\\!*?[\]{}~]/.test(c)) {
      throw new Unsupported(`unsupported character ${c}`);
    } else {
      word = (word ?? '') + c;
      i++;
    }
  }
  endCommand();
  return commands;
}

// 消す操作。cwd: そのコマンドを動かすフォルダ
type Delete = { kind: 'branch'; cwd: string; names: string[] } | { kind: 'worktree'; cwd: string; path: string; forces: number };

// コマンドから、消す操作を取り出す。受け付ける形でなければ null。消す操作が 1 つも無いものも null（awk の決めたとおり確認を出させる）
export function guardDeletes(command: string, cwd: string): Delete[] | null {
  let commands: string[][];
  try {
    commands = splitCommands(command);
  } catch {
    return null;
  }
  let dir = cwd;
  const deletes: Delete[] = [];
  for (const [index, words] of commands.entries()) {
    if (words.some((w) => w === '' || UNSAFE.test(w))) return null;
    if (words[0] === 'cd') {
      // 先頭の 1 つだけ。引数は 1 つ（zsh の cd 古い 新しい・オプションは読まない）
      if (index !== 0 || words.length !== 2 || words[1].startsWith('-')) return null;
      dir = resolve(cwd, words[1]);
      continue;
    }
    const del = deleteOf(words, dir);
    if (!del) return null;
    deletes.push(del);
  }
  return deletes.length > 0 ? deletes : null;
}

// git branch -D <名前>… か git worktree remove [--force] <パス> を読む。ほかの形なら null
function deleteOf(words: string[], dir: string): Delete | null {
  if (words[0] !== 'git') return null;
  if (words[1] === 'branch') return branchDelete(words.slice(2), dir);
  if (words[1] === 'worktree' && words[2] === 'remove') return worktreeRemove(words.slice(3), dir);
  return null;
}

// 長いオプション（--del のような省略形も）が、full の省略形か
const abbreviates = (word: string, full: string) => word.length > 2 && full.startsWith(word.slice(2));

function branchDelete(args: string[], dir: string): Delete | null {
  let del = false;
  let force = false;
  let strong = false;
  let ended = false;
  const names: string[] = [];
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('--')) {
      if (abbreviates(a, 'delete')) del = true;
      else if (abbreviates(a, 'force')) force = true;
      else return null;
    } else if (!ended && a.startsWith('-')) {
      if (!/^-[dDf]+$/.test(a)) return null;
      if (a.includes('D')) strong = true;
      if (a.includes('d')) del = true;
      if (a.includes('f')) force = true;
    } else names.push(a);
  }
  if (!strong && !(del && force)) return null;
  if (names.length === 0 || !names.every((n) => BRANCH_NAME.test(n))) return null;
  return { kind: 'branch', cwd: dir, names };
}

function worktreeRemove(args: string[], dir: string): Delete | null {
  let forces = 0;
  let ended = false;
  const paths: string[] = [];
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('--')) {
      if (!abbreviates(a, 'force')) return null;
      forces++;
    } else if (!ended && a.startsWith('-')) {
      if (!/^-f+$/.test(a)) return null;
      forces += a.length - 1;
    } else paths.push(a);
  }
  if (paths.length !== 1) return null;
  return { kind: 'worktree', cwd: dir, path: resolve(dir, paths[0]), forces };
}

// リポジトリの、共通の git のフォルダ（worktree どうしで同じ）。リポジトリでなければ null
async function commonDir(cwd: string): Promise<string | null> {
  const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => null);
  return out?.trim() || null;
}

// 確かめる。cwd: フックの入力の cwd（Claude Code の今のフォルダ）
export async function verifyCommand(command: string, cwd: string): Promise<GuardVerdict> {
  const deletes = guardDeletes(command, cwd);
  if (deletes === null) return 'ask';
  // リポジトリごとに、消すブランチと消す worktree をまとめて確かめる（一緒に消すブランチどうしで、互いのコミットを持つときに、
  // 両方を消してよいとしないように。一緒に消す worktree で取り出しているブランチは、取り出していないものとして数える）
  const repos = new Map<string, { cwd: string; root: string; branches: string[]; worktrees: { path: string; forces: number }[] }>();
  for (const d of deletes) {
    const common = await commonDir(d.cwd);
    if (!common || basename(common) !== '.git') return 'ask';
    let repo = repos.get(common);
    if (!repo) repos.set(common, (repo = { cwd: d.cwd, root: dirname(common), branches: [], worktrees: [] }));
    if (d.kind === 'branch') repo.branches.push(...d.names);
    else repo.worktrees.push({ path: d.path, forces: d.forces });
  }
  for (const repo of repos.values()) {
    for (const w of repo.worktrees) {
      if (!(await insideWorktrees(repo.root, w.path)) || !(await worktreeSafeToRemove(repo.root, w.path, w.forces))) return 'ask';
    }
    const removing = repo.worktrees.map((w) => w.path);
    if (repo.branches.length > 0 && !(await branchesSafeToDelete(repo.cwd, repo.branches, removing))) return 'ask';
  }
  return 'pass';
}

// tanacode が作る worktree の場所（<リポジトリ>/.claude/worktrees/<名前>）か
async function insideWorktrees(root: string, path: string): Promise<boolean> {
  const [base, target] = await Promise.all([realpath(join(root, WORKTREES_DIR)).catch(() => null), realpath(path).catch(() => null)]);
  if (!base || !target) return false;
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/');
}
