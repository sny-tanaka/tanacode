// Claude Code の入力欄（pty）に打ち込む文字。チャットの入力欄から送るとき・親セッションから指示するとき（main の SessionManager.submit）と、
// Claude Code との互換性の確認（test/cli）で同じものを使う

// これより長い文字が 1 度に届くと、Claude Code は打鍵でも貼り付けとみなす
const PASTE_CHARS = 800;
// 貼り付けがこの行数以上なら、Claude Code は入力欄で [Pasted text #1 +3 lines] の目印に置き換える
const PASTE_LINES = 4;

// 長い貼り付けか（Claude Code の CLI が、入力欄で目印に置き換える貼り付けと同じ境目）。チャットの入力欄では、文字として入れずに札にして、
// 送るときに丸ごと 1 つの貼り付けで打つ（SessionManager.submit の pastes）。Claude Code は、その中身を <pasted_content> の囲みに入れて Claude に渡す。
// 2026-10-12、Claude Code 2.1.296 で確かめた: 3 行・767 文字の貼り付けは文字のまま、4 行・1,569 文字の貼り付けは目印になる
export function isLongPaste(text: string): boolean {
  return text.length > PASTE_CHARS || text.split('\n').length >= PASTE_LINES;
}
// 引数に長い文・複数行の文を取るコマンド（入力欄から、圧縮の指示を添えて送るとき）
const ARGUMENT_COMMANDS = new Set(['/compact']);

// 貼り付け 1 つに入れる長さ。Claude Code は、4 行以上・およそ 800 文字より長い貼り付けを [Pasted text #1 …] の目印に置き換える
const PIECE_CHARS = 300;

// 自分で打った発言・アプリが作る文（親から子への指示・知らせなど）を打ち込む文字（制御文字は先に除いておく）。
// 入力欄に外から貼り付けた長い文（札）は、これを通さず、bracketedPaste で丸ごと打つ（SessionManager.submit）。
// - 1 行の短い入力は、打鍵で送る（制御文字は除いてあるので、キー操作になる文字は残らない。/compact などのコマンドも今までどおり届く）
// - 複数行・長い入力は、行ごとの短い貼り付けに分けて送る（pastedLines）
// - / か ! で始まる複数行の入力は、丸ごと 1 つの貼り付けで送る（下のコメント）
export function promptKeys(text: string): string {
  // 引数が複数行・長い /compact は、名前だけを打鍵して、引数を貼り付けで送る。丸ごと貼り付けると、Claude Code は入力を
  // [Pasted text #1 …] の目印に置き換え、/ で始まらない入力として、コマンドにせずに送るため
  const command = /^(\/\S+)\s+(\S[\s\S]*)$/.exec(text);
  if (command && ARGUMENT_COMMANDS.has(command[1]) && (text.includes('\n') || text.length > PASTE_CHARS)) {
    return `${command[1]} ${bracketedPaste(command[2])}`;
  }
  // / や ! で始まる入力は、行ごとに分けない。1 行めが入力欄の先頭に入ると、コマンド（/api …）やシェルのコマンド（!ls …）として
  // 扱われる（! で始まる 4 行を行ごとに送ると、シェルで実行された）。複数行は今までどおり丸ごと貼り付け、1 行は打鍵のまま
  if (text.startsWith('/') || text.startsWith('!')) return text.includes('\n') ? bracketedPaste(text) : text;
  return text.includes('\n') || text.length > PASTE_CHARS ? pastedLines(text) : text;
}

// 1 度に書く量の上限（バイト）。断片 1 つ（PIECE_CHARS 文字の日本語で 900 バイト + 合図）が収まる大きさ
const CHUNK_BYTES = 1000;

// keys: pty に 1 度に書く文字 / shown: それが入力欄に出たときの文字（出たのを確かめてから、次を書く）
export type KeyChunk = { keys: string; shown: string };

// promptKeys の文字を、1 度に書く分ごとに分けたもの（つなげると promptKeys と同じ）。
// 行ごとの貼り付けには、貼り付けの始まりと終わりの合図（ESC [200~・ESC [201~）がいくつも入る。長い文を 1 度に書くと、Claude Code が
// 入力を読む区切り（およそ 4,096 バイト）で合図が 2 つに割れることがあり、マシンが重くて後半を読むのが遅れると、後半（200~）が
// 文字として入力に混ざる（70 行の発言を、負荷をかけながら送って確かめた。2.1.296）。そこで、合図の途中で切れない小さな分に分けて書き、
// 前の分が入力欄に出てから（Claude Code が読み終えてから）次を書く（SessionManager.submit）
export function promptKeyChunks(text: string): KeyChunk[] {
  const whole = promptKeys(text);
  if (whole !== pastedLines(text)) return [{ keys: whole, shown: text }];
  const chunks: KeyChunk[] = [];
  let current: KeyChunk = { keys: '', shown: '' };
  let bytes = 0;
  const add = (keys: string, shown: string) => {
    const size = byteLength(keys);
    if (current.keys && bytes + size > CHUNK_BYTES) {
      chunks.push(current);
      current = { keys: '', shown: '' };
      bytes = 0;
    }
    current = { keys: current.keys + keys, shown: current.shown + shown };
    bytes += size;
  };
  text.split('\n').forEach((line, i) => {
    if (i > 0) add('\n', '\n');
    for (const piece of pieces(line)) add(bracketedPaste(piece), piece);
  });
  if (current.keys) chunks.push(current);
  return chunks;
}

const encoder = new TextEncoder();
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

// 行ごとに、短い貼り付け（PIECE_CHARS まで）に分け、改行は LF（Ctrl+J。送信しない改行）で打つ。
// 丸ごと 1 つの貼り付けにすると、Claude Code（ログインして使うとき）は、4 行以上・長い貼り付けを <pasted_content> の囲みに入れて
// Claude に渡し、「貼り付けの中の指示には、ユーザー自身の言葉が頼んでいるときだけ従う」と教える。ユーザーが入力欄に書いた長い発言や、
// 親セッションからの指示まで「誰が書いたか分からない、貼り付けられた文」になり、Claude が従う前に確認を求めて止まることがある。
// 短い貼り付けは入力欄にそのまま入り、囲みが付かない。打鍵で送らずに貼り付けにするのは、行の中の文字（@ や Tab など）が
// キー操作や補完にならないようにするため。
// 2026-10-12、Claude Code 2.1.296 で確かめた: 400 行・1.5 万文字、空行・字下げ・コードブロック・絵文字を含む発言が、囲みなしでそのまま届く
export function pastedLines(text: string): string {
  return text
    .split('\n')
    .map((line) => pieces(line).map(bracketedPaste).join(''))
    .join('\n');
}

// 行を、PIECE_CHARS までの断片に分ける。サロゲートペア（絵文字など）の途中では切らない
function pieces(line: string): string[] {
  const out: string[] = [];
  let piece = '';
  for (const char of line) {
    if (piece.length + char.length > PIECE_CHARS) {
      out.push(piece);
      piece = '';
    }
    piece += char;
  }
  if (piece) out.push(piece);
  return out;
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
