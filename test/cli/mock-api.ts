import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Anthropic の Messages API のふりをするサーバー。ANTHROPIC_BASE_URL をここに向けると、
// 本物の claude を API の料金なしで動かせる。返す応答は、決めておいた台本（Step）のとおり

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

// 会話の n 番目の応答（n = リクエストに入っている assistant の発言の数）
export type Step = Block[];

type Body = {
  model?: string;
  stream?: boolean;
  tools?: { name?: string }[];
  messages?: { role?: string }[];
};

export class MockApi {
  private server: Server | null = null;
  // 受け取ったリクエスト（うまくいかなかったときの手がかり）
  readonly requests: string[] = [];
  private count = 0;

  // 台本。起動したあとで決めてよい（作業フォルダのパスを入れるため）
  steps: Step[] = [];

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    this.requests.push(`${req.method} ${req.url}`);
    const path = (req.url ?? '').split('?')[0];
    if (path === '/v1/messages/count_tokens') return json(res, { input_tokens: 100 });
    if (path !== '/v1/messages') return json(res, {});

    const body = JSON.parse(raw || '{}') as Body;
    // 本体の会話にはツールの一覧が付く。付いていないもの（タイトル作りなどの裏の呼び出し）には短い文を返す
    const main = body.tools?.some((t) => t.name === 'Bash') ?? false;
    const index = body.messages?.filter((m) => m.role === 'assistant').length ?? 0;
    const blocks: Block[] = main ? (this.steps[index] ?? [{ type: 'text', text: '（台本の続きはありません）' }]) : [{ type: 'text', text: 'テスト' }];
    const stopReason = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    this.requests.push(`  ${main ? `本体の会話・${index} 番目の応答` : '裏の呼び出し'}`);
    // 応答ごとに ID を変える（同じ ID の応答は、Claude Code が 1 つの発言にまとめる）
    const reply = { id: `msg_mock_${++this.count}`, model: body.model ?? 'claude-mock', content: blocks, stopReason };
    if (body.stream) stream(res, reply);
    else json(res, message(reply));
  }
}

type Reply = { id: string; model: string; content: Block[]; stopReason: string };

function message({ id, model, content, stopReason }: Reply) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

// ストリーミング（SSE）の応答。文章は text_delta、ツールの入力は input_json_delta で 1 回に送る
function stream(res: ServerResponse, reply: Reply): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { ...message({ ...reply, content: [] }), stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  reply.content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: reply.stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', {});
  res.end();
}
