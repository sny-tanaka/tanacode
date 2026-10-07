// E2E（npm run coverage:e2e）で集めた V8 のカバレッジを、src の行に戻して coverage/e2e/coverage-final.json に書く。
// npm run coverage:report が、ほかのカバレッジ（coverage/unit・coverage/cli）と合わせて層ごとに出す。
// - メインプロセス・pty ホスト・MCP の中継: NODE_V8_COVERAGE が書いたもの（coverage/e2e-raw/v8/*.json）
// - 画面: Playwright の page.coverage で取ったもの（coverage/e2e-raw/renderer-*.json）
// どちらも、ビルドしたスクリプト（out/）の位置なので、ビルドのときに書き出したソースマップ（TANACODE_SOURCEMAP=1）で src に戻す。
// パッケージした .app のスクリプト（…/app.asar/out/…）は、手元の out/ の同じファイルとして読む（同じビルドから作ったもの）
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import astV8ToIstanbul from 'ast-v8-to-istanbul';
import libCoverage from 'istanbul-lib-coverage';
import { parseAstAsync } from 'vitest/node';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = join(root, 'coverage', 'e2e-raw');
const outDir = join(root, 'coverage', 'e2e');

// 数えるファイル（vitest.coverage.ts と同じ）
const counted = (path) =>
  /^src\/.+\.tsx?$/.test(path) && !path.endsWith('.stories.tsx') && !path.endsWith('.d.ts') && !path.startsWith('src/renderer/src/demo/');

// アプリの中のスクリプトの URL を、手元の out/ のファイルにする。アプリのスクリプトでなければ null
function localScript(url) {
  const match = /\/out\/((?:main|preload|renderer)\/[^?#]+)/.exec(url);
  return match ? join(root, 'out', decodeURIComponent(match[1])) : null;
}

// 集めたもの（スクリプトごとの関数の範囲と通った回数）
function collect() {
  const scripts = [];
  if (existsSync(join(raw, 'v8'))) {
    for (const name of readdirSync(join(raw, 'v8'))) {
      if (!name.endsWith('.json')) continue;
      scripts.push(...JSON.parse(readFileSync(join(raw, 'v8', name), 'utf8')).result);
    }
  }
  if (existsSync(raw)) {
    for (const name of readdirSync(raw)) {
      if (name.startsWith('renderer-') && name.endsWith('.json')) scripts.push(...JSON.parse(readFileSync(join(raw, name), 'utf8')));
    }
  }
  return scripts;
}

const scripts = collect();
if (scripts.length === 0) {
  console.error('E2E のカバレッジがありません（coverage/e2e-raw）。npm run coverage:e2e で集めてください');
  process.exit(1);
}

// 同じスクリプトは、コードと構文木とソースマップを読み直さない
const loaded = new Map();
async function load(file) {
  if (!loaded.has(file)) {
    const mapFile = `${file}.map`;
    if (!existsSync(file) || !existsSync(mapFile)) {
      loaded.set(file, null);
    } else {
      const code = readFileSync(file, 'utf8');
      loaded.set(file, { code, ast: await parseAstAsync(code), sourceMap: JSON.parse(readFileSync(mapFile, 'utf8')) });
    }
  }
  return loaded.get(file);
}

const map = libCoverage.createCoverageMap({});
const missing = new Set();
let used = 0;
for (const script of scripts) {
  const file = localScript(script.url);
  if (!file) continue;
  const source = await load(file);
  if (!source) {
    missing.add(relative(root, file));
    continue;
  }
  const data = await astV8ToIstanbul({ ...source, coverage: { url: pathToFileURL(file).href, functions: script.functions } });
  // ソースマップには依存（node_modules）も入っている。src のファイルだけ残す
  for (const [path, fileCoverage] of Object.entries(data)) {
    if (counted(relative(root, path).split('\\').join('/'))) map.merge({ [path]: fileCoverage });
  }
  used++;
}
if (missing.size > 0) {
  console.error(`ソースマップの無いスクリプトがあります（TANACODE_SOURCEMAP=1 でビルドしてください）: ${[...missing].join('、')}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'coverage-final.json'), JSON.stringify(map.toJSON()));
console.log(`E2E のカバレッジ: ${used} 個のスクリプトの記録から、src の ${map.files().length} 個のファイルを coverage/e2e に書きました`);
