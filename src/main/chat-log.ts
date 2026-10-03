import { readFile } from 'node:fs/promises';
import { isTranscriptEntry, toChatEvents, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import { rememberImage } from './image-cache';
import { parentFirst } from './transcript-tail';

// 会話ログの行（uuid を持つもの）と、その行から作ったイベントの位置
export type ChainEntry = { uuid: string; type: string | undefined; eventStart: number };

// 巻き戻し（/rewind）の後の発言は、途中の発言より前の行を親にして会話ログに追記される（同じファイルの中で枝分かれする）。
// 発言の親が直前の行ではなく、間に発言か応答があれば枝分かれとみなし、捨てるイベントの位置を返す。
// 応答の前に Esc で中断した発言も、会話から外れる（次の発言は、中断した発言より前の行を親にする）。
// 会話の最初の発言を中断したときは、次の発言の親が無い（null）ので、会話の始まりからの枝分かれとみなす
export function branchCut(chain: ChainEntry[], entry: TranscriptEntry): { eventCut: number; chainCut: number } | null {
  const content = entry.message?.content;
  const isPrompt =
    entry.type === 'user' &&
    !entry.isMeta &&
    !entry.isCompactSummary &&
    (typeof content === 'string' || (Array.isArray(content) && !content.some((b) => b.type === 'tool_result')));
  if (!isPrompt || entry.parentUuid === undefined) return null;
  const parent = entry.parentUuid === null ? -1 : chain.findIndex((c) => c.uuid === entry.parentUuid);
  if (parent === -1 && entry.parentUuid !== null) return null;
  const skipped = chain.slice(parent + 1);
  if (!skipped.some((c) => c.type === 'user' || c.type === 'assistant')) return null;
  return { eventCut: skipped[0].eventStart, chainCut: parent + 1 };
}

// 応答が何も来ないうちに Esc で中断すると、Claude Code は発言を会話から外して入力欄に戻す。
// 会話ログには発言の行が残るだけで、中断の行もターンの終わりの行も書かれない（次の発言で、会話から外れたことが分かる）。
// 入力欄に戻った文字（draft）が、まだ応答の無い最後の発言と同じなら、その発言のイベントの位置を返す。
// 空白は画面の折り返しで変わるので、除いて比べる
export function pulledBackPrompt(events: ChatEvent[], draft: string): number | null {
  const typed = draft.replace(/\s/g, '');
  if (!typed) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'user') return event.text.replace(/\s/g, '') === typed ? i : null;
    if (!BEFORE_RESPONSE.has(event.type)) return null;
  }
  return null;
}

// 発言のあと、応答が来る前にも出るイベント（UserPromptSubmit の hooks など）
const BEFORE_RESPONSE = new Set<ChatEvent['type']>(['hook', 'info', 'queue', 'remote-control', 'pr-link', 'ready']);

// 会話ログの行を、親（parentUuid）が先になる順に読む（TranscriptTail と同じ。parentFirst を参照）
export async function readEntries(file: string): Promise<TranscriptEntry[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isTranscriptEntry(entry)) entries.push(entry);
    } catch {
      // 書きかけの行
    }
  }
  return parentFirst(entries, (e) => e);
}

// サブエージェントの会話ログをチャットのイベントにする（タスクの中身の表示用）
export async function readAgentLog(file: string, cwd: string): Promise<ChatEvent[]> {
  return (await readEntries(file)).flatMap((entry) => toChatEvents(entry, cwd, true, rememberImage));
}

// 会話ログ全体をチャットのイベントにする（アーカイブ済みセッションを再開せずに見るため）
export async function readChatLog(file: string, cwd: string): Promise<ChatEvent[]> {
  let events: ChatEvent[] = [];
  let chain: ChainEntry[] = [];
  for (const entry of await readEntries(file)) {
    if (entry.uuid && !entry.isSidechain) {
      const cut = branchCut(chain, entry);
      if (cut) {
        events = events.slice(0, cut.eventCut);
        chain = chain.slice(0, cut.chainCut);
      }
      chain.push({ uuid: entry.uuid, type: entry.type, eventStart: events.length });
    }
    events.push(...toChatEvents(entry, cwd, false, rememberImage));
  }
  // 応答のないまま終わったターンを作業中として扱わない
  return [...events, { type: 'turn-end' }];
}
