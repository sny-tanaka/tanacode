import { finalCommentBody, MAX_COMMENT_CHARS, repoUrlOfPullRequest, stepFiles, walkthroughCommentBody, type WalkthroughCommentDraft } from '@shared/walkthrough-comment';
import type { Walkthrough } from '@shared/walkthrough';
import { t, tFor, type MessageKey, type Params } from '@shared/i18n';
import { git, repoInfo, repoPrefix, status } from './git';
import type { PullRequest } from './github';
import { pushedBranchName } from './worktree';

// ウォークスルーを GitHub の PR にコメントとして載せる（本文は @shared/walkthrough-comment）。
// 人が吹き出しのボタンを押して、下見で本文を確かめて（直して）から投稿するか、人に頼まれた Claude が
// MCP のツール post_walkthrough（walkthrough-control.ts）で、下見の本文のまま投稿する。どちらも本文はステップから組み立て、Claude に書かせない。
// パーマリンクは手元の HEAD を指すので、HEAD が PR の最新のコミットと同じで、ステップのファイルがそのコミットのとおりのときだけ載せる
// （アプリが代わりにプッシュや PR の作成はしない）

export type CommentDeps = {
  pullRequests: (cwd: string, branch: string) => Promise<PullRequest[] | null>;
  comment: (cwd: string, number: number, body: string) => Promise<string>;
};

type Target = { pr: PullRequest; sha: string; repoUrl: string; prefix: string };

// 載せられない理由の文を作る。画面には画面の言語で、Claude には英語で返す
type Say = (key: MessageKey, params?: Params) => string;
const english: Say = (key, params) => tFor('en', key, params);

// 載せられるか確かめる。だめなら理由
async function target(cwd: string, w: Walkthrough, deps: CommentDeps, say: Say): Promise<Target | string> {
  if (w.steps.length === 0) return say('main.walkthrough.noSteps');
  const prefix = await repoPrefix(cwd);
  if (prefix === null) return say('main.walkthrough.notRepo');
  const { branch } = await repoInfo(cwd);
  if (!branch) return say('main.walkthrough.detached');
  const prs = await deps.pullRequests(cwd, await pushedBranchName(cwd, branch));
  if (!prs) return say('main.walkthrough.prLookupFailed');
  const pr = prs.find((p) => p.state === 'OPEN');
  if (!pr) return say('main.walkthrough.noOpenPr', { branch });
  const repoUrl = repoUrlOfPullRequest(pr.url);
  if (!repoUrl) return say('main.walkthrough.badPrUrl', { url: pr.url });
  const sha = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (sha !== pr.headRefOid) {
    return say('main.walkthrough.headMismatch', { local: sha.slice(0, 7), remote: pr.headRefOid.slice(0, 7) });
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
  if (missing.length > 0) return say('main.walkthrough.missingFiles', { files: missing.join(say('main.format.listSeparator')) });
  const changed = new Set((await status(cwd))?.map((e) => e.path));
  const dirty = files.filter((f) => changed.has(f));
  if (dirty.length > 0) return say('main.walkthrough.dirtyFiles', { files: dirty.join(say('main.format.listSeparator')) });
  return { pr, sha, repoUrl, prefix };
}

// 下見。postedUrl: このウォークスルーを前に載せたコメント
export async function draftWalkthroughComment(cwd: string, w: Walkthrough, postedUrl: string | null, deps: CommentDeps): Promise<WalkthroughCommentDraft> {
  const found = await target(cwd, w, deps, t);
  if (typeof found === 'string') return { ok: false, reason: found };
  return { ok: true, prNumber: found.pr.number, prUrl: found.pr.url, sha: found.sha, body: walkthroughCommentBody(w, found.repoUrl, found.sha, found.prefix), postedUrl };
}

// 投稿する。下見のあとで HEAD やファイルが変わっていないかも確かめ直す。body: 下見の本文（人が直したもの）。書いたコメントの URL を返す
export async function postWalkthroughComment(cwd: string, w: Walkthrough, body: string, attribution: boolean, deps: CommentDeps): Promise<string> {
  const found = await target(cwd, w, deps, t);
  if (typeof found === 'string') throw new Error(found);
  return send(cwd, found, body, attribution, deps, t);
}

// Claude から投稿する（post_walkthrough）。ボタンで、下見の本文を直さず、一言も添えたまま投稿するのと同じ。
// 載せられなければ、理由（英語）で失敗する。投稿先の PR の番号と、書いたコメントの URL を返す
export async function postWalkthroughAsDrafted(cwd: string, w: Walkthrough, deps: CommentDeps): Promise<{ prNumber: number; url: string }> {
  const found = await target(cwd, w, deps, english);
  if (typeof found === 'string') throw new Error(found);
  const url = await send(cwd, found, walkthroughCommentBody(w, found.repoUrl, found.sha, found.prefix), true, deps, english);
  return { prNumber: found.pr.number, url };
}

async function send(cwd: string, found: Target, body: string, attribution: boolean, deps: CommentDeps, say: Say): Promise<string> {
  if (!body.trim()) throw new Error(say('main.walkthrough.emptyBody'));
  const text = finalCommentBody(body, attribution);
  if (text.length > MAX_COMMENT_CHARS) throw new Error(say('main.walkthrough.tooLong', { count: text.length, max: MAX_COMMENT_CHARS }));
  const url = (await deps.comment(cwd, found.pr.number, text)).trim();
  return /^https?:\/\//.test(url) ? url : found.pr.url;
}
