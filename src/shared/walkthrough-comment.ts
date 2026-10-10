import { t } from './i18n';
import type { Walkthrough } from './walkthrough';

// ウォークスルーを GitHub の PR にコメントとして載せるときの本文。ステップの順に、見出し・コードのパーマリンク・説明文を並べる。
// パーマリンク（コミットの SHA 付き）を 1 行だけで置くと、GitHub がそのコードを埋め込んで見せる（同じリポジトリのとき）。
// 差分の外の既存のコードも示せ、リンクがコミットに固定されるので、PR が進んでも行がずれない。
// 質問と答え・寄り道（show_code）は載せない（本人とのやりとりで、ほかのレビュワー向けではないため）

// GitHub のコメントの長さの上限
export const MAX_COMMENT_CHARS = 65536;

// 「Claude が書いた説明」の一言（投稿するときに選べる。既定で添える）。呼んだときの言語で作る
export function walkthroughAttribution(): string {
  return `_${t('walkthrough.postBody.attribution')}_`;
}

// 投稿の下見。ok なら、投稿先の PR とコメントの本文（一言は含めない）。だめなら、その理由
export type WalkthroughCommentDraft =
  | { ok: true; prNumber: number; prUrl: string; sha: string; body: string; postedUrl: string | null }
  | { ok: false; reason: string };

// PR の URL（https://github.com/owner/repo/pull/12）から、リポジトリの URL
export function repoUrlOfPullRequest(prUrl: string): string | null {
  const m = prUrl.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/);
  return m ? m[1] : null;
}

// コミットに固定したコードへのリンク。path はリポジトリのルートからのパス
export function permalink(repoUrl: string, sha: string, path: string, startLine: number, endLine: number): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const lines = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  return `${repoUrl}/blob/${sha}/${encoded}#${lines}`;
}

// prefix: リポジトリのルートからセッションのフォルダまで（ルートなら ''。末尾は /）
export function walkthroughCommentBody(w: Walkthrough, repoUrl: string, sha: string, prefix: string): string {
  const total = w.steps.length;
  const steps = w.steps.map((step, i) =>
    [
      `### ${i + 1}/${total} ${step.title}`,
      // リンクは前後を空行にして 1 行だけで置く（埋め込みになる条件）
      permalink(repoUrl, sha, `${prefix}${step.path}`, step.startLine, step.endLine),
      step.body.trim(),
    ].join('\n\n'),
  );
  const head = `## ${t('walkthrough.postBody.heading', { title: w.title })}\n\n${t('walkthrough.postBody.summary', { count: total, commit: `\`${sha.slice(0, 7)}\`` })}`;
  return [head, ...steps].join('\n\n');
}

// 投稿する本文。attribution なら、最後に一言を添える
export function finalCommentBody(body: string, attribution: boolean): string {
  const text = body.trim();
  return attribution ? `${text}\n\n---\n${walkthroughAttribution()}` : text;
}

// ステップの場所の一覧（下見の画面と、確かめるファイルの一覧に使う）
export function stepFiles(w: Walkthrough): string[] {
  return [...new Set(w.steps.map((s) => s.path))];
}
