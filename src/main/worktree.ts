import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { WorktreeLeftovers, WorktreePr, WorktreeRemoval } from '@shared/ipc';
import { defaultBranch, git } from './git';
import { type PullRequest, pullRequestsOf } from './github';

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
// 手元でスカッシュマージしたものを見分けるときに、デフォルトブランチの履歴で確かめる時点の数と、絞り込みに使うファイルの数の上限
const MAX_MERGE_CHECKS = 100;
const MAX_MERGE_CHECK_PATHS = 1000;
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

// worktree を消す前に、残っているもの（未コミットの変更・未追跡のファイル・プッシュしていないコミット）と、ブランチから作った PR
export async function worktreeLeftovers(ref: WorktreeRef, path: string): Promise<WorktreeLeftovers> {
  // PR は GitHub に問い合わせるので、数えている間に調べておく
  const lookup = pullRequestsOf(ref.root, await pushedBranchName(ref.root, ref.branch));
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
  const prs = await lookup;
  const local: LocalOnly = hasBranch ? await localOnlyCommits(ref.root, ref.branch, prs) : { count: 0, contentIn: null, heads: [] };
  let pr: WorktreePr = { state: prs ? 'none' : 'unknown' };
  const found = prs && pickPullRequest(prs);
  if (found) {
    // PR の head のあとに、手元で足したコミット
    const after = !hasBranch ? 0 : local.heads.includes(found.headRefOid) ? await countCommits(ref.root, [ref.branch, '--not', found.headRefOid]) : null;
    const state = ({ OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const)[found.state];
    pr = { state, number: found.number, base: found.baseRefName, url: found.url, after };
  }
  return { exists, branch: ref.branch, uncommitted, untracked, unpushed: local.count ?? 0, contentIn: local.contentIn, pr };
}

type LocalOnly = {
  // 手元にしか無いコミットの数（数えられなければ null）
  count: number | null;
  // 手元にしか無いコミットはあるが、中身が入っているデフォルトブランチ（このときの count は 0）
  contentIn: string | null;
  // PR の head のうち、手元にあるコミット
  heads: string[];
};

// branch の、手元にしか無いコミット。上流があれば上流に無いもの、無ければどのリモートにも、ほかのブランチにも無いもの
// （元にしたブランチのコミットは数えない）。PR の head に入っているコミットは、マージのあとにリモートのブランチを消していても
// GitHub にあるので数えない。それでも残れば、PR を使わずに手元でスカッシュマージ・cherry-pick したものかもしれないので、
// 中身がデフォルトブランチに入っているかを比べ、入っていれば 0 とみなす
async function localOnlyCommits(root: string, branch: string, prs: PullRequest[] | null): Promise<LocalOnly> {
  const heads = prs ? await localCommits(root, prs.map((p) => p.headRefOid)) : [];
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', `${branch}@{u}`]).then(
    (out) => out.trim() || null,
    () => null,
  );
  const count = await countCommits(
    root,
    upstream ? [branch, '--not', upstream, ...heads] : [branch, '--not', ...heads, '--remotes', `--exclude=${branch}`, '--branches'],
  );
  if (!count) return { count, contentIn: null, heads };
  const base = await defaultBranch(root);
  const targets = base ? await defaultBranchRefs(root, base) : [];
  if (targets.length > 0 && (await mergedInto(root, branch, targets))) return { count: 0, contentIn: base, heads };
  return { count, contentIn: null, heads };
}

// rev-list --count。数えられなければ null
function countCommits(root: string, args: string[]): Promise<number | null> {
  return git(root, ['rev-list', '--count', ...args]).then(
    (out) => (/^\d+$/.test(out.trim()) ? Number(out.trim()) : null),
    () => null,
  );
}

// branch をプッシュした先の、リモートのブランチの名前（PR の head はこの名前）。上流が無ければ、同じ名前
export async function pushedBranchName(root: string, branch: string): Promise<string> {
  const merge = await git(root, ['config', '--get', `branch.${branch}.merge`]).then(
    (out) => out.trim(),
    () => '',
  );
  return merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : branch;
}

// PR がいくつかあれば、開いているもの → マージ済み → 閉じたものの順に、新しいもの（gh は新しい順に返す）
function pickPullRequest(prs: PullRequest[]): PullRequest | null {
  for (const state of ['OPEN', 'MERGED', 'CLOSED'] as const) {
    const found = prs.find((p) => p.state === state);
    if (found) return found;
  }
  return null;
}

