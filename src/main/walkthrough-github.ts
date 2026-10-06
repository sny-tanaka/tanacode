import { finalCommentBody, MAX_COMMENT_CHARS, repoUrlOfPullRequest, stepFiles, walkthroughCommentBody, type WalkthroughCommentDraft } from '@shared/walkthrough-comment';
import type { Walkthrough } from '@shared/walkthrough';
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
  if (w.steps.length === 0) return 'ウォークスルーのステップがありません。';
  const prefix = await repoPrefix(cwd);
  if (prefix === null) return 'git のリポジトリではありません。';
  const { branch } = await repoInfo(cwd);
  if (!branch) return 'ブランチにいません（detached HEAD）。';
  const prs = await deps.pullRequests(cwd, await pushedBranchName(cwd, branch));
  if (!prs) return 'GitHub の PR を調べられませんでした。gh が入っていて、ログインしているか（gh auth status）確かめてください。';
  const pr = prs.find((p) => p.state === 'OPEN');
  if (!pr) return `ブランチ ${branch} の開いている PR がありません。先に PR を作ってください。`;
  const repoUrl = repoUrlOfPullRequest(pr.url);
  if (!repoUrl) return `PR の URL を読めませんでした（${pr.url}）。`;
  const sha = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (sha !== pr.headRefOid) {
    return `手元の HEAD（${sha.slice(0, 7)}）が、PR の最新のコミット（${pr.headRefOid.slice(0, 7)}）と違います。プッシュ（かプル）してから載せてください。`;
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
  if (missing.length > 0) return `コミットに入っていないファイルがあります: ${missing.join('、')}。コミットしてプッシュしてから載せてください。`;
  const changed = new Set((await status(cwd))?.map((e) => e.path));
  const dirty = files.filter((f) => changed.has(f));
  if (dirty.length > 0) return `コミットしていない変更があるファイルがあります: ${dirty.join('、')}。コミットしてプッシュしてから載せてください。`;
  return { pr, sha, repoUrl, prefix };
}

// 下見。postedUrl: このウォークスルーを前に載せたコメント
export async function draftWalkthroughComment(cwd: string, w: Walkthrough, postedUrl: string | null, deps: CommentDeps): Promise<WalkthroughCommentDraft> {
  const t = await target(cwd, w, deps);
  if (typeof t === 'string') return { ok: false, reason: t };
  return { ok: true, prNumber: t.pr.number, prUrl: t.pr.url, sha: t.sha, body: walkthroughCommentBody(w, t.repoUrl, t.sha, t.prefix), postedUrl };
}

// 投稿する。下見のあとで HEAD やファイルが変わっていないかも確かめ直す。body: 下見の本文（人が直したもの）。書いたコメントの URL を返す
export async function postWalkthroughComment(cwd: string, w: Walkthrough, body: string, attribution: boolean, deps: CommentDeps): Promise<string> {
  const t = await target(cwd, w, deps);
  if (typeof t === 'string') throw new Error(t);
  if (!body.trim()) throw new Error('本文が空です。');
  const text = finalCommentBody(body, attribution);
  if (text.length > MAX_COMMENT_CHARS) throw new Error(`本文が長すぎます（${text.length} 文字。GitHub のコメントは ${MAX_COMMENT_CHARS} 文字まで）。説明を短くしてください。`);
  const url = (await deps.comment(cwd, t.pr.number, text)).trim();
  return /^https?:\/\//.test(url) ? url : t.pr.url;
}
