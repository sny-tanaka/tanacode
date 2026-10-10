import { BROWSER_GATE_HOOK_ENV } from '@shared/chat';
import { t } from '@shared/i18n';
import { BROWSER_CLOSED_MESSAGE, BROWSER_COMMAND_ENV, BROWSER_GATE_REQUEST, BROWSER_SCRIPT_ENV } from './browser-bridge';
import { callBridge, type ToolResult } from './mcp-bridge';

// アプリ内ブラウザの JavaScript の実行（evaluate）の確認。アプリが起動する Claude Code に、--settings で PreToolUse のフックとして足す。
// 今のページが localhost（isLocalUrl）なら、確認なしで実行させる（permissionDecision: allow）。それ以外のページは、Claude Code の許可の確認を出させる（ask）。
// 「次から聞かない」で許可を残されていても、確認は出る（実測は test/cli/browser.test.ts）。
// ページは、アプリに聞く（中継とアプリの間のソケット）。聞けなかったときや、答えを読めなかったときは、確認を出させる側に倒す。
// フックは中継の入口（browser-mcp.js）を --gate 付きで動かす。環境変数は browserGateEnv（browser-bridge.ts）が起動する Claude Code に足す

// 入口に付けると、中継（MCP サーバー）ではなくフックとして動く
export const BROWSER_GATE_ARG = '--gate';

// 目印の環境変数は、チャットのフックの一覧に出さないためのもの
export const BROWSER_GATE_COMMAND = `${BROWSER_GATE_HOOK_ENV}=1 ELECTRON_RUN_AS_NODE=1 "$${BROWSER_COMMAND_ENV}" "$${BROWSER_SCRIPT_ENV}" ${BROWSER_GATE_ARG}`;

// アプリが答える、今のページ
export type GateAnswer = { local: boolean; url: string };

// アプリのエラーの返事や、形の違う返事は null（確認を出させる）
export function readAnswer(result: ToolResult): GateAnswer | null {
  if (result.isError) return null;
  const first = result.content[0];
  if (first?.type !== 'text') return null;
  try {
    const value = JSON.parse(first.text) as Partial<GateAnswer>;
    return typeof value.local === 'boolean' && typeof value.url === 'string' ? { local: value.local, url: value.url } : null;
  } catch {
    return null;
  }
}

// フックが標準出力に書く JSON（Claude Code の PreToolUse の出力）
export function gateOutput(answer: GateAnswer | null): string {
  const decide = (permissionDecision: 'allow' | 'ask', permissionDecisionReason: string) =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });
  if (!answer) return decide('ask', t('main.hooks.browserGateUnknown'));
  if (answer.local) return decide('allow', t('main.hooks.browserGateLocal'));
  return decide('ask', t('main.hooks.browserGateRemote', { url: answer.url }));
}

// フックの本体。アプリに今のページを聞いて、標準出力に書く内容を返す
export async function runGate(socketPath: string, session: string, timeoutMs: number): Promise<string> {
  const result = await callBridge(socketPath, { session, tool: BROWSER_GATE_REQUEST, args: {} }, timeoutMs, BROWSER_CLOSED_MESSAGE);
  return gateOutput(readAnswer(result));
}
