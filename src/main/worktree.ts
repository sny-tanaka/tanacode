import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { t } from '@shared/i18n';
import type { WorktreeBranch, WorktreeBranchKeep, WorktreeLeftovers, WorktreePr, WorktreeRemovedBranch, WorktreeRemoval } from '@shared/ipc';
import { defaultBranch, git, TRUNK_NAMES, submodulesOf, userGit } from './git';
import { type PullRequest, pullRequestsOf } from './github';

// worktree を作れない・消せない理由。message は画面の言語の文（画面に出す）。Claude に返すときは、reason と detail から英語の文を作る
// （sessions-control.ts。Claude に返す文は英語で書く決まり）。detail: ロックの理由など、添える言葉（人やツールが書いたもの）
export type WorktreeFailure = 'notRepo' | 'noCommit' | 'noName' | 'locked' | 'closedWhileCreating' | 'submoduleChanges';
export class WorktreeError extends Error {
  constructor(
    readonly reason: WorktreeFailure,
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

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
// rev-list に付けて、partial clone（--filter=blob:none など）で手元に無いオブジェクトを、取りに行かずに扱わせる（rev-list は --missing を
// 渡されると取りに行かない。渡したコミットが無ければ bad object で失敗する）。取りに行くと、リポジトリの設定の core.sshCommand・
// ext:: の URL・資格情報のヘルパーが動き、guard では止まらない（GIT_NO_LAZY_FETCH は git 2.45 からで、Apple の git 2.39 では効かない）
const MISSING_NO_FETCH = '--missing=print';
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

// cwd のリポジトリのいちばん上（worktree を作る場所）。git のリポジトリでなければ null
export async function repositoryRoot(cwd: string): Promise<string | null> {
  return git(cwd, ['rev-parse', '--show-toplevel']).then(
    (out) => out.trim() || null,
    () => null,
  );
}

// cwd から、worktree を作る場所と名前を決める。Claude Code はサブフォルダから始めても、リポジトリのいちばん上に作る（実測）。
// git のリポジトリでない・まだコミットが無いときは、理由を添えて失敗する
export async function planWorktree(cwd: string): Promise<WorktreePlan> {
  const root = await repositoryRoot(cwd);
  if (!root) throw new WorktreeError('notRepo', t('main.worktree.notRepo'));
  const hasHead = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(
    () => true,
    () => false,
  );
  if (!hasHead) throw new WorktreeError('noCommit', t('main.worktree.noCommit'));
  for (let i = 0; i < 20; i++) {
    const name = worktreeName();
    const path = worktreePath(root, name);
    const branch = worktreeBranch(name);
    if (existsSync(path) || (await branchExists(root, branch))) continue;
    return { name, branch, root, path };
  }
  throw new WorktreeError('noName', t('main.worktree.noName'));
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
// 元のフォルダの今の HEAD から同じ名前のブランチで作る。Claude Code は、同じ場所に worktree があれば --resume でそこに戻る（実測）。
// ファイルを取り出すのは、人が頼んだ操作として、ターミナルの git と同じ設定で（フォルダの設定のフィルター（git-crypt など）で元に戻した中身を出す）
// saved: 消したときに残したもの。branch: worktree で使っていて、残したブランチ（子が git switch -c で作ったものなど。あればそれで作り直す）/
// backupRef: 未コミットの変更の控え。作り直したブランチの先頭が、控えを作ったときのまま（控えの親）なら、控えの中身を作業フォルダに戻し
// （ステージしていたものも、ステージしていない変更・未追跡のファイルとして戻る）、控えを外す。戻せなければ、控えは残す
// 作り直すブランチを、元のフォルダやほかの worktree で取り出していれば（git は同じブランチを 2 か所で取り出さない）、そのブランチの
// 先頭から、ブランチから外れた状態（detached HEAD）で作り直す（何度開いても戻せないままにならないように。作業の中身は見える）
export type WorktreeSaved = { branch?: string | null; backupRef?: string | null };
// branch: 取り出したブランチ（detached HEAD なら null）/ busy: 取り出したかったが、ほかで取り出していたブランチ（detached HEAD で作り直した）
export type WorktreeRestored = { branch: string | null; busy: string | null; backup: 'applied' | 'kept' | null };
export async function restoreWorktree(ref: WorktreeRef, path: string, saved: WorktreeSaved = {}): Promise<WorktreeRestored> {
  // フォルダを手で消したときは、git に残った登録を先に片付ける
  await git(ref.root, ['worktree', 'prune']).catch(() => '');
  const kept = saved.branch && (await branchExists(ref.root, saved.branch)) ? saved.branch : null;
  const wanted = kept ?? ref.branch;
  const busy = (await branchesInUse(ref.root, null)).has(wanted) ? wanted : null;
  if (busy) await userGit(ref.root, ['worktree', 'add', '--detach', path, `refs/heads/${busy}`]);
  else if (kept || (await branchExists(ref.root, wanted))) await userGit(ref.root, ['worktree', 'add', path, wanted]);
  else await userGit(ref.root, ['worktree', 'add', '-b', wanted, path]);
  const branch = busy ? null : wanted;
  if (!saved.backupRef) return { branch, busy, backup: null };
  return { branch, busy, backup: (await applyBackup(ref.root, path, saved.backupRef)) ? 'applied' : 'kept' };
}


// 控えの中身を、作り直した worktree の作業フォルダに戻し、控えを外す。戻したら true
async function applyBackup(root: string, path: string, backupRef: string): Promise<boolean> {
  const [backup, parent, head] = await Promise.all(
    [`${backupRef}^{commit}`, `${backupRef}^1`, 'HEAD'].map((rev) =>
      git(rev === 'HEAD' ? path : root, ['rev-parse', '--verify', '-q', rev]).then(
        (out) => out.trim() || null,
        () => null,
      ),
    ),
  );
  if (!backup || !parent || parent !== head) return false;
  try {
    // ファイルを書き出すのは、人が頼んだ操作として、ターミナルの git と同じ設定で（フォルダの設定のフィルター（git-crypt など）を通す）。
    // 控えの木に無い追跡中のファイル（消していたもの）は消え、控えにしか無いファイル（未追跡だったもの）は未追跡として書き出される
    await userGit(path, ['restore', `--source=${backup}`, '--worktree', '--', '.']);
  } catch {
    return false;
  }
  // 戻したあとに、控えを外す（戻している間に別の控えに書き換わっていれば外さない）
  await git(root, ['update-ref', '-d', backupRef, backup]).catch(() => '');
  return true;
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

// worktree の準備（node_modules）でうまくいかなかったこと。installsFailed: 失敗した install（終了コードが 0 でない。止めたものも）/
// notCopied: 複製できず、install もしなかった node_modules の場所（worktree からの相対。'' はいちばん上）/ error: 準備そのものが失敗した理由 /
// waiting: 準備の途中で、入力を待っているように見える install（終わったら外す）
export type WorktreeSetupTrouble = {
  installsFailed: NodeModulesResult['installs'];
  notCopied: string[];
  error: string | null;
  waiting?: { dir: string; command: string };
};

// 準備の結果から、うまくいかなかったことを取り出す。無ければ null
export function setupTroubleOf(result: NodeModulesResult, error: string | null = null): WorktreeSetupTrouble | null {
  const installsFailed = result.installs.filter((i) => i.exitCode !== 0);
  // 複製できなかった場所は、install を受け持つことがある（lock ファイルがあるとき）。install もしなかった場所だけを数える
  const notCopied = result.failed.filter((dir) => !result.installs.some((i) => i.dir === dir));
  return installsFailed.length > 0 || notCopied.length > 0 || error ? { installsFailed, notCopied, error } : null;
}

// 子への最初の指示に添える、worktree の準備でうまくいかなかったこと（画面の言語。子のチャットにも、親の指示の一部として出る）
export function withSetupNote(prompt: string, trouble: WorktreeSetupTrouble | null): string {
  if (!trouble) return prompt;
  const separator = t('main.format.shortListSeparator');
  const at = (dir: string) => dir || t('main.worktree.topDir');
  const problems = [
    ...trouble.installsFailed.map((i) => t('main.worktree.commandFailedAt', { command: i.command, dir: at(i.dir), code: i.exitCode })),
    ...trouble.notCopied.map((dir) => t('tools.notice.setupNotCopied', { dir: at(dir) })),
    ...(trouble.error ? [t('main.worktree.prepareFailed', { error: trouble.error })] : []),
  ].join(separator);
  return `${prompt}\n\n${t('tools.notice.setupNote', { problems })}`;
}

type PrepareHooks = {
  onStep: (step: 'copying' | 'installing') => void;
  // worktree の cwd で install のコマンドを実行し、終了コードを返す（アプリは画面に出さずに動かし、失敗・入力待ちのときだけタブに出す）。dir: worktree からの相対
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

type ListedWorktree = { path: string; locked: string | null; branch: string | null };

// git worktree list --porcelain。locked: ロックの理由（理由なしのロックは ''）/ branch: 取り出しているブランチ（detached HEAD は null）
async function listWorktrees(root: string): Promise<ListedWorktree[]> {
  const out = await git(root, ['worktree', 'list', '--porcelain']).catch(() => '');
  const list: ListedWorktree[] = [];
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!path) continue;
    const lock = lines.find((l) => l === 'locked' || l.startsWith('locked '));
    const branch = lines.find((l) => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null;
    list.push({ path, locked: lock === undefined ? null : unquote(lock.slice('locked'.length).trim()), branch });
  }
  return list;
}

// git が " で囲み、日本語などを \345 のような 8 進数にした文字を、元に戻す
function unquote(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  const bytes: number[] = [];
  const body = text.slice(1, -1);
  // git が文字で書く制御文字（quote.c の \a \b \t \n \v \f \r）と " \
  const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
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

// worktree で今使っているブランチ（子が git switch -c で作ったものなど）。detached HEAD なら null。
// 登録されている worktree だけを読むこと（登録の無いフォルダで読むと、元のフォルダの HEAD を読んでしまう）
async function currentBranchOf(path: string): Promise<string | null> {
  const out = await git(path, ['symbolic-ref', '-q', 'HEAD']).then(
    (o) => o.trim(),
    () => '',
  );
  return out.startsWith('refs/heads/') ? out.slice('refs/heads/'.length) : null;
}

type BranchRole = { name: string; launched: boolean; current: boolean };

// worktree のブランチの候補。今のブランチが先、起動したときのブランチがあと（同じなら 1 つ）
function branchRoles(ref: WorktreeRef, current: string | null): BranchRole[] {
  const roles: BranchRole[] = [];
  if (current) roles.push({ name: current, launched: current === ref.branch, current: true });
  if (current !== ref.branch) roles.push({ name: ref.branch, launched: true, current: false });
  return roles;
}

// ブランチを確かめるときに使う、リポジトリのこと。base: デフォルトブランチ（分からなければ null）/ trunks: 消さないブランチ
// （デフォルトブランチと、main・develop などの幹の名前。子がそこへ切り替えただけのとき）/ inUse: ほかの worktree で取り出しているブランチ
type BranchContext = { base: string | null; trunks: Set<string>; inUse: Set<string> };

// except: 取り出しているブランチを数えない worktree（消す前の確認では、これから消す worktree）
async function branchContext(root: string, except: string | null): Promise<BranchContext> {
  const [base, inUse] = await Promise.all([defaultBranch(root), branchesInUse(root, except)]);
  return { base, trunks: new Set([...TRUNK_NAMES, ...(base ? [base] : [])]), inUse };
}

// ほかの worktree（except の場所のものは除く）で取り出しているブランチ。git は、取り出しているブランチを消さない
async function branchesInUse(root: string, except: string | null): Promise<Set<string>> {
  const used = new Set<string>();
  for (const w of await listWorktrees(root)) {
    if (w.branch && !(except && (await samePath(w.path, except)))) used.add(w.branch);
  }
  return used;
}

// ブランチの先頭のコミット。無ければ null
function branchOid(root: string, branch: string): Promise<string | null> {
  return git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).then(
    (out) => out.trim() || null,
    () => null,
  );
}

// 確かめたブランチ。oid: 確かめたときの先頭（消すときに、そのあとで動いていないかを見る）
type InspectedBranch = WorktreeBranch & { oid: string | null };

// worktree のブランチの状態と、消すときに残す理由。手元にしか無いコミットを数えるときは、一緒に消すかもしれないもう一方の
// ブランチを、ほかのブランチとして数えない（2 つともが互いのコミットを持つときに、両方を消してしまわないように）
async function inspectBranches(root: string, roles: BranchRole[], context: BranchContext): Promise<InspectedBranch[]> {
  const names = roles.map((r) => r.name);
  const oids = await Promise.all(roles.map((r) => branchOid(root, r.name)));
  // 幹のブランチは残すと決まっているので、PR も、手元にしか無いコミットも調べない
  const checked = roles.map((r) => !context.trunks.has(r.name));
  // PR は GitHub に問い合わせる（gh pr list --head は 1 つのブランチしか受け付けないので、ブランチごとに並べて 1 回ずつ）
  const lookups = await Promise.all(roles.map(async (r, i) => (checked[i] ? pullRequestsOf(root, await pushedBranchName(root, r.name), true) : null)));
  // どちらのブランチの PR のコミットも GitHub にあるので、2 つの役で合わせて除く（worktree-<名前> でコミットしてから git switch -c
  // した PR がスカッシュマージされたときの、worktree-<名前> だけのコミットも、その PR に入っている）
  const heads = await localCommits(root, lookups.flatMap((prs) => (prs ?? []).flatMap(prCommits)));
  return Promise.all(
    roles.map(async (role, i): Promise<InspectedBranch> => {
      const oid = oids[i];
      const exists = oid !== null;
      if (!checked[i]) return { ...role, oid, exists, unpushed: 0, contentIn: null, pr: { state: 'unknown' }, keep: exists ? 'trunk' : null };
      const prs = lookups[i];
      const local = exists ? await localOnlyCommits(root, role.name, heads, names, context.base) : { count: 0, contentIn: null };
      let pr: WorktreePr = { state: prs ? 'none' : 'unknown' };
      const found = prs && pickPullRequest(prs);
      if (found) {
        // PR のあとに、手元で足したコミット。PR のコミットが手元に 1 つも無ければ数えられない
        const mine = new Set(prCommits(found));
        const known = heads.filter((h) => mine.has(h));
        const after = !exists ? 0 : known.length > 0 ? await countCommits(root, [role.name, '--not', ...known]) : null;
        const state = ({ OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const)[found.state];
        pr = { state, number: found.number, base: found.baseRefName, url: found.url, after };
      }
      const keep = !exists ? null : context.inUse.has(role.name) ? 'checkedOut' : local.count === 0 ? null : 'localOnly';
      return { ...role, oid, exists, unpushed: local.count ?? 0, contentIn: local.contentIn, pr, keep };
    }),
  );
}

// PR の head と、PR のコミット
const prCommits = (pr: PullRequest) => [pr.headRefOid, ...(pr.commits ?? []).map((c) => c.oid)];

// worktree を消す前に、残っているもの（未コミットの変更・未追跡のファイル・プッシュしていないコミット）と、ブランチから作った PR
export async function worktreeLeftovers(ref: WorktreeRef, path: string): Promise<WorktreeLeftovers> {
  const exists = existsSync(path) && (await findWorktree(ref.root, path)) !== null;
  const current = exists ? await currentBranchOf(path) : null;
  const roles = branchRoles(ref, current);
  // PR を GitHub に問い合わせるので、調べている間に数える
  const inspecting = branchContext(ref.root, exists ? path : null).then((context) => inspectBranches(ref.root, roles, context));
  let uncommitted = 0;
  let untracked = 0;
  if (exists) {
    // submodule の ignore の設定（submodule.<name>.ignore）があっても、submodule の中の変更を見落とさない
    const parts = (await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).catch(() => '')).split('\0');
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i];
      if (item.length < 4) continue;
      if (item.startsWith('??')) untracked++;
      else uncommitted++;
      // リネーム・コピーは、次の要素が元のパス
      if (item[0] === 'R' || item[0] === 'C') i++;
    }
  }
  // 調べられなければ null（画面に、調べられなかったと出す）
  const submodules = exists ? await submodulesWithLeftovers(path).catch(() => null) : [];
  // 起動したときのブランチが手元に無ければ（子が名前を変えた・もう消した）、今のブランチがあるときは並べない
  const branches = (await inspecting).filter((b) => b.exists || b.current || !current).map(({ oid: _, ...branch }) => branch);
  return { exists, uncommitted, untracked, submodules, branches };
}

// worktree の submodule の git のデータ。label: 画面と Claude に出す、worktree からのパス / checkout: 取り出してあるフォルダ
// （deinit したもの・gitlink の無いコミットに切り替えたものなどは null）/ original: 元のフォルダの、対応する git のデータ
type SubmoduleData = { gitDir: string; label: string; checkout: string | null; original: string | null };

// worktree の submodule の git のデータを、取り出してあるかにかかわらず、すべて数え上げる（入れ子も）。git は worktree の submodule の
// データを <worktree の git-dir>/modules/<名前>（入れ子は、その中の modules/<名前>）に置き、git worktree remove はこれがあると
// --force でしか消さず、消すときは中を確かめずに一緒に消す。名前に / があれば、途中のフォルダは git のデータではない。
// 取り出してあるのにここに無いもの（.git をフォルダのまま持つ古い形）も、worktree と一緒に消えるので加える
async function submoduleData(path: string): Promise<{ items: SubmoduleData[]; hasModules: boolean }> {
  const [gitDirOut, commonOut] = (await git(path, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])).trim().split('\n');
  const worktreeGitDir = await realpath(gitDirOut);
  const commonDir = await realpath(resolve(path, commonOut));
  const top = await realpath(path);
  // 取り出してある submodule の、git のデータの場所 → フォルダ
  const checkouts = new Map<string, string>();
  for (const dir of await checkedOutSubmodules(path)) {
    checkouts.set(await realpath((await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()), await realpath(dir));
  }
  const found: SubmoduleData[] = [];
  const modulesRoot = join(worktreeGitDir, 'modules');
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = join(dir, entry.name);
      if (!isGitDir(sub)) {
        await walk(sub, `${prefix}${entry.name}/`);
        continue;
      }
      const checkout = checkouts.get(sub) ?? null;
      checkouts.delete(sub);
      const label = checkout ? relative(top, checkout) : `${prefix}${entry.name}`;
      const original = join(commonDir, 'modules', relative(modulesRoot, sub));
      found.push({ gitDir: sub, label, checkout, original: existsSync(original) ? original : null });
      await walk(join(sub, 'modules'), `${label}/`);
    }
  };
  await walk(modulesRoot, '');
  for (const [gitDir, checkout] of checkouts) found.push({ gitDir, label: relative(top, checkout), checkout, original: null });
  return { items: found, hasModules: existsSync(modulesRoot) };
}

