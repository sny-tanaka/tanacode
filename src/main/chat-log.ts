import { readFile } from 'node:fs/promises';
import { isTranscriptEntry, lineChatEvents, retractedUuidsOf, toChatEvents, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import { classifyLine } from '@shared/transcript-line';
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
  const entries = withoutForkContext(await readEntries(file), await forkToolUseId(file));
  return entries.flatMap((entry) => toChatEvents(entry, cwd, true, rememberImage));
}

// フォーク（subagent_type: fork）なら、そのエージェントを起こした Agent の呼び出しの ID（会話ログの隣の agent-<ID>.meta.json）。
// フォークでない・読めなければ null
async function forkToolUseId(file: string): Promise<string | null> {
  const meta = await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')
    .then((text) => JSON.parse(text) as { isFork?: unknown; agentType?: unknown; toolUseId?: unknown })
    .catch(() => null);
  if (!meta || (meta.isFork !== true && meta.agentType !== 'fork')) return null;
  return typeof meta.toolUseId === 'string' && meta.toolUseId ? meta.toolUseId : null;
}

// フォークの会話ログは、親の作業から始まる: 親の会話の写し（サブエージェントからのフォークだけ。本体からのフォークは fork-context-ref の 1 行）
// → そのエージェントを起こした Agent の呼び出し → その結果と、Claude Code がフォークに渡す決まりの文（<fork-boilerplate>）と指示
// （「Your directive: …」）の発言。フォーク自身の会話は、その発言の指示から始める（決まりの文と、起動の結果は出さない）
export function withoutForkContext(entries: TranscriptEntry[], toolUseId: string | null): TranscriptEntry[] {
  if (!toolUseId) return entries;
  const at = entries.findIndex((e) => e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'tool_use' && b.id === toolUseId));
  if (at === -1) return entries;
  return entries.slice(at + 1).map((entry) => {
    const content = entry.type === 'user' && Array.isArray(entry.message?.content) ? entry.message.content : null;
    if (!content?.some((b) => b.type === 'tool_result' && b.tool_use_id === toolUseId)) return entry;
    const kept = content
      .filter((b) => !(b.type === 'tool_result' && b.tool_use_id === toolUseId))
      .map((b) => (b.type === 'text' && typeof b.text === 'string' && b.text.includes('<fork-boilerplate>') ? { ...b, text: b.text.split('Your directive: ').slice(1).join('Your directive: ').trim() } : b))
      .filter((b) => !(b.type === 'text' && !b.text));
    return { ...entry, message: { ...entry.message, content: kept } };
  });
}

// 会話ログの行から作った今の状態のイベント（Remote Control のつながり・PR へのリンク）のうち、前の同じ種類のもの（before と、
// events のその前）と同じもの。Claude Code はこれらの行を 1 本の会話ログに数百回書き足す（bridge-session は lastSequenceNum だけ
// 違う）ので、同じものは積まない（画面は最後のものを使う。同じものを当て直しても変わらない）
const LOGGED_STATES = new Set<ChatEvent['type']>(['remote-control', 'pr-link']);
export function withoutRepeatedState(before: ChatEvent[], events: ChatEvent[]): ChatEvent[] {
  if (!events.some((e) => LOGGED_STATES.has(e.type))) return events;
  const kept: ChatEvent[] = [];
  for (const event of events) {
    if (LOGGED_STATES.has(event.type)) {
      const last = lastOfType(kept, event.type) ?? lastOfType(before, event.type);
      if (last && JSON.stringify(last) === JSON.stringify(event)) continue;
    }
    kept.push(event);
  }
  return kept;
}

function lastOfType(events: ChatEvent[], type: ChatEvent['type']): ChatEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return events[i];
  return undefined;
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
    // 巻き戻しと取り消しは、会話の行（@shared/transcript-line）で見る（uuid でつながるのは会話の行だけ）
    const line = classifyLine(entry);
    const conversation = line.kind === 'conversation' ? line.entry : null;
    if (conversation?.uuid && !conversation.isSidechain) {
      const cut = branchCut(chain, conversation);
      if (cut) {
        events = events.slice(0, cut.eventCut);
        chain = chain.slice(0, cut.chainCut);
      }
      chain.push({ uuid: conversation.uuid, type: conversation.type, eventStart: events.length });
    }
    const retracted = conversation && retract(chain, events, retractedUuidsOf(conversation));
    if (retracted) ({ chain, events } = retracted);
    events.push(...withoutRepeatedState(events, lineChatEvents(line, cwd, false, rememberImage)));
  }
  // 応答のないまま終わったターンを作業中として扱わない
  return endTurn ? [...events, { type: 'turn-end' }] : events;
}
