// Claude Code の入力欄（pty）に送る文章・チャットの入力欄に差し込む文章を整える

// 制御文字の除去は、main が Claude Code の入力欄に打ち込むときにも使うので shared に置く
export { stripControlChars } from '@shared/prompt-keys';

// 中身に含まれる最も長いバッククォートの連続の長さ
function longestBackticks(content: string): number {
  return Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
}

// 中身をコードブロックで囲む。フェンスは中身の最も長いバッククォートの連続より長くして、
// 中身の ``` でブロックから抜けられないようにする（CommonMark のフェンスの決まり）
export function codeBlock(content: string, lang = ''): string {
  const fence = '`'.repeat(Math.max(3, longestBackticks(content) + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

// 1 行の中のコード。区切りのバッククォートは中身の連続より長くし、中身の端がバッククォートなら空白を挟む
export function inlineCode(content: string): string {
  const tick = '`'.repeat(longestBackticks(content) + 1);
  const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
  return `${tick}${pad}${content}${pad}${tick}`;
}
