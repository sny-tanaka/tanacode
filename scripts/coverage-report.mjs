// 測ったカバレッジ（coverage/<名前>/coverage-final.json）をまとめて、層ごと（main・preload・shared・renderer）に出す（npm run coverage:report）。
// - 下限（test/coverage-thresholds.json）を下回った層があれば失敗にする。下限は上げるだけで、下げない
// - --update: 今の値から下限を書き直す（上がった層だけ）
// - --diff <ref>: <ref> から変えた行のうち、テストで通った行の割合も出す（PR の CI では、マージ先との差分）
// GitHub Actions では、同じ表をジョブの概要（GITHUB_STEP_SUMMARY）にも書く
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import libCoverage from 'istanbul-lib-coverage';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coverageDir = join(root, 'coverage');
const thresholdsFile = join(root, 'test/coverage-thresholds.json');
const LAYERS = [
  { name: 'main', prefix: 'src/main/' },
  { name: 'preload', prefix: 'src/preload/' },
  { name: 'shared', prefix: 'src/shared/' },
  { name: 'renderer', prefix: 'src/renderer/' },
];
const METRICS = ['lines', 'branches', 'functions'];
// 下限は今の値から少し下げて置く（本物の claude を動かすテストは、待ち方しだいで通る行が少し変わるため）
const MARGIN = 1;

const args = process.argv.slice(2);
const update = args.includes('--update');
const diffIndex = args.indexOf('--diff');
const diffRef = diffIndex >= 0 ? args[diffIndex + 1] : null;

// 測ったものを全部合わせる（同じファイルは、通った回数を足す）
const sources = existsSync(coverageDir)
  ? readdirSync(coverageDir).filter((name) => existsSync(join(coverageDir, name, 'coverage-final.json')))
  : [];
if (sources.length === 0) {
  console.error('カバレッジがありません。先に npm run coverage（と npm run coverage:cli）で測ってください');
  process.exit(1);
}
const map = libCoverage.createCoverageMap({});
for (const name of sources) map.merge(JSON.parse(readFileSync(join(coverageDir, name, 'coverage-final.json'), 'utf8')));
const files = map.files().map((abs) => ({ abs, path: relative(root, abs).split('\\').join('/') }));

const pct = (n) => `${n.toFixed(1)}%`;
// 数えるもの（分岐など）が 1 つも無い層は、割合を出さない
const cell = (m) => (m.total === 0 ? '-' : pct(m.pct));
const layerOf = (path) => LAYERS.find((l) => path.startsWith(l.prefix))?.name ?? null;

// 層ごとの集計
const summaries = new Map(LAYERS.map((l) => [l.name, libCoverage.createCoverageSummary()]));
const total = libCoverage.createCoverageSummary();
for (const f of files) {
  const s = map.fileCoverageFor(f.abs).toSummary();
  summaries.get(layerOf(f.path))?.merge(s);
  total.merge(s);
}

const thresholds = existsSync(thresholdsFile) ? JSON.parse(readFileSync(thresholdsFile, 'utf8')) : {};
const failures = [];
const raisable = [];
const out = [];
out.push(`## カバレッジ（${sources.join('・')}）`, '');
out.push('| 層 | 行 | 分岐 | 関数 | 下限（行 / 分岐 / 関数） |', '| --- | --- | --- | --- | --- |');
for (const { name } of LAYERS) {
  const s = summaries.get(name);
  const floor = thresholds[name] ?? {};
  for (const metric of METRICS) {
    if (s[metric].total === 0) continue;
    const actual = s[metric].pct;
    if (floor[metric] !== undefined && actual < floor[metric]) failures.push(`${name} の${label(metric)}が ${pct(actual)} で、下限の ${floor[metric]}% を下回りました`);
    if (Math.floor(actual) - MARGIN > (floor[metric] ?? -1)) raisable.push(name);
  }
  out.push(`| ${name} | ${cell(s.lines)} | ${cell(s.branches)} | ${cell(s.functions)} | ${METRICS.map((m) => (floor[m] === undefined ? '-' : `${floor[m]}%`)).join(' / ')} |`);
}
out.push(`| 合計 | ${cell(total.lines)} | ${cell(total.branches)} | ${cell(total.functions)} | |`, '');

// 1 行も通っていないファイル（どこから足すかの目安）
const untouched = files.filter((f) => map.fileCoverageFor(f.abs).toSummary().lines.total > 0 && map.fileCoverageFor(f.abs).toSummary().lines.covered === 0);
if (untouched.length > 0) {
  out.push(`<details><summary>1 行も通っていないファイル（${untouched.length} 個）</summary>`, '');
  for (const f of untouched) out.push(`- ${f.path}（${map.fileCoverageFor(f.abs).toSummary().lines.total} 行）`);
  out.push('', '</details>', '');
}

if (diffRef) out.push(...diffCoverage(diffRef));

if (update) {
  const next = { ...thresholds };
  for (const { name } of LAYERS) {
    const s = summaries.get(name);
    next[name] = Object.fromEntries(
      METRICS.filter((m) => s[m].total > 0).map((m) => [m, Math.max(thresholds[name]?.[m] ?? 0, Math.max(0, Math.floor(s[m].pct) - MARGIN))]),
    );
  }
  writeFileSync(thresholdsFile, `${JSON.stringify(next, null, 2)}\n`);
  out.push(`下限を書き直しました: ${relative(root, thresholdsFile)}`);
} else if (raisable.length > 0) {
  out.push(`下限より上がった層があります（${[...new Set(raisable)].join('・')}）。\`npm run coverage:report -- --update\` で下限を上げられます`);
}
for (const message of failures) out.push(`- ❌ ${message}`);

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
process.exit(failures.length > 0 ? 1 : 0);

function label(metric) {
  return { lines: '行', branches: '分岐', functions: '関数' }[metric];
}

// ref から変えた（足した）行のうち、テストで通った行の割合。数えるのは、カバレッジで行として数える行（式のある行）だけ
function diffCoverage(ref) {
  const diff = execFileSync('git', ['diff', '--unified=0', '--no-color', '--no-renames', ref, '--', 'src'], { cwd: root, encoding: 'utf8' });
  const added = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    // 消したファイルは「+++ /dev/null」
    const file = line.match(/^\+\+\+ (.+)$/);
    if (file) {
      current = file[1].startsWith('b/') ? file[1].slice(2) : null;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const lines = added.get(current) ?? [];
      for (let i = 0; i < count; i++) lines.push(start + i);
      added.set(current, lines);
    }
  }
  const byPath = new Map(files.map((f) => [f.path, f.abs]));
  let covered = 0;
  let measured = 0;
  const missed = [];
  for (const [path, lines] of added) {
    const abs = byPath.get(path);
    if (!abs) continue;
    const hits = map.fileCoverageFor(abs).getLineCoverage();
    const notHit = [];
    for (const n of lines) {
      if (hits[n] === undefined) continue;
      measured++;
      if (hits[n] > 0) covered++;
      else notHit.push(n);
    }
    if (notHit.length > 0) missed.push(`- ${path}: ${ranges(notHit)}`);
  }
  if (measured === 0) return [`変えた行（${ref} から）: 数える行はありません`, ''];
  const result = [`変えた行（${ref} から）: ${covered} / ${measured} 行がテストで通りました（${pct((covered / measured) * 100)}）`, ''];
  if (missed.length > 0) result.push('<details><summary>テストで通らなかった、変えた行</summary>', '', ...missed, '', '</details>', '');
  return result;
}

// [3, 4, 5, 9] → "3-5, 9"
function ranges(lines) {
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    parts.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j;
  }
  return parts.join(', ');
}
