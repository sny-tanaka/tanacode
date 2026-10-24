import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { CHECKLIST_HOOK_ENV } from '@shared/chat';
import type { ReminderEvent, TurnActivity } from '@shared/checklist-reminder';
import { CHECKLIST_MCP_SERVER } from '@shared/checklist-tools';
import { CHECKLIST_CLOSED_MESSAGE, CHECKLIST_COMMAND_ENV, CHECKLIST_SCRIPT_ENV, checklistHookRequest, PRECOMPACT_HOOK_REQUEST } from './checklist-bridge';
import { callBridge } from './mcp-bridge';

// Claude にチェックリストを使い続けさせる hooks。アプリが起動する Claude Code に、--settings で足す（statusline.ts の ownSettings）。
// - UserPromptSubmit: 人が発言したら、今のチェックリストを Claude に渡す（発言で計画が変わったら、先にリストを直させる）
// - Stop: ツールを使ったのにチェックリストに触れずにターンを終えようとしたら、アプリに伝える。止めずに（Claude に何も渡さずに）終えさせ、
//   次の発言の知らせ（UserPromptSubmit）で、前のターンの分もリストを直させる（@shared/checklist-reminder の missedTurn）
// - SessionStart（compact）: 会話が圧縮されたら、今のチェックリストを渡す
// 渡す文と、ターンを数えるかどうかは、アプリが決める（@shared/checklist-reminder）。フックは、Claude が使ったツールを会話ログから数えて、アプリに聞く。
// フックは中継の入口（checklist-mcp.js）を --hook 付きで動かす。環境変数は checklistHookEnv（checklist-bridge.ts）が、起動する Claude Code に足す。
// アプリに聞けなかったとき・答えを読めなかったときは、何も出さない（Claude の作業を止めない側に倒す）
//
// 会話ログは、遅れて、起きた順とは限らない順で書かれる（Claude Code 2.1.296 で確かめた）。
// - 応答の行は、その応答（とツール）が終わってから、0.1 秒おきにまとめて書かれる
// - Remote Control 中は、1 行ごとにリモートへの保存を待ってから次の行を書くので、数秒遅れることもある
// - 最初の応答の行を、発言の行（とそれに続く attachment の行）より先に書くことがある（transcript-tail.ts の parentFirst と同じ事情）
// そのため、ターンの終わりのフックが動いた時点で、最後に使ったツールの行がまだ無いことがある。ファイルの終わりから順に数えると、
// チェックリストを直した直後でも「触れていない」と数えたり、ツールを使ったターンを数え損なったりする。そこで、
// - 行の順番ではなく、親（parentUuid）をたどって数える（turnActivity）。最後の応答から、ターンのはじまりまで
// - フックの入力の last_assistant_message（最後の応答の文）と同じ応答が書かれ、そこからターンのはじまりまで親がつながるのを待ってから数える（settledScan）
// - 前のターンの最後の応答と同じ文でも、そのあとにターンが始まっていれば、そろったとしない（このターンの応答がまだ書かれていない）
// - 待ってもそろわなかったときは、そろわなかったことをアプリに伝え、アプリが自分の受けたもの（チャットの stream-json の応答・
//   チェックリストのツールの呼び出し）で確かめる（ChecklistControl の reminder）

// 入口に付けると、中継（MCP サーバー）ではなくフックとして動く
export const CHECKLIST_HOOK_ARG = '--hook';

// 目印の環境変数は、チャットのフックの一覧に出さないためのもの
export const CHECKLIST_HOOK_COMMAND = `${CHECKLIST_HOOK_ENV}=1 ELECTRON_RUN_AS_NODE=1 "$${CHECKLIST_COMMAND_ENV}" "$${CHECKLIST_SCRIPT_ENV}" ${CHECKLIST_HOOK_ARG}`;

// フックが待つ上限（秒）。過ぎたら Claude Code がフックをやめて、そのまま進む
const HOOK_TIMEOUT_SECONDS = 10;

// --settings の hooks に足すもの
export function checklistHooks(): Record<string, unknown[]> {
  const hooks = [{ type: 'command', command: CHECKLIST_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }];
  // PreCompact（auto）: Claude Code の自動の圧縮が始まる前。自動の最適化圧縮がオンなら、止めて、アプリの流れに入る（preCompactBlock）
  return { UserPromptSubmit: [{ hooks }], Stop: [{ hooks }], SessionStart: [{ matcher: 'compact', hooks }], PreCompact: [{ matcher: 'auto', hooks }] };
}

// Claude Code がフックの標準入力に渡す JSON のうち、使うもの。last_assistant_message: 最後の応答の文（Stop。無いこともある）
// trigger: 圧縮の始まり方（PreCompact。auto・manual）
type HookInput = { hook_event_name?: string; stop_hook_active?: boolean; transcript_path?: string; last_assistant_message?: string; trigger?: string };

const EVENTS: Record<string, ReminderEvent> = { UserPromptSubmit: 'prompt', Stop: 'stop', SessionStart: 'compact' };

// 会話ログの終わりから読む大きさ。1 ターンがこれより長ければ、読めた分だけを数える（ツールを使ったことは分かる）
const TAIL_BYTES = 4 * 1024 * 1024;

