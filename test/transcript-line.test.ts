import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import { classifyLine, conversationOf, knownOf } from '@shared/transcript-line';

// 会話ログの行の種類の分け方（@shared/transcript-line）。会話ログを読むところは、ここで 1 回だけ分けて、読み手には要る種類だけを渡す

const kind = (entry: TranscriptEntry) => classifyLine(entry).kind;

describe('classifyLine', () => {
  it('発言・応答・system・attachment は会話の行', () => {
    for (const type of ['user', 'assistant', 'system', 'attachment']) expect(kind({ type })).toBe('conversation');
  });

  it('名前・順番待ち・権限モード・Remote Control・PR へのリンクは、ほかで使う付帯の行', () => {
    for (const type of ['custom-title', 'ai-title', 'queue-operation', 'permission-mode', 'bridge-session', 'pr-link']) expect(kind({ type })).toBe('side');
  });

  it('API の要求の控え（2.1.301 から。前の tool_use・tool_result の写しが入る）と、Claude Code が自分で使う付帯情報は、意図して捨てる行', () => {
    const copy = { type: 'api-request-blob', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Async agent launched' }] } } as TranscriptEntry;
    expect(kind(copy)).toBe('ignored');
    for (const type of ['api-request', 'api-request-shape', 'mode', 'atis-latch', 'last-prompt', 'file-history-snapshot', 'worktree-state', 'summary']) expect(kind({ type })).toBe('ignored');
  });

  it('知らない種類と種類の欄の無い行は、名前と、知らない・形が違うのわけを付けて、知らない行', () => {
    expect(classifyLine({ type: 'brand-new' })).toMatchObject({ kind: 'unknown', name: 'brand-new', problem: 'unknown' });
    expect(classifyLine({ uuid: 'x1' })).toMatchObject({ kind: 'unknown', name: '', problem: 'malformed' });
    expect(classifyLine({ type: 3 } as unknown as TranscriptEntry)).toMatchObject({ kind: 'unknown', name: '', problem: 'malformed' });
  });

  it('conversationOf・knownOf: 渡してよい行だけを返す', () => {
    const user: TranscriptEntry = { type: 'user', uuid: 'u1' };
    const title: TranscriptEntry = { type: 'custom-title', customTitle: '名前' };
    const copy = { type: 'api-request-blob' } as TranscriptEntry;
    expect([user, title, copy, { type: 'brand-new' }].map(conversationOf)).toEqual([user, null, null, null]);
    expect([user, title, copy, { type: 'brand-new' }].map(knownOf)).toEqual([user, title, null, null]);
  });
});

// 本物の Claude Code から取った控え（test/fixtures/claude-code/<バージョン>/transcript.jsonl）の行は、どれも知っている
describe('控えの会話ログの行の種類', () => {
  const dir = join(__dirname, 'fixtures', 'claude-code');
  const versions = existsSync(dir) ? readdirSync(dir) : [];
  it.each(versions)('Claude Code %s: 知らない行が無い', (version) => {
    const entries = readFileSync(join(dir, version, 'transcript.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TranscriptEntry);
    expect(entries.map(classifyLine).filter((line) => line.kind === 'unknown')).toEqual([]);
    // 会話の行の uuid と parentUuid でつながる（ほかの種類の行には uuid が無い。巻き戻しの見分けは、会話の行だけで足りる）
    expect(entries.filter((e) => e.uuid && kind(e) !== 'conversation')).toEqual([]);
  });
});
