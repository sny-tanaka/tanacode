import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitBranches } from '@shared/ipc';

const MAX_BUFFER = 64 * 1024 * 1024;
// 未追跡のファイルの行数を数える上限（大きいものは数えない）
const MAX_COUNT_BYTES = 1024 * 1024;

export class GitError extends Error {}

// cwd で git を実行して標準出力を返す。失敗したら GitError（メッセージは標準エラー）
export function git(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = { cwd, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } };
    const child = execFile('git', args, options, (err, stdout, stderr) => {
      if (err) reject(new GitError((stderr || err.message).trim()));
      else resolve(stdout);
    });
    // 渡すものが無ければ、標準入力はすぐ閉じる（何かが標準入力からの入力を待っても、待ち続けずに失敗させる）
    child.stdin?.end(input);
  });
}

// cwd がリポジトリの中なら、リポジトリのルートから cwd までの相対パス（ルートなら ''）。リポジトリでなければ null
export async function repoPrefix(cwd: string): Promise<string | null> {
  return git(cwd, ['rev-parse', '--show-prefix']).then(
    (out) => out.trim(),
    () => null,
  );
}

export type StatusEntry = {
  // cwd からの相対パス
  path: string;
  // リネーム元（cwd からの相対パス）
  from?: string;
  // X: ステージ済みの状態 / Y: 作業ツリーの状態（git status --porcelain の 2 文字）
  index: string;
  worktree: string;
};

// git status。パスはリポジトリのルートからなので、cwd からの相対に直す（cwd の外は除く）
export async function status(cwd: string): Promise<StatusEntry[] | null> {
  const prefix = await repoPrefix(cwd);
  if (prefix === null) return null;
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (item.length < 4) continue;
    const index = item[0];
    const worktree = item[1];
    const path = item.slice(3);
    // リネーム・コピーは次の要素が元のパス
    const from = index === 'R' || index === 'C' ? parts[++i] : undefined;
    if (!path.startsWith(prefix)) continue;
    entries.push({
      path: path.slice(prefix.length),
      from: from?.startsWith(prefix) ? from.slice(prefix.length) : from,
      index,
      worktree,
    });
  }
  return entries;
}

// .gitignore で無視されるファイルか
export async function isIgnored(cwd: string, relPath: string): Promise<boolean> {
  return git(cwd, ['check-ignore', '-q', '--', relPath]).then(
    () => true,
    () => false,
  );
}

// HEAD の内容。HEAD に無いファイルなら null
export async function showHead(cwd: string, relPath: string): Promise<string | null> {
  return git(cwd, ['show', `HEAD:./${relPath}`]).catch(() => null);
}

// ステージ済み（インデックス）の内容。無ければ null
export async function showIndex(cwd: string, relPath: string): Promise<string | null> {
  return git(cwd, ['show', `:./${relPath}`]).catch(() => null);
}

export type RepoInfo = {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  // まだ 1 つもコミットが無い
  empty: boolean;
};

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  const branch = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).then(
    (out) => out.trim() || null,
    () => null,
  );
  const empty = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(
    () => false,
    () => true,
  );
  const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).then(
    (out) => out.trim() || null,
    () => null,
  );
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).catch(() => '0\t0');
    [behind, ahead] = counts.trim().split(/\s+/).map(Number);
  }
  return { branch, upstream, ahead, behind, empty };
}

export async function branches(cwd: string): Promise<GitBranches> {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname)', '--sort=-committerdate', 'refs/heads', 'refs/remotes']);
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of out.split('\n').filter(Boolean)) {
    if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
    else if (!ref.endsWith('/HEAD')) remote.push(ref.slice('refs/remotes/'.length));
  }
  return { local, remote, defaultBranch: await defaultBranch(cwd) };
}