// 会話ログが最後の応答まで書かれるのを待つ上限と、確かめる間隔。ふつうは 0.1 秒ほどで書かれる。
// 過ぎたら、読めた分で数える（フックの上限の 10 秒に、アプリを待つ 5 秒と合わせて収まる長さにする）
const SETTLE_TIMEOUT_MS = 2000;
const SETTLE_POLL_MS = 25;

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
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  origin?: { kind?: string };
  message?: { content?: string | { type?: string; name?: string; text?: string }[] };
};

// 会話ログから読んだ、このターンのこと。since: ターンのはじまりの時刻（ミリ秒。はじまりまでたどれなければ、たどれたいちばん前の行の時刻。
// 時刻が無ければ null）。settled: 最後の応答（last）が書かれていて、そこからターンのはじまりまで、親がつながっているのを確かめた
export type TurnScan = TurnActivity & { since: number | null; settled: boolean };

// ターンのはじまりの行か。user の行で、ツールの結果でも、Claude Code が足した行（isMeta・圧縮の要約）でもないもの（発言・完了通知など）と、
// 別の Claude（サブエージェント・ほかのセッション）からの知らせ（isMeta で origin が peer。待機中の Claude Code は、これで続きを始める。
// @shared/chat の toChatEvents と同じ見分け方）
function startsTurn(line: Line): boolean {
  if (line.type !== 'user' || line.isCompactSummary || line.isVisibleInTranscriptOnly) return false;
  if (line.isMeta) return line.origin?.kind === 'peer';
  const content = line.message?.content;
  return typeof content === 'string' || (Array.isArray(content) && !content.some((b) => b.type === 'tool_result'));
}

// 応答の行の文。Claude Code が last_assistant_message を作るのと同じく、文のブロックを空白でつなぐ
function textOf(line: Line): string {
  const content = line.message?.content;
  if (line.type !== 'assistant' || !Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join(' ');
}

// 空白の違いを除いて比べるための形
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// このターン（最後の発言のあと）に使ったツールを、会話ログ（JSONL）から数える。
// 最後の応答の行から、親（parentUuid）をたどって、ターンのはじまりの行まで数える。サブエージェントの行は、このつながりに入らない。
// last: 最後の応答の文（フックの入力の last_assistant_message）。あれば、その文の応答（同じ文がいくつもあれば、いちばん新しいもの）から、
// 無ければ（古い Claude Code・文の無い応答）、ファイルのいちばん後ろの行からたどる。
// earlier: その uuid の行が、読んだ範囲（会話ログの終わりの部分。readTail）より前にあるか。前にあるのは、まだ書かれていないのではないので、
// そこまでで数え終える（1 ターンが読んだ範囲より長いとき）
export function turnActivity(transcript: string, last?: string, earlier: (uuid: string) => boolean = () => false): TurnScan {
  const scan: TurnScan = { turn: 0, checklist: 0, since: null, settled: false };
  const lines: Line[] = [];
  for (const text of transcript.split('\n')) {
    if (!text) continue;
    try {
      const line = JSON.parse(text) as Line;
      if (line.uuid && !line.isSidechain) lines.push(line);
    } catch {
      // 書きかけの行
    }
  }
  const byUuid = new Map(lines.map((line) => [line.uuid, line]));
  const wanted = last === undefined ? null : flat(last);
  const answers = wanted === null ? [] : lines.filter((line) => textOf(line) !== '' && flat(textOf(line)) === wanted);
  const newest = answers.reduce<Line | undefined>((a, b) => (a && (a.timestamp ?? '') > (b.timestamp ?? '') ? a : b), undefined);
  const seen = new Set<Line>();
  let first: Line | undefined;
  for (let line: Line | undefined = newest ?? lines[lines.length - 1]; line && !seen.has(line); line = line.parentUuid ? byUuid.get(line.parentUuid) : undefined) {
    seen.add(line);
    first = line;
    const content = line.message?.content;
    if (line.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== 'tool_use' || !block.name) continue;
        if (block.name.startsWith(`mcp__${CHECKLIST_MCP_SERVER}__`)) scan.checklist++;
        else scan.turn++;
      }
    }
    if (startsTurn(line)) break;
  }
  scan.since = (first?.timestamp && Date.parse(first.timestamp)) || null;
  // たどったつながりの外に、それよりあとに始まったターンがあれば、たどったのは前のターンの同じ文の応答（このターンの応答がまだ書かれていない）
  const after = first?.timestamp ?? '';
  const later = !!after && lines.some((line) => !seen.has(line) && (line.timestamp ?? '') > after && startsTurn(line));
  scan.settled = newest !== undefined && first !== undefined && !later && (startsTurn(first) || (!!first.parentUuid && earlier(first.parentUuid)));
  return scan;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

