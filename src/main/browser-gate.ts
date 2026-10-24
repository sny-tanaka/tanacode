import { browserToolId } from '@shared/browser-tools';
import { BROWSER_GATE_HOOK_ENV } from '@shared/chat';
import { t } from '@shared/i18n';
import { BROWSER_CLOSED_MESSAGE, BROWSER_COMMAND_ENV, BROWSER_GATE_REQUEST, BROWSER_SCRIPT_ENV } from './browser-bridge';
import { callBridge, type ToolResult } from './mcp-bridge';
import { alwaysAllowed, alwaysAllowOutput } from './tool-permissions';

// アプリ内ブラウザのツールの確認。アプリが起動する Claude Code に、--settings で PreToolUse のフックとして足す。
// - JavaScript の実行（evaluate）: 今のページが localhost（isLocalUrl）なら、確認なしで実行させる（permissionDecision: allow）。
//   それ以外のページは、Claude Code の許可の確認を出させる（ask）
// - 開く（navigate）: 許す先の外のページを開くときは、権限モードによらず、毎回 Claude Code の許可の確認を出させる（ask）。
//   許す先・そのタブで許可したオリジンを同じタブで開くときは、何も決めない（Claude Code のふだんの許可の決まりに任せる）。
//   allow は返さない（manual のセッションの確認まで飛ばしてしまうため）
// 「次から聞かない」で許可を残されていても、ask の確認は出る（実測は test/cli/browser.test.ts）。
// ツールの許可（メニューの「MCP → Claude のツールの許可…」）で「常に許可」にしたツールは、どのページ・どの先でも allow を返す（tool-permissions.ts）。
// どちらかは、アプリに聞く（中継とアプリの間のソケット）。ツールの名前と入力は、Claude Code がフックの標準入力に渡す JSON から読む。
// JavaScript の実行で、アプリに聞けなかったときや、答えを読めなかったときは、確認を出させる側に倒す。開くときは何も決めない
// （開くのはアプリなので、アプリが動いていなければ開けない。アプリは、人に確認した印の無い外の先を開かない）。
// フックは中継の入口（browser-mcp.js）を --gate 付きで動かす。環境変数は browserGateEnv（browser-bridge.ts）が起動する Claude Code に足す

// 入口に付けると、中継（MCP サーバー）ではなくフックとして動く
export const BROWSER_GATE_ARG = '--gate';

// 目印の環境変数は、チャットのフックの一覧に出さないためのもの
export const BROWSER_GATE_COMMAND = `${BROWSER_GATE_HOOK_ENV}=1 ELECTRON_RUN_AS_NODE=1 "$${BROWSER_COMMAND_ENV}" "$${BROWSER_SCRIPT_ENV}" ${BROWSER_GATE_ARG}`;

// アプリが答える、今のページ（evaluate）
export type GateAnswer = { local: boolean; url: string };
// アプリが答える、開く先（navigate）。outside: 許す先の外で、人に確認するオリジン（null は、何も決めない）
export type NavigateGateAnswer = { outside: string | null };

// フックの標準入力（Claude Code の PreToolUse の入力）のうち、使うもの。toolUseId: その呼び出しの ID（tool_use_id。無ければ付けない）
export type GateInput = { tool: string; input: Record<string, unknown>; toolUseId?: string };

// 標準入力の JSON を読む。読めなければ、ツールの名前を空にする（確認を出させる）
export function readGateInput(text: string): GateInput {
  try {
    const value = JSON.parse(text) as { tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown };
    const input = value.tool_input && typeof value.tool_input === 'object' && !Array.isArray(value.tool_input) ? (value.tool_input as Record<string, unknown>) : {};
    return { tool: typeof value.tool_name === 'string' ? value.tool_name : '', input, ...(typeof value.tool_use_id === 'string' ? { toolUseId: value.tool_use_id } : {}) };
  } catch {
    return { tool: '', input: {} };
  }
}

// アプリのエラーの返事や、形の違う返事は null（確認を出させる）
export function readAnswer(result: ToolResult): GateAnswer | null {
  const value = readJson(result) as Partial<GateAnswer> | null;
  return value && typeof value.local === 'boolean' && typeof value.url === 'string' ? { local: value.local, url: value.url } : null;
}

// アプリのエラーの返事や、形の違う返事は null（何も決めない）
export function readNavigateAnswer(result: ToolResult): NavigateGateAnswer | null {
  const value = readJson(result) as Partial<NavigateGateAnswer> | null;
  return value && (value.outside === null || typeof value.outside === 'string') ? { outside: value.outside } : null;
}

function readJson(result: ToolResult): unknown {
  if (result.isError) return null;
  const first = result.content[0];
  if (first?.type !== 'text') return null;
  try {
    const value: unknown = JSON.parse(first.text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// フックが標準出力に書く JSON（Claude Code の PreToolUse の出力）
function decide(permissionDecision: 'allow' | 'ask', permissionDecisionReason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });
}

// JavaScript の実行
export function gateOutput(answer: GateAnswer | null): string {
  if (!answer) return decide('ask', t('main.hooks.browserGateUnknown'));
  if (answer.local) return decide('allow', t('main.hooks.browserGateLocal'));
  return decide('ask', t('main.hooks.browserGateRemote', { url: answer.url }));
}

// 開く。何も決めないときは、空の JSON
export function navigateGateOutput(answer: NavigateGateAnswer | null): string {
  return answer?.outside ? decide('ask', t('main.hooks.browserGateOutside', { origin: answer.outside })) : '{}';
}

// フックの本体。アプリにツールの名前と入力を渡して聞き、標準出力に書く内容を返す。hookInput: 標準入力に届いた JSON
export async function runGate(socketPath: string, session: string, timeoutMs: number, hookInput: string): Promise<string> {
  const { tool, input, toolUseId } = readGateInput(hookInput);
  const navigate = tool === browserToolId('navigate');
  // ほかのツールで呼ばれたら（フックの設定と合わない）、確認を出させる。localhost のページでも allow は返さない
  if (!navigate && tool !== browserToolId('evaluate')) return gateOutput(null);
  const result = await callBridge(socketPath, { session, tool: BROWSER_GATE_REQUEST, args: { tool, input, ...(toolUseId ? { toolUseId } : {}) } }, timeoutMs, BROWSER_CLOSED_MESSAGE);
  // ツールの許可で「常に許可」にしていれば、確認を出させない（アプリは上の問い合わせで、確認した印を控えてある。plan のときは既定のまま）
  if (alwaysAllowed(tool, hookInput)) return alwaysAllowOutput();
  return navigate ? navigateGateOutput(readNavigateAnswer(result)) : gateOutput(readAnswer(result));
}