// デフォルトブランチの名前。origin/HEAD（clone したときの控え）の指す先。
// 控えが無ければ、main・master などのうち手元か origin にあるもの
export async function defaultBranch(cwd: string): Promise<string | null> {
  const originHead = await git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).then(
    (out) => out.trim() || null,
    () => null,
  );
  if (originHead) return originHead.replace(/^origin\//, '');
  const refs = new Set(
    (await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin']).catch(() => ''))
      .split('\n')
      .filter(Boolean),
  );
  return TRUNK_NAMES.find((name) => refs.has(name) || refs.has(`origin/${name}`)) ?? null;
}

// ブランチの差分の基点。branch: 分岐元のブランチとの分岐点 / upstream: 基点のブランチ（main など）にいるときの上流
export type BranchBase = { ref: string; mergeBase: string; kind: 'branch' | 'upstream' };

// 基点になりうるブランチの名前。これらのブランチにいるときは、分岐元ではなく上流と比べる
const TRUNK_NAMES = ['main', 'master', 'develop', 'development', 'trunk'];

// 作業中のブランチの基点を決める。
// 別のブランチにいるときは、main・master・develop などのうち分岐点がいちばん近いもの。
// main など基点のブランチそのものにいるときは、全履歴を出さないよう上流（origin/main など）と比べる
export async function branchBase(cwd: string, info: RepoInfo): Promise<BranchBase | null> {
  if (info.empty) return null;
  const mergeBase = (ref: string) => git(cwd, ['merge-base', 'HEAD', ref]).then((out) => out.trim() || null, () => null);
  const originHead = await git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).then(
    (out) => out.trim() || null,
    () => null,
  );
  const isTrunk = !!info.branch && (TRUNK_NAMES.includes(info.branch) || originHead === `origin/${info.branch}`);
  const upstreamBase = async (): Promise<BranchBase | null> => {
    const mb = info.upstream ? await mergeBase(info.upstream) : null;
    return info.upstream && mb ? { ref: info.upstream, mergeBase: mb, kind: 'upstream' } : null;
  };
  if (isTrunk) return upstreamBase();

  const refs = new Set(
    (await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).catch(() => ''))
      .split('\n')
      .filter(Boolean),
  );
  const own = new Set([info.branch, info.upstream, info.branch && `origin/${info.branch}`].filter(Boolean));
  const candidates = [originHead, ...TRUNK_NAMES.flatMap((name) => [`origin/${name}`, name])].filter(
    (ref, i, list): ref is string => !!ref && refs.has(ref) && !own.has(ref) && list.indexOf(ref) === i,
  );
  let best: (BranchBase & { distance: number }) | null = null;
  for (const ref of candidates) {
    const mb = await mergeBase(ref);
    if (!mb) continue;
    const distance = Number((await git(cwd, ['rev-list', '--count', `${mb}..HEAD`]).catch(() => '')).trim());
    if (Number.isNaN(distance)) continue;
    if (!best || distance < best.distance) best = { ref, mergeBase: mb, kind: 'branch', distance };
  }
  if (!best) return upstreamBase();
  const { distance: _, ...base } = best;
  return base;
}

export type BranchFile = { path: string; kind: 'added' | 'modified' | 'deleted'; added: number; removed: number; binary: boolean };

// 基点から作業ツリーまでの変更（コミット済み・ステージ済み・未ステージ・未追跡をまとめて）。パスは cwd からの相対
export async function branchFiles(cwd: string, mergeBase: string): Promise<BranchFile[]> {
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(cwd, ['diff', '--relative', '--no-renames', '--name-status', '-z', mergeBase]),
    git(cwd, ['diff', '--relative', '--no-renames', '--numstat', '-z', mergeBase]),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const line of numstat.split('\0').filter(Boolean)) {
    const [added, removed, ...rest] = line.split('\t');
    counts.set(rest.join('\t'), { added: Number(added) || 0, removed: Number(removed) || 0, binary: added === '-' });
  }
  const files: BranchFile[] = [];
  const parts = nameStatus.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i];
    const path = parts[i + 1];
    if (!code || !path) continue;
    const kind = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    files.push({ path, kind, ...(counts.get(path) ?? { added: 0, removed: 0, binary: false }) });
  }
  for (const path of untracked.split('\0').filter(Boolean)) {
    // ふつうのファイルだけ数える（シンボリックリンクの先・デバイス・名前付きパイプは読まない。/dev/zero へのリンクは読み終わらない）
    const info = await lstat(join(cwd, path)).catch(() => null);
    const text = info?.isFile() && info.size <= MAX_COUNT_BYTES ? await readFile(join(cwd, path)).catch(() => null) : null;
    const binary = !!text && text.includes(0);
    const added = text && !binary ? text.toString('utf8').split('\n').length - (text.at(-1) === 10 ? 1 : 0) : 0;
    files.push({ path, kind: 'added', added, removed: 0, binary });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// 基点での内容。基点に無いファイルなら null
export async function showAt(cwd: string, rev: string, relPath: string): Promise<string | null> {
  return git(cwd, ['show', `${rev}:./${relPath}`]).catch(() => null);
}
