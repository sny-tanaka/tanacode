import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CHECKLIST_REMINDER_TAG, CHECKLIST_UNCHANGED_MARK } from '../../src/shared/checklist-tools';

// Anthropic の Messages API のふりをするサーバー。ANTHROPIC_BASE_URL をここに向けると、
// 本物の claude を API の料金なしで動かせる。返す応答は、決めておいた台本（Conversation）のとおり。
// 本体の会話のほか、サブエージェントやワークフローのエージェントも別の会話として API を呼ぶので、
// 会話のはじめ（最初の応答より前）の発言で台本を選ぶ。ワークフローのエージェントには元のユーザーの依頼のあとに
// スクリプトが作った仕事が届くので、台本の文字がいちばん後ろに出てくるものを選ぶ

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  // 思考。署名（signature）はモックなので、それらしい文字にする
  | { type: 'thinking'; thinking: string; signature?: string }
  // そのほかの、API が返すブロック（サーバーのツールの server_tool_use など）。content_block_start でそのまま送る（アプリの知らないブロックを確かめる）
  | { type: 'raw'; block: Record<string, unknown> };

// 会話の n 番目の応答（n = リクエストに入っている assistant の発言の数）
export type Step = Block[];

// match: 会話のはじめの発言に含まれる文字。delayMs: 応答を返し始めるまで待つ時間（作業中の画面を見るため）。
// model: 応答に書くモデル（無ければ頼まれたモデル。会話ログのモデルが画面のモデル名になるかを見るため）
// failures: 応答の番号 → 応答の代わりに返す API エラー。cuts: 応答の番号 → 書いている途中で接続を切る応答（ストリーミングのときだけ）。
// malformed: 応答の番号 → ツールを呼ばないのに stop_reason が tool_use の応答（ツールの呼び出しの形が壊れた応答）。
// cuts と malformed は、Claude Code が取り消して取り直す応答（会話ログには残らない）
export type Conversation = {
  match: string;
  steps: Step[];
  delayMs?: number;
  model?: string;
  failures?: Record<number, ApiFailure>;
  cuts?: Record<number, Retracted>;
  malformed?: Record<number, Retracted>;
};

// 応答の代わりに返す API エラー。status: HTTP の状態コード（529 は overloaded）。errorType: エラーの種類（overloaded_error など）。
// times: 続けて返す回数（無ければ毎回）。使い切ったあとは台本どおりの応答を返す（再試行が通る）。headers: 添える応答のヘッダー
export type ApiFailure = { status: number; errorType: string; message: string; times?: number; headers?: Record<string, string> };

// プランの利用枠（5 時間の枠）に当たったときの API の応答（429 と、枠のヘッダー）。resetsAt: 枠が戻る時刻（ミリ秒）。
// Claude Code は、OAuth のトークン（CLAUDE_CODE_OAUTH_TOKEN）で動いているときだけ、これを利用枠として読む（API キーでは、ただの 429。2.1.302 で実測）
export function usageLimitFailure(resetsAt: number, times?: number): ApiFailure {
  const reset = String(Math.floor(resetsAt / 1000));
  return {
    status: 429,
    errorType: 'rate_limit_error',
    message: 'Number of request tokens has exceeded your rate limit',
    ...(times === undefined ? {} : { times }),
    headers: {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': reset,
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
      'anthropic-ratelimit-unified-fallback': 'unavailable',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': reset,
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
    },
  };
}

// 台本の応答の代わりに返す、取り消される応答。text: その応答の文（切るものは、切る前に送る書きかけ）。
// times: 続けて返す回数（無ければ毎回）。使い切ったあとは台本どおりの応答を返す（Claude Code の取り直しが通る）
export type Retracted = { text: string; times?: number };

type Message = { role?: string; content?: string | { type?: string; text?: string; content?: string | { type?: string; text?: string }[] }[] };
type Body = {
  model?: string;
  output_config?: { effort?: unknown };
  stream?: boolean;
  tools?: { name?: string }[];
  messages?: Message[];
  system?: string | { type?: string; text?: string }[];
};

