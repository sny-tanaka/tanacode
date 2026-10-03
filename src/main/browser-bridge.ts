import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { BROWSER_MCP_SERVER, allowedBrowserToolIds } from '@shared/browser-tools';

// アプリ内ブラウザの中継（browser-mcp.ts。Claude Code が起動する MCP サーバー）とアプリのやりとり。
// userData の Unix ソケット（自分だけが読み書きできる権限）に、JSON を 1 行ずつ書く。中継はツールの呼び出しのたびにつなぎ、返事を受け取ったら切る。
// アプリを閉じている間はつながらないので、中継が「tanacode が起動していません」と返す。アプリが戻れば、そのまま使える
// （HTTP にしないのは、アプリを起動し直すたびにポートが変わり、動き続けている Claude Code からつながらなくなるため）

// 中継に渡す環境変数（--mcp-config の env）。ソケットのパスと、どのセッションの Claude Code か
export const BROWSER_SOCKET_ENV = 'TANACODE_BROWSER_SOCKET';
export const BROWSER_SESSION_ENV = 'TANACODE_BROWSER_SESSION';

// MCP のツールの結果（tools/call の result）
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type BridgeRequest = { id: number; session: string; tool: string; args: Record<string, unknown> };
export type BridgeResponse = { id: number; result: ToolResult };

export type BridgeHandler = (session: string, tool: string, args: Record<string, unknown>) => Promise<ToolResult>;

// 1 行の上限。スクリーンショットの画像が入るので大きめ
const MAX_LINE = 32 * 1024 * 1024;

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError } : { content: [{ type: 'text', text }] };
}

// アプリ側の待ち受け
export class BrowserBridge {
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
        if (line) void this.answer(socket, line);
      }
    });
    socket.on('error', () => socket.destroy());
  }

  private async answer(socket: Socket, line: string): Promise<void> {
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
      result = await this.handler(request.session, request.tool, args);
    } catch (error) {
      result = textResult(error instanceof Error ? error.message : String(error), true);
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, result } satisfies BridgeResponse)}\n`);
  }
}

// 中継の側。アプリにつないで 1 回呼び、返事を待つ。つながらない・返事が無いときは、Claude に返すエラーの結果にする
export function callBridge(socketPath: string, request: Omit<BridgeRequest, 'id'>, timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolve) => {
    const id = 1;
    let buffered = '';
    let done = false;
    const finish = (result: ToolResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
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
          closed
            ? 'tanacode が起動していません。アプリ内ブラウザを使うには、ユーザーに tanacode を起動してもらってください'
            : `tanacode につながりませんでした（${error.code ?? error.message}）`,
          true,
        ),
      );
    });
    socket.on('close', () => finish(textResult('tanacode との接続が切れました。もう一度試してください', true)));
  });
}

// Claude Code に MCP サーバー（中継）を足すための材料。アプリが起動する Claude Code にだけ、起動の引数で渡す（~/.claude の設定には書かない）
export type BrowserMcpLaunch = {
  // 中継を動かす実行ファイル（tanacode 本体の Helper を Node として。互換性の確認では node）と、中継のスクリプト
  command: string;
  script: string;
  socketPath: string;
  version: string;
};

// --mcp-config と --allowedTools。sessionId: どのセッションの Claude Code か（中継の env で渡す）。
// 読むだけのツールは許可済みにし、ページを動かすツールは Claude Code の許可の確認を通す
export function browserMcpArgs(launch: BrowserMcpLaunch, sessionId: string): string[] {
  const server = {
    type: 'stdio',
    command: launch.command,
    args: [launch.script],
    env: { ELECTRON_RUN_AS_NODE: '1', [BROWSER_SOCKET_ENV]: launch.socketPath, [BROWSER_SESSION_ENV]: sessionId, TANACODE_VERSION: launch.version },
  };
  return ['--mcp-config', JSON.stringify({ mcpServers: { [BROWSER_MCP_SERVER]: server } }), '--allowedTools', allowedBrowserToolIds().join(',')];
}
