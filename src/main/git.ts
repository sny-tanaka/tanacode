import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { GitBranches } from '@shared/ipc';

const MAX_BUFFER = 64 * 1024 * 1024;
// 未追跡のファイルの行数を数える上限（大きいものは数えない）と、数えるファイルの数の上限（それより多いものは、読まずに 0 とする）
const MAX_COUNT_BYTES = 1024 * 1024;
const MAX_COUNT_FILES = 1000;

export class GitError extends Error {}

// tanacode が自分で動かす git（状態・差分・ブランチを読む・worktree の片付けなど）は、開いたフォルダの設定で、人の知らないコマンドを
// 動かさないよう、コマンドを動かす設定を打ち消して動かす（guardOf）。人がソース管理パネルで頼んだ操作（ステージ・コミット・プッシュ・
// プル・ブランチの切り替えなど）と、worktree の作り直し・消す前の控えの書き込みは userGit で、ターミナルで git を打ったときと同じに動かす
// （フック・資格情報・フィルターを使う）
export function git(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<string> {
  return guardOf(cwd).then((guard) => runGit(cwd, [...guard.args, ...args], input, { ...env, ...guard.env }));
}

// 人が頼んだ操作。設定はそのまま使う
export function userGit(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<string> {
  return runGit(cwd, args, input, env);
}

// cwd で git を実行して標準出力を返す。失敗したら GitError（メッセージは標準エラー）
function runGit(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<string> {
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

// 打ち消す設定を読み直す間隔（ソース管理パネルは、状態を何度も読むため）
const GUARD_TTL_MS = 2000;
// 打ち消す設定の渡し方。args: -c（どの git でも効く）。env: 同じものを GIT_CONFIG_COUNT・GIT_CONFIG_KEY_<n>・GIT_CONFIG_VALUE_<n> で
// （git 2.31 から。-c は最初の「=」で名前と値を分けるので、名前に「=」を含むもの（[filter "a=b"]）は env でしか打ち消せない）
type Guard = { args: string[]; env: Record<string, string> };
const guards = new Map<string, { at: number; guard: Promise<Guard> }>();
// git-lfs が入れる決まった形のフィルター（git lfs install。--skip 付きも）。読むだけの git にも要る（無いと、LFS のファイルが変更に見える）
const LFS_FILTER = /^git-lfs (clean -- %f|smudge( --skip)? -- %f|filter-process( --skip)?)$/;

// 開いたフォルダの設定のうち、読むだけの git でもコマンドを動かすものを打ち消す設定。
// - core.fsmonitor（状態・ファイルの一覧で動く）と、フック（.git/hooks・core.hooksPath。インデックスや参照を書くと動くものがある）と、
//   ログの署名の確かめ（log.showSignature。gpg.program を動かす）は、いつも止める
// - フィルター（filter.<名前>.clean・smudge・process）と merge のドライバー（merge.<名前>.driver）は、リポジトリの設定（local・worktree）で
//   決めたものだけ空にする（空のものは動かない。git 2.39 で確かめた）。ユーザー自身の設定（global・system）と git-lfs の決まった形は残す。
//   空にしたフィルターは、required も false にする。そのため、読むだけの git は、フィルターを通す前の中身で比べる（ターミナルの git と差分の見え方が違うことがある）
// - diff の外部コマンド（diff.external・diff.<名前>.command）と textconv は、diff を動かす所で --no-ext-diff・--no-textconv を付ける
// 名前に「=」を含むものを打ち消せない古い git（2.31 より前）では、git を動かさない（GitError）
export function guardOf(cwd: string): Promise<Guard> {
  const now = Date.now();
  const cached = guards.get(cwd);
  if (cached && now - cached.at < GUARD_TTL_MS) return cached.guard;
  const guard = runGit(cwd, ['config', '--show-scope', '--null', '--get-regexp', '^(filter|merge)\\..+\\.(clean|smudge|process|driver)$'])
    .catch(() => '')
    .then(async (out) => {
      const pairs: [string, string][] = [
        ['core.fsmonitor', 'false'],
        ['core.hooksPath', '/dev/null'],
        // ログ・show で署名を確かめさせない（確かめに gpg.program を動かす）
        ['log.showSignature', 'false'],
      ];
      const parts = out.split('\0');
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const scope = parts[i];
        const [key, ...value] = parts[i + 1].split('\n');
        if (scope === 'global' || scope === 'system') continue;
        if (key.startsWith('filter.') && LFS_FILTER.test(value.join('\n'))) continue;
        pairs.push([key, '']);
        // なくてはならないとされたフィルター（required。git-crypt が書く）は、空にすると git add・diff などが失敗するので、無くてよいことにする
        const required = key.startsWith('filter.') ? `${key.slice(0, key.lastIndexOf('.'))}.required` : null;
        if (required && !pairs.some(([k]) => k === required)) pairs.push([required, 'false']);
      }
      if (pairs.some(([key]) => key.includes('=')) && !(await configEnvSupported(cwd))) {
        throw new GitError('This folder has git settings that tanacode cannot turn off with this git. Update git to 2.31 or later.');
      }
      return { args: pairs.filter(([key]) => !key.includes('=')).flatMap(([key, value]) => ['-c', `${key}=${value}`]), env: configEnv(pairs) };
    });
  guards.set(cwd, { at: now, guard });
  return guard;
}

// GIT_CONFIG_COUNT などで渡す設定。もとの環境にあるもの（ユーザーが渡したもの）は残し、その後ろに足す
function configEnv(pairs: [string, string][]): Record<string, string> {
  const given = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '', 10);
  const base = Number.isInteger(given) && given > 0 ? given : 0;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(base + pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${base + i}`] = key;
    env[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  return env;
}

// GIT_CONFIG_COUNT を読む git（2.31 から）か
async function configEnvSupported(cwd: string): Promise<boolean> {
  const out = await runGit(cwd, ['--version']).catch(() => '');
  const [, major, minor] = /git version (\d+)\.(\d+)/.exec(out) ?? [];
  return major !== undefined && (Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 31));
}

// 基点（画面から来ることもある）。git のオプションとして読まれないよう、HEAD と 16 進のコミットの ID だけを受け付ける
function commitId(value: string): string {
  if (!/^(HEAD|[0-9a-f]{4,64})$/i.test(value)) throw new GitError(`not a commit id: ${value.slice(0, 80)}`);
  return value;
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
      // 元のパスは cwd の外のこともある（../a.txt のようにする）。頭に / を付けて、プロセスの今のフォルダに頼らずに比べる
      from: from === undefined ? undefined : posix.relative(`/${prefix}`, `/${from}`),
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
  return git(cwd, ['show', '--no-textconv', `HEAD:./${relPath}`]).catch(() => null);
}

// ステージ済み（インデックス）の内容。無ければ null
export async function showIndex(cwd: string, relPath: string): Promise<string | null> {
  return git(cwd, ['show', '--no-textconv', `:./${relPath}`]).catch(() => null);
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
  const base = commitId(mergeBase);
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--relative', '--no-renames', '--name-status', '-z', base]),
    git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--relative', '--no-renames', '--numstat', '-z', base]),
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
  let counted = 0;
  for (const path of untracked.split('\0').filter(Boolean)) {
    if (counted++ >= MAX_COUNT_FILES) {
      files.push({ path, kind: 'added', added: 0, removed: 0, binary: false });
      continue;
    }
    // ふつうのファイルだけ数える（シンボリックリンクの先・デバイス・名前付きパイプは読まない。/dev/zero へのリンクは読み終わらない）
    const info = await lstat(join(cwd, path)).catch(() => null);
    const text = info?.isFile() && info.size <= MAX_COUNT_BYTES ? await readFile(join(cwd, path)).catch(() => null) : null;
    const binary = !!text && text.includes(0);
    // 空のファイルは 0 行（ステージしたときに git が数えるのと同じ）
    const added = text && text.length > 0 && !binary ? text.toString('utf8').split('\n').length - (text.at(-1) === 10 ? 1 : 0) : 0;
    files.push({ path, kind: 'added', added, removed: 0, binary });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// 基点での内容。基点に無いファイル・コミットの ID でない基点なら null
export async function showAt(cwd: string, rev: string, relPath: string): Promise<string | null> {
  return Promise.resolve()
    .then(() => git(cwd, ['show', '--no-textconv', `${commitId(rev)}:./${relPath}`]))
    .catch(() => null);
}
