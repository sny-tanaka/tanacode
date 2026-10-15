import { relative, sep } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import durations from './durations.json';

// CI で E2E を何台かに分けて流すとき（--shard）、どの台もかかる時間がそろうように分ける。
// vitest の既定の分け方（ファイルのパスのハッシュの順に、数で等分）では、重いファイル（sessions など）が 1 つの台に寄り、
// その台が全体の時間を決めていた。ファイルごとの時間（durations.json。CI で測った秒数）の長いものから順に、
// そのときの合計がいちばん短い台に入れる。表に無いファイルは、表の中央値として扱う

/** files を count 個に分ける。どの台で呼んでも同じ分け方になるよう、同じ時間のものは名前の順に入れる */
export function partition(files: readonly string[], count: number, seconds: Readonly<Record<string, number>>): string[][] {
  const known = Object.values(seconds).sort((a, b) => a - b);
  const fallback = known.length > 0 ? known[Math.floor(known.length / 2)] : 1;
  const weight = (file: string) => seconds[file] ?? fallback;
  const sorted = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ total: 0, files: [] as string[] }));
  for (const file of sorted) {
    // 合計が同じなら、前の台に入れる
    const lightest = shards.reduce((min, shard) => (shard.total < min.total ? shard : min));
    lightest.files.push(file);
    lightest.total += weight(file);
  }
  return shards.map((shard) => shard.files);
}

export default class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const name = (spec: TestSpecification) => relative(root, spec.moduleId).split(sep).join('/');
    const mine = new Set(partition(files.map(name), shard.count, durations)[shard.index - 1]);
    return files.filter((spec) => mine.has(name(spec)));
  }
}
