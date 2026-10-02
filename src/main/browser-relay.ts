import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { BROWSER_MCP_INSTRUCTIONS, BROWSER_MCP_SERVER, BROWSER_TOOLS, browserTool } from '@shared/browser-tools';
import { textResult, type ToolResult } from './browser-bridge';

// アプリ内ブラウザの MCP サーバー（stdio）。Claude Code と JSON-RPC を 1 行ずつやりとりし、ツールの呼び出しをアプリへ中継する。
// MCP の SDK は使わず、使う分（initialize・tools/list・tools/call・ping）だけを書く

type Id = string | number | null;
type Incoming = { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> };
type Outgoing = { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } };

// 知っている MCP の版。Claude Code が求めた版がこの中にあればそれで、無ければ最初のもので答える
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25', '2025-03-26', '2024-11-05'];

export type RelayDeps = {
  version: string;
  // アプリにツールの呼び出しを渡し、結果を受け取る
  call: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
};

// 1 つのメッセージへの返事。通知（id の無いもの）には返さない（null）
export async function respond(message: Incoming, deps: RelayDeps): Promise<Outgoing | null> {
  const { id, method, params } = message;
  if (id === undefined) return null;
  const ok = (result: unknown): Outgoing => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': {
      const wanted = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: BROWSER_MCP_SERVER, title: 'tanacode のアプリ内ブラウザ', version: deps.version },
        instructions: BROWSER_MCP_INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: BROWSER_TOOLS.map((t) => ({
          name: t.name,
          title: t.label,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.label, readOnlyHint: t.kind === 'read', openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = typeof params?.name === 'string' ? params.name : '';
      const raw = params?.arguments;
      const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      if (!browserTool(name)) return ok(textResult(`知らないツールです: ${name}`, true));
      return ok(await deps.call(name, args));
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// 標準入力から読んで、標準出力に返事を書く。返事は届いた順でなくてよい（id で対応づく）。onClose: 標準入力が閉じたとき（Claude Code が終わった）
export function runRelay(input: Readable, output: Writable, deps: RelayDeps, onClose: () => void): void {
  const write = (message: Outgoing) => output.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: Incoming;
    try {
      message = JSON.parse(line) as Incoming;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    void respond(message, deps).then(
      (reply) => reply && write(reply),
      (error: unknown) => message.id !== undefined && write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } }),
    );
  });
  lines.on('close', onClose);
}
