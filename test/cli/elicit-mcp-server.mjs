// テスト用の MCP サーバー（stdio。1 行に 1 つの JSON-RPC）。ツールを呼ばれると、MCP クライアント（Claude Code）に
// elicitation/create で人への質問を送り、返事をそのままツールの結果にする（test/cli/elicitation.test.ts）。
// - ask_form: フォームの形（項目の種類をひととおり）
// - ask_url: URL の形。accept が返ったら、ELICIT_DONE のファイルができるのを待って（人がページで終えたことにする）、
//   完了の知らせ（notifications/elicitation/complete）を送ってから、ツールの結果を返す
// 受け取ったもの（initialize の capabilities・方法の名前）は、ELICIT_LOG のファイルに 1 行ずつ書く
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const LOG = process.env.ELICIT_LOG;
const DONE = process.env.ELICIT_DONE;

const FORM_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', title: '出す先', oneOf: [{ const: 'stg', title: 'ステージング' }, { const: 'prod', title: '本番' }] },
    replicas: { type: 'integer', title: '台数', minimum: 1, maximum: 5, default: 2 },
    note: { type: 'string', title: 'メモ', maxLength: 20 },
    notify: { type: 'boolean', title: '終わったら知らせる', default: false },
    regions: { type: 'array', title: '地域', items: { type: 'string', enum: ['jp', 'us'] } },
  },
  required: ['target'],
};
const LOGIN_URL = 'https://login.example.com/authorize?state=tanacode-test';
const ELICITATION_ID = 'el-tanacode-test';

const log = (entry) => LOG && appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let next = 0;
const waiting = new Map();
// クライアントに要求を送り、返事（result か error）を待つ
function request(method, params) {
  const id = `srv-${++next}`;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

const TOOLS = [
  { name: 'ask_form', description: 'Ask the user where to deploy (form).', inputSchema: { type: 'object', properties: {} } },
  { name: 'ask_url', description: 'Ask the user to log in on a web page (URL).', inputSchema: { type: 'object', properties: {} } },
];

async function call(id, name) {
  if (name === 'ask_form') {
    const reply = await request('elicitation/create', { mode: 'form', message: 'どこに出しますか？', requestedSchema: FORM_SCHEMA });
    log({ elicited: 'form', reply });
    send({ id, result: { content: [{ type: 'text', text: `ELICIT-RESULT ${JSON.stringify(reply.result ?? reply.error)}` }] } });
    return;
  }
  if (name === 'ask_url') {
    const reply = await request('elicitation/create', { mode: 'url', message: 'ログインしてください', url: LOGIN_URL, elicitationId: ELICITATION_ID });
    log({ elicited: 'url', reply });
    if (reply.result?.action === 'accept') {
      while (DONE && !existsSync(DONE)) await sleep(50);
      send({ method: 'notifications/elicitation/complete', params: { elicitationId: ELICITATION_ID } });
      log({ completed: ELICITATION_ID });
    }
    send({ id, result: { content: [{ type: 'text', text: `ELICIT-RESULT ${JSON.stringify(reply.result ?? reply.error)}` }] } });
    return;
  }
  send({ id, error: { code: -32602, message: `Unknown tool: ${name}` } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // クライアントからの返事
  if (message.id !== undefined && message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  log({ method: message.method, ...(message.method === 'initialize' ? { capabilities: message.params?.capabilities } : {}) });
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'elicit', version: '1.0.0' } } });
      return;
    case 'tools/list':
      send({ id: message.id, result: { tools: TOOLS } });
      return;
    case 'tools/call':
      void call(message.id, message.params?.name);
      return;
    case 'ping':
      send({ id: message.id, result: {} });
      return;
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});
