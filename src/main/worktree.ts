import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { WorktreeLeftovers, WorktreeRemoval } from '@shared/ipc';
import { defaultBranch, git } from './git';

// claude --worktree <名前> で始めるセッション。worktree は Claude Code が作る（元のフォルダへの書き込みや git の操作を止める、
// Claude Code の隔離のチェックを生かすため）。場所は、リポジトリのいちばん上の .claude/worktrees/<名前>、ブランチは worktree-<名前>。
// アプリは名前を決め、node_modules を用意し、アーカイブ・一覧からの削除のときに消す（Claude Code の終了時の確認は、
// アプリがプロセスを止めるので出ず、Claude Code の自動の掃除も --worktree のセッションは対象外のため）

export const WORKTREES_DIR = '.claude/worktrees';
// Claude Code が worktree に付けるロックの理由（「claude session <名前> (pid … start …)」）。プロセスを止めても残る
const CLAUDE_LOCK = /^claude session /;
// node_modules の中の、絶対パスが入るキャッシュ。複製しても使えないので消す
const ABSOLUTE_CACHES = ['.vite', '.cache'];
// npm 以外のパッケージマネージャーの印。あれば npm install はしない
const OTHER_LOCKFILES = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];

export type WorktreeRef = { name: string; branch: string; root: string };
export type WorktreePlan = WorktreeRef & { path: string };

export function worktreeBranch(name: string): string {
  return `worktree-${name}`;
}

export function worktreePath(root: string, name: string): string {
  return join(root, WORKTREES_DIR, name);
}

// cwd から、worktree を作る場所と名前を決める。Claude Code はサブフォルダから始めても、リポジトリのいちばん上に作る（実測）。
// git のリポジトリでない・まだコミットが無いときは、理由を添えて失敗する
export async function planWorktree(cwd: string): Promise<WorktreePlan> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel']).then(
    (out) => out.trim(),
    () => null,
  );
  if (!root) throw new Error('worktree で始めるには、git のリポジトリのフォルダを選んでください');
  const hasHead = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(
    () => true,
    () => false,
  );
  if (!hasHead) throw new Error('worktree で始めるには、リポジトリにコミットが 1 つ以上必要です');
  for (let i = 0; i < 20; i++) {
    const name = worktreeName();
    const path = worktreePath(root, name);
    const branch = worktreeBranch(name);
    if (existsSync(path) || (await branchExists(root, branch))) continue;
    return { name, branch, root, path };
  }
  throw new Error('worktree の名前を決められませんでした');
}

