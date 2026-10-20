import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retractedUuidsOf, toChatEvents, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import { readChatLog, retract, type ChainEntry } from '../src/main/chat-log';
import { notificationEvent } from '../src/main/stream/notification';
import { PartialText } from '../src/main/stream/partial';
import type { NotificationMessage, StreamEventMessage } from '../src/main/stream/protocol';
import { unreadableStreamLines } from './scenario';

// チャットのお知らせ（Claude Code の警告・モデルの切り替え・断られた応答の取り直し・メモリ）。
// モデルの切り替えと取り直しの行は、本物の Claude Code 2.1.302 をモックの API につないで録ったもの
// （test/fixtures/claude-code-events/2.1.302/。スキル /claude-code-events の scripts/record.mjs の場面 refusal-fallback・model-fallback で録り、
// アプリが読まない大きな行（システムプロンプト・一覧の添付・API の要求の控えなど）を除いた）。
// - refusal-fallback: Opus 5.5 が 2 回断る（文とツールの呼び出しのある応答）→ 1 回目は同じモデルで取り直し（断った応答は残る）→
//   2 回目は取り消して、Opus 4.8 で取り直す（_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1。別のモデルへの取り直しは、Anthropic の API のときだけ）
// - model-fallback: Opus 5.5 が混み合い（529 を 3 回）、--fallback-model の Sonnet 5.5 に切り替える
// メモリ（memory_saved・relevant_memories）は録れなかった（自動のメモリを使う設定が要る）ので、2.1.302 の本体のコードの形で組み立てた

const FIXTURES = join(__dirname, 'fixtures', 'claude-code-events', '2.1.302');
const CWD = '/tmp/tanacode-cli/work';

const readLines = (scenario: string, file: 'stream.jsonl' | 'transcript.jsonl') =>
  readFileSync(join(FIXTURES, scenario, file), 'utf8').split('\n').filter(Boolean);
const transcript = (scenario: string) => readLines(scenario, 'transcript.jsonl').map((l) => JSON.parse(l) as TranscriptEntry);
const stream = (scenario: string) => readLines(scenario, 'stream.jsonl').map((l) => JSON.parse(l) as Record<string, unknown>);
const system = (subtype: string, extra: Record<string, unknown> = {}): TranscriptEntry => ({ type: 'system', subtype, uuid: 's1', ...extra });

describe('モデルの切り替え（model_fallback）', () => {
  it('会話ログの行から「X から Y に切り替えました」を警告の色で出し、開くと Claude Code の説明が読める', () => {
    const row = transcript('model-fallback').find((e) => e.subtype === 'model_fallback')!;
    expect(toChatEvents(row, CWD)).toEqual([
      { type: 'info', id: row.uuid, text: 'モデルを Opus 5.5 から Sonnet 5.5 に切り替えました', detail: 'Switched to Sonnet 5.5 due to high demand for Opus 5.5', warning: true },
    ]);
  });

  it('stream にも同じ行が出るが、チャットには会話ログからの 1 回だけ出す（stream の行は形だけを確かめる）', () => {
    const lines = readLines('model-fallback', 'stream.jsonl');
    expect(unreadableStreamLines(lines)).toEqual({ malformed: 0, unknown: {} });
    const streamed = stream('model-fallback').find((v) => v.subtype === 'model_fallback')!;
    const logged = transcript('model-fallback').find((e) => e.subtype === 'model_fallback')!;
    expect(streamed.uuid).toBe(logged.uuid);
  });

  it('読めないモデルの ID はそのまま出し、モデルが分からなければ決まった文。説明が無ければ開けない', () => {
    expect(toChatEvents(system('model_fallback', { originalModel: 'my-model', fallbackModel: 'claude-sonnet-5-5' }), CWD)).toEqual([
      { type: 'info', id: 's1', text: 'モデルを my-model から Sonnet 5.5 に切り替えました', warning: true },
    ]);
    expect(toChatEvents(system('model_fallback', { content: '  理由  ' }), CWD)).toEqual([{ type: 'info', id: 's1', text: 'モデルを切り替えました', detail: '理由', warning: true }]);
  });
});

