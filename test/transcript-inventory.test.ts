import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import { InventoryBuilder, mergeInventories, type Inventory } from './transcript-inventory';
import { missingUsedFields, USED_FIELDS } from './transcript-used-fields';

// Claude Code が書いた行の目録（test/transcript-inventory.ts）と、2 つの目録の比べ方（scripts/inventory-diff.mjs）

const CWD = '/work';

describe('InventoryBuilder', () => {
  it('会話ログ: 行・content のブロック・ツールの結果ごとに、出たフィールドを並べる。意図して捨てる行は種類だけ', () => {
    const builder = new InventoryBuilder();
    const entries: TranscriptEntry[] = [
      { type: 'user', uuid: 'u1', message: { content: '頼み' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} }] } },
      { type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, toolUseResult: { filePath: '/work/a', structuredPatch: [] } },
      // 呼び出しの見つからない結果・文字の結果
      { type: 'user', uuid: 'u3', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'x' }] }, toolUseResult: 'Error: x' },
      { type: 'system', subtype: 'turn_duration', uuid: 's1', durationMs: 1 } as TranscriptEntry,
      { type: 'attachment', uuid: 'at1', attachment: { type: 'hook_success', hookEvent: 'Stop' } },
      { type: 'custom-title', customTitle: '名前' },
      { type: 'api-request-blob', hash: 'h', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } } as TranscriptEntry,
    ];
    builder.addTranscript(entries, CWD);
    expect(builder.result().transcript).toEqual({
      'api-request-blob': [],
      'assistant': ['message', 'message.content', 'message.id', 'type', 'uuid'],
      'assistant.content/tool_use': ['id', 'input', 'name', 'type'],
      'attachment/hook_success': ['attachment', 'attachment.hookEvent', 'attachment.type', 'type', 'uuid'],
      'custom-title': ['customTitle', 'type'],
      'system/turn_duration': ['durationMs', 'subtype', 'type', 'uuid'],
      'toolUseResult/(unknown tool)': ['(string)'],
      'toolUseResult/Edit': ['filePath', 'structuredPatch'],
      'user': ['message', 'message.content', 'toolUseResult', 'type', 'uuid'],
      'user.content/tool_result': ['content', 'tool_use_id', 'type'],
    });
    expect(builder.unknown.size).toBe(0);
  });

  it('知らない種類（行・system の行・attachment・ブロック）を、チャットの組み立てと同じ名前で数える。本体の会話ログのサブエージェントの行も見る', () => {
    const builder = new InventoryBuilder();
    builder.addTranscript(
      [
        { type: 'brand-new', uuid: 'n1' },
        { uuid: 'x1' },
        { type: 'system', subtype: 'brand_new_notice', uuid: 's1' },
        { type: 'attachment', uuid: 'at1', attachment: { type: 'max_turns_reached' } },
        { type: 'assistant', uuid: 'a1', isSidechain: true, message: { content: [{ type: 'server_tool_use' }] } },
      ],
      CWD,
    );
    expect(Object.fromEntries(builder.unknown)).toEqual({ 'brand-new': 1, '': 1, 'system/brand_new_notice': 1, 'attachment/max_turns_reached': 1, 'assistant/server_tool_use': 1 });
    expect(Object.keys(builder.result().transcript)).toEqual(['(no type)', 'assistant', 'assistant.content/server_tool_use', 'attachment/max_turns_reached', 'brand-new', 'system/brand_new_notice']);
  });

  it('stream-json: 種類（system・result は subtype、制御の要求と返事は subtype、stream_event はイベントの type）と、いちばん上と中のキー', () => {
    const builder = new InventoryBuilder();
    builder.addStream([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'assistant', message: { id: 'm', content: [] }, uuid: 'a' }),
      JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash' } }),
      JSON.stringify({ type: 'control_response', response: { subtype: 'success' } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: {} } }),
      JSON.stringify({ type: 'result', subtype: 'success' }),
      'JSON でない',
      '[1]',
    ]);
    expect(builder.result().stream).toEqual({
      'assistant': ['message', 'message.content', 'message.id', 'type', 'uuid'],
      'control_request/can_use_tool': ['request', 'request.subtype', 'request.tool_name', 'request_id', 'type'],
      'control_response/success': ['response', 'type'],
      'result/success': ['subtype', 'type'],
      'stream_event/message_start': ['event', 'event.message', 'event.type', 'type'],
      'system/init': ['session_id', 'subtype', 'type'],
    });
  });

  it('mergeInventories: 種類とフィールドを合わせ、並べ直す', () => {
    const a: Inventory = { transcript: { user: ['uuid', 'type'] }, stream: {} };
    const b: Inventory = { transcript: { user: ['message'], 'system/init': [] }, stream: { result: ['type'] } };
    expect(mergeInventories([a, b])).toEqual({ transcript: { 'system/init': [], user: ['message', 'type', 'uuid'] }, stream: { result: ['type'] } });
  });

  it('台本の名前を添えると、種類ごとに出た台本を sources に載せ、合わせるときもまとめる', () => {
    const builder = new InventoryBuilder();
    builder.addTranscript([{ type: 'custom-title', customTitle: '名前' }], CWD);
    builder.addStream([JSON.stringify({ type: 'result', subtype: 'success' })]);
    const basic = builder.result('basic.test.ts');
    expect(basic.sources).toEqual({ transcript: { 'custom-title': ['basic.test.ts'] }, stream: { 'result/success': ['basic.test.ts'] } });
    const other: Inventory = { transcript: { 'custom-title': ['type'] }, stream: {}, sources: { transcript: { 'custom-title': ['session.test.ts'] }, stream: {} } };
    expect(mergeInventories([basic, other]).sources).toEqual({ transcript: { 'custom-title': ['basic.test.ts', 'session.test.ts'] }, stream: { 'result/success': ['basic.test.ts'] } });
  });
});

