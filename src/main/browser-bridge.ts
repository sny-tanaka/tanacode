import { BROWSER_MCP } from '@shared/browser-tools';
import { language } from '@shared/i18n';
import { mcpArgs, mcpServerEntry, type McpLaunch, type McpServerEntry } from './mcp-bridge';

// アプリ内ブラウザの中継（browser-mcp.ts。Claude Code が起動する MCP サーバー）に渡すもの。ソケットのやりとりは mcp-bridge.ts

// 中継に渡す環境変数（--mcp-config の env）。ソケットのパスと、どのセッションの Claude Code か
export const BROWSER_SOCKET_ENV = 'TANACODE_BROWSER_SOCKET';
export const BROWSER_SESSION_ENV = 'TANACODE_BROWSER_SESSION';
// 中継の入口（browser-mcp.js）を、JavaScript の実行の確認のフック（browser-gate.ts）として動かすための環境変数。
// フックは Claude Code の環境で動くので、起動する Claude Code の環境に足す（--mcp-config の env は、MCP サーバーにしか届かない）
export const BROWSER_COMMAND_ENV = 'TANACODE_BROWSER_COMMAND';
export const BROWSER_SCRIPT_ENV = 'TANACODE_BROWSER_SCRIPT';
// フックが確認の理由を書く言語（Claude Code を起動したときのアプリの言語）
export const BROWSER_LANGUAGE_ENV = 'TANACODE_LANGUAGE';
// フックがアプリに、今のページで JavaScript を実行してよいか（localhost か）を聞く、中継の内部の呼び出し。MCP のツールではない
export const BROWSER_GATE_REQUEST = 'gate:evaluate';

// アプリが起動していないとき、中継が Claude に返す文
export const BROWSER_CLOSED_MESSAGE = 'tanacode が起動していません。アプリ内ブラウザを使うには、ユーザーに tanacode を起動してもらってください';

export type BrowserMcpLaunch = McpLaunch;

// 起動する Claude Code の環境に足す、JavaScript の実行の確認のフックが使う環境変数
export function browserGateEnv(launch: BrowserMcpLaunch, sessionId: string): Record<string, string> {
  return {
    [BROWSER_SOCKET_ENV]: launch.socketPath,
    [BROWSER_SESSION_ENV]: sessionId,
    [BROWSER_COMMAND_ENV]: launch.command,
    [BROWSER_SCRIPT_ENV]: launch.script,
    [BROWSER_LANGUAGE_ENV]: language(),
  };
}

// --mcp-config に入れるアプリ内ブラウザのサーバー。sessionId: どのセッションの Claude Code か（中継の env で渡す）。
// 読むだけのツールは許可済みにし、ページを動かすツールは Claude Code の許可の確認を通す（JavaScript の実行は、フックが決める）
export function browserMcpServer(launch: BrowserMcpLaunch, sessionId: string): McpServerEntry {
  return mcpServerEntry(BROWSER_MCP, launch, { [BROWSER_SOCKET_ENV]: launch.socketPath, [BROWSER_SESSION_ENV]: sessionId });
}

// アプリ内ブラウザだけを足すときの --mcp-config と --allowedTools
export function browserMcpArgs(launch: BrowserMcpLaunch, sessionId: string): string[] {
  return mcpArgs([browserMcpServer(launch, sessionId)]);
}