describe('断られた応答の取り直し（model_refusal_fallback）', () => {
  it('会話ログの行から「X が応答を断ったので、Y で取り直しました」を出し、開くと Claude Code の説明（断られた種類つき）が読める', () => {
    const row = transcript('refusal-fallback').find((e) => e.subtype === 'model_refusal_fallback')!;
    const [event] = toChatEvents(row, CWD);
    expect(event).toMatchObject({ type: 'info', id: row.uuid, text: 'Opus 5.5 が応答を断ったので、Opus 4.8 で取り直しました', warning: true });
    expect(event.type === 'info' && event.detail).toContain('Details: `[cyber]`');
    expect(toChatEvents(system('model_refusal_fallback'), CWD)).toEqual([{ type: 'info', id: 's1', text: '断られた応答を、別のモデルで取り直しました', warning: true }]);
  });

  it('取り消された応答（ツールを実行したものも）は会話ログに書かれない。チャットには、残った応答・お知らせ・取り直した答えが出る', async () => {
    const entries = transcript('refusal-fallback');
    const retracted = retractedUuidsOf(entries.find((e) => e.subtype === 'model_refusal_fallback')!);
    // 2 回目の応答の文・ツールの呼び出し・その結果（stream には出た）
    expect(retracted).toHaveLength(3);
    expect(entries.filter((e) => retracted.includes(e.uuid!))).toEqual([]);
    const streamed = stream('refusal-fallback');
    expect(retracted.every((uuid) => streamed.some((v) => v.uuid === uuid))).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'tanacode-notices-'));
    try {
      const file = join(dir, 'log.jsonl');
      writeFileSync(file, `${readLines('refusal-fallback', 'transcript.jsonl').join('\n')}\n`);
      const chat = (await readChatLog(file, CWD)).map(brief);
      expect(chat).toEqual([
        'user:こんにちは',
        // 1 回目に断った応答は、同じモデルで取り直すので残る（TUI も出す）
        'assistant-text:書きかけの文です。これは取り消されるはず',
        'tool-use:Bash',
        'tool-result:toolu_msg_1',
        "info:Opus 5.5's safeguards stopped the response above · continuing once with that noted",
        'info:Opus 5.5 が応答を断ったので、Opus 4.8 で取り直しました',
        'assistant-text:答えです。',
        'turn-end',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('取り消された応答が会話ログに書かれていても、チャットから外す（Claude Code も、会話を再開するときに外す）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanacode-notices-'));
    try {
      const file = join(dir, 'log.jsonl');
      const lines = [
        { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: '調べて' } },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '断られる文' }] } },
        { type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } },
        { type: 'user', uuid: 'r1', parentUuid: 'a2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] } },
        { type: 'system', subtype: 'model_refusal_fallback', uuid: 'f1', parentUuid: 'u1', originalModel: 'claude-opus-5-5', fallbackModel: 'claude-opus-4-8', retractedMessageUuids: ['a1', 'a2', 'r1'] },
        { type: 'assistant', uuid: 'a3', parentUuid: 'f1', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '取り直した答え' }] } },
      ];
      writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      expect((await readChatLog(file, CWD)).map(brief)).toEqual(['user:調べて', 'info:Opus 5.5 が応答を断ったので、Opus 4.8 で取り直しました', 'assistant-text:取り直した答え', 'turn-end']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retract: 取り消された行のイベントを外し、あとの行のイベントの位置をずらす。外す行が無ければ null', () => {
    const info = (id: string): ChatEvent => ({ type: 'info', id, text: id });
    const events = [info('head'), info('a'), info('b1'), info('b2'), info('c')];
    const chain: ChainEntry[] = [
      { uuid: 'a', type: 'assistant', eventStart: 1 },
      { uuid: 'b', type: 'assistant', eventStart: 2 },
      { uuid: 'c', type: 'user', eventStart: 4 },
    ];
    expect(retract(chain, events, ['b'])).toEqual({
      chain: [
        { uuid: 'a', type: 'assistant', eventStart: 1 },
        { uuid: 'c', type: 'user', eventStart: 2 },
      ],
      events: [info('head'), info('a'), info('c')],
    });
    expect(retract(chain, events, ['zzz'])).toBeNull();
    expect(retract([], [], ['a'])).toBeNull();
  });

  it('retractedUuidsOf: model_refusal_fallback の行の、文字の uuid だけ', () => {
    expect(retractedUuidsOf(system('model_refusal_fallback', { retractedMessageUuids: ['a', '', 3, 'b'] }))).toEqual(['a', 'b']);
    expect(retractedUuidsOf(system('model_refusal_fallback', { retractedMessageUuids: 'a' }))).toEqual([]);
    expect(retractedUuidsOf(system('model_fallback', { retractedMessageUuids: ['a'] }))).toEqual([]);
    expect(retractedUuidsOf({ type: 'assistant', subtype: 'model_refusal_fallback', retractedMessageUuids: ['a'] })).toEqual([]);
  });

  it('stream の行は、どれも読める（知らない種類・形の違う行が無い）。取り消された応答の uuid の形が違えば、読めない行', () => {
    expect(unreadableStreamLines(readLines('refusal-fallback', 'stream.jsonl'))).toEqual({ malformed: 0, unknown: {} });
    const line = (extra: Record<string, unknown>) => JSON.stringify({ type: 'system', subtype: 'model_refusal_fallback', uuid: 'f', ...extra });
    expect(unreadableStreamLines([line({}), line({ retracted_message_uuids: [] })])).toEqual({ malformed: 0, unknown: {} });
    expect(unreadableStreamLines([line({ retracted_message_uuids: 'a' }), line({ retracted_message_uuids: [1] })])).toEqual({ malformed: 2, unknown: {} });
  });
});

