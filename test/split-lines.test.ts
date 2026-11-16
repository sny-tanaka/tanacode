import { describe, expect, it } from 'vitest';
import { splitLines, type LineLimit } from '../src/main/split-lines';

// ソケットに 1 行ずつ書いた JSON を、届いた断片から行に分ける部品（pty ホストとアプリ・MCP の中継とアプリのやりとりで使う）。
// 本物のソケットで長い行を受け取るところは、test/pty-host-client.test.ts・test/pty-host-server.test.ts・test/mcp-bridge.test.ts

describe('splitLines', () => {
  const split = (chunks: string[], stopAt?: string, limit?: LineLimit) => {
    const lines: string[] = [];
    const push = splitLines((line) => {
      lines.push(line);
      return line === stopAt;
    }, limit);
    for (const chunk of chunks) push(chunk);
    return lines;
  };

  it('断片の切れ目をまたぐ行をつなぎ、1 つの断片の中の行は順に渡す。改行の無い末尾は、次の断片まで持っておく', () => {
    expect(split(['a', 'b\nc\n', '\nd', 'e', '\n', 'f'])).toEqual(['ab', 'c', '', 'de']);
  });

  it('true を返したら、同じ断片の残りの行は渡さない（hello の返事を受けたら、そこで聞くのをやめる）', () => {
    expect(split(['x\nhello\ny\n'], 'hello')).toEqual(['x', 'hello']);
  });

  // 直す前: 断片が届くたびに、溜めた全体を先頭から改行を探し直していたので、長い行を受け取る時間が行の長さの 2 乗で伸びた
  // （9MB の行 2 本で約 1 秒。大きな出力の stream-json の 1 行で main が止まり、ほかのテストと流すと時間切れで落ちた）
  it('長い行を細かい断片で受け取っても、行の長さに比例する時間で済む（改行は新しく届いた断片の中だけを探す）', () => {
    const chunk = 'x'.repeat(16 * 1024);
    const chunks = [...Array<string>(4096).fill(chunk), '\n'];
    const started = performance.now();
    const lines = split(chunks);
    // 64MB の行。探し直すと 4096 回 × 平均 32MB を読み直すので 10 秒ほどかかる。比例する時間なら数十ミリ秒
    expect(performance.now() - started).toBeLessThan(1000);
    expect(lines.map((line) => line.length)).toEqual([64 * 1024 * 1024]);
  });

  it('上限より長い行は、改行が来る前でも onTooLong を 1 度だけ呼び、そのあとは何も渡さない。上限ちょうどの行は渡す', () => {
    let tooLong = 0;
    const limit = { maxLength: 4, onTooLong: () => tooLong++ };
    expect(split(['abcd\nab', 'cde', '\nok\n'], undefined, limit)).toEqual(['abcd']);
    expect(tooLong).toBe(1);
    // 1 つの断片の中の、改行で終わった長い行・末尾の長い残り
    tooLong = 0;
    expect(split(['ok\nabcde\nnext\n'], undefined, limit)).toEqual(['ok']);
    expect(tooLong).toBe(1);
    tooLong = 0;
    expect(split(['ok\nabcde'], undefined, limit)).toEqual(['ok']);
    expect(tooLong).toBe(1);
  });
});
