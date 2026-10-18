// 本物の claude -p（stream-json）をモックの API につないで、出てきた行と会話ログを録る。
// 使い方: node record.mjs --cli <claude の実体> --scenario <normal|cut|refusal> --out <書き出すフォルダ> [--repo <tanacode のフォルダ>]
// - normal: ふつうに答える
// - cut: 1 回目のストリーミングを、書いている途中で切る（取り直しの行を見る）
// - refusal: 1 回目の応答を stop_reason "refusal" で終える（断られたときの行を見る）
// 起動の引数は tanacode と同じ（src/main/stream/protocol.ts の STREAM_ARGS を読む）。環境変数は test/cli/claude-run.ts と同じ最小限
// （クラウドの開発環境などの変数を受け継ぐと、ふだんは出ない種類が出る）。HOME は使い捨てのフォルダにする
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    cli: { type: 'string' },
    scenario: { type: 'string', default: 'normal' },
    out: { type: 'string' },
    repo: { type: 'string', default: '.' },
  },
});
if (!values.cli || !values.out || !['normal', 'cut', 'refusal'].includes(values.scenario)) {
  console.error('使い方: node record.mjs --cli <claude の実体> --scenario <normal|cut|refusal> --out <フォルダ> [--repo <tanacode>]');
  process.exit(1);
}
const scenario = values.scenario;
const out = resolve(values.out);
mkdirSync(out, { recursive: true });

// tanacode と同じ起動の引数
const protocol = readFileSync(join(resolve(values.repo), 'src/main/stream/protocol.ts'), 'utf8');
const streamArgs = [...(/export const STREAM_ARGS = \[([\s\S]*?)\]/.exec(protocol)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
if (streamArgs.length === 0) throw new Error('STREAM_ARGS が読めません');

// ---- モックの API ----
let calls = 0;
const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const message = (id, content, stop) => ({ id, type: 'message', role: 'assistant', model: 'claude-mock', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
const DRAFT = '書きかけの文です。これは取り消されるはず';
const ANSWER = '答えです。';

function streamReply(res, id, text, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'message_start', { message: { ...message(id, [], null), usage: { input_tokens: 10, output_tokens: 0 } } });
  sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  sse(res, 'content_block_stop', { index: 0 });
  sse(res, 'message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', {});
  res.end();
}

const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const path = (req.url ?? '').split('?')[0];
  if (path === '/v1/messages/count_tokens') return void res.end(JSON.stringify({ input_tokens: 10 }));
  if (path !== '/v1/messages') return void res.end('{}');
  const body = JSON.parse(raw || '{}');
  // ツールの一覧の無い呼び出し（タイトル作りなど）には短い文を返す
  if (!body.tools?.length) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify(message(`msg_plain_${++calls}`, [{ type: 'text', text: 'title' }], 'end_turn')));
  }
  const n = ++calls;
  const id = `msg_${n}`;
  if (n === 1 && body.stream && scenario === 'cut') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, 'message_start', { message: { ...message(id, [], null), usage: { input_tokens: 10, output_tokens: 0 } } });
    sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: DRAFT } });
    setTimeout(() => res.socket?.destroy(), 300);
    return;
  }
  if (n === 1 && scenario === 'refusal') {
    if (body.stream) return streamReply(res, id, DRAFT, 'refusal');
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify(message(id, [{ type: 'text', text: DRAFT }], 'refusal')));
  }
  if (body.stream) return streamReply(res, id, ANSWER, 'end_turn');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(message(id, [{ type: 'text', text: ANSWER }], 'end_turn')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

// ---- claude ----
const home = mkdtempSync(join(tmpdir(), 'cc-events-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'cc-events-cwd-'));
const sessionId = '22222222-2222-4222-8222-222222222222';
const env = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  LANG: 'en_US.UTF-8',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ANTHROPIC_API_KEY: 'sk-ant-api03-tanacode-events-check-000000000000000000',
  NO_PROXY: '127.0.0.1,localhost',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  // tanacode がチャットの claude に付けるもの（src/main/claude-session.ts の claudeEnv）
  CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
  CLAUDE_CODE_CLASSIFIER_SUMMARY: '0',
  // 再試行を早く終える
  CLAUDE_CODE_MAX_RETRIES: '1',
};
const args = [...streamArgs, '--model', 'default', '--session-id', sessionId];
const child = spawn(values.cli, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = [];
let buffer = '';
let stderr = '';
child.stdout.on('data', (data) => {
  buffer += data;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    lines.push(line);
    try {
      if (JSON.parse(line).type === 'result') child.stdin.end();
    } catch {}
  }
});
child.stderr.on('data', (data) => (stderr += data));
// tanacode と同じく、initialize を送ってから発言を送る
child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'rec-1', request: { subtype: 'initialize', perTaskStopAffordance: true } })}\n`);
child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'こんにちは' }, parent_tool_use_id: null, uuid: '11111111-1111-4111-8111-111111111111' })}\n`);
const timer = setTimeout(() => child.kill(), 90_000);
const exitCode = await new Promise((r) => child.on('exit', r));
clearTimeout(timer);
server.close();

// ---- 書き出し ----
writeFileSync(join(out, 'stream.jsonl'), `${lines.join('\n')}\n`);
const projects = join(home, '.claude', 'projects');
let transcript = null;
for (const dir of readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const file = join(projects, dir.name, `${sessionId}.jsonl`);
  try {
    copyFileSync(file, join(out, 'transcript.jsonl'));
    transcript = file;
  } catch {}
}
const kinds = {};
const fields = {};
for (const line of lines) {
  const v = JSON.parse(line);
  const kind = typeof v.subtype === 'string' ? `${v.type}/${v.subtype}` : v.type;
  kinds[kind] = (kinds[kind] ?? 0) + 1;
  if (v.type === 'stream_event') for (const k of Object.keys(v)) if (!['type', 'event', 'session_id', 'parent_tool_use_id', 'uuid'].includes(k)) fields[k] = (fields[k] ?? 0) + 1;
}
console.log(JSON.stringify({ scenario, exitCode, apiCalls: calls, lines: lines.length, kinds, streamEventFields: fields, transcript: transcript ? join(out, 'transcript.jsonl') : null, stderrTail: stderr.slice(-500) }, null, 2));
