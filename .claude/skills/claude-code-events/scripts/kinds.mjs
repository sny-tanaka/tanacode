// Claude Code の本体・Agent SDK の型・tanacode の読み取りから、stream-json の種類を集めて突き合わせる。
// 使い方: node kinds.mjs --cli <claude の実体> --sdk <sdk.d.ts> [--repo <tanacode のフォルダ>] [--json <書き出す先>]
// 本体の中の名前は決まった書き方だけを拾うので、数はおおよそ。分け方（stream-json に出るか・会話ログ用か）も目安で、
// 最後は前後のコード（--context で出す）を読んで決める
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    cli: { type: 'string' },
    sdk: { type: 'string' },
    repo: { type: 'string', default: '.' },
    json: { type: 'string' },
    // 前後のコードを出す種類（カンマ区切り）
    context: { type: 'string' },
  },
});
if (!values.cli || !values.sdk) {
  console.error('使い方: node kinds.mjs --cli <claude の実体> --sdk <sdk.d.ts> [--repo <tanacode>] [--json <file>] [--context a,b]');
  process.exit(1);
}

// 本体は JavaScript のソースが文字のまま入った 1 つの実行ファイル。ASCII の部分だけ読めればよいので latin1 で読む
const cli = readFileSync(values.cli).toString('latin1');
const sdk = readFileSync(values.sdk, 'utf8');
const repo = resolve(values.repo);
const clientSrc = readFileSync(join(repo, 'src/main/stream/client.ts'), 'utf8');
const chatSrc = readFileSync(join(repo, 'src/shared/chat.ts'), 'utf8');

const uniq = (xs) => [...new Set(xs)].sort();
const all = (re, s, g = 1) => [...s.matchAll(re)].map((m) => m[g]);

// ---- Agent SDK の型 ----
const union = /export declare type SDKMessage = ([^;]+);/.exec(sdk)?.[1] ?? '';
const sdkKinds = [];
for (const name of union.split('|').map((s) => s.trim()).filter(Boolean)) {
  const start = sdk.indexOf(`export declare type ${name} =`);
  const body = start === -1 ? '' : sdk.slice(start, sdk.indexOf('\n};', start));
  const type = /\btype: '([^']+)'/.exec(body)?.[1] ?? null;
  const subtype = /\bsubtype: '([^']+)'/.exec(body)?.[1] ?? null;
  sdkKinds.push({ name, type, subtype });
}
const sdkSystem = new Set(sdkKinds.filter((k) => k.type === 'system' && k.subtype).map((k) => k.subtype));
const sdkTop = new Set(sdkKinds.filter((k) => k.type && k.type !== 'system').map((k) => k.type));

