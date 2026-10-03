import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { findTool, type McpServerDef } from '@shared/mcp-tools';
import { textResult, type ToolResult } from './mcp-bridge';

// tanacode が Claude Code に足す MCP サーバー（stdio。アプリ内ブラウザ・セッション）。Claude Code と JSON-RPC を 1 行ずつやりとりし、
// ツールの呼び出しをアプリへ中継する。MCP の SDK は使わず、使う分（initialize・tools/list・tools/call・ping と、取り消しの notifications/cancelled）だけを書く

type Id = string | number | null;
type Incoming = { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> };
type Outgoing = { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } };

// 知っている MCP の版。Claude Code が求めた版がこの中にあればそれで、無ければ最初のもので答える
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25', '2025-03-26', '2024-11-05'];

export type RelayDeps = {
  // どの MCP サーバーとして答えるか（ツールの一覧と説明）
  server: McpServerDef;
  version: string;
  // アプリにツールの呼び出しを渡し、結果を受け取る。signal: Claude Code がその呼び出しを取り消した（Esc で中断した・待つ上限を過ぎた）
  call: (tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>;
};

// 1 つのメッセージへの返事。通知（id の無いもの）には返さない（null）
export async function respond(message: Incoming, deps: RelayDeps, signal: AbortSignal = new AbortController().signal): Promise<Outgoing | null> {
  const { id, method, params } = message;
  if (id === undefined) return null;
  const ok = (result: unknown): Outgoing => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': {
      const wanted = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: deps.server.name, title: deps.server.title, version: deps.version },
        instructions: deps.server.instructions,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: deps.server.tools.map((t) => ({
          name: t.name,
          title: t.label,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.label, readOnlyHint: t.kind === 'read' || t.kind === 'ask', openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = typeof params?.name === 'string' ? params.name : '';
      const raw = params?.arguments;
      const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      if (!findTool(deps.server, name)) return ok(textResult(`知らないツールです: ${name}`, true));
      return ok(await deps.call(name, args, signal));
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// 標準入力から読んで、標準出力に返事を書く。返事は届いた順でなくてよい（id で対応づく）。onClose: 標準入力が閉じたとき（Claude Code が終わった）。
// Claude Code が取り消した呼び出し（notifications/cancelled）は、アプリに待つのをやめさせ、返事を書かない（MCP の決まり）
export function runRelay(input: Readable, output: Writable, deps: RelayDeps, onClose: () => void): void {
  const write = (message: Outgoing) => output.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  // 答えている途中の呼び出し（id → 取り消し）
  const running = new Map<Id, AbortController>();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: Incoming;
    try {
      message = JSON.parse(line) as Incoming;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (message.method === 'notifications/cancelled') {
      const requestId = message.params?.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') running.get(requestId)?.abort();
      return;
    }
    const { id } = message;
    const cancel = new AbortController();
    if (id !== undefined) running.set(id, cancel);
    void respond(message, deps, cancel.signal)
      .then(
        (reply) => reply && !cancel.signal.aborted && write(reply),
        (error: unknown) => id !== undefined && !cancel.signal.aborted && write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } }),
      )
      .finally(() => {
        if (id !== undefined && running.get(id) === cancel) running.delete(id);
      });
  });
  lines.on('close', onClose);
}