// oids のうち、手元にあるコミット（無いコミットを rev-list の --not に渡すと失敗するので、先に除く）
async function localCommits(root: string, oids: string[]): Promise<string[]> {
  const candidates = [...new Set(oids.filter((oid) => /^[0-9a-f]{40,64}$/.test(oid)))];
  const found = await Promise.all(
    candidates.map((oid) =>
      git(root, ['cat-file', '-e', `${oid}^{commit}`]).then(
        () => true,
        () => false,
      ),
    ),
  );
  return candidates.filter((_, i) => found[i]);
}

// デフォルトブランチとして比べる先。手元のブランチと origin のもの（あるものだけ）
async function defaultBranchRefs(root: string, base: string): Promise<string[]> {
  const refs = [`refs/heads/${base}`, `refs/remotes/origin/${base}`];
  const found = await Promise.all(
    refs.map((r) =>
      git(root, ['show-ref', '--verify', '-q', r]).then(
        () => true,
        () => false,
      ),
    ),
  );
  return refs.filter((_, i) => found[i]);
}

// branch の中身が、もう targets（デフォルトブランチ）に入っているか。スカッシュマージ・cherry-pick ではコミットが作り直されて
// ハッシュが変わるので、中身で比べる。targets の、branch と分かれたあとの時点（今の先頭と、branch が変えたファイルに触れたコミットを
// 古い順に）のどこかで、branch をマージしても何も変わらなければ、入っている（マージのあとにデフォルトブランチで同じところを
// 変えていても見つかる）。衝突を直してからマージしたものは見分けられず、入っていない側に倒れる
async function mergedInto(root: string, branch: string, targets: string[]): Promise<boolean> {
  const ahead = await countCommits(root, [branch, '--not', ...targets]);
  if (ahead === 0) return true;
  if (ahead === null) return false;
  const changed = await git(root, ['diff', '--name-only', '-z', `${targets[0]}...${branch}`]).then(
    (out) => out.split('\0').filter(Boolean),
    () => null,
  );
  if (changed === null) return false;
  // 変えたファイルが多すぎるときは、ファイルで絞らない（コマンドの長さの上限を超えないように）
  const paths = changed.length > 0 && changed.length <= MAX_MERGE_CHECK_PATHS ? ['--', ...changed] : [];
  const tips = await git(root, ['log', '--no-walk', '--format=%H %T', ...targets]).catch(() => '');
  const history = await git(root, ['--literal-pathspecs', 'log', '--format=%H %T', '--reverse', ...targets, '--not', branch, ...paths]).catch(() => '');
  const points = [...new Set([...tips.split('\n'), ...history.split('\n')].filter(Boolean))].slice(0, MAX_MERGE_CHECKS);
  for (const point of points) {
    const [commit, tree] = point.split(' ');
    // 衝突したら失敗する（終了コード 1）ので、入っていない時点として次へ
    const merged = await git(root, ['merge-tree', '--write-tree', commit, branch]).then(
      (out) => out.split('\n')[0].trim(),
      () => null,
    );
    if (merged === tree) return true;
  }
  return false;
}

// branch を消しても、どのコミットも失われないか（手元にしか無いコミットが無い）
async function safeToDelete(root: string, branch: string): Promise<boolean> {
  const prs = await pullRequestsOf(root, await pushedBranchName(root, branch));
  return (await localOnlyCommits(root, branch, prs)).count === 0;
}

