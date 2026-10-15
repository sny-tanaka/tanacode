import { relative, sep } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// テストのファイルごとの時間の表（durations.json。CI で測った秒数）で、vitest がファイルを流す台・順を決める（sequence.sequencer）。
// 表に無いファイルは、表の中央値として扱う。同じ時間のものは名前の順にして、どこで決めても同じになるようにする

type Seconds = Readonly<Record<string, number>>;

function weigher(seconds: Seconds): (file: string) => number {
  const known = Object.values(seconds).sort((a, b) => a - b);
  const fallback = known.length > 0 ? known[Math.floor(known.length / 2)] : 1;
  return (file) => seconds[file] ?? fallback;
}

/** 長いものから順に並べる */
export function longestFirst(files: readonly string[], seconds: Seconds): string[] {
  const weight = weigher(seconds);
  return [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
}

/** files を count 個に分ける。長いものから順に、そのときの合計がいちばん短いところ（同じなら前）に入れる */
export function partition(files: readonly string[], count: number, seconds: Seconds): string[][] {
  const weight = weigher(seconds);
  const shards = Array.from({ length: count }, () => ({ total: 0, files: [] as string[] }));
  for (const file of longestFirst(files, seconds)) {
    const lightest = shards.reduce((min, shard) => (shard.total < min.total ? shard : min));
    lightest.files.push(file);
    lightest.total += weight(file);
  }
  return shards.map((shard) => shard.files);
}

/**
 * - shard: --shard で何台かに分けるとき、台の合計の時間がそろうように分ける（vitest の既定は、パスのハッシュの順に数で等分するので、
 *   重いファイルが 1 つの台に寄ることがある）
 * - sort（sortLongestFirst のとき）: 長いものから流す（ファイルを並べて流すとき、長いファイルが最後に残って終わりが延びないように）。
 *   付けないときは vitest の既定（前に落ちたもの・長かったものから。手元の記録を使う）
 */
export function durationSequencer(seconds: Seconds, { sortLongestFirst = false } = {}): typeof BaseSequencer {
  return class DurationSequencer extends BaseSequencer {
    private name(spec: TestSpecification): string {
      return relative(this.ctx.config.root, spec.moduleId).split(sep).join('/');
    }

    override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
      const { shard } = this.ctx.config;
      if (!shard) return files;
      const mine = new Set(partition(files.map((spec) => this.name(spec)), shard.count, seconds)[shard.index - 1]);
      return files.filter((spec) => mine.has(this.name(spec)));
    }

    override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
      if (!sortLongestFirst) return super.sort(files);
      const order = longestFirst(files.map((spec) => this.name(spec)), seconds);
      return [...files].sort((a, b) => order.indexOf(this.name(a)) - order.indexOf(this.name(b)));
    }
  };
}
