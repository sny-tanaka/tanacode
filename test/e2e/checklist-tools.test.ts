import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checklistToolId } from '@shared/checklist-tools';
import { E2EApp } from './app';

// Claude が MCP でチェックリストのカードを並べ替え、消したリストをゴミ箱から戻すと、画面のパネルに出るか。
// Claude がカードを積む → card_move（to_list を省く）で並べ替えると、パネルの並びが変わる（番号はそのまま）→
// list_delete で消すと、パネルから消えてゴミ箱に入る → checklist_trash でゴミ箱を読み、list_restore で戻すと、並べ替えたままパネルに戻る

const PROMPT = 'やることのリストを作ってください';
const REORDER = '#3 と #1 を先にしてください';
const CLEAN = 'やることのリストを片付けてください';
const BACK = '消したリストを戻してください';
const LIST = 'やること';
const READY = 'カードを積みました';
const MOVED = '並べ替えました';
const DELETED = 'リストを消しました';
const RESTORED = 'リストを戻しました';

describe('Claude がチェックリストを並べ替え、ゴミ箱から戻す', () => {
  let app: E2EApp;
  const list = () => app.page.locator('.checklist-list', { has: app.page.locator('.checklist-list-name', { hasText: LIST }) });
  // パネルに並んでいるカード（番号とタイトル）
  const rows = () =>
    list()
      .locator('.checklist-card')
      .evaluateAll((cards) => cards.map((c) => `${c.querySelector('.checklist-number')?.textContent} ${c.querySelector('.checklist-title')?.textContent}`));
  const trashed = () => app.page.locator('.checklist-trash-item', { hasText: LIST });
  const openTrash = async () => {
    await app.page.locator('.checklist-trash-head').waitFor();
    if (!(await app.page.locator('.checklist-trash-body').isVisible())) await app.page.click('.checklist-trash-head');
  };

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: PROMPT,
          steps: [
            [
              {
                type: 'tool_use',
                id: 'toolu_add',
                name: checklistToolId('card_add'),
                input: { list: LIST, list_description: '上から順に', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }] },
              },
            ],
            [{ type: 'text', text: READY }],
            // 2 つめの発言。#3 と #1 を、この順で #2 の前に入れる
            [{ type: 'tool_use', id: 'toolu_move', name: checklistToolId('card_move'), input: { list: LIST, numbers: '3,1', before: 2 } }],
            [{ type: 'text', text: MOVED }],
            // 3 つめの発言。リストごとゴミ箱に入れる
            [{ type: 'tool_use', id: 'toolu_delete', name: checklistToolId('list_delete'), input: { list: LIST } }],
            [{ type: 'text', text: DELETED }],
            // 4 つめの発言。ゴミ箱を読んで、リストを戻す
            [{ type: 'tool_use', id: 'toolu_trash', name: checklistToolId('checklist_trash'), input: {} }],
            [{ type: 'tool_use', id: 'toolu_restore', name: checklistToolId('list_restore'), input: { list: LIST } }],
            [{ type: 'text', text: RESTORED }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`checklist-tools-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Claude が積んだカードが、積んだ順にパネルに出る', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', READY).waitFor();
    await app.page.click('.activity-bar [aria-label^="チェックリスト"]');
    await list().waitFor();
    await expect.poll(rows).toEqual(['#1 A', '#2 B', '#3 C', '#4 D']);
  });

  it('Claude が to_list を省いて card_move すると、パネルの並びが変わる（番号はそのまま）', async () => {
    await app.send(REORDER);
    await app.byText('.chat-list', MOVED).waitFor();
    await expect.poll(rows).toEqual(['#3 C', '#1 A', '#2 B', '#4 D']);
    expect(app.api.toolResults.some((r) => r.includes(`Put #3, #1 in "${LIST}" before #2 (the numbers stay).`))).toBe(true);
  });

  it('Claude が list_delete すると、パネルから消えて、ゴミ箱に入る', async () => {
    await app.send(CLEAN);
    await app.byText('.chat-list', DELETED).waitFor();
    await list().waitFor({ state: 'detached' });
    await openTrash();
    await trashed().waitFor();
  });

  it('Claude が checklist_trash でゴミ箱を読み、list_restore で戻すと、並べ替えたままパネルに戻る', async () => {
    await app.send(BACK);
    await app.byText('.chat-list', RESTORED).waitFor();
    const trash = app.api.toolResults.find((r) => r.includes('## Lists in the trash')) ?? '';
    expect(trash).toMatch(new RegExp(`- "${LIST}" \\(id [0-9a-f]{8}; ordinary list; deleted by Claude, .+; restore it with list_restore\\): 4 cards`));
    expect(trash).toContain('  - #3 C\n  - #1 A\n  - #2 B\n  - #4 D');
    expect(app.api.toolResults.some((r) => r.includes(`Restored the list "${LIST}" from the trash with 4 cards (#1-4).`))).toBe(true);
    await list().waitFor();
    await expect.poll(rows).toEqual(['#3 C', '#1 A', '#2 B', '#4 D']);
    await trashed().waitFor({ state: 'detached' });
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