// worktree を消す。Claude Code は先に止めておくこと。
// 1. 未コミットの変更や未追跡のファイルがあれば、一時的なインデックスでコミットにし、refs/tanacode/backup/<名前> に控えを残す
// 2. gitignore されたフォルダ（node_modules など）を、.git の中のごみ箱へ動かす。git worktree remove に消させると、
//    ファイルの多い node_modules で 20〜30 秒かかる（APFS のファイル削除が遅い）。動かすだけなら一瞬で、中身の削除は 5. で裏に回す
// 3. git worktree remove。中身が残っているときだけ、控えを取ったうえで --force。失敗したら、2. で動かしたものを戻す
// 4. git branch -d。上流か今のブランチにマージ済みのときだけ消える。消えなくても、手元にしか無いコミットが無ければ（PR をスカッシュマージした・
//    リモートの別のブランチに直接プッシュした・手元でデフォルトブランチにスカッシュマージしたなど）-D で消す。手元にしか無いコミットがあれば、
//    ブランチごと残す
// 5. ごみ箱の中身を、裏で削除する（待たない）
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
    const aside = await setAsideIgnoredDirs(ref, path);
    try {
      await git(ref.root, ['worktree', 'remove', ...(dirty ? ['--force'] : []), path]);
    } catch (error) {
      await aside.restore();
      throw error;
    }
    aside.discard();
  } else {
    // フォルダがもう無い（手で消した）。git に残った登録だけを片付ける
    if (listed?.locked && CLAUDE_LOCK.test(listed.locked)) {
      await git(ref.root, ['worktree', 'unlock', path]).catch(() => '');
    }
    await git(ref.root, ['worktree', 'prune']).catch(() => '');
  }
  let branchKept = false;
  if (await branchExists(ref.root, ref.branch)) {
    const deleteBranch = (force: boolean) =>
      git(ref.root, ['branch', force ? '-D' : '-d', ref.branch]).then(
        () => true,
        () => false,
      );
    branchKept = !(await deleteBranch(false)) && !((await safeToDelete(ref.root, ref.branch)) && (await deleteBranch(true)));
  }
  return { backupRef, branch: ref.branch, branchKept };
}

// worktree の中の、gitignore されたフォルダ（node_modules・dist など）の動かし先。.git の中なので、worktree と同じボリューム
// （リネームだけで済み、ファイルは 1 つも触らない）で、ソース管理にも出ない
const TRASH_DIR = 'tanacode-trash';
// 使っているごみ箱（動かしてから git worktree remove の結果を待っている間と、裏で削除している間）。
// 別の worktree の削除が、ほかの削除のごみ箱を消し残しと間違えて消さないように覚えておく
const trashing = new Set<string>();

export type AsideDirs = {
  // 動かしたフォルダを、元の場所に戻す（git worktree remove に失敗したとき）
  restore: () => Promise<void>;
  // 動かしたフォルダを、裏で削除する。待たない。前に消し残したごみ箱も、あわせて片付ける
  discard: () => void;
};

// worktree の中の、gitignore されたフォルダを、ごみ箱へ動かす。動かせなかったフォルダ（別のボリュームなど）は、
// そのまま git worktree remove が消す（遅いだけで、結果は同じ）
export async function setAsideIgnoredDirs(ref: WorktreeRef, path: string): Promise<AsideDirs> {
  const moved: { from: string; to: string }[] = [];
  let trash: string | null = null;
  try {
    const gitDir = resolve(ref.root, (await git(ref.root, ['rev-parse', '--git-common-dir'])).trim());
    // --directory: 無視されたフォルダは、中に入らずフォルダ名だけを出す（末尾が /）
    const listed = await git(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
    const dirs = listed.split('\0').filter((entry) => entry.endsWith('/'));
    if (dirs.length > 0) {
      trash = join(gitDir, TRASH_DIR, `${ref.name}-${randomBytes(3).toString('hex')}`);
      trashing.add(trash);
      await mkdir(trash, { recursive: true });
      for (const dir of dirs) {
        const from = join(path, dir.slice(0, -1));
        const to = join(trash, String(moved.length));
        await rename(from, to).then(
          () => moved.push({ from, to }),
          () => {},
        );
      }
    }
    const root = join(gitDir, TRASH_DIR);
    return {
      restore: () => putBack(moved, trash),
      discard: () => {
        if (trash) deleteInBackground(trash);
        // アプリが終わって消し残したごみ箱があれば、ここで片付ける
        void readdir(root).then((names) => {
          for (const name of names) if (!trashing.has(join(root, name))) deleteInBackground(join(root, name));
        }, () => {});
      },
    };
  } catch {
    // 動かした分は戻して、そのまま git worktree remove に任せる
    await putBack(moved, trash);
    return { restore: async () => {}, discard: () => {} };
  }
}

async function putBack(moved: { from: string; to: string }[], trash: string | null): Promise<void> {
  for (const { from, to } of moved) await rename(to, from).catch(() => {});
  if (trash) await rm(trash, { recursive: true, force: true }).catch(() => {});
  if (trash) trashing.delete(trash);
}

function deleteInBackground(dir: string): void {
  trashing.add(dir);
  execFile('rm', ['-rf', dir], () => trashing.delete(dir));
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
