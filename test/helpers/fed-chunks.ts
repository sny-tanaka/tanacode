import { vi } from 'vitest';
import type * as SplitLines from '../../src/main/split-lines';

// 本物のソケットで長い行を受け取る部品（MCP の中継とアプリ・pty ホスト）が、届いた断片をそのまま splitLines に渡しているかを数える。
// テストのファイルで vi.mock('../src/main/split-lines', () => import('./helpers/fed-chunks')) と差し替えて使う。
// 以前は、30MB の行を受け取る時間が 1 秒未満かを測っていたが、CI で単体テストの全体を並べて流すと、比例する時間で読めていても
// 1 秒を超えて落ちた（手元では 60〜100ms・2 乗で伸びる読み方なら 5 秒を超える）。行の長さに比例する時間で読めることは、
// CPU だけで測れる test/split-lines.test.ts が確かめ、ここでは、部品の側で溜めた全体を渡し直していないか（渡した量）を見る
const real = await vi.importActual<typeof SplitLines>('../../src/main/split-lines');

// vi.resetModules で読み直されても（test/pty-host-server.test.ts はホストを読み込むたびに読み直す）、同じ数を見るように globalThis に置く
const key = Symbol.for('tanacode.test.fedChunks');
const holder = globalThis as unknown as Record<symbol, { chunks: number; length: number } | undefined>;
const fed = (holder[key] ??= { chunks: 0, length: 0 });

// 数えた量を空にする（長い行を送る直前に呼ぶ）
export function resetFedChunks(): void {
  fed.chunks = 0;
  fed.length = 0;
}

// resetFedChunks のあとに、すべての splitLines に渡された断片の数と、文字数の合計
export function fedChunks(): { chunks: number; length: number } {
  return { ...fed };
}

export const splitLines: typeof SplitLines.splitLines = (onLine, limit) => {
  const push = real.splitLines(onLine, limit);
  return (chunk) => {
    fed.chunks++;
    fed.length += chunk.length;
    push(chunk);
  };
};