describe('書いている途中の文から、取り消された応答を外す（PartialText の drop）', () => {
  const event = (value: StreamEventMessage['event']): StreamEventMessage => ({ type: 'stream_event', event: value, parent_tool_use_id: null, uuid: 'u', session_id: 's' });
  const draft = (partial: PartialText, id: string, text: string) => {
    partial.event(event({ type: 'message_start', message: { id } }));
    partial.event(event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    partial.event(event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
    partial.event(event({ type: 'content_block_stop', index: 0 }));
  };

  it('取り消された応答のブロックだけを外す。外すものが無ければ false', () => {
    const partial = new PartialText();
    draft(partial, 'kept', '残る');
    draft(partial, 'refused', '断られた');
    expect(partial.drop(['refused', 'unknown'])).toBe(true);
    expect(partial.view()).toEqual([{ id: 'kept:0', kind: 'text', text: '残る' }]);
    expect(partial.drop(['refused'])).toBe(false);
    expect(partial.drop([])).toBe(false);
  });
});

describe('メモリ（relevant_memories・memory_saved）', () => {
  const memory = (path: string) => ({ path, content: '本文', mtimeMs: 1, header: `Memory: ${path}` });

  it('思い出したメモリは「メモリを N 件思い出しました」。開くとファイルの名前が読める（中身は出さない）', () => {
    const recalled: TranscriptEntry = {
      type: 'attachment',
      uuid: 'm1',
      attachment: { type: 'relevant_memories', memories: [memory('/home/u/.claude/projects/p/memory/build.md'), memory('/home/u/.claude/projects/p/memory/style.md')] },
    };
    expect(toChatEvents(recalled, CWD)).toEqual([{ type: 'info', id: 'm1', text: 'メモリを 2 件思い出しました', detail: 'build.md\nstyle.md' }]);
    // 空のものは出さない
    expect(toChatEvents({ type: 'attachment', uuid: 'm2', attachment: { type: 'relevant_memories', memories: [] } }, CWD)).toEqual([]);
  });

  it('思い出したメモリの形が違えば（一覧が無い・パスでないものが混じる）、黙って捨てずに未知のイベント（形の崩れ）として出す', () => {
    const malformed = { type: 'unknown-event', name: 'attachment/relevant_memories', problem: 'malformed', source: 'transcript' };
    expect(toChatEvents({ type: 'attachment', uuid: 'm3', attachment: { type: 'relevant_memories' } }, CWD)).toEqual([expect.objectContaining(malformed)]);
    expect(toChatEvents({ type: 'attachment', uuid: 'm4', attachment: { type: 'relevant_memories', memories: [memory('/m/build.md'), { path: 3 }] } }, CWD)).toEqual([
      expect.objectContaining(malformed),
    ]);
    expect(toChatEvents({ type: 'attachment', uuid: 'm5', attachment: { type: 'relevant_memories', memories: [null] } }, CWD)).toEqual([expect.objectContaining(malformed)]);
  });

  it('保存したメモリは「メモリを N 件保存しました」。開くとファイルの名前が読める', () => {
    expect(toChatEvents(system('memory_saved', { writtenPaths: ['/home/u/.claude/projects/p/memory/build.md'], teamCount: 0 }), CWD)).toEqual([
      { type: 'info', id: 's1', text: 'メモリを 1 件保存しました', detail: 'build.md' },
    ]);
    expect(toChatEvents(system('memory_saved', { writtenPaths: [] }), CWD)).toEqual([]);
  });

  it('保存したメモリの形が違えば（一覧が無い・パスでないものが混じる）、黙って捨てずに未知のイベント（形の崩れ）として出す', () => {
    const malformed = { type: 'unknown-event', name: 'system/memory_saved', problem: 'malformed', source: 'transcript' };
    expect(toChatEvents(system('memory_saved'), CWD)).toEqual([expect.objectContaining(malformed)]);
    expect(toChatEvents(system('memory_saved', { writtenPaths: '/m/build.md' }), CWD)).toEqual([expect.objectContaining(malformed)]);
    expect(toChatEvents(system('memory_saved', { writtenPaths: ['/m/build.md', ''] }), CWD)).toEqual([expect.objectContaining(malformed)]);
  });
});

describe('Claude Code の警告（system/notification）', () => {
  const notification = (key: string, extra: Partial<NotificationMessage> = {}): NotificationMessage => ({
    type: 'system',
    subtype: 'notification',
    key,
    text: `${key} の文`,
    priority: 'high',
    uuid: 'n1',
    ...extra,
  });

  it('文をそのままお知らせにする。警告・エラーの色のものは警告の色で出す', () => {
    // 起動時のエフォートの上限（2.1.302 の本体の形）
    expect(notificationEvent(notification('model-effort-cap', { text: ' Effort xhigh is not available · using high ', color: 'warning' }))).toEqual({
      type: 'info',
      id: 'notification:n1',
      text: 'Effort xhigh is not available · using high',
      warning: true,
    });
    expect(notificationEvent(notification('fast-mode-overage-rejected', { color: 'error' }))?.warning).toBe(true);
    expect(notificationEvent(notification('plugin-reload-pending', { color: 'suggestion' }))).toEqual({ type: 'info', id: 'notification:n1', text: 'plugin-reload-pending の文' });
    // 知らない key も出す。uuid の無い行は、毎回違う ID にする
    const a = notificationEvent(notification('brand-new', { uuid: undefined }));
    const b = notificationEvent(notification('brand-new', { uuid: undefined }));
    expect(a?.id).toMatch(/^notification:/);
    expect(a?.id).not.toBe(b?.id);
  });

  it('ほかの道で出しているもの・tanacode 自身が起こしたもの・一時的なもの・空の文は出さない', () => {
    for (const key of ['stop-hook-error', 'stop-hook-block-cap', 'error-compacting-conversation', 'compaction-blocked-by-hook', 'remote-tool-status-t1', 'remote-tool-notice-t1']) {
      expect(notificationEvent(notification(key)), key).toBeNull();
    }
    expect(notificationEvent(notification('memory-paused', { text: '  ' }))).toBeNull();
  });

  it('key と文の無い行は、読めない行として数える', () => {
    const line = (extra: Record<string, unknown>) => JSON.stringify({ type: 'system', subtype: 'notification', ...extra });
    expect(unreadableStreamLines([line({ key: 'k', text: 't', priority: 'low' })])).toEqual({ malformed: 0, unknown: {} });
    expect(unreadableStreamLines([line({ key: 'k' }), line({ text: 't' })])).toEqual({ malformed: 2, unknown: {} });
    // 思い出したメモリ（stream にも出るが、チャットには会話ログの relevant_memories から出す）は、受け取るだけ
    expect(unreadableStreamLines([JSON.stringify({ type: 'system', subtype: 'memory_recall', mode: 'select', memories: [] })])).toEqual({ malformed: 0, unknown: {} });
  });
});

// イベントを短い文字にする（並びを見るため）
function brief(event: ChatEvent): string {
  switch (event.type) {
    case 'user':
    case 'assistant-text':
    case 'info':
      return `${event.type}:${event.text}`;
    case 'tool-use':
      return `tool-use:${event.name}`;
    case 'tool-result':
      return `tool-result:${event.id}`;
    default:
      return event.type;
  }
}
