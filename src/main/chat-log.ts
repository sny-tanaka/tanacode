import { readFile } from 'node:fs/promises';
import { isTranscriptEntry, retractedUuidsOf, toChatEvents, type ChatEvent, type TranscriptEntry } from '@shared/chat';
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

// 取り消された応答の行（uuids。model_refusal_fallback の retractedMessageUuids と、会話ログに書かれてから消された行）から作ったイベントを外す。
// 外した行は chain からも外し、あとの行のイベントの位置をずらす。外す行が無ければ null
export function retract(chain: ChainEntry[], events: ChatEvent[], uuids: string[]): { chain: ChainEntry[]; events: ChatEvent[] } | null {
  const dropped = new Set(uuids);
  if (!chain.some((c) => dropped.has(c.uuid))) return null;
  // 最初の行より前のイベント（uuid の無い行から作ったもの）は残す
  const kept = events.slice(0, chain[0].eventStart);
  const rest: ChainEntry[] = [];
  chain.forEach((c, i) => {
    if (dropped.has(c.uuid)) return;
    rest.push({ ...c, eventStart: kept.length });
    kept.push(...events.slice(c.eventStart, chain[i + 1]?.eventStart ?? events.length));
  });
  return { chain: rest, events: kept };
}

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
  return chatEventsOf(await readEntries(file), cwd);
}

// 作業の書き出しの材料。チャットのイベントと、作業したブランチ（会話ログの行の gitBranch。出てきた順・重なりなし）。
// live: Claude Code が動いている。作業の途中なら、結果を待っているツールは実行中のまま（中断にしない）
export async function readExportLog(file: string, cwd: string, live: boolean): Promise<{ events: ChatEvent[]; branches: string[] }> {
  const entries = await readEntries(file);
  const branches = [...new Set(entries.filter((e) => !e.isSidechain).map((e) => e.gitBranch).filter((b): b is string => typeof b === 'string' && b !== ''))];
  return { events: chatEventsOf(entries, cwd, !live), branches };
}

function chatEventsOf(entries: TranscriptEntry[], cwd: string, endTurn = true): ChatEvent[] {
  let events: ChatEvent[] = [];
  let chain: ChainEntry[] = [];
  for (const entry of entries) {
    if (entry.uuid && !entry.isSidechain) {
      const cut = branchCut(chain, entry);
      if (cut) {
        events = events.slice(0, cut.eventCut);
        chain = chain.slice(0, cut.chainCut);
      }
      chain.push({ uuid: entry.uuid, type: entry.type, eventStart: events.length });
    }
    const retracted = retract(chain, events, retractedUuidsOf(entry));
    if (retracted) ({ chain, events } = retracted);
    events.push(...toChatEvents(entry, cwd, false, rememberImage));
  }
  // 応答のないまま終わったターンを作業中として扱わない
  return endTurn ? [...events, { type: 'turn-end' }] : events;
}
