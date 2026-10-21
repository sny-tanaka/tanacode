import { availableParallelism, loadavg } from 'node:os';
import { onTestFailed } from 'vitest';

// テストの段ごとの経過時間を覚え、落ちたとき（時間切れも）に、段ごとの経過と、そのときの Mac（CI の台）の負荷を出す。
// git を何度も動かすテストが、単体テストの全体を並べて流したときに 5 秒の時間切れで落ちたことがあり（手元では再現しなかった）、
// どの段で遅れたか（1 つの段だけか、どの段も遅いか）と、CPU の取り合いがあったかを、次に落ちたときに読めるようにする。
// 返す関数を、段を終えるたびに段の名前で呼ぶ
export const stages = (): ((name: string) => void) => {
  const start = performance.now();
  const marks: string[] = [];
  onTestFailed(() => {
    const load = loadavg().map((n) => n.toFixed(1)).join(' / ');
    console.log(`段ごとの経過: ${marks.join(' → ') || '（最初の段の途中）'}。負荷（1・5・15 分の平均）: ${load}。CPU: ${availableParallelism()} 個`);
  });
  return (name) => marks.push(`${name} ${Math.round(performance.now() - start)}ms`);
};
