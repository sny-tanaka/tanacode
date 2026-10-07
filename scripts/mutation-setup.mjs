// ミューテーションテスト（scripts/mutation.mjs）で、テストごとに、対象のコードのどこを通ったかを記録する（Vitest の setupFiles）。
// 印を付けたコード（mutation.mjs の instrument）が、通った場所の番号を globalThis.__tanacodeMutationHit で知らせる。
// - テストの中（beforeEach から afterEach まで）で通った場所は、そのテストの meta.mutationHits に
// - テストの外（読み込み・beforeAll）で通った場所は、次のテストの meta.mutationSetupHits に（ファイルのテスト全部に関わるものとして扱う）
// テストを 1 つずつ順に流す前提（test.concurrent は使っていない）
import { afterEach, beforeEach } from 'vitest';

const hits = new Set();
globalThis.__tanacodeMutationHit = (id) => {
  hits.add(id);
};
// 正規表現は、作ったときではなく、使ったとき（exec。test・match・replace なども exec を通る）に知らせる
class Probe extends RegExp {
  // split などが写しを作るときは、元の番号を引き継ぐ
  constructor(pattern, flags, id) {
    super(pattern, flags);
    this.mutationId = id ?? pattern?.mutationId;
  }
  exec(text) {
    hits.add(this.mutationId);
    return super.exec(text);
  }
}
globalThis.__tanacodeMutationRegExp = (id, regexp) => new Probe(regexp, regexp.flags, id);

beforeEach(({ task }) => {
  if (hits.size > 0) task.meta.mutationSetupHits = [...hits];
  hits.clear();
});

afterEach(({ task }) => {
  task.meta.mutationHits = [...hits];
  hits.clear();
});