function isGitDir(dir: string): boolean {
  return existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects'));
}

// 取り出してある（中に .git のある）submodule のフォルダ（入れ子も）
async function checkedOutSubmodules(dir: string): Promise<string[]> {
  const found: string[] = [];
  // 衝突中は、同じパスが段ごとに並ぶ
  for (const sub of new Set(await submodulesOf(dir))) found.push(sub, ...(await checkedOutSubmodules(sub)));
  return found;
}

// worktree を消すと失われるものが中にある submodule の、worktree からのパス
async function submodulesWithLeftovers(path: string, data?: SubmoduleData[]): Promise<string[]> {
  const found: string[] = [];
  // 1 つずつ（git のプロセスを一度に立てすぎない）
  for (const item of data ?? (await submoduleData(path)).items) if (await submoduleHasLeftovers(item)) found.push(item.label);
  return found;
}

// submodule の中に、worktree を消すと失われるものがあるか。取り出してあれば、未コミットの変更・未追跡のファイル。どれも、stash と、
// 手元にしか無いコミット（今のコミットと、リモート以外のすべての ref（ブランチ・タグ・notes など）から辿れて、submodule のリモート
// （を最後に取り込んだ時点）に無く、元のフォルダの submodule（.git/modules/<名前>）のどの ref からも辿れないもの）
async function submoduleHasLeftovers(item: SubmoduleData): Promise<boolean> {
  if (item.checkout) {
    // 入れ子の submodule の中の変更は、入れ子の側で見る（dirty: 入れ子の今のコミットが変わったものだけを、ここの変更として出す）
    const status = await git(item.checkout, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty']);
    if (status !== '') return true;
  }
  if ((await dataGit(item.gitDir, ['for-each-ref', '--format=%(refname)', 'refs/stash'])).trim() !== '') return true;
  // --all: refs/ のすべての ref（タグはタグを指すタグも最後まで剥がす。木を指すタグでも失敗しない）と、submodule の中の worktree も
  // 含めた HEAD（まだ無ければ除く）。そこからリモートのものを除く
  const local = (await dataGit(item.gitDir, ['rev-list', MISSING_NO_FETCH, '--exclude=refs/remotes/*', '--all', '--not', '--remotes'])).trim();
  if (local === '') return false;
  // 元のフォルダの submodule の ref から、そのコミットがすべて辿れれば、消しても失われない。元のフォルダに無いコミットを渡すので、
  // partial clone でも取りに行かせず（MISSING_NO_FETCH）、無いコミットがあれば失敗させて、失われる側に倒す
  if (!item.original) return true;
  const left = await dataGit(item.original, ['rev-list', MISSING_NO_FETCH, '--count', '--stdin', '--not', '--all'], `${local}\n`).then(
    (out) => out.trim(),
    () => null,
  );
  return left !== '0';
}

// submodule の git のデータの中で、作業フォルダを使わない git を動かす。入れ子の submodule の git のデータには、作業フォルダの場所
// （core.worktree）が書いてあり、そのフォルダが無いと（deinit したあとに消したなど）git が動かないので、git のデータ自身を指させる
// （git はリポジトリを探すときに core.worktree を設定のファイルから直に読むので、-c では変えられない。環境変数なら勝つ）。
// 動かすのは ref とコミットを読むものだけ。partial clone で無いものを取りに行くと、リポジトリの設定の core.sshCommand・資格情報の
// ヘルパーなどが動くので、コミットを辿るものには MISSING_NO_FETCH を付ける
function dataGit(gitDir: string, args: string[], input?: string): Promise<string> {
  return git(gitDir, args, input, { GIT_DIR: gitDir, GIT_WORK_TREE: gitDir });
}


type LocalOnly = {
  // 手元にしか無いコミットの数（数えられなければ null）
  count: number | null;
  // 手元にしか無いコミットはあるが、中身が入っているデフォルトブランチ（このときの count は 0）
  contentIn: string | null;
};

// branch の、手元にしか無いコミット。上流があれば上流に無いもの、無ければどのリモートにも、ほかのブランチにも無いもの
// （元にしたブランチのコミットは数えない。together: 一緒に消すかもしれないブランチは、ほかのブランチとして数えない）。
// heads（PR の head と PR のコミットのうち、手元にあるもの）から辿れるコミットは、マージのあとにリモートのブランチを消していても
// GitHub にあるので数えない（PR のコミットも見るのは、update-branch で PR の head が手元より先に進み、head が手元に無いときのため）。
// それでも残れば、PR を使わずに手元でスカッシュマージ・cherry-pick したものかもしれないので、
// 中身がデフォルトブランチ（base）に入っているかを比べ、入っていれば 0 とみなす
async function localOnlyCommits(root: string, branch: string, heads: string[], together: string[], base: string | null): Promise<LocalOnly> {
  const tracked = await git(root, ['rev-parse', '--abbrev-ref', `${branch}@{u}`]).then(
    (out) => out.trim() || null,
    () => null,
  );
  // 上流が、一緒に消すかもしれない手元のブランチなら（git switch -c --track worktree-<名前> など）、上流として使わない
  const upstream = tracked && !together.includes(tracked) ? tracked : null;
  const excludes = [...new Set([branch, ...together])].map((name) => `--exclude=${name}`);
  const count = await countCommits(
    root,
    upstream ? [branch, '--not', upstream, ...heads] : [branch, '--not', ...heads, '--remotes', ...excludes, '--branches'],
  );
  if (!count) return { count, contentIn: null };
  const targets = base ? await defaultBranchRefs(root, base) : [];
  if (targets.length > 0 && (await mergedInto(root, branch, targets))) return { count: 0, contentIn: base };
  return { count, contentIn: null };
}


// rev-list --count。数えられなければ null
function countCommits(root: string, args: string[]): Promise<number | null> {
  return git(root, ['rev-list', MISSING_NO_FETCH, '--count', ...args]).then(
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

// oids のうち、手元にあるコミット（無いコミットを rev-list の --not に渡すと失敗するので、先に除く）。GitHub から受け取った、手元に
// 無いかもしれないコミットなので、partial clone でも取りに行かせない（cat-file -e は取りに行く）。PR のコミットは数百になることがあるので、
// 1 回の rev-list で確かめる（--ignore-missing: 無いものは渡さなかったことにする）
async function localCommits(root: string, oids: string[]): Promise<string[]> {
  const candidates = [...new Set(oids.filter((oid) => /^[0-9a-f]{40,64}$/.test(oid)))];
  if (candidates.length === 0) return [];
  const out = await git(root, ['rev-list', MISSING_NO_FETCH, '--ignore-missing', '--no-walk', '--stdin'], `${candidates.join('\n')}\n`).catch(() => '');
  const found = new Set(out.split('\n').map((line) => line.trim()));
  return candidates.filter((oid) => found.has(oid));
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

// partial clone（手元に無いオブジェクトを、必要になったときにリモートから取りに行く）か。extensions.partialClone か、
// remote.<名前>.promisor が設定されている。読めなければ、partial clone とみなす
async function partialClone(root: string): Promise<boolean> {
  // 「<名前>\n<値>\0」。名前の節と変数は小文字で出る
  const out = await git(root, ['config', '--null', '--list']).catch(() => null);
  if (out === null) return true;
  return out.split('\0').some((entry) => {
    const end = entry.indexOf('\n');
    const key = end < 0 ? entry : entry.slice(0, end);
    const value = end < 0 ? 'true' : entry.slice(end + 1).trim().toLowerCase();
    if (key === 'extensions.partialclone') return value !== '';
    return /^remote\..*\.promisor$/s.test(key) && !['false', 'no', 'off', '0', ''].includes(value);
  });
}

// branch の中身が、もう targets（デフォルトブランチ）に入っているか。スカッシュマージ・cherry-pick ではコミットが作り直されて
// ハッシュが変わるので、中身で比べる。targets の、branch と分かれたあとの時点（今の先頭と、branch が変えたファイルに触れたコミットを
// 古い順に）のどこかで、branch をマージしても何も変わらなければ、入っている（マージのあとにデフォルトブランチで同じところを
// 変えていても見つかる）。衝突を直してからマージしたものは見分けられず、入っていない側に倒れる
async function mergedInto(root: string, branch: string, targets: string[]): Promise<boolean> {
  const ahead = await countCommits(root, [branch, '--not', ...targets]);
  if (ahead === 0) return true;
  if (ahead === null) return false;
  // 中身で比べる diff・ファイルを絞った log・merge-tree は木やファイルの中身を読み、partial clone では無いものを取りに行く
  // （リポジトリの設定のコマンドが動く）ので、比べずに入っていない側に倒す
  if (await partialClone(root)) return false;
  const changed = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', `${targets[0]}...${branch}`]).then(
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

// worktree を消す。Claude Code は先に止めておくこと。
// 1. 未コミットの変更や未追跡のファイルがあれば、一時的なインデックスでコミットにし、refs/tanacode/backup/<名前> に控えを残す
// 2. gitignore されたフォルダ（node_modules など）を、.git の中のごみ箱へ動かす。git worktree remove に消させると、
//    ファイルの多い node_modules で 20〜30 秒かかる（APFS のファイル削除が遅い）。動かすだけなら一瞬で、中身の削除は 5. で裏に回す
// 3. git worktree remove。中身が残っているときと、submodule の git のデータがあるとき（--force でしか消せない）だけ、--force。
//    失敗したら、2. で動かしたものを戻す
// （1. の前に、submodule の中に失われるもの（控えに入らない）があれば、何も変えずに断る）
// 4. ブランチを消す。起動したときのブランチ（worktree-<名前>）と、worktree で今使っていたブランチ（子が git switch -c で作って PR を
//    出したものなど。1. の前に読んでおく）の両方。git branch -d は、上流か今のブランチにマージ済みのときだけ消える。消えなくても、
//    手元にしか無いコミットが無ければ（PR をスカッシュマージした・リモートの別のブランチに直接プッシュした・手元でデフォルトブランチに
//    スカッシュマージしたなど）-D で消す。手元にしか無いコミットがあれば、ブランチごと残す。デフォルトブランチ・main・develop などと、
//    ほかの worktree で取り出しているブランチは消さない
// 5. ごみ箱の中身を、裏で削除する（待たない）
// Claude Code が付けたロックは外す。ほかのロック（ユーザーが付けたもの）があれば、消さずに理由を添えて失敗する。
// detached HEAD で、どのブランチ・タグ・リモートにも無いコミットにいるときも、1. の控えに残す（控えのコミットの親が、そのコミット）
export async function removeWorktree(ref: WorktreeRef, path: string): Promise<WorktreeRemoval> {
  let backupRef: string | null = null;
  let current: string | null = null;
  const listed = await findWorktree(ref.root, path);
  if (listed && existsSync(path)) {
    if (listed.locked !== null && !CLAUDE_LOCK.test(listed.locked)) {
      throw new WorktreeError('locked', listed.locked ? t('main.worktree.lockedWithReason', { reason: listed.locked }) : t('main.worktree.locked'), listed.locked || null);
    }
    // submodule の git のデータ（deinit したものも）があると、git worktree remove は --force でしか消せない（中に変更が無くても
    // 断る）。--force は submodule の中も確かめずに消すので、中に失われるもの（控えに入らない）があれば、何も変えずに断る
    const submodules = await submoduleData(path);
    const left = await submodulesWithLeftovers(path, submodules.items);
    if (left.length > 0) throw new WorktreeError('submoduleChanges', t('main.worktree.submoduleChanges', { paths: left.join(', '), count: left.length }), left.join(', '));
    if (listed.locked !== null) await git(ref.root, ['worktree', 'unlock', path]);
    current = await currentBranchOf(path);
    const dirty = (await git(path, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'])) !== '';
    // detached HEAD のコミットが、どこからも辿れない（worktree を消すと、HEAD の記録ごと失われる）。数えられなければ、ある側に倒す
    const stray = current === null && (await countCommits(path, ['HEAD', '--not', '--branches', '--tags', '--remotes'])) !== 0;
    if (dirty || stray) backupRef = await backupChanges(ref, path);
    const aside = await setAsideIgnoredDirs(ref, path);
    try {
      await git(ref.root, ['worktree', 'remove', ...(dirty || submodules.hasModules || submodules.items.length > 0 ? ['--force'] : []), path]);
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
  return { backupRef, branches: await deleteBranches(ref, current) };
}

// worktree を消したあとに、そのブランチを消す（removeWorktree の 4.）
async function deleteBranches(ref: WorktreeRef, current: string | null): Promise<WorktreeRemovedBranch[]> {
  const roles: BranchRole[] = [];
  for (const role of branchRoles(ref, current)) if (await branchExists(ref.root, role.name)) roles.push(role);
  if (roles.length === 0) return [];
  // 先にすべてを確かめてから消す。git branch -d（上流にマージ済みなら消える）は使わない。上流が一緒に消すブランチのとき
  // （git switch -c --track worktree-<名前> など）に、上流にしか無いコミットを、両方を消して失うため
  const inspected = await inspectBranches(ref.root, roles, await branchContext(ref.root, null));
  const result: WorktreeRemovedBranch[] = [];
  for (const branch of inspected) {
    // 確かめたときの先頭のままのときだけ消す（確かめている間に、コミットが足されていたら消さない）
    const deleted =
      !branch.keep &&
      !!branch.oid &&
      (await git(ref.root, ['update-ref', '-d', `refs/heads/${branch.name}`, branch.oid]).then(
        () => true,
        () => false,
      ));
    // git branch -D と同じく、ブランチの設定（上流など）も外す
    if (deleted) await git(ref.root, ['config', '--remove-section', `branch.${branch.name}`]).catch(() => '');
    result.push({ name: branch.name, launched: branch.launched, current: branch.current, deleted, keep: branch.keep });
  }
  return result;
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
    // 中身を書き込むのは、人が頼んだ操作として、ターミナルの git と同じ設定で（フォルダの設定のフィルター（git-crypt など）を通した中身を残す）
    await userGit(path, ['add', '-A', '--', '.'], undefined, env);
    const tree = (await git(path, ['write-tree'], undefined, env)).trim();
    const message = `tanacode: worktree ${ref.name} を消す前の控え（未コミットの変更と未追跡のファイル。親は、そのときの HEAD）`;
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

const BACKUP_REFS = 'refs/tanacode/backup/';

// root のリポジトリの、worktree を消す前の控え（新しい順）。date: 作った時刻（ミリ秒）/ subject: コミットのメッセージの 1 行目 /
// strays: 控えの親が、どのブランチ・タグ・リモートからも辿れない（控えを消すと、そのコミットも失われる）。数えられなければ、ある側に倒す
export async function listBackups(root: string): Promise<{ ref: string; date: number; subject: string; strays: boolean }[]> {
  const format = '%(refname)%00%(committerdate:unix)%00%(subject)';
  const out = await git(root, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, BACKUP_REFS]).catch(() => '');
  const backups = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, date, subject] = line.split('\0');
      return { ref, date: Number(date) * 1000, subject: subject ?? '' };
    });
  // 1 つずつ（git のプロセスを一度に立てすぎない）
  const result = [];
  for (const backup of backups) {
    const left = await countCommits(root, [`${backup.ref}^`, '--not', '--branches', '--tags', '--remotes']);
    result.push({ ...backup, strays: left !== 0 });
  }
  return result;
}


// 控えを消す。refs/tanacode/backup/ の下のものだけ
export async function deleteBackup(root: string, ref: string): Promise<void> {
  if (!ref.startsWith(BACKUP_REFS) || ref.includes('..')) throw new Error(`not a backup: ${ref}`);
  await git(root, ['update-ref', '-d', ref]);
}
