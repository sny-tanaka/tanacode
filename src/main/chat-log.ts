import { readFile } from 'node:fs/promises';
import { isTranscriptEntry, toChatEvents, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import { rememberImage } from './image-cache';

// 会話ログの行（uuid を持つもの）と、その行から作ったイベントの位置
export type ChainEntry = { uuid: string; type: string | undefined; eventStart: number };

// 巻き戻し（/rewind）の後の発言は、途中の発言より前の行を親にして会話ログに追記される（同じファイルの中で枝分かれする）。
// 発言の親が直前の行ではなく、間に発言か応答があれば枝分かれとみなし、捨てるイベントの位置を返す
export function branchCut(chain: ChainEntry[], entry: TranscriptEntry): { eventCut: number; chainCut: number } | null {
  const content = entry.message?.content;
  const isPrompt =
    entry.type === 'user' &&
    !entry.isMeta &&
    !entry.isCompactSummary &&
    (typeof content === 'string' || (Array.isArray(content) && !content.some((b) => b.type === 'tool_result')));
  if (!isPrompt || !entry.parentUuid) return null;
  const parent = chain.findIndex((c) => c.uuid === entry.parentUuid);
  if (parent === -1) return null;
  const skipped = chain.slice(parent + 1);
  if (!skipped.some((c) => c.type === 'user' || c.type === 'assistant')) return null;
  return { eventCut: skipped[0].eventStart, chainCut: parent + 1 };
}

// サブエージェントの会話ログをチャットのイベントにする（タスクの中身の表示用）
export async function readAgentLog(file: string, cwd: string): Promise<ChatEvent[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const events: ChatEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isTranscriptEntry(entry)) events.push(...toChatEvents(entry, cwd, true, rememberImage));
    } catch {
      // 書きかけの行
    }
  }
  return events;
}

// 会話ログ全体をチャットのイベントにする（アーカイブ済みセッションを再開せずに見るため）
export async function readChatLog(file: string, cwd: string): Promise<ChatEvent[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  let events: ChatEvent[] = [];
  let chain: ChainEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isTranscriptEntry(entry)) continue;
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