// 会話ログのどこかに、その uuid の行があるか。大きいファイルなので、少しずつ読んで探す
export function hasLine(path: string, uuid: string): boolean {
  const needle = Buffer.from(`"uuid":${JSON.stringify(uuid)}`);
  const chunk = Buffer.alloc(1024 * 1024 + needle.length);
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    // kept: 読んだものの終わりに残した長さ（つなぎ目にまたがるものを見落とさないため）
    for (let position = 0, kept = 0; ; ) {
      const read = readSync(fd, chunk, kept, chunk.length - kept, position);
      if (read === 0) return false;
      const filled = kept + read;
      if (chunk.subarray(0, filled).includes(needle)) return true;
      kept = Math.min(needle.length - 1, filled);
      chunk.copy(chunk, 0, filled - kept, filled);
      position += read;
    }
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// 会話ログが最後の応答（last）まで書かれるのを待って、数える。
// last が無いときは、確かめようがないので、待たずに今あるものを数える（settled は false）。
// そろう前に数えたものは、前のターンのものかもしれない（このターンの行がまだ 1 つも書かれていないとき）ので、そろうまでは何も決めない
export async function settledScan(path: string, last: string | undefined, timeoutMs = SETTLE_TIMEOUT_MS): Promise<TurnScan> {
  const until = Date.now() + timeoutMs;
  let size = fileSize(path);
  // 読んだ範囲に親が無いとき、それより前にあるか。同じ行は 1 回だけ探す（まだ書かれていない行は、書かれれば読んだ範囲に入る）
  const found = new Map<string, boolean>();
  const earlier = (uuid: string) => {
    if (size <= TAIL_BYTES) return false;
    if (!found.has(uuid)) found.set(uuid, hasLine(path, uuid));
    return found.get(uuid) === true;
  };
  const read = () => turnActivity(readTail(path), last, earlier);
  let scan = read();
  while (!scan.settled && last !== undefined && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    // 書き足されたときだけ読み直す
    const now = fileSize(path);
    if (now === size) continue;
    size = now;
    scan = read();
  }
  return scan;
}

// フックが標準出力に書く JSON。どれも、文を Claude のコンテキストに足す（additionalContext）。
// Stop には、今のアプリは文を返さない（ChecklistControl の reminder）。前のバージョンのアプリは、Stop でも文を渡して続けさせていた
// （decision: block は Claude Code 2.1.302 でエラー（hookErrors）になり、ターミナルモードの画面に赤い「Stop hook error」と通知が出るため。
// additionalContext は「Stop hook feedback」として続きを始めさせ、続きのフックの入力には stop_hook_active が付く。2.1.293 からある）
export function hookOutput(hookEventName: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

// フックの本体。標準入力の JSON を読み、アプリに聞いて、標準出力に書く内容を返す（何も出さないときは空）。
// settleMs: 会話ログが最後の応答まで書かれるのを待つ上限（テストでは短くする）
export async function runHook(stdin: string, socketPath: string, session: string, timeoutMs: number, settleMs = SETTLE_TIMEOUT_MS): Promise<string> {
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return '';
  }
  const name = input.hook_event_name ?? '';
  const event = EVENTS[name];
  if (!event) return '';
  let args: Record<string, unknown> = { turn: 0, checklist: 0 };
  if (event === 'stop') {
    // ほかの Stop のフック（人のもの）が止めたあとの続きは、数えない（止める前のターンで数えてある）
    if (input.stop_hook_active || !input.transcript_path) return '';
    const last = typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim() ? input.last_assistant_message : undefined;
    const { turn, checklist, since, settled } = await settledScan(input.transcript_path, last, settleMs);
    // 数えないと分かっているターン（そろった会話ログで、チェックリストに触れた・ツールを使っていない）は、アプリに聞かない。
    // そろわなかったときは、見えているのが前のターンのものかもしれないので、数えたものによらずアプリに聞く
    // （アプリは、チャットなら stream-json で受けた応答から、このターンのツールを数えている。ChecklistControl の reminder）
    if (settled && (checklist > 0 || turn === 0)) return '';
    args = { turn, checklist, since, settled };
  }
  const result = await callBridge(socketPath, { session, tool: checklistHookRequest(event), args }, timeoutMs, CHECKLIST_CLOSED_MESSAGE);
  const first = result.content[0];
  const text = !result.isError && first?.type === 'text' ? first.text : '';
  return text ? hookOutput(name, text) : '';
}

// 圧縮の前のフック（PreCompact）。Claude Code の自動の圧縮（要約）が始まろうとしたとき、アプリに聞いて、
// 自動の最適化圧縮がオンで使えるセッションなら、止める理由を返す（入口が、標準エラーに書いて終了コード 2 で終える。要約は作られず、会話はそのまま続く）。
// 止めないとき（ほかのフック・手動の /compact・オフのセッション・アプリに聞けない）は null
export async function preCompactBlock(stdin: string, socketPath: string, session: string, timeoutMs: number): Promise<string | null> {
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return null;
  }
  if (input.hook_event_name !== 'PreCompact' || input.trigger !== 'auto') return null;
  const result = await callBridge(socketPath, { session, tool: PRECOMPACT_HOOK_REQUEST, args: {} }, timeoutMs, CHECKLIST_CLOSED_MESSAGE);
  const first = result.content[0];
  const text = !result.isError && first?.type === 'text' ? first.text : '';
  return text || null;
}
