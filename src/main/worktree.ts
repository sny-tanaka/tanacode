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
// lock ファイルと、それを使うパッケージマネージャーの install のコマンド。同じフォルダに複数あれば、上のものを使う
// （npm 以外を使うリポジトリに、古い package-lock.json が残っていることがあるため）
const LOCKFILES: { file: string; command: string }[] = [
  { file: 'pnpm-lock.yaml', command: 'pnpm install' },
  { file: 'yarn.lock', command: 'yarn install' },
  { file: 'bun.lock', command: 'bun install' },
  { file: 'bun.lockb', command: 'bun install' },
  { file: 'package-lock.json', command: 'npm install' },
];
// yarn の Plug'n'Play（node_modules を使わない）。ふつうは gitignore されていて worktree に無く、yarn install するまで依存を読めない
const PNP_FILE = '.pnp.cjs';

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

// node_modules の用意の結果。場所は worktree からの相対（'' はいちばん上）
export type NodeModulesResult = {
  // 元のフォルダから複製した node_modules
  cloned: string[];
  // 複製できなかった node_modules（APFS 以外・別のボリューム）
  failed: string[];
  // install を実行した場所と、コマンド（npm install など）と、終了コード
  installs: { dir: string; command: string; exitCode: number }[];
};

type PrepareHooks = {
  onStep: (step: 'copying' | 'installing') => void;
  // worktree の cwd で install のコマンドを実行し、終了コードを返す（アプリはターミナルのタブに進み具合を出す）。dir: worktree からの相対
  install: (cwd: string, dir: string, command: string) => Promise<number>;
  // node_modules を複製する。既定は APFS のクローン（clonefile。書き換えるまでディスクは増えない）
  clone?: (from: string, to: string) => Promise<void>;
};

// lock ファイルのある場所と、そこで使うパッケージマネージャー
type LockDir = { dir: string; file: string; command: string };

// worktree に node_modules を用意する。モノレポ（workspaces や、サブフォルダごとのプロジェクト）にも対応するため、
// git で追跡している package.json の隣の node_modules を、元のフォルダから APFS のクローンで複製する（絶対パスの入るキャッシュは除く）。
// そのうえで、lock ファイル（package-lock.json・yarn.lock・pnpm-lock.yaml・bun.lock）の場所ごとに、そのパッケージマネージャーで install する。
// install するのは、lock が元のフォルダと違う場所と、複製できなかった node_modules を受け持つ場所（同じ場所か、いちばん近い上のフォルダ。
// workspaces ならリポジトリのいちばん上）と、yarn の Plug'n'Play で .pnp.cjs が worktree に無い場所。
// 元のフォルダで使っていない場所（node_modules も .pnp.cjs も無い）は何もしない。Python の .venv や Ruby の gem などは対象外
export async function prepareNodeModules(root: string, path: string, hooks: PrepareHooks): Promise<NodeModulesResult> {
  const result: NodeModulesResult = { cloned: [], failed: [], installs: [] };
  const dirs = await packageDirs(path);
  const has = (base: string, dir: string, name: string) => existsSync(join(base, dir, name));
  const targets: string[] = [];
  for (const dir of dirs) if ((await isDirectory(join(root, dir, 'node_modules'))) && !has(path, dir, 'node_modules')) targets.push(dir);

  if (targets.length > 0) hooks.onStep('copying');
  for (const dir of targets) {
    const to = join(path, dir, 'node_modules');
    try {
      await (hooks.clone ?? apfsClone)(join(root, dir, 'node_modules'), to);
      await Promise.all(ABSOLUTE_CACHES.map((name) => rm(join(to, name), { recursive: true, force: true }).catch(() => {})));
      result.cloned.push(dir);
    } catch {
      await rm(to, { recursive: true, force: true }).catch(() => {});
      result.failed.push(dir);
    }
  }

  // install できる場所。lock ファイルがあり、元のフォルダでも依存を入れているところ（node_modules か、yarn の .pnp.cjs がある）
  const lockDirs: LockDir[] = [];
  for (const dir of dirs) {
    const lock = LOCKFILES.find((l) => has(path, dir, l.file));
    if (lock && (has(root, dir, 'node_modules') || has(root, dir, PNP_FILE))) lockDirs.push({ dir, ...lock });
  }
  const installs = new Map<string, LockDir>();
  for (const lock of lockDirs) {
    const [mine, theirs] = await Promise.all([
      readFile(join(path, lock.dir, lock.file), 'utf8').catch(() => null),
      readFile(join(root, lock.dir, lock.file), 'utf8').catch(() => null),
    ]);
    if (mine !== theirs || (has(root, lock.dir, PNP_FILE) && !has(path, lock.dir, PNP_FILE))) installs.set(lock.dir, lock);
  }
  for (const dir of result.failed) {
    const owner = nearestLockDir(dir, lockDirs);
    if (owner) installs.set(owner.dir, owner);
  }
  if (installs.size === 0) return result;
  hooks.onStep('installing');
  // 上のフォルダから順に（workspaces のいちばん上の install が、下の node_modules も作る）
  for (const lock of [...installs.values()].sort((a, b) => a.dir.split('/').length - b.dir.split('/').length || a.dir.localeCompare(b.dir))) {
    result.installs.push({ dir: lock.dir, command: lock.command, exitCode: await hooks.install(join(path, lock.dir), lock.dir, lock.command) });
  }
  return result;
}