describe('missingUsedFields', () => {
  it('目録に無い、tanacode が読むフィールドと種類を返す', () => {
    const { user: _, ...rest } = USED_FIELDS;
    expect(missingUsedFields({ transcript: { ...USED_FIELDS }, stream: {} })).toEqual([]);
    const partial = { transcript: { ...rest, assistant: USED_FIELDS.assistant.filter((name) => name !== 'message.usage') }, stream: {} };
    expect(missingUsedFields(partial)).toEqual(['user: （種類が無い）', 'assistant: message.usage']);
  });
});

describe('scripts/inventory-diff.mjs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-inventory-diff-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const SCRIPT = join(__dirname, '..', 'scripts', 'inventory-diff.mjs');
  const write = (name: string, inventory: Inventory) => {
    writeFileSync(join(dir, name), JSON.stringify(inventory));
    return join(dir, name);
  };
  const run = (prev: string, next: string) => {
    const out = join(dir, 'diff.md');
    const status = execFileSync(process.execPath, [SCRIPT, prev, next, out], { encoding: 'utf8' }).trim();
    let text: string | null = null;
    try {
      text = readFileSync(out, 'utf8');
    } catch {
      text = null;
    }
    return { status, text };
  };

  it('同じなら same と書き、差分は書かない', () => {
    const inventory = { transcript: { user: ['type'] }, stream: { result: ['type'] } };
    expect(run(write('a.json', inventory), write('b.json', inventory))).toEqual({ status: 'same', text: null });
  });

  it('増えた種類・消えた種類・増えた・消えたフィールドを、会話ログと stream-json に分けて書く', () => {
    const prev = write('a.json', { transcript: { user: ['type', 'uuid'], 'system/old': [] }, stream: { result: ['type'] } });
    const next = write('b.json', { transcript: { user: ['type', 'promptId'], 'system/new': ['level'] }, stream: { result: ['type'] } });
    const { status, text } = run(prev, next);
    expect(status).toBe('changed');
    expect(text).toBe(
      [
        '### 会話ログ',
        '',
        '- 増えた種類: `system/new`（フィールド: `level`）',
        '- 消えた種類: `system/old`',
        '- `user` に増えたフィールド: `promptId`',
        '- `user` から消えたフィールド: `uuid`',
        '',
      ].join('\n'),
    );
  });

  it('出た台本（sources）があれば添える。消えたものは前の目録の台本、ほかは新しい目録の台本。台本の違いだけでは差にしない', () => {
    const prev = write('a.json', { transcript: { user: ['type'], 'system/old': [] }, stream: {}, sources: { transcript: { user: ['basic.test.ts'], 'system/old': ['errors.test.ts'] }, stream: {} } });
    const next = write('b.json', { transcript: { user: ['type', 'promptId'], 'system/new_notice': ['level'] }, stream: {}, sources: { transcript: { user: ['input.test.ts'], 'system/new_notice': ['session.test.ts'] }, stream: {} } });
    expect(run(prev, next).text).toBe(
      [
        '### 会話ログ',
        '',
        '- 増えた種類: `system/new_notice`（フィールド: `level`）［台本: session.test.ts］',
        '- 消えた種類: `system/old`［台本: errors.test.ts］',
        '- `user` に増えたフィールド: `promptId`［台本: input.test.ts］',
        '',
      ].join('\n'),
    );
    const same = { transcript: { user: ['type'] }, stream: {} };
    expect(run(write('c.json', { ...same, sources: { transcript: { user: ['a.test.ts'] }, stream: {} } }), write('d.json', { ...same, sources: { transcript: { user: ['b.test.ts'] }, stream: {} } })).status).toBe('same');
  });

  it('揺れる種類（ターミナルモードの TUI が止められるときに書く permission-mode）は、出た・出ないの違いを差にせず、ほかに差があれば書き添える', () => {
    const base = { transcript: { user: ['type'] }, stream: {} };
    const flapped = { transcript: { user: ['type'], 'permission-mode': ['permissionMode', 'type'] }, stream: {} };
    expect(run(write('a.json', base), write('b.json', flapped)).status).toBe('same');
    expect(run(write('c.json', flapped), write('d.json', base)).status).toBe('same');
    // 出たときのフィールドは比べる
    expect(run(write('e.json', flapped), write('f.json', { ...flapped, transcript: { ...flapped.transcript, 'permission-mode': ['type'] } })).text).toContain('`permission-mode` から消えたフィールド: `permissionMode`');
    const { text } = run(write('g.json', base), write('h.json', { ...flapped, transcript: { ...flapped.transcript, 'system/new': [] } }));
    expect(text).toContain('- 増えた種類: `system/new`');
    expect(text).toContain('### 揺れる種類\n\n- 揺れる種類（比べない）: `permission-mode`（ターミナルモードの TUI が、止められるときに書く');
  });

  it('会話ログで、アプリが捨てる種類（transcript-line.ts の一覧）が消えただけなら差にせず、ほかに差があれば書き添える', () => {
    const prev = { transcript: { user: ['type'], 'attachment/total_tokens_reminder': ['type'], 'system/away_summary': [], 'last-prompt': [] }, stream: {} };
    const base = { transcript: { user: ['type'] }, stream: {} };
    expect(run(write('a.json', prev), write('b.json', base)).status).toBe('same');
    // 増えたときは差にする（捨てる一覧にあっても、増えたのは Claude Code の変化）
    expect(run(write('c.json', base), write('d.json', prev)).status).toBe('changed');
    // 捨てない種類と、チャットには出さないがほかで読む種類（読むフィールドの一覧にある attachment/file）が消えたら差にする
    const used = run(write('e.json', { transcript: { ...base.transcript, 'attachment/queued_command': [], 'attachment/file': [] }, stream: {} }), write('f.json', base)).text;
    expect(used).toContain('- 消えた種類: `attachment/queued_command`');
    expect(used).toContain('- 消えた種類: `attachment/file`');
    // stream-json では比べる
    expect(run(write('g.json', { transcript: {}, stream: { 'system/away_summary': [] } }), write('h.json', { transcript: {}, stream: {} })).status).toBe('changed');
    const { text } = run(write('i.json', prev), write('j.json', { transcript: { user: ['type', 'promptId'] }, stream: {} }));
    expect(text).toContain('- `user` に増えたフィールド: `promptId`');
    expect(text).toContain('### 消えた、アプリが捨てる種類\n\n- 消えた種類（アプリが捨てる種類なので比べない）: `attachment/total_tokens_reminder`');
  });

  it('前の目録が無ければ、changed と、比べられないことを書く。新しい目録が無ければ失敗にする', () => {
    const next = write('b.json', { transcript: { user: [] }, stream: {} });
    const { status, text } = run(join(dir, 'none.json'), next);
    expect(status).toBe('changed');
    expect(text).toContain('比べる前の目録がありません');
    expect(() => execFileSync(process.execPath, [SCRIPT, next, join(dir, 'none.json'), join(dir, 'x.md')], { stdio: 'pipe' })).toThrow();
  });
});
