// 貼り付けた文の扱い。チャットの入力欄の札（長い貼り付け）、ターミナルモードの TUI に貼るときの囲み、外から来た文の制御文字

// これより長い文を貼り付けると、札にする
const PASTE_CHARS = 800;
// 貼り付けがこの行数以上なら、札にする
const PASTE_LINES = 4;

// 長い貼り付けか（Claude Code の画面の入力欄が [Pasted text #1 +3 lines] の目印に置き換える貼り付けと同じ境目）。チャットの入力欄では、
// 文字として入れずに札にして、送るときに pasted_content として渡す（SessionManager.submit の pastes。Claude Code が <pasted_content> の
// 囲みに入れて Claude に渡す）。2026-10-12、Claude Code 2.1.296 で確かめた: 3 行・767 文字の貼り付けは文字のまま、4 行・1,569 文字は目印になる
export function isLongPaste(text: string): boolean {
  return text.length > PASTE_CHARS || text.split('\n').length >= PASTE_LINES;
}

// 端末に貼り付けとして書く（ブラケットペースト）。ターミナルモードの TUI の入力欄に貼るとき（Enter は送らない）。
// 中の文は、先に stripControlChars を通しておく（ESC が残ると、ESC[201~ で貼り付けを抜けてしまう）
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

// キー操作として解釈されうる制御文字と、目に見えない制御文字を取り除く。
// ESC（\x1b）が残ると、ブラケットペーストを途中で終わらせたり（\x1b[201~）、Shift+Tab（\x1b[Z）などのキーとして届いたりする。
// ^U（行を消す）・^H（1 文字消す）や双方向の制御文字（U+202E など）は、見えている文字と実際に送る文字をずらせる。
// 改行（\n）とタブ（\t）だけ残し、CR（\r\n・\r）は改行にそろえる。チャットの入力・シェルに書くコマンド・画面に出す文で使う
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;

export function stripControlChars(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
}