export class MockApi {
  private server: Server | null = null;
  // 受け取ったリクエスト（うまくいかなかったときの手がかり）
  readonly requests: string[] = [];
  private count = 0;
  // 返した API エラーの回数（台本の文字と応答の番号ごと）
  private readonly failed = new Map<string, number>();
  // 台本のある会話に付いてきたツールの名前（台本で使うツールが、今の Claude Code にあるかを確かめる）
  readonly tools = new Set<string>();
  // 受け取ったリクエストの、最後の user の発言の文章（/compact の要約の頼み方などを確かめる）
  readonly lastPrompts: string[] = [];
  // 台本のある会話の、Claude に渡ったシステムの文（システムプロンプトと、会話の中の system の発言。
  // 今の Claude Code は MCP サーバーの説明を後者に入れる）。圧縮のあとも MCP サーバーの説明が渡るかを確かめる
  readonly systems: string[] = [];
  // 台本のある会話の、リクエストごとの発言の文章（user と system のすべて）。フックが足した文が Claude に渡ったかを確かめる
  readonly contexts: string[] = [];
  // 受け取ったツールの結果（tool_result）の文章。質問への答えや許可の結果が、Claude まで届いたかを確かめる
  readonly toolResults: string[] = [];
  // ツールの一覧が付いた呼び出し（本体の会話）ごとの、頼まれたモデルとエフォート（モデル・エフォートの切り替えが届いたかを確かめる）
  readonly calls: { model: string | undefined; effort: unknown }[] = [];

  // チェックリストを使い続けさせるフックがターンの終わりを止めたとき（Stop hook feedback）の応答も、台本から返すか。
  // ふだんは、本物のモデルが直すものの無いときにするのと同じく、決まった目印だけを返して、台本を進めない
  // （チェックリストを足して動かす台本が、ターンの終わりごとに 1 つずつずれないように）。フックそのものを確かめるときだけ true にする
  scriptChecklistStops = false;

  // 応答に付ける入力のトークン数（コンテキストの使用量として statusLine と会話ログに出る。上限は 20 万）。
  // 大きくすると、コンテキストが埋まってきたときの動き（自動の最適化圧縮）を確かめられる
  inputTokens = 100;
  // 台本より先に、最後の user の発言から応答を決める（何番目の応答かが決まらない場面で使う）。
  // prompt: 最後の user の発言の文章（ツールの結果だけなら空）/ results: その発言に入っているツールの結果の文章 /
  // context: リクエストの user と system の発言の文章すべて（Claude Code が足した案内を読むとき）。null を返すと台本に任せる
  intercept: ((prompt: string, results: string[], context: string) => Block[] | null) | null = null;
  // 台本より先に、最後の user の発言から、応答の代わりに返す API エラーを決める（/compact の要約の頼みを失敗させるなど）。
  // null を返すと、ふだんどおりに応答する
  failIf: ((prompt: string) => ApiFailure | null) | null = null;

  // 台本。起動したあとで決めてよい（作業フォルダのパスを入れるため）
  conversations: Conversation[] = [];
  // ツールの一覧が付いていない呼び出し（タイトル作り・auto モードの判定など）への返事。match: その呼び出しの発言に含まれる文字。
  // delayMs: 返すまで待つ時間（auto モードの判定を待たせるなど）。どれにも当たらなければ、これまでどおり短い文を返す
  plainReplies: { match: string; text: string; delayMs?: number }[] = [];
  // ツールの一覧が付いていない呼び出しを、これが済むまで返さない（Claude Code がその返事を待たずに先へ進むことを確かめる）
  holdPlain: Promise<void> | null = null;
  // 台本のある会話の文のブロックを、書き終える（content_block_stop を送る）前に、これが済むまで止める（text: そのブロックの文）。
  // Claude Code は、ブロックを書き終えてから会話ログに書くので、書いている途中の文がアプリに届いてから、会話ログに出るようにできる。
  // 書いている途中で接続を切る応答（cuts）では、書きかけを送ってから切るまでに止める（書きかけがアプリに届いてから切る）
  holdText: ((text: string) => Promise<unknown>) | null = null;
  // 台本のある会話のツールの呼び出しのブロックを書き終えた（content_block_stop を送った）あと、次を送る前に、これが済むまで止める
  // （id: その呼び出しの tool_use ID）。Claude Code は、書き終えた呼び出しから動かすので、その結果が会話ログに出てから次の呼び出しを
  // 送れる（本物のモデルが、並べて呼ぶ次の呼び出しをゆっくり書いているときと同じ並び）
  holdTool: ((id: string) => Promise<unknown>) | null = null;

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
    // 本文は、かたまり（Buffer）を集めてから 1 度に文字にする。かたまりごとに文字にすると、かたまりの区切り（およそ 64 KiB ごと）に
    // またがった 1 文字（日本語は 3 バイト）が、U+FFFD に化ける（4 万文字の再開の文で、Claude に届いた発言の 1 文字が化けて見えた）
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    this.requests.push(`${req.method} ${req.url}`);
    const path = (req.url ?? '').split('?')[0];
    if (path === '/v1/messages/count_tokens') return json(res, { input_tokens: 100 });
    if (path !== '/v1/messages') return json(res, {});

