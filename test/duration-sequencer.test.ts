import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import cliDurations from './cli/durations.json';
import e2eDurations from './e2e/durations.json';
import { longestFirst, partition } from './helpers/duration-sequencer';

// ファイルごとの時間の表で、テストのファイルを流す台・順を決める（test/helpers/duration-sequencer.ts）。
// E2E は CI で 3 台に分け、本物の claude のテスト（cli）は長いものから流す

const testFiles = (dir: string) =>
  readdirSync(join(__dirname, dir))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `test/${dir}/${name}`);
const total = (files: string[], seconds: Record<string, number>) => files.reduce((sum, file) => sum + seconds[file], 0);

describe.each([
  ['e2e', e2eDurations],
  ['cli', cliDurations],
])('test/%s の時間の表', (dir, seconds) => {
  it('どのテストのファイルも載っていて、無いファイルは載っていない（ファイルを足したら、CI のログの秒数で表にも足す）', () => {
    const files = testFiles(dir);
    expect(files.filter((file) => !(file in seconds))).toEqual([]);
    expect(Object.keys(seconds).filter((file) => !files.includes(file))).toEqual([]);
  });
});

it('E2E のファイルを 3 台に分けると、どのファイルもちょうど 1 つの台に入る', () => {
  const files = testFiles('e2e');
  const shards = partition(files, 3, e2eDurations);
  expect(shards).toHaveLength(3);
  expect(shards.flat().sort()).toEqual([...files].sort());
});

it('E2E を 3 台に分けると、いちばん重い台といちばん軽い台の差は、いちばん重いファイルより小さい', () => {
  const shards = partition(testFiles('e2e'), 3, e2eDurations).map((files) => total(files, e2eDurations));
  expect(Math.max(...shards) - Math.min(...shards)).toBeLessThan(Math.max(...Object.values(e2eDurations)));
});

it('長いものから順に、合計のいちばん短い台に入れる（重いファイルが 1 つの台に寄らない）', () => {
  const seconds = { a: 60, b: 50, c: 40, d: 30, e: 20, f: 10 };
  // a・b・c を 1 台ずつに入れたあと、d は合計のいちばん短い c の台（40）へ、e は b の台（50）へ、f は a の台（60）へ
  expect(partition(Object.keys(seconds), 3, seconds)).toEqual([
    ['a', 'f'],
    ['b', 'e'],
    ['c', 'd'],
  ]);
});

it('表に無いファイルは、表の中央値として数える', () => {
  // 中央値は 20。x は 20 として、合計が短いほうの台へ入る
  const seconds = { a: 30, b: 20, c: 10 };
  expect(longestFirst(['c', 'x', 'b', 'a'], seconds)).toEqual(['a', 'b', 'x', 'c']);
  expect(partition(['a', 'b', 'c', 'x'], 2, seconds)).toEqual([
    ['a', 'c'],
    ['b', 'x'],
  ]);
});

it('同じ時間のファイルは名前の順にする（どの台で分けても同じ分け方になる）', () => {
  const seconds = { b: 10, a: 10, d: 10, c: 10 };
  expect(partition(['d', 'c', 'b', 'a'], 2, seconds)).toEqual([
    ['a', 'c'],
    ['b', 'd'],
  ]);
  expect(partition(['a', 'b', 'c', 'd'], 2, seconds)).toEqual([
    ['a', 'c'],
    ['b', 'd'],
  ]);
});