// 名前は月日と短い乱数（例: tc-1002-k3x9）。ブランチ名にもなるので、英小文字と数字だけにする
function worktreeName(now = new Date()): string {
  const date = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const random = [...randomBytes(4)].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  return `tc-${date}-${random}`;
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  return git(root, ['show-ref', '--verify', '-q', `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
}

// 元のフォルダのソース管理で、worktree が未追跡に出ないようにする。.gitignore で無視されていなければ、
// コミットされない .git/info/exclude に足す（リポジトリの .gitignore は書き換えない）
export async function hideWorktrees(root: string): Promise<void> {
  const ignored = await git(root, ['check-ignore', '-q', '--', `${WORKTREES_DIR}/x`]).then(
    () => true,
    () => false,
  );
  if (ignored) return;
  const rel = (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).trim();
  const file = isAbsolute(rel) ? rel : resolve(root, rel);
  await mkdir(dirname(file), { recursive: true });
  const text = await readFile(file, 'utf8').catch(() => '');
  const head = text === '' || text.endsWith('\n') ? '' : '\n';
  await appendFile(file, `${head}# tanacode: Claude Code の worktree（claude --worktree）\n/${WORKTREES_DIR}/\n`);
}

// Claude Code が worktree を作るのを待つ。alive が false になったら（Claude Code が終わった）あきらめる
export async function waitForWorktree(path: string, alive: () => boolean, timeoutMs = 60_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // .git（worktree の印のファイル）ができたら、git worktree add が済んでいる
    if (existsSync(join(path, '.git'))) return true;
    if (!alive()) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// 消した worktree を、残したブランチから作り直す（アーカイブから戻すとき）。ブランチも無ければ（マージ済みで消えた）、
// 元のフォルダの今の HEAD から同じ名前のブランチで作る。Claude Code は、同じ場所に worktree があれば --resume でそこに戻る（実測）
export async function restoreWorktree(ref: WorktreeRef, path: string): Promise<void> {
  // フォルダを手で消したときは、git に残った登録を先に片付ける
  await git(ref.root, ['worktree', 'prune']).catch(() => '');
  if (await branchExists(ref.root, ref.branch)) await git(ref.root, ['worktree', 'add', path, ref.branch]);
  else await git(ref.root, ['worktree', 'add', '-b', ref.branch, path]);
}

export type NodeModulesResult =
  // 元のフォルダに node_modules が無い・worktree にもうある
  | { kind: 'none' }
  // クローンした（installExitCode: package-lock.json が元のフォルダと違ったので、続けて npm install したときの終了コード）
  | { kind: 'cloned'; installExitCode: number | null }
  // クローンできなかったので npm install した（npm のプロジェクトでなければ、何もしない）
  | { kind: 'installed'; exitCode: number }
  | { kind: 'failed'; message: string };

type PrepareHooks = {
  onStep: (step: 'copying' | 'installing') => void;
  // worktree で npm install を実行し、終了コードを返す（アプリはターミナルのタブに進み具合を出す）
  install: (cwd: string) => Promise<number>;
  // node_modules を複製する。既定は APFS のクローン（cp -c -R。書き換えるまでディスクは増えない）
  clone?: (from: string, to: string) => Promise<void>;
};

// worktree に node_modules を用意する。元のフォルダの node_modules を APFS のクローンで複製し、絶対パスの入るキャッシュは除く。
// package-lock.json が元のフォルダと違えば、続けて npm install。クローンできなければ（APFS 以外・別のボリューム）npm install。
// 元のフォルダに node_modules が無ければ何もしない。対象は npm だけ（Python の .venv などは対象外）
export async function prepareNodeModules(root: string, path: string, hooks: PrepareHooks): Promise<NodeModulesResult> {
  const from = join(root, 'node_modules');
  const to = join(path, 'node_modules');
  if (!(await isDirectory(from)) || existsSync(to)) return { kind: 'none' };
  hooks.onStep('copying');
  try {
    await (hooks.clone ?? apfsClone)(from, to);
  } catch {
    await rm(to, { recursive: true, force: true }).catch(() => {});
    if (!(await usesNpm(path))) return { kind: 'failed', message: 'node_modules を複製できませんでした' };
    hooks.onStep('installing');
    return { kind: 'installed', exitCode: await hooks.install(path) };
  }
  await Promise.all(ABSOLUTE_CACHES.map((name) => rm(join(to, name), { recursive: true, force: true }).catch(() => {})));
  const [mine, theirs] = await Promise.all([readFile(join(path, 'package-lock.json'), 'utf8').catch(() => null), readFile(join(root, 'package-lock.json'), 'utf8').catch(() => null)]);
  if (mine === theirs || !(await usesNpm(path))) return { kind: 'cloned', installExitCode: null };
  hooks.onStep('installing');
  return { kind: 'cloned', installExitCode: await hooks.install(path) };
}

function apfsClone(from: string, to: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('APFS のクローンは macOS だけ'));
  return new Promise((resolve, reject) => {
    execFile('cp', ['-c', '-R', from, to], (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

// npm のプロジェクトか（package.json があり、ほかのパッケージマネージャーの lockfile が無い）
async function usesNpm(path: string): Promise<boolean> {
  if (!existsSync(join(path, 'package.json'))) return false;
  return !OTHER_LOCKFILES.some((name) => existsSync(join(path, name)));
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

type ListedWorktree = { path: string; locked: string | null };

// git worktree list --porcelain。locked: ロックの理由（理由なしのロックは ''）
async function listWorktrees(root: string): Promise<ListedWorktree[]> {
  const out = await git(root, ['worktree', 'list', '--porcelain']).catch(() => '');
  const list: ListedWorktree[] = [];
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!path) continue;
    const lock = lines.find((l) => l === 'locked' || l.startsWith('locked '));
    list.push({ path, locked: lock === undefined ? null : unquote(lock.slice('locked'.length).trim()) });
  }
  return list;
}

// git が " で囲み、日本語などを \345 のような 8 進数にした文字を、元に戻す
function unquote(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  const bytes: number[] = [];
  const body = text.slice(1, -1);
  const escapes: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else {
      bytes.push(...Buffer.from(escapes[body[i + 1]] ?? body[i + 1] ?? '', 'utf8'));
      i++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// macOS の /tmp と /private/tmp のように、同じフォルダの別の書き方を比べられるようにする
async function samePath(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const [ra, rb] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return ra === rb;
}

async function findWorktree(root: string, path: string): Promise<ListedWorktree | null> {
  for (const w of await listWorktrees(root)) if (await samePath(w.path, path)) return w;
  return null;
}

// worktree を消す前に、残っているもの（未コミットの変更・未追跡のファイル・プッシュしていないコミット・デフォルトブランチに入っていないコミット）
export async function worktreeLeftovers(ref: WorktreeRef, path: string): Promise<WorktreeLeftovers> {
  const exists = existsSync(path) && (await findWorktree(ref.root, path)) !== null;
  let uncommitted = 0;
  let untracked = 0;
  if (exists) {
    const parts = (await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => '')).split('\0');
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i];
      if (item.length < 4) continue;
      if (item.startsWith('??')) untracked++;
      else uncommitted++;
      // リネーム・コピーは、次の要素が元のパス
      if (item[0] === 'R' || item[0] === 'C') i++;
    }
  }
  const hasBranch = await branchExists(ref.root, ref.branch);
  const count = (args: string[]) =>
    git(ref.root, ['rev-list', '--count', ...args]).then(
      (out) => Number(out.trim()) || 0,
      () => 0,
    );
  let unpushed = 0;
  let unmerged: number | null = null;
  const base = await defaultBranch(ref.root);
  if (hasBranch) {
    const upstream = await git(ref.root, ['rev-parse', '--abbrev-ref', `${ref.branch}@{u}`]).then(
      (out) => out.trim() || null,
      () => null,
    );
    // 上流が無ければ、このブランチだけにあって、どのリモートにも無いコミット（元にしたブランチのコミットは数えない）
    unpushed = upstream
      ? await count([`${upstream}..${ref.branch}`])
      : await count([ref.branch, '--not', '--remotes', `--exclude=${ref.branch}`, '--branches']);
    if (base) {
      const target = (await branchExists(ref.root, base)) ? base : `origin/${base}`;
      unmerged = await count([ref.branch, '--not', target]);
    }
  } else if (base) {
    unmerged = 0;
  }
  return { exists, branch: ref.branch, uncommitted, untracked, unpushed, unmerged, defaultBranch: base };
}

// worktree を消す。Claude Code は先に止めておくこと。
// 1. 未コミットの変更や未追跡のファイルがあれば、一時的なインデックスでコミットにし、refs/tanacode/backup/<名前> に控えを残す
// 2. git worktree remove。中身が残っているときだけ、控えを取ったうえで --force
// 3. git branch -d。マージ済みのときだけ消える。まだどこにも入っていないコミットは、ブランチごと残す
// Claude Code が付けたロックは外す。ほかのロック（ユーザーが付けたもの）があれば、消さずに理由を添えて失敗する
export async function removeWorktree(ref: WorktreeRef, path: string): Promise<WorktreeRemoval> {
  let backupRef: string | null = null;
  const listed = await findWorktree(ref.root, path);
  if (listed && existsSync(path)) {
    if (listed.locked !== null) {
      if (!CLAUDE_LOCK.test(listed.locked)) {
        throw new Error(`worktree がロックされているため、消しませんでした${listed.locked ? `（${listed.locked}）` : ''}`);
      }
      await git(ref.root, ['worktree', 'unlock', path]);
    }
    const dirty = (await git(path, ['status', '--porcelain', '--untracked-files=all'])).trim() !== '';
    if (dirty) backupRef = await backupChanges(ref, path);
    await git(ref.root, ['worktree', 'remove', ...(dirty ? ['--force'] : []), path]);
  } else {
    // フォルダがもう無い（手で消した）。git に残った登録だけを片付ける
    if (listed?.locked && CLAUDE_LOCK.test(listed.locked)) {
      await git(ref.root, ['worktree', 'unlock', path]).catch(() => '');
    }
    await git(ref.root, ['worktree', 'prune']).catch(() => '');
  }
  let branchKept = false;
  if (await branchExists(ref.root, ref.branch)) {
    branchKept = await git(ref.root, ['branch', '-d', ref.branch]).then(
      () => false,
      () => true,
    );
  }
  return { backupRef, branch: ref.branch, branchKept };
}

// 未コミットの変更と未追跡のファイル（.gitignore で無視されるものは除く）を、ふだんのインデックスに触らずにコミットにして、ref に残す
async function backupChanges(ref: WorktreeRef, path: string): Promise<string> {
  const index = join(tmpdir(), `tanacode-index-${randomBytes(6).toString('hex')}`);
  const env = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'tanacode',
    GIT_AUTHOR_EMAIL: 'tanacode@localhost',
    GIT_COMMITTER_NAME: 'tanacode',
    GIT_COMMITTER_EMAIL: 'tanacode@localhost',
  };
  try {
    await git(path, ['read-tree', 'HEAD'], undefined, env);
    await git(path, ['add', '-A', '--', '.'], undefined, env);
    const tree = (await git(path, ['write-tree'], undefined, env)).trim();
    const message = `tanacode: worktree ${ref.name} を消す前の、未コミットの変更と未追跡のファイル`;
    const commit = (await git(path, ['commit-tree', tree, '-p', 'HEAD', '-m', message], undefined, env)).trim();
    const name = await freeBackupRef(ref.root, ref.name);
    await git(ref.root, ['update-ref', name, commit]);
    return name;
  } finally {
    await rm(index, { force: true }).catch(() => {});
  }
}

// 同じ名前の控えがあれば、番号を付けて分ける（前の控えを上書きしない）
async function freeBackupRef(root: string, name: string): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = `refs/tanacode/backup/${name}${i === 1 ? '' : `-${i}`}`;
    const taken = await git(root, ['show-ref', '--verify', '-q', candidate]).then(
      () => true,
      () => false,
    );
    if (!taken) return candidate;
  }
}
