// Claude Code の入力欄（pty）に打ち込む文字。チャットの入力欄から送るとき（ChatInput）と、
// Claude Code との互換性の確認（test/cli）で同じものを使う

// 発言を打ち込む文字（制御文字は先に除いておく）。改行を含む入力はブラケットペーストで送り、途中の改行で送信されないようにする。
// 1 行の入力は打鍵で送る（制御文字は除いてあるので、キー操作になる文字は残らない。/compact などのコマンドも今までどおり届く）
export function promptKeys(text: string): string {
  return text.includes('\n') ? bracketedPaste(text) : text;
}

// 貼り付けとして送る。添付するファイルのパスもこれで送る（画像は [Image #n] として添付される）
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
