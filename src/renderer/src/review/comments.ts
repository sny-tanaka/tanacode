// コードへのレビューコメント（エディタ・差分の行に付けて、チャットの送信と一緒に Claude に渡す）
export type ReviewComment = { id: string; path: string; startLine: number; endLine: number; quote: string; text: string };

// 送信する本文に付ける、コメントの一覧
export function formatComments(comments: ReviewComment[]): string {
  const blocks = comments.map((c, i) => {
    const lines = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
    return `[${i + 1}] ${c.path}:${lines}\n\`\`\`\n${c.quote}\n\`\`\`\n${c.text}`;
  });
  return `以下はコードへのレビューコメントです。それぞれ対応してください。\n\n${blocks.join('\n\n')}`;
}