// git で追跡している package.json のあるフォルダ（worktree からの相対。'' はいちばん上）。node_modules の中は除く
async function packageDirs(path: string): Promise<string[]> {
  const out = await git(path, ['ls-files', '-z', '--', 'package.json', '*/package.json']).catch(() => null);
  if (out === null) return [''];
  const dirs = new Set<string>();
  for (const file of out.split('\0')) {
    if (!file || (file !== 'package.json' && !file.endsWith('/package.json'))) continue;
    if (file.split('/').includes('node_modules')) continue;
    dirs.add(file === 'package.json' ? '' : file.slice(0, -'/package.json'.length));
  }
  return [...dirs].sort();
}

// dir の node_modules を受け持つ lock ファイルの場所（同じフォルダか、いちばん近い上のフォルダ）
function nearestLockDir(dir: string, lockDirs: LockDir[]): LockDir | null {
  let best: LockDir | null = null;
  for (const lock of lockDirs) {
    const covers = lock.dir === '' || dir === lock.dir || dir.startsWith(`${lock.dir}/`);
    if (covers && (best === null || lock.dir.length > best.dir.length)) best = lock;
  }
  return best;
}

// ディレクトリ丸ごとを 1 回の clonefile(2) で複製するスクリプト（macOS 標準の osascript で動く JXA。clonefile を呼べるコマンドが無いため）
const CLONEFILE_JXA = [
  "ObjC.bindFunction('clonefile', ['int', ['char *', 'char *', 'unsigned int']]);",
  "function run(argv) { if ($.clonefile(argv[0], argv[1], 0) !== 0) throw new Error('clonefile'); }",
].join('\n');

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

// node_modules を APFS のクローンで複製する。cp -c -R はファイル 1 つごとにクローンするので、ファイルの多い node_modules では遅い
// （実測: 15 万ファイルで 44 秒。ディレクトリ丸ごとの clonefile なら 3 秒）。そのため、まず丸ごとの clonefile を試す。
// できなければ（別のボリューム・APFS 以外など）cp -c -R にする。こちらはクローンできなければ、通常のコピーになる。
// clonefile が途中までコピー先を作っていたら、cp を重ねずに失敗にする（呼び出し側が消す）
export async function apfsClone(from: string, to: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('APFS のクローンは macOS だけ');
  try {
    await run('osascript', ['-l', 'JavaScript', '-e', CLONEFILE_JXA, from, to]);
  } catch (error) {
    if (existsSync(to)) throw error;
    await run('cp', ['-c', '-R', from, to]);
  }
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
