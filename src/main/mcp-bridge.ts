import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { allowedToolIds, type McpServerDef } from '@shared/mcp-tools';

// tanacode が Claude Code に足す MCP サーバーの中継（browser-mcp.ts・sessions-mcp.ts。Claude Code が起動する）とアプリのやりとり。
// userData の Unix ソケット（自分だけが読み書きできる権限）に、JSON を 1 行ずつ書く。中継はツールの呼び出しのたびにつなぎ、返事を受け取ったら切る。
// アプリを閉じている間はつながらないので、中継が「tanacode が起動していません」と返す。アプリが戻れば、そのまま使える
// （HTTP にしないのは、アプリを起動し直すたびにポートが変わり、動き続けている Claude Code からつながらなくなるため）。
// MCP サーバーごとに、ソケットを分ける（ツールの名前が重なっても、どちらのツールか取り違えない）

// MCP のツールの結果（tools/call の result）
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type BridgeRequest = { id: number; session: string; tool: string; args: Record<string, unknown> };
export type BridgeResponse = { id: number; result: ToolResult };

// signal: 中継がソケットを閉じた（Claude Code が呼び出しを取り消した・中継が終わった）ら abort する
export type BridgeHandler = (session: string, tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>;

// 1 行の上限。スクリーンショットの画像が入るので大きめ
const MAX_LINE = 32 * 1024 * 1024;

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError } : { content: [{ type: 'text', text }] };
}

// アプリ側の待ち受け
export class McpBridge {
  private server: Server | null = null;

  constructor(
    readonly socketPath: string,
    private readonly handler: BridgeHandler,
  ) {}

  async start(): Promise<void> {
    // 前に起動したアプリが残したソケット（落ちたときなど）は消して作り直す
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // ソケットのファイルは、作ったときから自分だけが読み書きできるようにする（listen のあとで絞るまでの間も、ほかの人につながせない）
      const mask = process.umask(0o177);
      try {
        server.listen(this.socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      } finally {
        process.umask(mask);
      }
    });
    chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  close(): void {
    this.server?.close();
    this.server = null;
    try {
      unlinkSync(this.socketPath);
    } catch {
      // もう無い
    }
  }

  private serve(socket: Socket): void {
    socket.setEncoding('utf8');
    // 中継は呼び出しのたびにつなぐので、ソケットが閉じたら、その呼び出しはもう誰も待っていない
    const closed = new AbortController();
    socket.on('close', () => closed.abort());
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) void this.answer(socket, line, closed.signal);
      }
    });
    socket.on('error', () => socket.destroy());
  }

  private async answer(socket: Socket, line: string, signal: AbortSignal): Promise<void> {
    let request: BridgeRequest;
    try {
      request = JSON.parse(line) as BridgeRequest;
    } catch {
      return;
    }
    if (typeof request?.id !== 'number' || typeof request.session !== 'string' || typeof request.tool !== 'string') return;
    const args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? request.args : {};
    let result: ToolResult;
    try {
      result = await this.handler(request.session, request.tool, args, signal);
    } catch (error) {
      result = textResult(error instanceof Error ? error.message : String(error), true);
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, result } satisfies BridgeResponse)}\n`);
  }
}

// 中継の側。アプリにつないで 1 回呼び、返事を待つ。つながらない・返事が無いときは、Claude に返すエラーの結果にする。
// closedMessage: アプリが起動していない（ソケットが無い）ときに Claude に返す文。
// signal: Claude Code が呼び出しを取り消した。ソケットを閉じて、アプリに待つのをやめさせる
export function callBridge(
  socketPath: string,
  request: Omit<BridgeRequest, 'id'>,
  timeoutMs: number,
  closedMessage: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const id = 1;
    let buffered = '';
    let done = false;
    const cancel = () => finish(textResult('取り消されました', true));
    const finish = (result: ToolResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      socket.destroy();
      resolve(result);
    };
    const socket = connect(socketPath);
    socket.setEncoding('utf8');
    const timer = setTimeout(
      () => finish(textResult('tanacode から返事がありませんでした。アプリが止まっていないか確かめてください', true)),
      timeoutMs,
    );
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, ...request } satisfies BridgeRequest)}\n`));
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffered.slice(0, newline)) as BridgeResponse;
        finish(response.id === id && response.result ? response.result : textResult('tanacode の返事を読めませんでした', true));
      } catch {
        finish(textResult('tanacode の返事を読めませんでした', true));
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const closed = error.code === 'ENOENT' || error.code === 'ECONNREFUSED';
      finish(
        textResult(
          closed ? closedMessage : `tanacode につながりませんでした（${error.code ?? error.message}）`,
          true,
        ),
      );
    });
    socket.on('close', () => finish(textResult('tanacode との接続が切れました。もう一度試してください', true)));
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}

// Claude Code に MCP サーバー（中継）を足すための材料。アプリが起動する Claude Code にだけ、起動の引数で渡す（~/.claude の設定には書かない）
export type McpLaunch = {
  // 中継を動かす実行ファイル（tanacode 本体の Helper を Node として。互換性の確認では node）と、中継のスクリプト
  command: string;
  script: string;
  socketPath: string;
  version: string;
};

// --mcp-config に入れる 1 つのサーバーと、--allowedTools で許可済みにするツール
export type McpServerEntry = { name: string; config: Record<string, unknown>; allowed: string[] };

// env: 中継に渡す環境変数（ソケットのパスと、どのセッションの Claude Code か）。
// timeoutMs: 1 回のツールの呼び出しを Claude Code が待つ上限（省くと Claude Code の既定）
export function mcpServerEntry(def: McpServerDef, launch: McpLaunch, env: Record<string, string>, timeoutMs?: number): McpServerEntry {
  return {
    name: def.name,
    config: {
      type: 'stdio',
      command: launch.command,
      args: [launch.script],
      env: { ELECTRON_RUN_AS_NODE: '1', ...env, TANACODE_VERSION: launch.version },
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    },
    allowed: allowedToolIds(def),
  };
}

// --mcp-config と --allowedTools。どちらも 1 回にまとめて渡す（値をいくつも取る引数で、2 回渡したときの扱いが決まっていないため）。
// 読むだけのツールは許可済みにし、それ以外は Claude Code の許可の確認を通す
export function mcpArgs(entries: McpServerEntry[]): string[] {
  if (entries.length === 0) return [];
  const servers = Object.fromEntries(entries.map((e) => [e.name, e.config]));
  return ['--mcp-config', JSON.stringify({ mcpServers: servers }), '--allowedTools', entries.flatMap((e) => e.allowed).join(',')];
}
