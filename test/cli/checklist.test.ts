import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKLIST_TOOLS, checklistToolId } from '@shared/checklist-tools';
import { ChecklistControl } from '../../src/main/checklist-control';
import { ChecklistStore } from '../../src/main/checklist-store';
import { McpBridge } from '../../src/main/mcp-bridge';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi, type Block } from './mock-api';

// 本物の claude をモックの API で動かし、チェックリストの MCP サーバー（中継）を確かめる。
// アプリと同じ起動の引数（--mcp-config・--allowedTools）で起動し、中継（src/main/checklist-mcp.ts をビルドしたもの）が、
// アプリの代わりのソケットの先の ChecklistControl まで、ツールの呼び出しを運ぶか。
// - ツールはすべて、許可の確認なしに通る（書き換えるツールも）
// - サーバーの説明（instructions）が Claude に渡り、/compact で会話を圧縮したあとも渡る
// - 人がスレッドに「Claude に通知する」で返信すると、手の空いた Claude Code の入力欄に知らせが打たれ、
//   会話ログから、カードの場所を持つ「Claude への知らせ」として読める

const USE = 'チェックリストを使ってください';
const AFTER_COMPACT = '圧縮のあとも続けてください';
// 台本の最後の応答。/compact の要約の頼みにも同じ応答が返るので、圧縮のあとの会話の最初（要約）に入り、圧縮のあとの台本を選べる
const LAST_REPLY = '返信を読みました（圧縮の目印）';
const COMPACT_MARK = '圧縮の目印';

const version = claudeVersion();

const call = (id: string, name: string, input: Record<string, unknown> = {}): Block[] => [{ type: 'tool_use', id, name: checklistToolId(name), input }];
const say = (text: string): Block[] => [{ type: 'text', text }];

describe(`Claude Code ${version} とチェックリストの MCP`, () => {
  let api: MockApi;
  let bridge: McpBridge;
  let dir: string;
  let store: ChecklistStore;
  let control: ChecklistControl | null = null;
  let run: ClaudeRun;
  const tools: string[] = [];

  const resultOf = (toolUseId: string): string | undefined => {
    for (const entry of run.entries) {
      const content = entry.type === 'user' ? (entry as { message?: { content?: unknown } }).message?.content : null;
      if (!Array.isArray(content)) continue;
      const hit = content.find((b: { type?: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id === toolUseId) as
        | { content?: string | { text?: string }[] }
        | undefined;
      if (hit) return typeof hit.content === 'string' ? hit.content : (hit.content ?? []).map((c) => c.text ?? '').join('\n');
    }
    return undefined;
  };

  beforeAll(async () => {
    const script = await buildRelay('checklist-mcp');
    dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-'));
    store = new ChecklistStore(join(dir, 'checklists'));
    bridge = new McpBridge(join(dir, 'checklist.sock'), (session, tool, args) => {
      tools.push(tool);
      return control!.handle(session, tool, args);
    });
    await bridge.start();
    api = new MockApi();
    api.conversations = [
      {
        match: USE,
        delayMs: 300,
        steps: [
          call('toolu_add', 'card_add', {
            list: '完了前チェック',
            list_description: '作業を終える前に、すべて満たされているか確かめる',
            cards: [{ title: '税込表示が整数であること' }, { title: '税率0%でも壊れないこと' }],
          }),
          call('toolu_check', 'card_check', { list: '完了前チェック', numbers: '1', comment: 'テストで確かめた' }),
          call('toolu_overview', 'checklist_overview'),
          say('チェックリストを使いました'),
          call('toolu_get', 'card_get', { list: '完了前チェック', numbers: '2' }),
          say(LAST_REPLY),
        ],
      },
      // 圧縮のあとの会話は、要約（user）・Claude Code の応答（assistant）から始まるので、台本は 2 番目の応答から使う
      { match: COMPACT_MARK, steps: [say('（使わない）'), call('toolu_after', 'checklist_overview'), say('圧縮のあとも読めます')] },
    ];
    run = new ClaudeRun(await api.start(), { checklist: { command: process.execPath, script, socketPath: bridge.socketPath, version: 'test' } });
    await run.open();
    control = new ChecklistControl({ store, host: run.manager, enabled: () => true, notifyDelayMs: 50 });
  });

  afterAll(async () => {
    control?.dispose();
    await run?.stop();
    await api?.stop();
    bridge?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('ツールの一覧と説明が Claude に渡り、書き換えるツールも許可の確認なしにアプリまで届く', async () => {
    await run.send(USE);
    // 確認が出ていれば、答えないかぎりここで止まる
    await run.waitFor('一覧の結果', () => resultOf('toolu_overview'));
    for (const tool of CHECKLIST_TOOLS) expect([...api.tools], tool.name).toContain(checklistToolId(tool.name));
    expect(api.systems.every((s) => s.includes('## tanacode-checklist') && s.includes('圧縮されても消えない'))).toBe(true);
    expect(tools).toEqual(['card_add', 'card_check', 'checklist_overview']);
    expect(resultOf('toolu_overview')).toContain('- [x] #1 税込表示が整数であること');
    const list = store.findList(run.sessionId!, '完了前チェック')!;
    expect(list.cards.map((c) => [c.title, c.checked, c.checkedBy ?? null])).toEqual([
      ['税込表示が整数であること', true, 'claude'],
      ['税率0%でも壊れないこと', false, null],
    ]);
    await run.waitFor('応答', () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === 'チェックリストを使いました'));
  });

  it('「Claude に通知する」で返信すると、手の空いた Claude に知らせが打たれ、カードの場所を持つ知らせとして読める', async () => {
    const list = store.findList(run.sessionId!, '完了前チェック')!;
    const card = list.cards[1];
    control!.apply(run.sessionId!, { type: 'card-reply', listId: list.id, cardId: card.id, text: '0% のときは税込も同じ額にして', notify: true });
    await run.waitFor('知らせ', () => run.chatEvents.find((e) => e.type === 'notice' && e.cards?.length), 30_000);
    const notice = run.chatEvents.find((e) => e.type === 'notice' && e.cards?.length);
    expect(notice).toMatchObject({ type: 'notice', cards: [{ listId: list.id, cardId: card.id }] });
    expect(notice?.type === 'notice' && notice.text).toContain('0% のときは税込も同じ額にして');
    // 知らせを受けて Claude が読んだら、Claude の未読は消える
    await run.waitFor('カードを読んだ結果', () => resultOf('toolu_get'));
    expect(resultOf('toolu_get')).toContain('人の返信（未読）');
    expect(store.findList(run.sessionId!, '完了前チェック')!.cards[1].readByClaude).toBeGreaterThan(0);
  });

  it('/compact で会話を圧縮しても、サーバーの説明は渡り続け、チェックリストも読める', async () => {
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === LAST_REPLY));
    await run.send('/compact');
    await run.waitFor('圧縮の区切り', () => run.chatEvents.some((e) => e.type === 'divider'), 30_000);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt');
    const before = api.systems.length;
    await run.send(AFTER_COMPACT);
    await run.waitFor('圧縮のあとの一覧', () => resultOf('toolu_after'), 30_000);
    expect(api.systems.slice(before).every((s) => s.includes('## tanacode-checklist') && s.includes('checklist_overview'))).toBe(true);
    expect(resultOf('toolu_after')).toContain('## 完了前チェック（1/2 チェック済み）');
  });
});
