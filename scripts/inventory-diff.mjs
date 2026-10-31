// Claude Code が書いた行の目録（test/fixtures/claude-code/<バージョン>/inventory.json。test/transcript-inventory.ts）を 2 つ比べる。
// GitHub Actions（claude-code-check.yml）が、動作確認済のバージョンを上げる PR を作るときに呼ぶ。差があれば、PR を自動ではマージしない
//   node scripts/inventory-diff.mjs <前の目録> <新しい目録> <差分の書き出し先>
// 標準出力に、比べた結果を 1 語で書く（ワークフローがこれを見る）
//   same:    差が無い
//   changed: 差がある（前の目録が無いときも）。差分を Markdown で書き出し先に書く（PR の本文に載せる）
// 新しい目録が無ければ、失敗にする（控えが取れていない）
// 会話ログで、アプリが捨てる種類（src/shared/transcript-line.ts の一覧にあり、読むフィールドの一覧 test/transcript-used-fields.ts に
// 無いもの）が消えただけなら、差にしない（読んでいないので、消えても困らない）。ほかに差があるときは、書き添える
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { classifyLine, isIgnoredAssistantBlock, isIgnoredAttachment, isIgnoredSystem } from '../src/shared/transcript-line.ts';
import { USED_FIELDS } from '../test/transcript-used-fields.ts';

// PR の本文の上限（65,536 文字）に収める
const MAX_CHARS = 50_000;
const PARTS = [
  ['transcript', '会話ログ'],
  ['stream', 'stream-json'],
];
// 台本の中で、出るかどうかが実行ごとに揺れる種類（Claude Code が書く時機によるもの。台本では決まって出させられない）と、そのわけ。
// 出た・出ないの違いは差にしない（出たときのフィールドは比べる）。ほかに差があるときは、揺れたことを書き添える
const UNSTABLE_KINDS = {
  transcript: {
    // TUI は、動いている間には書かず、止められるときに書く（2.1.302 の手元で確かめた）。書き終える前に止まると無い
    // （2.1.303 の CI では、2 回に 1 回）
    'permission-mode': 'ターミナルモードの TUI が、止められるときに書く（terminal-mode.test.ts。書き終える前に止まると無い）',
  },
  stream: {},
};

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
const unstable = [];
const dropped = [];
const sections = PARTS.flatMap(([key, title]) => {
  const ignored = key === 'transcript' ? isIgnoredKind : () => false;
  const { lines, flapped, droppedIgnored } = diffPart(prev[key] ?? {}, next[key] ?? {}, prev.sources?.[key] ?? {}, next.sources?.[key] ?? {}, UNSTABLE_KINDS[key], ignored);
  unstable.push(...flapped.map((kind) => `- 揺れる種類（比べない）: \`${kind}\`（${UNSTABLE_KINDS[key][kind]}）`));
  dropped.push(...droppedIgnored.map((kind) => `- 消えた種類（アプリが捨てる種類なので比べない）: \`${kind}\``));
  return lines.length > 0 ? [`### ${title}`, '', ...lines, ''] : [];
});
if (sections.length > 0 && unstable.length > 0) sections.push('### 揺れる種類', '', ...unstable, '');
if (sections.length > 0 && dropped.length > 0) sections.push('### 消えた、アプリが捨てる種類', '', ...dropped, '');
if (sections.length === 0) {
  console.log('same');
  process.exit(0);
}
let text = sections.join('\n');
if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n\n（長いので、ここで切りました。全部は、2 つの目録を比べて見てください）\n`;
writeFileSync(outFile, text);
console.log('changed');

// 種類ごとのフィールドの名前の一覧どうしを比べて、Markdown の行にする。その種類が出た台本（目録の sources）も添える
// （台本の揺れか、Claude Code の変化かを見分ける手がかり。消えたものは前の目録、ほかは新しい目録の台本）
// unstable: 出た・出ないの違いを差にしない種類（UNSTABLE_KINDS）。flapped: そのうち、出た・出ないが違ったもの
// ignored: 消えても差にしない種類か（アプリが捨てる種類）。droppedIgnored: そのうち、消えたもの
function diffPart(before, after, beforeSources, afterSources, unstable, ignored) {
  const code = (names) => names.map((name) => `\`${name}\``).join('・');
  const from = (sources, kind) => (sources[kind]?.length ? `［台本: ${sources[kind].join('・')}］` : '');
  const lines = [];
  const flapped = [...Object.keys(after), ...Object.keys(before)].filter((kind) => kind in unstable && (kind in before) !== (kind in after));
  const added = Object.keys(after).filter((kind) => !(kind in before) && !(kind in unstable));
  const gone = Object.keys(before).filter((kind) => !(kind in after) && !(kind in unstable));
  const removed = gone.filter((kind) => !ignored(kind));
  const droppedIgnored = gone.filter((kind) => ignored(kind));
  for (const kind of added) lines.push(`- 増えた種類: \`${kind}\`${after[kind].length > 0 ? `（フィールド: ${code(after[kind])}）` : ''}${from(afterSources, kind)}`);
  for (const kind of removed) lines.push(`- 消えた種類: \`${kind}\`${from(beforeSources, kind)}`);
  for (const kind of Object.keys(after).filter((k) => k in before)) {
    const plus = after[kind].filter((name) => !before[kind].includes(name));
    const minus = before[kind].filter((name) => !after[kind].includes(name));
    if (plus.length > 0) lines.push(`- \`${kind}\` に増えたフィールド: ${code(plus)}${from(afterSources, kind)}`);
    if (minus.length > 0) lines.push(`- \`${kind}\` から消えたフィールド: ${code(minus)}${from(beforeSources, kind)}`);
  }
  return { lines, flapped, droppedIgnored };
}

// 目録の会話ログの種類（行の type・system/<subtype>・attachment/<type>・assistant.content/<type> など。test/transcript-inventory.ts）が、
// アプリが捨てる種類か。チャットには出さなくても、ほかで読む種類（attachment/file など。読むフィールドの一覧にある）は除く
function isIgnoredKind(kind) {
  if (kind in USED_FIELDS) return false;
  const [head, sub] = kind.split('/');
  if (sub === undefined) return classifyLine({ type: head }).kind === 'ignored';
  if (head === 'system') return isIgnoredSystem(sub);
  if (head === 'attachment') return isIgnoredAttachment(sub);
  if (head === 'assistant.content') return isIgnoredAssistantBlock(sub);
  return false;
}
