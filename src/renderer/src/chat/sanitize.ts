// Claude Code の入力欄（pty）に送る文章・チャットの入力欄に差し込む文章を整える

// キー操作として解釈されうる制御文字と、目に見えない制御文字を取り除く。
// ESC（\x1b）が残ると、ブラケットペーストを途中で終わらせたり（\x1b[201~）、Shift+Tab（\x1b[Z）などのキーとして届いたりする。
// ^U（行を消す）・^H（1 文字消す）や双方向の制御文字（U+202E など）は、見えている文字と実際に送る文字をずらせる。
// 改行（\n）とタブ（\t）だけ残し、CR（\r\n・\r）は改行にそろえる。チャットの入力・シェルに書くコマンドの両方で使う
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function stripControlChars(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
}

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