    const body = JSON.parse(raw || '{}') as Body;
    // ツールの一覧が付いていないもの（タイトル作りなどの裏の呼び出し）には、台本を使わず短い文を返す
    const tools = body.tools ?? [];
    const messages = body.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    this.lastPrompts.push(textOf(lastUser));
    if (tools.length > 0) this.calls.push({ model: body.model, effort: body.output_config?.effort });
    if (Array.isArray(lastUser?.content)) for (const b of lastUser.content) if (b.type === 'tool_result') this.toolResults.push(resultText(b.content));
    const reply = messages.findIndex((m) => m.role === 'assistant');
    const opening = (reply === -1 ? messages : messages.slice(0, reply)).filter((m) => m.role === 'user');
    const first = opening.map(textOf).join('\n');
    const at = (c: Conversation) => first.lastIndexOf(c.match);
    const conversation =
      tools.length > 0 ? this.conversations.filter((c) => at(c) !== -1).sort((a, b) => at(b) - at(a))[0] : undefined;
    // 目印だけの応答は、台本の応答に数えない
    const scripted = (m: Message) => m.role === 'assistant' && (this.scriptChecklistStops || textOf(m).trim() !== CHECKLIST_UNCHANGED_MARK);
    const index = messages.filter(scripted).length;
    // 止めたあとの続き（Claude Code が、フックの文を最後の user の発言に入れて続ける。2.1.302 は「Stop hook additional context: 」を頭に付ける）
    const stopped = !this.scriptChecklistStops && tools.length > 0 && textOf(lastUser).includes(`<${CHECKLIST_REMINDER_TAG}>Before you end this turn`);
    if (conversation) for (const t of tools) if (t.name) this.tools.add(t.name);
    if (conversation) {
      const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map((b) => b.text ?? '').join('\n');
      this.systems.push([system, ...messages.filter((m) => m.role === 'system').map(textOf)].join('\n'));
      this.contexts.push(messages.filter((m) => m.role !== 'assistant').map(textOf).join('\n'));
    }
    const plain = tools.length === 0 ? this.plainReplies.find((r) => messages.map(textOf).join('\n').includes(r.match)) : undefined;
    const lastResults = Array.isArray(lastUser?.content) ? lastUser.content.filter((b) => b.type === 'tool_result').map((b) => resultText(b.content)) : [];
    const context = messages.filter((m) => m.role !== 'assistant').map(textOf).join('\n');
    const intercepted = tools.length > 0 && !stopped ? (this.intercept?.(textOf(lastUser), lastResults, context) ?? null) : null;
    const blocks: Block[] = intercepted
      ? intercepted
      : stopped
      ? [{ type: 'text', text: CHECKLIST_UNCHANGED_MARK }]
      : conversation
      ? (conversation.steps[index] ?? [{ type: 'text', text: '（台本の続きはありません）' }])
      : [{ type: 'text', text: plain?.text ?? 'テスト' }];
    const stopReason = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    this.requests.push(`  ${conversation ? `「${conversation.match}」の会話・${index} 番目の応答` : `台本の無い呼び出し（${first.slice(0, 60)}）`}`);
    if (conversation?.delayMs) await new Promise((resolve) => setTimeout(resolve, conversation.delayMs));
    if (plain?.delayMs) await new Promise((resolve) => setTimeout(resolve, plain.delayMs));
    if (tools.length === 0 && this.holdPlain) await this.holdPlain;
    const forced = tools.length > 0 ? (this.failIf?.(textOf(lastUser)) ?? null) : null;
    if (forced) {
      this.requests.push(`  → API エラー ${forced.status}（failIf）`);
      return fail(res, forced);
    }
    const failure = conversation?.failures?.[index];
    const key = `${conversation?.match}:${index}`;
    if (failure && (failure.times === undefined || (this.failed.get(key) ?? 0) < failure.times)) {
      this.failed.set(key, (this.failed.get(key) ?? 0) + 1);
      this.requests.push(`  → API エラー ${failure.status}（${this.failed.get(key)} 回目）`);
      return fail(res, failure);
    }
    // 応答ごとに ID を変える（同じ ID の応答は、Claude Code が 1 つの発言にまとめる）
    const answer = { id: `msg_mock_${++this.count}`, model: conversation?.model ?? body.model ?? 'claude-mock', content: blocks, stopReason, inputTokens: this.inputTokens };
    // 止めた文を待ち切れなくても、応答は最後まで返す（Claude Code を止めたままにしない）。待ち切れなかったことは手がかりに残す
    const holdText = conversation ? this.holdText : null;
    const hold = holdText
      ? (text: string) => holdText(text).then(
          () => undefined,
          (error: unknown) => void this.requests.push(`  → 文「${text}」を止めたが、待ち切れなかった（${error instanceof Error ? error.message : String(error)}）`),
        )
      : null;
    const holdTool = conversation ? this.holdTool : null;
    const holdAfterTool = holdTool
      ? (id: string) => holdTool(id).then(
          () => undefined,
          (error: unknown) => void this.requests.push(`  → 呼び出し ${id} のあとで止めたが、待ち切れなかった（${error instanceof Error ? error.message : String(error)}）`),
        )
      : null;
    // 取り消される応答を、使い切るまで台本の応答の代わりに返す
    const retract = (label: string, retracted: Retracted | undefined): Retracted | undefined => {
      const counted = `${key}:${label}`;
      if (!retracted || (retracted.times !== undefined && (this.failed.get(counted) ?? 0) >= retracted.times)) return undefined;
      this.failed.set(counted, (this.failed.get(counted) ?? 0) + 1);
      this.requests.push(`  → ${label}（${this.failed.get(counted)} 回目）`);
      return retracted;
    };
    const cut = body.stream ? retract('書いている途中で接続を切る', conversation?.cuts?.[index]) : undefined;
    if (cut) return cutStream(res, answer, cut.text, hold);
    const malformed = retract('形の壊れたツールの呼び出し', conversation?.malformed?.[index]);
    const sent: Reply = malformed ? { ...answer, content: [{ type: 'text', text: malformed.text }], stopReason: 'tool_use' } : answer;
    if (body.stream) await stream(res, sent, hold, holdAfterTool);
    else json(res, message(sent));
  }
}

