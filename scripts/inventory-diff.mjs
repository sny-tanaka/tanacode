// Claude Code が書いた行の目録（test/fixtures/claude-code/<バージョン>/inventory.json。test/transcript-inventory.ts）を 2 つ比べる。
// GitHub Actions（claude-code-check.yml）が、動作確認済のバージョンを上げる PR を作るときに呼ぶ。差があれば、PR を自動ではマージしない
//   node scripts/inventory-diff.mjs <前の目録> <新しい目録> <差分の書き出し先>
// 標準出力に、比べた結果を 1 語で書く（ワークフローがこれを見る）
//   same:    差が無い
//   changed: 差がある（前の目録が無いときも）。差分を Markdown で書き出し先に書く（PR の本文に載せる）
// 新しい目録が無ければ、失敗にする（控えが取れていない）
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// PR の本文の上限（65,536 文字）に収める
const MAX_CHARS = 50_000;
const PARTS = [
  ['transcript', '会話ログ'],
  ['stream', 'stream-json'],
];

const [oldFile, newFile, outFile] = process.argv.slice(2);
if (!oldFile || !newFile || !outFile) {
  console.error('使い方: node scripts/inventory-diff.mjs <前の目録> <新しい目録> <差分の書き出し先>');
  process.exit(1);
}
if (!existsSync(newFile)) {
  console.error(`新しい目録がありません: ${newFile}`);
  process.exit(1);
}

const next = JSON.parse(readFileSync(newFile, 'utf8'));
if (!existsSync(oldFile)) {
  writeFileSync(outFile, `比べる前の目録がありません（\`${oldFile}\`）。新しい目録の種類は、会話ログ ${Object.keys(next.transcript ?? {}).length}・stream-json ${Object.keys(next.stream ?? {}).length} です。\n`);
  console.log('changed');
  process.exit(0);
}

const prev = JSON.parse(readFileSync(oldFile, 'utf8'));
const sections = PARTS.flatMap(([key, title]) => {
  const lines = diffPart(prev[key] ?? {}, next[key] ?? {});
  return lines.length > 0 ? [`### ${title}`, '', ...lines, ''] : [];
});
if (sections.length === 0) {
  console.log('same');
  process.exit(0);
}
let text = sections.join('\n');
if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n\n（長いので、ここで切りました。全部は、2 つの目録を比べて見てください）\n`;
writeFileSync(outFile, text);
console.log('changed');

// 種類ごとのフィールドの名前の一覧どうしを比べて、Markdown の行にする
function diffPart(before, after) {
  const code = (names) => names.map((name) => `\`${name}\``).join('・');
  const lines = [];
  const added = Object.keys(after).filter((kind) => !(kind in before));
  const removed = Object.keys(before).filter((kind) => !(kind in after));
  for (const kind of added) lines.push(`- 増えた種類: \`${kind}\`${after[kind].length > 0 ? `（フィールド: ${code(after[kind])}）` : ''}`);
  for (const kind of removed) lines.push(`- 消えた種類: \`${kind}\``);
  for (const kind of Object.keys(after).filter((k) => k in before)) {
    const plus = after[kind].filter((name) => !before[kind].includes(name));
    const minus = before[kind].filter((name) => !after[kind].includes(name));
    if (plus.length > 0) lines.push(`- \`${kind}\` に増えたフィールド: ${code(plus)}`);
    if (minus.length > 0) lines.push(`- \`${kind}\` から消えたフィールド: ${code(minus)}`);
  }
  return lines;
}
