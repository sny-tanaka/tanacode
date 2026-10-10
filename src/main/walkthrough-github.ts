import { finalCommentBody, MAX_COMMENT_CHARS, repoUrlOfPullRequest, stepFiles, walkthroughCommentBody, type WalkthroughCommentDraft } from '@shared/walkthrough-comment';
import type { Walkthrough } from '@shared/walkthrough';
import { t } from '@shared/i18n';
import { git, repoInfo, repoPrefix, status } from './git';
import type { PullRequest } from './github';
import { pushedBranchName } from './worktree';

// ウォークスルーを GitHub の PR にコメントとして載せる（本文は @shared/walkthrough-comment）。
// 人が吹き出しのボタンを押して、下見で本文を確かめてから投稿する。Claude は通さない。
// パーマリンクは手元の HEAD を指すので、HEAD が PR の最新のコミットと同じで、ステップのファイルがそのコミットのとおりのときだけ載せる
// （アプリが代わりにプッシュや PR の作成はしない）

export type CommentDeps = {
  pullRequests: (cwd: string, branch: string) => Promise<PullRequest[] | null>;
  comment: (cwd: string, number: number, body: string) => Promise<string>;
};

type Target = { pr: PullRequest; sha: string; repoUrl: string; prefix: string };

// 載せられるか確かめる。だめなら理由
async function target(cwd: string, w: Walkthrough, deps: CommentDeps): Promise<Target | string> {
  if (w.steps.length === 0) return t('main.walkthrough.noSteps');
  const prefix = await repoPrefix(cwd);
  if (prefix === null) return t('main.walkthrough.notRepo');
  const { branch } = await repoInfo(cwd);
  if (!branch) return t('main.walkthrough.detached');
  const prs = await deps.pullRequests(cwd, await pushedBranchName(cwd, branch));
  if (!prs) return t('main.walkthrough.prLookupFailed');
  const pr = prs.find((p) => p.state === 'OPEN');
  if (!pr) return t('main.walkthrough.noOpenPr', { branch });
  const repoUrl = repoUrlOfPullRequest(pr.url);
  if (!repoUrl) return t('main.walkthrough.badPrUrl', { url: pr.url });
  const sha = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (sha !== pr.headRefOid) {
    return t('main.walkthrough.headMismatch', { local: sha.slice(0, 7), remote: pr.headRefOid.slice(0, 7) });
  }
  const files = stepFiles(w);
  const missing: string[] = [];
  for (const file of files) {
    const inCommit = await git(cwd, ['cat-file', '-e', `HEAD:${prefix}${file}`]).then(
      () => true,
      () => false,
    );
    if (!inCommit) missing.push(file);
  }
  if (missing.length > 0) return t('main.walkthrough.missingFiles', { files: missing.join(t('main.format.listSeparator')) });
  const changed = new Set((await status(cwd))?.map((e) => e.path));
  const dirty = files.filter((f) => changed.has(f));
  if (dirty.length > 0) return t('main.walkthrough.dirtyFiles', { files: dirty.join(t('main.format.listSeparator')) });
  return { pr, sha, repoUrl, prefix };
}

// 下見。postedUrl: このウォークスルーを前に載せたコメント
export async function draftWalkthroughComment(cwd: string, w: Walkthrough, postedUrl: string | null, deps: CommentDeps): Promise<WalkthroughCommentDraft> {
  const found = await target(cwd, w, deps);
  if (typeof found === 'string') return { ok: false, reason: found };
  return { ok: true, prNumber: found.pr.number, prUrl: found.pr.url, sha: found.sha, body: walkthroughCommentBody(w, found.repoUrl, found.sha, found.prefix), postedUrl };
}

// 投稿する。下見のあとで HEAD やファイルが変わっていないかも確かめ直す。body: 下見の本文（人が直したもの）。書いたコメントの URL を返す
export async function postWalkthroughComment(cwd: string, w: Walkthrough, body: string, attribution: boolean, deps: CommentDeps): Promise<string> {
  const found = await target(cwd, w, deps);
  if (typeof found === 'string') throw new Error(found);
  if (!body.trim()) throw new Error(t('main.walkthrough.emptyBody'));
  const text = finalCommentBody(body, attribution);
  if (text.length > MAX_COMMENT_CHARS) throw new Error(t('main.walkthrough.tooLong', { count: text.length, max: MAX_COMMENT_CHARS }));
  const url = (await deps.comment(cwd, found.pr.number, text)).trim();
  return /^https?:\/\//.test(url) ? url : found.pr.url;
}