// 思考の署名（本物の API が付ける暗号の署名の代わり）
const MOCK_SIGNATURE = 'bW9jay1zaWduYXR1cmU=';

type Reply = { id: string; model: string; content: Block[]; stopReason: string; inputTokens: number };

function message({ id, model, content, stopReason, inputTokens }: Reply) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: content.map((block) => (block.type === 'raw' ? block.block : block)),
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 20 },
  };
}

// 本物の API と同じ形のエラー（{ type: 'error', error: { type, message } }）
function fail(res: ServerResponse, { status, errorType, message, headers }: ApiFailure): void {
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_mock_${status}`, ...headers });
  res.end(JSON.stringify({ type: 'error', error: { type: errorType, message } }));
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

// ストリーミング（SSE）の応答を、応答の始まり（message_start）まで送る。返すのは、続きの出来事を送る関数
function openStream(res: ServerResponse, reply: Reply): (type: string, data: Record<string, unknown>) => void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { ...message({ ...reply, content: [] }), stop_reason: null, usage: { input_tokens: reply.inputTokens, output_tokens: 0 } } });
  return send;
}

// ストリーミング（SSE）の応答。文章は text_delta、ツールの入力は input_json_delta で 1 回に送る。
// hold: 文のブロックを書き終える前に待つもの（MockApi.holdText）。holdAfterTool: ツールの呼び出しのブロックを書き終えたあとに待つもの（MockApi.holdTool）
async function stream(
  res: ServerResponse,
  reply: Reply,
  hold: ((text: string) => Promise<void>) | null,
  holdAfterTool: ((id: string) => Promise<void>) | null = null,
): Promise<void> {
  const send = openStream(res, reply);
  for (const [index, block] of reply.content.entries()) {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
      if (hold) await hold(block.text);
    } else if (block.type === 'thinking') {
      send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      send('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature ?? MOCK_SIGNATURE } });
    } else if (block.type === 'raw') {
      send('content_block_start', { index, content_block: block.block });
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { index });
    if (block.type === 'tool_use' && holdAfterTool) await holdAfterTool(block.id);
  }
  send('message_delta', { delta: { stop_reason: reply.stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', {});
  res.end();
}

// 書いている途中で接続が切れるストリーミングの応答。文のブロックの書きかけ（text）まで送り、hold が済んだら接続を切る
async function cutStream(res: ServerResponse, reply: Reply, text: string, hold: ((text: string) => Promise<void>) | null): Promise<void> {
  const send = openStream(res, reply);
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  if (hold) await hold(text);
  res.socket?.destroy();
}

function textOf(message: Message | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}

function resultText(content: string | { type?: string; text?: string }[] | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((b) => b.text ?? '').join('\n');
}
