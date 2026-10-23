// tanacode のバージョンと、動作確認済の Claude Code のバージョンの対応表（compat.json）を書き換える。
// アプリは develop の compat.json を読んで、ステータスバーの印に使う（src/main/claude-compat.ts）。表の形は src/shared/claude-compat.ts。
// - update-verified-version.mjs が、動作確認済のバージョンを上げるときに updateCompatTable を呼ぶ
// - GitHub Actions（claude-code-check.yml）が、PR の本文を書くのに使う
//     node scripts/compat-table.mjs current
//   標準出力に、いまのアプリ（package.json のバージョン）の行の Claude Code のバージョンを書く（行が無ければ空）
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TABLE_FILE = 'compat.json';
const RANGE = /^>=(\d+\.\d+\.\d+)(?: <(\d+\.\d+\.\d+))?$/;

// 動作確認済のバージョンを version に上げたときの、表の書き換え。
// - 次にリリースするアプリ（package.json のバージョンの patch を 1 つ上げたもの以上）の行は、いつも version にする（組み込んだバージョンと揃える）
// - いまのアプリ（package.json のバージョン。公開済み）の行は、その行のバージョンと version で、行の目録（inventory.json）に差が無いときだけ上げる
//   （アプリを直さなくても読める。リリースせずに、公開済みのアプリの印が変わる）。差があれば据え置く（直したアプリをリリースで届ける）
// - 2 つが同じ行で、いまのアプリの行を上げられないときは、次にリリースするバージョンで行を分ける
// 古いアプリの行は書き換えない
export function updateCompatTable(version) {
  const rows = readRows();
  const app = appVersion();
  const next = nextPatch(app);
  const iApp = rows.findIndex((r) => contains(r, app));
  const iNext = rows.findIndex((r) => contains(r, next));
  if (iNext < 0) throw new Error(`${TABLE_FILE} に ${next} 以上の行がありません（最後の行は上限を付けません）`);
  const bumpApp = iApp >= 0 && compareVersions(version, rows[iApp].claudeCode) > 0 && sameInventory(rows[iApp].claudeCode, version);
  if (iApp === iNext) {
    if (bumpApp) rows[iApp].claudeCode = version;
    else rows.splice(iApp, 1, { ...rows[iApp], below: next }, { from: next, below: rows[iApp].below, claudeCode: version });
  } else {
    rows[iNext].claudeCode = version;
    if (bumpApp) rows[iApp].claudeCode = version;
  }
  writeRows(rows);
}

// いまのアプリの行の、Claude Code のバージョン（無ければ null）
export function currentVerified() {
  const app = appVersion();
  return readRows().find((r) => contains(r, app))?.claudeCode ?? null;
}

function readRows() {
  const table = JSON.parse(readFileSync(TABLE_FILE, 'utf8'));
  return table.rows.map(({ app, claudeCode }) => {
    const m = RANGE.exec(app);
    if (!m) throw new Error(`${TABLE_FILE} の範囲の形が違います: ${app}`);
    return { from: m[1], below: m[2] ?? null, claudeCode };
  });
}

// 1 行に 1 つの範囲で書く（差分が読みやすいように）
function writeRows(rows) {
  const lines = rows.map((r) => `    { "app": ${JSON.stringify(r.below ? `>=${r.from} <${r.below}` : `>=${r.from}`)}, "claudeCode": ${JSON.stringify(r.claudeCode)} }`);
  writeFileSync(TABLE_FILE, `{\n  "rows": [\n${lines.join(',\n')}\n  ]\n}\n`);
}

function appVersion() {
  return JSON.parse(readFileSync('package.json', 'utf8')).version;
}

function contains(row, version) {
  return compareVersions(version, row.from) >= 0 && (row.below === null || compareVersions(version, row.below) < 0);
}

function nextPatch(version) {
  return version.replace(/\d+$/, (n) => String(Number(n) + 1));
}

// 2 つのバージョンの控えの行の目録に、差が無いか（scripts/inventory-diff.mjs。前の目録が無いときは差があるとみなす）
function sameInventory(prev, next) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-'));
  try {
    const inventory = (v) => `test/fixtures/claude-code/${v}/inventory.json`;
    const script = fileURLToPath(new URL('inventory-diff.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [script, inventory(prev), inventory(next), join(dir, 'diff.md')], { encoding: 'utf8' });
    return out.trim() === 'same';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'current') console.log(currentVerified() ?? '');
  else {
    console.error('使い方: node scripts/compat-table.mjs current');
    process.exit(1);
  }
}
