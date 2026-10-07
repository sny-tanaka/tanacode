// E2E（npm run coverage:e2e）で集めた V8 のカバレッジを、src の行に戻して coverage/e2e/coverage-final.json に書く。
// npm run coverage:report が、ほかのカバレッジ（coverage/unit・coverage/cli）と合わせて層ごとに出す。
// - メインプロセス・pty ホスト・MCP の中継: NODE_V8_COVERAGE が書いたもの（coverage/e2e-raw/v8/*.json）
// - 画面: Playwright の page.coverage で取ったもの（coverage/e2e-raw/renderer-*.json）
// どちらも、ビルドしたスクリプト（out/）の位置なので、ビルドのときに書き出したソースマップ（TANACODE_SOURCEMAP=1）で src に戻す。
// パッケージした .app のスクリプト（…/app.asar/out/…）は、手元の out/ の同じファイルとして読む（同じビルドから作ったもの）
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeScriptCovs } from '@bcoe/v8-coverage';
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

// 集めたもの（スクリプトごとの関数の範囲と通った回数）。どの順に読んでも同じ結果になるよう、名前の順に読む
function collect() {
  const scripts = [];
  const v8 = join(raw, 'v8');
  if (existsSync(v8)) {
    for (const name of readdirSync(v8).sort()) {
      if (name.endsWith('.json')) scripts.push(...JSON.parse(readFileSync(join(v8, name), 'utf8')).result);
    }
  }
  if (existsSync(raw)) {
    for (const name of readdirSync(raw).sort()) {
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

// 同じスクリプト（アプリを起動するたび・プロセスごとに記録がある）は、V8 の記録のまま先に合わせてから、1 回だけ src に戻す
// （記録ごとに戻すと、大きなスクリプト（画面は 10MB ほど）を何十回も戻すことになり、遅いため）
const byFile = new Map();
for (const script of scripts) {
  const file = localScript(script.url);
  if (!file) continue;
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push({ scriptId: '0', url: pathToFileURL(file).href, functions: script.functions });
}

const map = libCoverage.createCoverageMap({});
const missing = [];
for (const file of [...byFile.keys()].sort()) {
  const mapFile = `${file}.map`;
  if (!existsSync(file) || !existsSync(mapFile)) {
    missing.push(relative(root, file));
    continue;
  }
  const merged = mergeScriptCovs(byFile.get(file));
  const code = readFileSync(file, 'utf8');
  // 構文木は、ast-v8-to-istanbul が印を付けて書き換える（2 回目に使うと、論理式の分岐を数えなくなる）ので、使い回さない
  const data = await astV8ToIstanbul({
    code,
    ast: await parseAstAsync(code),
    sourceMap: JSON.parse(readFileSync(mapFile, 'utf8')),
    coverage: { url: merged.url, functions: merged.functions },
  });
  // ソースマップには依存（node_modules）も入っている。src のファイルだけ残す。
  // 同じ src のファイルが、いくつかのスクリプトに入っていることがある（shared の一部は main と画面の両方に入る）
  for (const [path, fileCoverage] of Object.entries(data)) {
    if (counted(relative(root, path).split('\\').join('/'))) map.merge({ [path]: fileCoverage });
  }
}
if (missing.length > 0) {
  console.error(`ソースマップの無いスクリプトがあります（TANACODE_SOURCEMAP=1 でビルドしてください）: ${missing.join('、')}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'coverage-final.json'), JSON.stringify(map.toJSON()));
const records = [...byFile.values()].reduce((sum, list) => sum + list.length, 0);
console.log(
  `E2E のカバレッジ: アプリの ${byFile.size} 個のスクリプトの ${records} 個の記録から、src の ${map.files().length} 個のファイルを coverage/e2e に書きました`,
);
