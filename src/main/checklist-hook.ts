import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { CHECKLIST_HOOK_ENV } from '@shared/chat';
import type { ReminderEvent, TurnActivity } from '@shared/checklist-reminder';
import { CHECKLIST_MCP_SERVER } from '@shared/checklist-tools';
import { CHECKLIST_CLOSED_MESSAGE, CHECKLIST_COMMAND_ENV, CHECKLIST_SCRIPT_ENV, checklistHookRequest } from './checklist-bridge';
import { callBridge } from './mcp-bridge';

// Claude にチェックリストを使い続けさせる hooks。アプリが起動する Claude Code に、--settings で足す（statusline.ts の ownSettings）。
// - UserPromptSubmit: 人が発言したら、今のチェックリストを Claude に渡す（発言で計画が変わったら、先にリストを直させる）
// - Stop: ツールを使ったのにチェックリストに触れずにターンを終えようとしたら、1 回だけ止めて、リストを今の状態に直させる
// - SessionStart（compact）: 会話が圧縮されたら、今のチェックリストを渡す
// 渡す文と、止めるかどうかは、アプリが決める（@shared/checklist-reminder）。フックは、Claude が使ったツールを会話ログから数えて、アプリに聞く。
// フックは中継の入口（checklist-mcp.js）を --hook 付きで動かす。環境変数は checklistHookEnv（checklist-bridge.ts）が、起動する Claude Code に足す。
// アプリに聞けなかったとき・答えを読めなかったときは、何も出さない（Claude の作業を止めない側に倒す）

// 入口に付けると、中継（MCP サーバー）ではなくフックとして動く
export const CHECKLIST_HOOK_ARG = '--hook';

// 目印の環境変数は、チャットのフックの一覧に出さないためのもの
export const CHECKLIST_HOOK_COMMAND = `${CHECKLIST_HOOK_ENV}=1 ELECTRON_RUN_AS_NODE=1 "$${CHECKLIST_COMMAND_ENV}" "$${CHECKLIST_SCRIPT_ENV}" ${CHECKLIST_HOOK_ARG}`;

// フックが待つ上限（秒）。過ぎたら Claude Code がフックをやめて、そのまま進む
const HOOK_TIMEOUT_SECONDS = 10;

// --settings の hooks に足すもの
export function checklistHooks(): Record<string, unknown[]> {
  const hooks = [{ type: 'command', command: CHECKLIST_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }];
  return { UserPromptSubmit: [{ hooks }], Stop: [{ hooks }], SessionStart: [{ matcher: 'compact', hooks }] };
}

// Claude Code がフックの標準入力に渡す JSON のうち、使うもの
type HookInput = { hook_event_name?: string; stop_hook_active?: boolean; transcript_path?: string };

const EVENTS: Record<string, ReminderEvent> = { UserPromptSubmit: 'prompt', Stop: 'stop', SessionStart: 'compact' };

// 会話ログの終わりから読む大きさ。1 ターンがこれより長ければ、読めた分だけを数える（ツールを使ったことは分かる）
const TAIL_BYTES = 4 * 1024 * 1024;

// 会話ログの終わりの部分（途中から始まる 1 行めは捨てる）。読めなければ空
export function readTail(path: string, maxBytes = TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

type Line = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  message?: { content?: string | { type?: string; name?: string }[] };
};

// このターン（最後の発言のあと）に使ったツールを、会話ログ（JSONL）の終わりから数える。
// 発言: user の行で、ツールの結果でも、Claude Code が足した行（isMeta・圧縮の要約）でもないもの
export function turnActivity(transcript: string): TurnActivity {
  const activity: TurnActivity = { turn: 0, checklist: 0 };
  const lines = transcript.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let line: Line;
    try {
      line = JSON.parse(lines[i]) as Line;
    } catch {
      continue;
    }
    if (line.isSidechain) continue;
    const content = line.message?.content;
    if (line.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== 'tool_use' || !block.name) continue;
        if (block.name.startsWith(`mcp__${CHECKLIST_MCP_SERVER}__`)) activity.checklist++;
        else activity.turn++;
      }
    }
    if (line.type !== 'user' || line.isMeta || line.isCompactSummary || line.isVisibleInTranscriptOnly) continue;
    if (typeof content === 'string' || (Array.isArray(content) && !content.some((b) => b.type === 'tool_result'))) break;
  }
  return activity;
}

// フックが標準出力に書く JSON。Stop はターンの終わりを止めて、理由を Claude に渡す。ほかは、文を Claude のコンテキストに足す
export function hookOutput(hookEventName: string, text: string): string {
  if (hookEventName === 'Stop') return JSON.stringify({ decision: 'block', reason: text });
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

// フックの本体。標準入力の JSON を読み、アプリに聞いて、標準出力に書く内容を返す（何も出さないときは空）
export async function runHook(stdin: string, socketPath: string, session: string, timeoutMs: number): Promise<string> {
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return '';
  }
  const name = input.hook_event_name ?? '';
  const event = EVENTS[name];
  if (!event) return '';
  let activity: TurnActivity = { turn: 0, checklist: 0 };
  if (event === 'stop') {
    // 止めたあとの続きは、もう止めない（終われなくなる）
    if (input.stop_hook_active) return '';
    activity = turnActivity(input.transcript_path ? readTail(input.transcript_path) : '');
    // 止めないと分かっているターンは、アプリに聞かない
    if (activity.checklist > 0 || activity.turn === 0) return '';
  }
  const result = await callBridge(socketPath, { session, tool: checklistHookRequest(event), args: activity }, timeoutMs, CHECKLIST_CLOSED_MESSAGE);
  const first = result.content[0];
  const text = !result.isError && first?.type === 'text' ? first.text : '';
  return text ? hookOutput(name, text) : '';
}
