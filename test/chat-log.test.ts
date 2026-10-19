import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, TranscriptEntry } from '@shared/chat';
import { branchCut, readAgentLog, readChatLog, readEntries, readExportLog, type ChainEntry } from '../src/main/chat-log';

// 会話ログをチャットのイベントにする（アーカイブしたセッション・書き出し・エージェントの会話）。巻き戻しの枝分かれと、中断で入力欄に戻った発言

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-chat-log-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CWD = '/work';

let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 7, 0, 0, n++)).toISOString();
const user = (uuid: string, parentUuid: string | null | undefined, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid,
  parentUuid,
  timestamp: at(),
  message: { role: 'user', content: text },
  ...extra,
});
const assistant = (uuid: string, parentUuid: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  timestamp: at(),
  message: { id: `msg_${uuid}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
  ...extra,
});
const turnEnd = (uuid: string, parentUuid: string) => ({ type: 'system', subtype: 'turn_duration', uuid, parentUuid, timestamp: at(), durationMs: 1 });

const write = (name: string, ...entries: unknown[]) => {
  const file = join(dir, name);
  writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
  return file;
};
const texts = (events: ChatEvent[]) => events.flatMap((e) => (e.type === 'user' || e.type === 'assistant-text' ? [e.text] : []));

describe('branchCut', () => {
  const chain: ChainEntry[] = [
    { uuid: 'u1', type: 'user', eventStart: 0 },
    { uuid: 'a1', type: 'assistant', eventStart: 1 },
    { uuid: 's1', type: 'system', eventStart: 2 },
    { uuid: 'u2', type: 'user', eventStart: 3 },
    { uuid: 'a2', type: 'assistant', eventStart: 4 },
  ];
  const entry = (e: Record<string, unknown>) => e as TranscriptEntry;

  it('発言の親が直前の行でなく、間に発言か応答があれば、間の行から後を捨てる位置を返す', () => {
    expect(branchCut(chain, entry(user('u3', 'a1', 'やり直し')))).toEqual({ eventCut: 2, chainCut: 2 });
    expect(branchCut(chain, entry(user('u3', 'u1', 'やり直し')))).toEqual({ eventCut: 1, chainCut: 1 });
  });

  it('会話の最初の発言を中断したあとの発言（親が null）は、会話の始まりからの枝分かれ', () => {
    expect(branchCut(chain, entry(user('u3', null, 'やり直し')))).toEqual({ eventCut: 0, chainCut: 0 });
    // まだ何も無ければ、捨てるものは無い
    expect(branchCut([], entry(user('u3', null, 'はじめ')))).toBeNull();
  });

  it('直前の行の続き・間に発言も応答も無い・親が分からない・親の無い行は、枝分かれではない', () => {
    expect(branchCut(chain, entry(user('u3', 'a2', '続き')))).toBeNull();
    expect(branchCut(chain.slice(0, 3), entry(user('u3', 'a1', '続き')))).toBeNull();
    expect(branchCut(chain, entry(user('u3', 'unknown', '続き')))).toBeNull();
    expect(branchCut(chain, entry(user('u3', undefined, '続き')))).toBeNull();
  });

  it('発言でない行（応答・ツールの結果・メタ・圧縮の要約）は、枝分かれの印にしない', () => {
    expect(branchCut(chain, entry(assistant('x', 'u1', '応答')))).toBeNull();
    const toolResult = { ...user('x', 'u1', ''), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } };
    expect(branchCut(chain, entry(toolResult))).toBeNull();
    expect(branchCut(chain, entry(user('x', 'u1', 'メタ', { isMeta: true })))).toBeNull();
    expect(branchCut(chain, entry(user('x', 'u1', '要約', { isCompactSummary: true })))).toBeNull();
    // 画像だけの発言（content が配列で、ツールの結果を含まない）は発言
    const image = { ...user('x', 'u1', ''), message: { role: 'user', content: [{ type: 'image', source: {} }] } };
    expect(branchCut(chain, entry(image))).toEqual({ eventCut: 1, chainCut: 1 });
  });
});

describe('会話ログを読む', () => {
  it('readEntries: 書きかけの行・行でないもの（オブジェクトでない JSON）を飛ばし、親が先になる順に並べる。ファイルが無ければ空', async () => {
    const file = write('a.jsonl', assistant('a1', 'u1', 'はい'), '{"type":"user", "uuid": "書きかけ', '42', user('u1', null, 'はじめ'), '');
    expect((await readEntries(file)).map((e) => e.uuid)).toEqual(['u1', 'a1']);
    expect(await readEntries(join(dir, 'none.jsonl'))).toEqual([]);
  });

  it('readChatLog: 巻き戻しで枝分かれした後の発言だけを残し、最後のターンを終える。サブエージェントの行は出さない', async () => {
    const file = write(
      'b.jsonl',
      user('u1', null, 'はじめ'),
      assistant('a1', 'u1', 'はい'),
      turnEnd('t1', 'a1'),
      user('u2', 't1', '次'),
      assistant('side', 'u2', 'サブエージェント', { isSidechain: true }),
      assistant('a2', 'u2', '了解'),
      user('u3', 'a1', 'やり直し'),
      assistant('a3', 'u3', 'やり直しました'),
    );
    const events = await readChatLog(file, CWD);
    expect(texts(events)).toEqual(['はじめ', 'はい', 'やり直し', 'やり直しました']);
    expect(events.at(-1)).toEqual({ type: 'turn-end' });
  });

  it('readExportLog: 作業したブランチ（本体の行の gitBranch。出てきた順・重なりなし）と、動いている間は最後のターンを終えないイベント', async () => {
    const file = write(
      'c.jsonl',
      user('u1', null, 'はじめ', { gitBranch: 'main' }),
      assistant('a1', 'u1', 'はい', { gitBranch: 'feature/x' }),
      assistant('side', 'u1', 'サブエージェント', { isSidechain: true, gitBranch: 'side' }),
      user('u2', 'a1', '次', { gitBranch: 'main' }),
      assistant('a2', 'u2', 'まだ', { gitBranch: '' }),
    );
    const live = await readExportLog(file, CWD, true);
    expect(live.branches).toEqual(['main', 'feature/x']);
    expect(live.events.at(-1)?.type).toBe('assistant-text');
    const done = await readExportLog(file, CWD, false);
    expect(done.events.at(-1)).toEqual({ type: 'turn-end' });
  });

  it('readChatLog: API の要求の控えと意図して捨てる行は出さない。知らない行は未知のイベントにする', async () => {
    // 控えには、前の発言と応答がもう一度入る（uuid は無い）
    const copy = (role: string, text: string) => ({ type: 'api-request-blob', hash: `h-${text}`, message: { role, content: [{ type: 'text', text }] } });
    const file = write(
      'd.jsonl',
      user('u1', null, 'はじめ'),
      copy('user', 'はじめ'),
      assistant('a1', 'u1', 'はい'),
      copy('assistant', 'はい'),
      { type: 'file-history-snapshot', messageId: 'u1' },
      { type: 'brand-new', uuid: 'n1', parentUuid: 'a1' },
      user('u2', 'a1', '次'),
    );
    const events = await readChatLog(file, CWD);
    expect(texts(events)).toEqual(['はじめ', 'はい', '次']);
    expect(events.filter((e) => e.type === 'unknown-event')).toMatchObject([{ name: 'brand-new', id: 'unknown:n1' }]);
  });

  it('readAgentLog: サブエージェントの会話ログ（行はどれもサイドチェーン）をそのまま出す', async () => {
    const file = write('agent.jsonl', user('u1', null, '調べて', { isSidechain: true }), assistant('a1', 'u1', '調べました', { isSidechain: true }));
    expect(texts(await readAgentLog(file, CWD))).toEqual(['調べて', '調べました']);
  });
});