// ---- Claude Code の本体 ----
// system の種類ごとの書かれ方。timestamp・isMeta の付いた行は会話ログ用の目安
const system = new Map();
for (const m of cli.matchAll(/type:"system",subtype:"([a-z_]+)"/g)) {
  const s = system.get(m[1]) ?? { count: 0, transcriptLike: 0 };
  s.count += 1;
  const after = cli.slice(m.index, m.index + 400);
  const end = after.search(/\}\)|\}\}|\};|\},\{type:/);
  if (/timestamp:|isMeta:/.test(end === -1 ? after : after.slice(0, end))) s.transcriptLike += 1;
  system.set(m[1], s);
}
// 会話の処理の行を stream-json の行に変える関数（function*。case"system":switch(x.subtype){ … default:return} を含む）。
// 中の system の case は stream-json に出すもの（ほかの subtype は出さない）。外側の case は、その関数が振り分ける行の種類
// （出すものと、変えて出すもの・出さないものが混ざる）
const outputFilter = new Set();
const routed = new Set();
for (const m of cli.matchAll(/case"system":switch\([\w$]+\.subtype\)\{([\s\S]{0,4000}?)default:return\}/g)) {
  for (const c of m[1].matchAll(/case"([a-z_]+)"/g)) outputFilter.add(c[1]);
  const start = cli.lastIndexOf('function*', m.index);
  for (const c of cli.slice(start, m.index + m[0].length + 3000).matchAll(/case"([a-z_]+)"/g)) routed.add(c[1]);
}
for (const s of outputFilter) routed.delete(s);
routed.delete('system');
// 出力の待ち行列に入れる関数。stream-json にだけ出る system の行（task_summary など）を渡している関数を、名前の目印にする
// （圧縮されたコードなので、名前はバージョンごとに変わる）。ほかに、.enqueue({type:…}) で入れるものも拾う
const emitters = new Set(all(/([\w$]+)\(\{type:"system",subtype:"(?:task_summary|commands_changed|notification|session_title_changed)"/g, cli));
const emitted = new Set(all(/\.enqueue\(\{type:"([a-z_]+)"/g, cli));
for (const name of emitters) {
  const escaped = name.replace(/\$/g, '\\$');
  for (const t of all(new RegExp(`(?<![\\w$.])${escaped}\\(\\{type:"([a-z_]+)"`, 'g'), cli)) emitted.add(t);
}
emitted.delete('system');
const topLevel = uniq([...routed, ...emitted]);
// 本体からアプリへの要求
const controlRequests = uniq(all(/sendRequest\(\{subtype:"([a-z_]+)"/g, cli));
// stream_event の行に付く追加の欄（stream_event を作る関数の、event 以外の欄）
const streamEventFields = uniq(
  [...cli.matchAll(/\{type:"stream_event",event:[\w$.]+,([\s\S]{0,700}?)\}\}/g)].flatMap((m) => all(/(?:^|[{,])([a-z_]+):/g, m[1])),
).filter((f) => !['session_id', 'parent_tool_use_id', 'uuid'].includes(f));

// ---- tanacode の読み取り ----
const block = (src, start, end) => {
  const i = src.indexOf(start);
  return i === -1 ? '' : src.slice(i, src.indexOf(end, i + start.length));
};
const ignored = new Set(all(/'([a-z_/]+)'/g, block(clientSrc, 'const IGNORED_KINDS', ']);')));
const systemChecks = new Set(all(/^\s+([a-z_]+): \(/gm, block(clientSrc, 'const SYSTEM_CHECKS', '\n};')));
const topKnown = new Set([
  ...all(/case '([a-z_]+)':/g, block(clientSrc, 'function messageOf', '\n}')),
  ...all(/case '([a-z_]+)':/g, block(clientSrc, 'private receive(', '\n  }')),
]);
topKnown.delete('system');
const transcriptHandled = new Set(all(/entry\.subtype === '([a-z_]+)'/g, block(chatSrc, 'export function toChatEvents', '\n}')));
// 会話ログの system の行のうち、意図して捨てるもの。読む（分岐のある）ものでも、これでもないものは、チャットに未知のイベントとして出る
const transcriptKnown = new Set(all(/'([a-z_]+)'/g, block(chatSrc, 'const IGNORED_SYSTEM', ']);')));

const tanacodeSystem = (s) => (ignored.has(`system/${s}`) ? '捨てる' : systemChecks.has(s) ? '使う' : '知らない');
const tanacodeTop = (t) => (ignored.has(t) ? '捨てる' : topKnown.has(t) ? '使う' : '知らない');

// ---- 書き出し ----
const yes = (b) => (b ? '有' : '無');
const lines = [];
lines.push(`# stream-json の種類の突き合わせ`, '');
lines.push(`- SDK の型: ${sdkKinds.length} 種類（うち system ${sdkSystem.size}）`);
lines.push(`- 本体の system: ${system.size} 種類（うち stream-json に出す会話の処理の行 ${outputFilter.size}）`);
lines.push('', '## system', '', '| subtype | SDK | 会話の処理から出す | 書かれた数 | うち会話ログ用らしいもの | tanacode（stream） | tanacode（会話ログ） |', '| --- | --- | --- | --- | --- | --- | --- |');
for (const name of uniq([...system.keys(), ...sdkSystem, ...systemChecks])) {
  const s = system.get(name) ?? { count: 0, transcriptLike: 0 };
  lines.push(`| \`${name}\` | ${yes(sdkSystem.has(name))} | ${outputFilter.has(name) ? '出す' : ''} | ${s.count} | ${s.transcriptLike} | ${tanacodeSystem(name)} | ${transcriptHandled.has(name) ? '読む' : transcriptKnown.has(name) ? '捨てる' : '未知のイベント'} |`);
}
lines.push('', '## system 以外', '', `出力の待ち行列に入れる関数（目印から見つけたもの）: ${[...emitters].map((e) => `\`${e}\``).join('・') || '見つからない'}`, '');
lines.push('| type | SDK | 出力の待ち行列に入れる | 会話の処理の行の振り分けにある | tanacode |', '| --- | --- | --- | --- | --- |');
for (const name of uniq([...sdkTop, ...topKnown, ...ignored].filter((k) => !k.includes('/')).concat(topLevel))) {
  lines.push(`| \`${name}\` | ${yes(sdkTop.has(name))} | ${emitted.has(name) ? '有' : ''} | ${routed.has(name) ? '有' : ''} | ${tanacodeTop(name)} |`);
}
lines.push('', '「会話の処理の行の振り分けにある」だけの種類には、stream-json に出ないもの（会話の処理の中だけの行・別の形に変えて出すもの）も混ざります。SDK にも tanacode にも無いものは、前後のコード（--context）で確かめます。');
lines.push('', '## 本体からアプリへの要求（control_request）', '', controlRequests.map((r) => `\`${r}\``).join('・'));
lines.push('', '## stream_event の追加の欄', '', streamEventFields.map((f) => `\`${f}\``).join('・'));

// 前後のコード
for (const name of (values.context ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  lines.push('', `## 前後のコード: ${name}`, '');
  // 種類の名前（"name"）と、欄の名前（name:）のどちらでも探す
  const re = new RegExp(`"${name}"|[{,]${name}:`, 'g');
  let n = 0;
  for (const m of cli.matchAll(re)) {
    lines.push('```', cli.slice(Math.max(0, m.index - 300), m.index + 200).replace(/[^\x20-\x7e]/g, ' '), '```');
    if (++n >= 3) break;
  }
}
console.log(lines.join('\n'));

if (values.json) {
  writeFileSync(
    values.json,
    JSON.stringify(
      {
        sdk: sdkKinds,
        system: Object.fromEntries([...system].sort()),
        outputFilter: uniq([...outputFilter]),
        emitters: uniq([...emitters]),
        topLevel,
        controlRequests,
        streamEventFields,
        tanacode: { ignored: uniq([...ignored]), systemChecks: uniq([...systemChecks]), topKnown: uniq([...topKnown]), transcriptHandled: uniq([...transcriptHandled]), transcriptKnown: uniq([...transcriptKnown]) },
      },
      null,
      2,
    ),
  );
}
