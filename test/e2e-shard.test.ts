import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import durations from './e2e/durations.json';
import { partition } from './e2e/sequencer';

// CI で E2E を何台かに分けるときの分け方（test/e2e/sequencer.ts）

const e2eFiles = readdirSync(join(__dirname, 'e2e'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `test/e2e/${name}`);
const total = (files: string[], seconds: Record<string, number>) => files.reduce((sum, file) => sum + seconds[file], 0);

it('どのファイルも、ちょうど 1 つの台に入る', () => {
  const shards = partition(e2eFiles, 3, durations);
  expect(shards).toHaveLength(3);
  expect(shards.flat().sort()).toEqual([...e2eFiles].sort());
});

it('台の合計がそろう（重いファイルが 1 つの台に寄らない）', () => {
  const seconds = { a: 60, b: 50, c: 40, d: 30, e: 20, f: 10 };
  // a・b・c を 1 台ずつに入れたあと、d は合計のいちばん短い c の台（40）へ、e は b の台（50）へ、f は a の台（60）へ
  expect(partition(Object.keys(seconds), 3, seconds)).toEqual([['a', 'f'], ['b', 'e'], ['c', 'd']]);
});

it('今の E2E のファイルを 3 台に分けると、いちばん重い台といちばん軽い台の差は、いちばん重いファイルより小さい', () => {
  const shards = partition(e2eFiles, 3, durations).map((files) => total(files, durations));
  expect(Math.max(...shards) - Math.min(...shards)).toBeLessThan(Math.max(...Object.values(durations)));
});

it('E2E のファイルは、どれも時間の表に載っている（足したら、CI のログの秒数で表にも足す）', () => {
  expect(e2eFiles.filter((file) => !(file in durations))).toEqual([]);
  expect(Object.keys(durations).filter((file) => !e2eFiles.includes(file))).toEqual([]);
});

it('表に無いファイルは、表の中央値として数える', () => {
  // 中央値は 20。x は 20 として、合計が短いほうの台へ入る
  const seconds = { a: 30, b: 20, c: 10 };
  expect(partition(['a', 'b', 'c', 'x'], 2, seconds)).toEqual([['a', 'c'], ['b', 'x']]);
});

it('同じ時間のファイルは名前の順に入れる（どの台で分けても同じ分け方になる）', () => {
  const seconds = { b: 10, a: 10, d: 10, c: 10 };
  expect(partition(['d', 'c', 'b', 'a'], 2, seconds)).toEqual([['a', 'c'], ['b', 'd']]);
  expect(partition(['a', 'b', 'c', 'd'], 2, seconds)).toEqual([['a', 'c'], ['b', 'd']]);
});
