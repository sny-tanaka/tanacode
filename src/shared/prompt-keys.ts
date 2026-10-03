// Claude Code の入力欄（pty）に打ち込む文字。チャットの入力欄から送るとき・親セッションから指示するとき（main の SessionManager.submit）と、
// Claude Code との互換性の確認（test/cli）で同じものを使う

// これより長い文字が 1 度に届くと、Claude Code は打鍵でも貼り付けとみなす
const PASTE_CHARS = 800;
// 引数に長い文・複数行の文を取るコマンド（コンテキストのパネルが、圧縮の指示を添えて送る）
const ARGUMENT_COMMANDS = new Set(['/compact']);

// 発言を打ち込む文字（制御文字は先に除いておく）。改行を含む入力はブラケットペーストで送り、途中の改行で送信されないようにする。
// 1 行の入力は打鍵で送る（制御文字は除いてあるので、キー操作になる文字は残らない。/compact などのコマンドも今までどおり届く）
export function promptKeys(text: string): string {
  // 引数が複数行・長い /compact は、名前だけを打鍵して、引数を貼り付けで送る。丸ごと貼り付けると、Claude Code は入力を
  // [Pasted text #1 …] の目印に置き換え、/ で始まらない入力として、コマンドにせずに送るため。
  // ほかの「/単語」で始まる複数行の発言（「/api のエンドポイントを…」など）は、コマンドにならないよう今までどおり丸ごと貼り付ける
  const command = /^(\/\S+)\s+(\S[\s\S]*)$/.exec(text);
  if (command && ARGUMENT_COMMANDS.has(command[1]) && (text.includes('\n') || text.length > PASTE_CHARS)) {
    return `${command[1]} ${bracketedPaste(command[2])}`;
  }
  return text.includes('\n') ? bracketedPaste(text) : text;
}

// 貼り付けとして送る。添付するファイルのパスもこれで送る（画像は [Image #n] として添付される）
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

// キー操作として解釈されうる制御文字と、目に見えない制御文字を取り除く。
// ESC（\x1b）が残ると、ブラケットペーストを途中で終わらせたり（\x1b[201~）、Shift+Tab（\x1b[Z）などのキーとして届いたりする。
// ^U（行を消す）・^H（1 文字消す）や双方向の制御文字（U+202E など）は、見えている文字と実際に送る文字をずらせる。
// 改行（\n）とタブ（\t）だけ残し、CR（\r\n・\r）は改行にそろえる。チャットの入力・シェルに書くコマンドの両方で使う
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function stripControlChars(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
}
