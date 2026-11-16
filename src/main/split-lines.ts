// ソケットに 1 行ずつ書いた JSON（pty ホストとアプリ・MCP の中継とアプリのやりとり）を、届いた断片から行に分ける。
// アプリ（main）・pty ホスト・MCP の中継（Claude Code が起動する）の、別々のビルドの入り口から読むので、ほかのものを読み込まない

// 行の長さの上限。超えたら onTooLong を呼び、そのあとは何も渡さない（相手が壊れているので、呼んだ側が接続を切る）
export type LineLimit = { maxLength: number; onTooLong: () => void };

// 届いた断片を行に分けて、onLine に渡す（onLine が true を返したら、同じ断片の残りは渡さない）。
// 改行は、新しく届いた断片の中だけを探す。溜めた全体を先頭から探し直すと、長い行（大きな出力の stream-json の 1 行・
// スクリーンショットの入ったツールの結果）を細かい断片で受け取る時間が、行の長さの 2 乗で伸びる
export function splitLines(onLine: (line: string) => boolean | void, limit?: LineLimit): (chunk: string) => void {
  let pending = '';
  let stopped = false;
  const tooLong = (length: number) => {
    if (!limit || length <= limit.maxLength) return false;
    stopped = true;
    pending = '';
    limit.onTooLong();
    return true;
  };
  return (chunk) => {
    if (stopped) return;
    let newline = chunk.indexOf('\n');
    if (newline < 0) {
      pending += chunk;
      tooLong(pending.length);
      return;
    }
    let line = pending + chunk.slice(0, newline);
    pending = '';
    for (;;) {
      if (tooLong(line.length) || onLine(line) === true) return;
      const start = newline + 1;
      newline = chunk.indexOf('\n', start);
      if (newline < 0) {
        pending = chunk.slice(start);
        tooLong(pending.length);
        return;
      }
      line = chunk.slice(start, newline);
    }
  };
}
