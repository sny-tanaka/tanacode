// tanacode で動作確認済の Claude Code のバージョンを、互換性の確認（npm run test:cli）が通った版に上げる。
// GitHub Actions（claude-code-check.yml）が、毎日の確認が通ったあとに呼ぶ。
//   node scripts/update-verified-version.mjs <版>
// 標準出力に、することを 1 語で書く（ワークフローがこれを見て PR を作る）
//   bump:     確認した版が今の動作確認済のバージョンより新しい。src/shared/claude-code.ts と README・GUIDE の版を書き換えた
//   fixtures: 同じ版だが、その版の控えがまだコミットされていない（控えだけを足す）
//   skip:     何もしない（古い版を確かめたとき・控えもあるとき）
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const CONSTANT_FILE = 'src/shared/claude-code.ts';
const CONSTANT = /(export const VERIFIED_CLAUDE_CODE_VERSION = ')(\d+\.\d+\.\d+)(';)/;
// 「動作確認済」を含む行の版を書き換える
const DOCS = ['README.md', 'GUIDE.md'];

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error(`版の形が違います: ${version}`);
  process.exit(1);
}

const source = readFileSync(CONSTANT_FILE, 'utf8');
const current = source.match(CONSTANT)?.[2];
if (!current) {
  console.error(`${CONSTANT_FILE} に VERIFIED_CLAUDE_CODE_VERSION が見つかりません`);
  process.exit(1);
}

const fixtures = `test/fixtures/claude-code/${version}`;
const order = compareVersions(version, current);
if (order < 0 || !existsSync(fixtures)) {
  // 古い版を指定して確かめたときは下げない。控えが取れていなければ（確認が途中で失敗したなど）上げない
  console.log('skip');
} else if (order > 0) {
  writeFileSync(CONSTANT_FILE, source.replace(CONSTANT, `$1${version}$3`));
  for (const file of DOCS) {
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.split('\n').map((line) => (line.includes('動作確認済') ? line.replaceAll(current, version) : line)).join('\n'));
  }
  console.log('bump');
} else {
  console.log(committed(fixtures) ? 'skip' : 'fixtures');
}

function committed(dir) {
  return execFileSync('git', ['ls-files', dir], { encoding: 'utf8' }).trim() !== '';
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
