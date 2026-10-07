// ミューテーションテスト（scripts/mutation.mjs）の、テストを流す側。親が fork で起動し、IPC で指示を受けて結果を返す。
// 対象のファイルの中身は Vite のプラグインで差し替える（ソースのファイルは書き換えない）。テストの出力は出さない。
// プロジェクトの設定（vitest.config.ts）をそのまま使う
// - hits <同時に流す数>: 印を付けた対象のコードで、テストのファイルを流し、テストごとに通った場所（mutation-setup.mjs）と時間を返す
// - host: Vitest を 1 つ立ち上げたままにして、ミュータントごとに、指定のテストだけを流す。1 つ落ちたら止める（bail）
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';

const SETUP = join(fileURLToPath(new URL('.', import.meta.url)), 'mutation-setup.mjs');
const [mode, workers] = process.argv.slice(2);
const send = (message) => new Promise((done) => process.send(message, done));
const nextMessage = () => new Promise((done) => process.once('message', done));
// 何も出さないレポーター
const quiet = { onInit() {} };

// 差し替える中身（ファイルの絶対パス → コード）
let replaced = new Map();
const replace = {
  name: 'tanacode-mutation',
  enforce: 'pre',
  load(id) {
    return replaced.get(id.split('?')[0]) ?? null;
  },
};

// 流した結果を、落ちた（killed）・全部通った（survived）に分ける。落ちたときは、はじめに落ちたテストの名前を添える
function judge({ testModules, unhandledErrors }) {
  let passed = 0;
  let failed = null;
  for (const module of testModules) {
    for (const test of module.children.allTests()) {
      const state = test.result().state;
      if (state === 'passed') passed++;
      else if (state === 'failed') failed ??= `${module.relativeModuleId} > ${test.fullName}`;
    }
    // 読み込みの時点で落ちた（例外・構文の誤り）
    if (module.state() === 'failed') failed ??= `${module.relativeModuleId}（読み込み）`;
  }
  if (!failed && unhandledErrors.length > 0) failed = 'テストの外の例外';
  return { status: failed ? 'killed' : passed > 0 ? 'survived' : 'no-tests', passed, failed };
}

if (mode === 'hits') {
  const vitest = await createVitest(
    'test',
    {
      config: 'vitest.config.ts',
      watch: false,
      silent: true,
      reporters: [quiet],
      maxWorkers: Number(workers) || 1,
      setupFiles: [SETUP],
      coverage: { enabled: false },
    },
    { plugins: [replace] },
  );
  await send({ type: 'ready' });
  const { files, testFiles } = await nextMessage();
  replaced = new Map(Object.entries(files));
  const result = await vitest.runTestFiles(testFiles);
  const tests = [];
  const modules = [];
  for (const module of result.testModules) {
    const d = module.diagnostic();
    modules.push({ file: module.moduleId, ms: d.duration, overheadMs: d.environmentSetupDuration + d.prepareDuration + d.collectDuration + d.setupDuration });
    for (const test of module.children.allTests()) {
      const meta = test.meta();
      tests.push({
        id: test.id,
        file: module.moduleId,
        ms: test.diagnostic()?.duration ?? 0,
        hits: meta.mutationHits ?? [],
        setupHits: meta.mutationSetupHits ?? [],
      });
    }
  }
  await send({ type: 'hits', ...judge(result), tests, modules });
  await vitest.close();
  process.exit(0);
}

if (mode === 'host') {
  // 流す順（親が、速いテストのファイルから並べて渡す。早く落ちれば、残りは流さずに済む）
  let order = [];
  class InOrder {
    async shard(files) {
      return files;
    }
    async sort(files) {
      const rank = (spec) => (order.indexOf(spec.moduleId) + order.length + 1) % (order.length + 1);
      return [...files].sort((a, b) => rank(a) - rank(b));
    }
  }
  const vitest = await createVitest(
    'test',
    {
      config: 'vitest.config.ts',
      watch: false,
      silent: true,
      reporters: [quiet],
      maxWorkers: 1,
      bail: 1,
      coverage: { enabled: false },
      sequence: { sequencer: InOrder },
    },
    { plugins: [replace] },
  );
  const project = vitest.getRootProject();
  process.on('message', async (message) => {
    if (message.type !== 'run') return;
    const previous = [...replaced.keys()];
    replaced = new Map(message.code === null ? [] : [[message.file, message.code]]);
    for (const file of new Set([...previous, message.file])) vitest.invalidateFile(file);
    order = message.specs.map((s) => s.file);
    // testIds が無いものは、ファイルのテストを全部流す
    const specs = message.specs.map((s) => project.createSpecification(s.file, s.testIds ? { testIds: s.testIds } : undefined));
    const started = Date.now();
    let result;
    try {
      result = judge(await vitest.runTestSpecifications(specs));
    } catch (error) {
      result = { status: 'error', passed: 0, failed: String(error?.stack ?? error).slice(0, 2000) };
    }
    await send({ type: 'result', id: message.id, ...result, ms: Date.now() - started });
  });
  await send({ type: 'ready' });
}
