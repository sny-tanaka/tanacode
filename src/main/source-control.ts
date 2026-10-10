import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from '@shared/i18n';
import type { BranchChanges, FileBaseline, GitBranches, GitDiffSides, GitState } from '@shared/ipc';
import { branchBase, branchFiles, branches, defaultBranch, git, GitError, repoInfo, showAt, showHead, showIndex, status } from './git';

// ソース管理パネルの操作。パスはすべて cwd（セッションのフォルダ）からの相対
export class SourceControl {
  constructor(private readonly cwd: string) {}

  async state(): Promise<GitState> {
    const entries = await status(this.cwd).catch(() => null);
    if (!entries) return { isRepo: false };
    const info = await repoInfo(this.cwd);
    return { isRepo: true, ...info, entries, branchChanges: await this.branchChanges(info).catch(() => null) };
  }

  // 今のブランチの基点から作業ツリーまでの変更（ローカルだけのプルリクエストのように見るため）
  private async branchChanges(info: Awaited<ReturnType<typeof repoInfo>>): Promise<BranchChanges | null> {
    const base = await branchBase(this.cwd, info);
    if (!base) return null;
    const files = await branchFiles(this.cwd, base.mergeBase);
    return { base, files: Object.fromEntries(files.map(({ path, ...change }) => [path, change])) };
  }

  async branchDiffSides(mergeBase: string, relPath: string): Promise<GitDiffSides> {
    const [original, modified] = await Promise.all([
      showAt(this.cwd, mergeBase, relPath),
      readFile(join(this.cwd, relPath), 'utf8').catch(() => ''),
    ]);
    return { original: original ?? '', modified };
  }

  async baseline(mergeBase: string, relPath: string): Promise<FileBaseline> {
    const text = await showAt(this.cwd, mergeBase, relPath);
    return { exists: text !== null, text: text ?? '' };
  }

  branches(): Promise<GitBranches> {
    return branches(this.cwd);
  }

  async stage(paths: string[]): Promise<void> {
    await git(this.cwd, ['add', '-A', '--', ...paths]);
  }

  async unstage(paths: string[]): Promise<void> {
    const { empty } = await repoInfo(this.cwd);
    // 最初のコミット前は HEAD が無いので restore --staged が使えない
    if (empty) await git(this.cwd, ['rm', '--cached', '-r', '-q', '--', ...paths]);
    else await git(this.cwd, ['restore', '--staged', '--', ...paths]);
  }

  // 作業ツリーの変更を捨てる。未追跡のファイルは消す
  async discard(paths: string[]): Promise<void> {
    const entries = (await status(this.cwd)) ?? [];
    const untracked = new Set(entries.filter((e) => e.index === '?').map((e) => e.path));
    const tracked = paths.filter((p) => !untracked.has(p));
    if (tracked.length > 0) await git(this.cwd, ['restore', '--', ...tracked]);
    for (const p of paths.filter((p) => untracked.has(p))) await rm(join(this.cwd, p), { force: true, recursive: true });
  }

  async commit(message: string, amend: boolean): Promise<void> {
    if (!message.trim() && !amend) throw new GitError(t('main.git.commitMessageRequired'));
    const args = ['commit', '-F', '-'];
    if (amend) args.push('--amend');
    await git(this.cwd, args, message);
  }

  async lastCommitMessage(): Promise<string> {
    return git(this.cwd, ['log', '-1', '--format=%B']).then(
      (out) => out.trim(),
      () => '',
    );
  }

  async push(): Promise<void> {
    const { upstream } = await repoInfo(this.cwd);
    // 上流が無ければ origin に同じ名前で作る
    await git(this.cwd, upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']);
  }

  async pull(): Promise<void> {
    await git(this.cwd, ['pull']);
  }

  async fetch(): Promise<void> {
    await git(this.cwd, ['fetch', '--prune']);
  }

  // local: 既存のブランチへ / remote: origin/foo なら同じ名前のローカルブランチを作って追跡 / create: 新しいブランチ
  async checkout(branch: string, mode: 'local' | 'remote' | 'create'): Promise<void> {
    if (mode === 'create') await git(this.cwd, ['switch', '-c', branch]);
    else if (mode === 'remote') await git(this.cwd, ['switch', '--track', branch]);
    else await git(this.cwd, ['switch', branch]);
  }

  // リモートの最新を取り込み、デフォルトブランチに切り替えて最新にする。
  // 手元のデフォルトブランチがリモートと分かれていたら、fast-forward できないので切り替えたところで止める
  async switchToLatestDefault(): Promise<void> {
    const hasOrigin = await git(this.cwd, ['remote', 'get-url', 'origin']).then(
      () => true,
      () => false,
    );
    if (hasOrigin) {
      await git(this.cwd, ['fetch', '--prune', 'origin']);
      // リモートでデフォルトブランチが変わっていることがあるので、origin/HEAD を取り直す（取れなければ手元の控えを使う）
      await git(this.cwd, ['remote', 'set-head', 'origin', '--auto']).catch(() => {});
    }
    const name = await defaultBranch(this.cwd);
    if (!name) throw new GitError(t('main.git.noDefaultBranch'));
    const hasRef = (ref: string) =>
      git(this.cwd, ['rev-parse', '--verify', '-q', ref]).then(
        () => true,
        () => false,
      );
    if ((await repoInfo(this.cwd)).branch !== name) {
      await git(this.cwd, (await hasRef(`refs/heads/${name}`)) ? ['switch', name] : ['switch', '--track', `origin/${name}`]);
    }
    // 取り込んだ origin のものに合わせる。手元のブランチの上流は、無いことも origin 以外のこともあるので頼らない
    const { upstream } = await repoInfo(this.cwd);
    const remoteRef = hasOrigin && (await hasRef(`refs/remotes/origin/${name}`)) ? `origin/${name}` : null;
    const target = remoteRef ?? upstream;
    if (!target) return;
    // 上流が無いとプル・プッシュの数も出ないので、origin のものを上流にする
    if (!upstream && remoteRef) await git(this.cwd, ['branch', `--set-upstream-to=${remoteRef}`]);
    await git(this.cwd, ['merge', '--ff-only', target]).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      throw new GitError(`${t('main.git.diverged', { name, target })}\n${detail}`);
    });
  }

  // 差分表示の左右。staged なら HEAD とステージ済み、そうでなければステージ済み（無ければ HEAD）と作業ツリー
  async diffSides(relPath: string, staged: boolean): Promise<GitDiffSides> {
    const head = await showHead(this.cwd, relPath);
    const index = await showIndex(this.cwd, relPath);
    if (staged) return { original: head ?? '', modified: index ?? '' };
    const worktree = await readFile(join(this.cwd, relPath), 'utf8').catch(() => '');
    return { original: index ?? head ?? '', modified: worktree };
  }
}
