import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChecklistEvent } from '../src/shared/checklist-tools';
import type { SessionSummary } from '../src/shared/ipc';
import type { ScreenInfo } from '../src/shared/screen';
import type { SessionState } from '../src/shared/session-tools';
import { ChecklistControl } from '../src/main/checklist-control';
import { ChecklistStore } from '../src/main/checklist-store';
import { textResult, type ToolResult } from '../src/main/mcp-bridge';
import type { NoticeHost } from '../src/main/session-notices';

// チェックリストの MCP のツールと画面からのコピー（ChecklistControl）のうち、断るとき・結果の文の細かいところ。
// 主な流れ（作る・チェック・移す・知らせ・コピー）は test/checklist.test.ts

const ME = '11111111-0000-4000-8000-000000000001';
const PEER = '22222222-0000-4000-8000-000000000002';
// PEER と先頭 8 文字が同じ
const TWIN = '22222222-ffff-4000-8000-00000000000f';
const ARCHIVED = '44444444-0000-4000-8000-000000000004';
const UNTITLED = '55555555-0000-4000-8000-000000000005';

// SessionManager の代わり（知らせに使うところだけ）
class FakeHost implements NoticeHost {
  sessions: SessionSummary[] = [];
  submitted: { id: string; text: string }[] = [];

  add(id: string, patch: Partial<SessionSummary> = {}): void {
    this.sessions.push({
      id,
      title: `s-${id.slice(0, 2)}`,
      cwd: '/work/shop',
      archived: false,
      createdAt: 0,
      updatedAt: 0,
      running: true,
      unread: false,
      attention: null,
      backgroundTasks: 0,
      model: null,
      effort: null,
      settingsFile: null,
      remoteControl: false,
      worktree: null,
      parentId: null,
      ...patch,
    });
  }

  list = () => this.sessions;
  stateOf = (): SessionState => 'idle';
  screen = (): ScreenInfo => ({ state: { kind: 'prompt' }, model: null, effort: null, mode: null, draft: '', ready: true });
  submitWhenReady = async (id: string, text: string) => void this.submitted.push({ id, text });
  watchState = () => () => {};
}

let dir: string;
let host: FakeHost;
let store: ChecklistStore;
let control: ChecklistControl;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-control-'));
  host = new FakeHost();
  host.add(ME);
  host.add(PEER);
  host.add(ARCHIVED, { archived: true });
  host.add(UNTITLED, { title: null });
  store = new ChecklistStore(dir);
  control = new ChecklistControl({ store, host, enabled: () => true, notifyDelayMs: 10 });
});
afterEach(() => {
  control.dispose();
  store.flush();
  rmSync(dir, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}, caller = ME) => control.handle(caller, name, args);
// 結果の本文（人の書き換えを添えた 2 つ目の要素は除く）
const first = (result: ToolResult) => (result.content[0] as { text: string }).text;
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('MCP のツール（断るとき・結果の文）', () => {
  it('list_create: 説明を省くと空にする', async () => {
    expect(first(await call('list_create', { name: 'やること' }))).toBe('Created the list "やること".');
    expect(store.findList(ME, 'やること')!.description).toBe('');
  });

  it('list_update・list_delete: 名前と説明を変え、ゴミ箱に入れる。リストが 1 つも無ければ、そう返す', async () => {
    expect(first(await call('list_update', { list: 'やること', name: 'x' }))).toBe('There is no list "やること". There are no lists yet.');
    await call('list_create', { name: 'やること', description: '上から' });
    expect(first(await call('list_update', { list: 'やること', name: '完了前チェック', description: '終える前に確かめる' }))).toBe('Updated the list "完了前チェック".');
    expect(store.findList(ME, '完了前チェック')).toMatchObject({ description: '終える前に確かめる' });
    // 文字でない値は、変えないものとして扱う
    await call('list_update', { list: '完了前チェック', name: 1, description: null });
    expect(store.findList(ME, '完了前チェック')).toMatchObject({ description: '終える前に確かめる' });
    expect(first(await call('list_delete', { list: '完了前チェック' }))).toBe('Moved the list "完了前チェック" to the trash (the user can restore it in the app).');
    expect(store.findList(ME, '完了前チェック')).toBeUndefined();
    expect(store.lists(ME)[0].deletedAt).toBeDefined();
  });

  it('card_update: タイトルと説明文を変える。省いたものは変えない', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A', body: '前' }] });
    expect(first(await call('card_update', { list: 'やること', number: '#1', body: '後' }))).toBe('Updated "やること" #1.');
    expect(store.findList(ME, 'やること')!.cards[0]).toMatchObject({ title: 'A', body: '後' });
    await call('card_update', { list: 'やること', number: 1, title: 'B' });
    expect(store.findList(ME, 'やること')!.cards[0]).toMatchObject({ title: 'B', body: '後' });
    expect(first(await call('card_update', { list: 'やること', number: 2, title: 'C' }))).toContain('#2 is not in "やること"');
  });

  it('card_add: cards が無い・空・配列でないときと、タイトルが文字でないカードは断る。本文が文字でなければ省く', async () => {
    await call('list_create', { name: 'やること' });
    for (const cards of [undefined, [], 'A']) {
      const result = await call('card_add', { list: 'やること', cards });
      expect(result.isError).toBe(true);
      expect(first(result)).toBe('Pass at least one card to add in cards.');
    }
    expect(first(await call('card_add', { list: 'やること', cards: [{ title: 1 }] }))).toBe('タイトルが空のカードは作れません');
    expect(first(await call('card_add', { list: 'やること', cards: [null] }))).toBe('タイトルが空のカードは作れません');
    expect(first(await call('card_add', { list: 'やること', cards: [{ title: 'A', body: 3 }] }))).toBe('Added #1 "A" to "やること".');
    expect(store.findList(ME, 'やること')!.cards.map((c) => [c.number, c.title, c.body])).toEqual([[1, 'A', '']]);
  });

  it('card_check・card_uncheck: もとからその状態のカードは、そう返す。枚数に合わせて単数・複数を書き分ける', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }] });
    expect(first(await call('card_check', { list: 'やること', numbers: '1' }))).toBe('Checked #1 in "やること". 1 unchecked card left in "やること".');
    expect(first(await call('card_check', { list: 'やること', numbers: '1-2' }))).toBe(
      'Checked #2 in "やること". #1 was already checked. 0 unchecked cards left in "やること".',
    );
    expect(first(await call('card_check', { list: 'やること', numbers: '1' }))).toBe('#1 was already checked. 0 unchecked cards left in "やること".');
    expect(first(await call('card_check', { list: 'やること', numbers: '1-2' }))).toBe('#1, #2 were already checked. 0 unchecked cards left in "やること".');
    expect(first(await call('card_uncheck', { list: 'やること', numbers: '1', reason: 'やり直す' }))).toBe('Unchecked #1 in "やること".');
    expect(first(await call('card_uncheck', { list: 'やること', numbers: '1', reason: 'やり直す' }))).toBe('#1 was already unchecked.');
  });

  it('card_move: 同じリスト（書き方が違うだけの名前も）へは移さない', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] });
    const result = await call('card_move', { list: 'やること', numbers: '1', to_list: ' やること ' });
    expect(result.isError).toBe(true);
    expect(first(result)).toBe('The destination is the same list.');
  });

  it('card_restore: ゴミ箱に無い番号は、ゴミ箱に無いと返す', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }] });
    await call('card_delete', { list: 'やること', numbers: '1' });
    expect(first(await call('card_restore', { list: 'やること', numbers: '1-2' }))).toBe('#2 is not in the trash of "やること". Check the numbers with checklist_overview.');
    expect(store.findList(ME, 'やること')!.cards[0].deletedAt).toBeDefined();
  });

  it('card_get: チェックした人・作った人・Claude の返信（行ごとに字下げ）を書く', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] });
    const list = store.findList(ME, 'やること')!;
    const [byHuman] = store.addCards(ME, 'human', list.id, [{ title: 'B' }]);
    await call('card_check', { list: 'やること', numbers: '1' });
    store.setChecked(ME, 'human', list.id, [byHuman.id], true);
    await call('card_reply', { list: 'やること', number: 1, text: '1 行目\n2 行目' });
    const got = first(await call('card_get', { list: 'やること', numbers: '1-2' }));
    const [one, two] = got.split('\n\n---\n\n');
    expect(one).toMatch(/^## "やること" #1 A\n- Status: checked \(by Claude, \d{4}-\d\d-\d\d \d\d:\d\d\)\n- Created by: Claude\n/);
    expect(one).toMatch(/- \d{4}-\d\d-\d\d \d\d:\d\d Claude replied:\n {2}1 行目\n {2}2 行目$/);
    expect(two).toMatch(/- Status: checked \(by the user, .+\)\n- Created by: the user\n\n### Body\n\(none\)/);
  });

  it('card_get: 長すぎる結果は、上限で切って省いた文字数を書く', async () => {
    const list = store.createList(ME, 'human', 'やること', '');
    store.addCards(
      ME,
      'human',
      list.id,
      Array.from({ length: 20 }, (_, i) => ({ title: `カード ${i + 1}`, body: 'あ'.repeat(4000) })),
    );
    const got = first(await call('card_get', { list: 'やること', numbers: '1-20' }));
    expect(got).toMatch(/\n…\(\d+ characters omitted\)$/);
    expect(got.length).toBeLessThan(60_100);
    expect(got).toContain('## "やること" #1 カード 1');
    expect(got).not.toContain('## "やること" #20 カード 20');
  });

  it('cards_copy: 先に同じ名前のリストがあればそこに足す。notify: false なら知らせない', async () => {
    await call('card_add', { list: '確認', list_description: '', cards: [{ title: 'A' }] });
    store.createList(PEER, 'human', '確認', '');
    expect(first(await call('cards_copy', { from_list: '確認', numbers: '1', to_session: PEER, notify: false }))).toBe(
      'Copied #1 of "確認" in session "s-11" to "確認" in session "s-22" (22222222) as #1.',
    );
    expect(store.findList(PEER, '確認')!.cards.map((c) => c.title)).toEqual(['A']);
    await settle();
    expect(host.submitted).toEqual([]);
  });

  it('cards_copy: 名前の無いセッションは「新しいセッション」と書く', async () => {
    const list = store.createList(UNTITLED, 'human', '確認', '');
    store.addCards(UNTITLED, 'human', list.id, [{ title: 'A' }]);
    expect(first(await call('cards_copy', { from_session: UNTITLED, from_list: '確認', numbers: '1' }))).toBe(
      'Copied #1 of "確認" in session "新しいセッション" to "確認" in this session as #1. (The list "確認" did not exist, so it was created.)',
    );
  });

  it('cards_copy: 短い ID・先頭が重なる ID のセッションは断る', async () => {
    await call('card_add', { list: '確認', list_description: '', cards: [{ title: 'A' }] });
    host.add(TWIN);
    expect(first(await call('cards_copy', { from_list: '確認', numbers: '1', to_session: '2222' }))).toBe('Pass at least the first 8 characters of the session ID.');
    expect(first(await call('cards_copy', { from_list: '確認', numbers: '1', to_session: '22222222' }))).toBe(
      'More than one session has an ID starting with 22222222. Pass a longer ID.',
    );
    expect(store.lists(PEER)).toEqual([]);
  });

  it('知らないセッション・知らないツールは断る。思いがけない失敗は、ツールの結果にせずに投げる', async () => {
    expect(first(await control.handle('nobody', 'checklist_overview', {}))).toBe('This session is not in tanacode.');
    expect(first(await call('rm'))).toBe('Unknown tool: rm');
    vi.spyOn(store, 'lists').mockImplementation(() => {
      throw new Error('読めない');
    });
    await expect(call('checklist_overview')).rejects.toThrow('読めない');
  });
});

describe('画面からのコピー', () => {
  let request: Parameters<ChecklistControl['copy']>[0];
  beforeEach(() => {
    const list = store.createList(ME, 'human', '確認', '');
    const [card] = store.addCards(ME, 'human', list.id, [{ title: 'A' }]);
    request = { fromSession: ME, listId: list.id, cardIds: [card.id], toSession: PEER, notify: true };
  });

  it('無いセッション・アーカイブしたセッションへは断る', () => {
    expect(() => control.copy({ ...request, fromSession: 'nobody' })).toThrow('セッションが見つかりません');
    expect(() => control.copy({ ...request, toSession: 'nobody' })).toThrow('セッションが見つかりません');
    expect(() => control.copy({ ...request, toSession: ARCHIVED })).toThrow('アーカイブしたセッションにはコピーできません');
    expect(store.lists(ARCHIVED)).toEqual([]);
  });

  it('知らせるなら、先の Claude に、届いたカードの場所を持つ知らせを送る。同じセッションの中のコピーでは知らせない', async () => {
    control.copy({ ...request, toSession: ME, toList: '控え' });
    control.copy(request);
    await settle();
    expect(host.submitted.map((s) => s.id)).toEqual([PEER]);
    const copied = store.findList(PEER, '確認')!;
    const event = parseChecklistEvent(host.submitted[0].text);
    expect(event?.cards).toEqual([{ listId: copied.id, cardId: copied.cards[0].id }]);
    expect(event?.message).toContain('セッション「s-11」から「確認」に #1（「A」）が届きました。');
    expect(store.findList(ME, '控え')!.cards.map((c) => c.title)).toEqual(['A']);
  });
});

describe('結果の中身', () => {
  it('断るときは isError を付けて、決まった文を返す', async () => {
    expect(await control.handle('nobody', 'checklist_overview', {})).toEqual(textResult('This session is not in tanacode.', true));
    expect(await call('rm')).toEqual(textResult('Unknown tool: rm', true));
  });

  it('文字の引数が無い・空白だけのときは、どの引数かを添えて断る', async () => {
    expect(first(await call('list_create', { name: '  ' }))).toBe('name is required.');
    expect(first(await call('card_add', { cards: [{ title: 'A' }] }))).toBe('list is required.');
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] });
    expect(first(await call('card_get', { numbers: '1' }))).toBe('list is required.');
    expect(first(await call('card_uncheck', { list: 'やること', numbers: '1', reason: ' ' }))).toBe('reason is required.');
    expect(first(await call('card_reply', { list: 'やること', number: 1 }))).toBe('text is required.');
    expect(first(await call('card_move', { list: 'やること', numbers: '1' }))).toBe('to_list is required.');
    // 無いリストは、あるリストを並べて教える
    await call('list_create', { name: '完了' });
    expect(first(await call('card_get', { list: 'ない', numbers: '1' }))).toBe('There is no list "ない". Existing lists: "やること", "完了".');
    // 無い番号は、そのリストに無いと返す（ゴミ箱とは書かない）
    expect(first(await call('card_check', { list: 'やること', numbers: '1-3' }))).toBe('#2, #3 are not in "やること". Check the numbers with checklist_overview.');
  });

  it('Claude のツールで書き換えたものは、書いた人を Claude にする', async () => {
    await call('list_create', { name: 'やること' });
    await call('card_add', { list: 'やること', cards: [{ title: 'A', body: '説明' }, { title: 'B' }, { title: 'C' }] });
    await call('card_update', { list: 'やること', number: 1, title: 'A2' });
    await call('card_check', { list: 'やること', numbers: '1' });
    await call('card_reply', { list: 'やること', number: 1, text: 'メモ' });
    await call('card_delete', { list: 'やること', numbers: '2' });
    await call('card_restore', { list: 'やること', numbers: '2' });
    await call('card_move', { list: 'やること', numbers: '3', to_list: '移した先' });
    await call('card_add', { list: '新しいリスト', list_description: '', cards: [{ title: 'D' }] });
    const list = store.findList(ME, 'やること')!;
    const [a, b] = list.cards;
    expect([list.createdBy, a.createdBy, a.checkedBy, a.body]).toEqual(['claude', 'claude', 'claude', '説明']);
    expect([a.readByHuman, a.readByClaude > 0]).toEqual([0, true]);
    expect(a.thread.map((e) => `${e.author}:${e.kind === 'event' ? e.event.type : e.text}`)).toEqual(['claude:created', 'claude:title', 'claude:checked', 'claude:メモ']);
    expect(b.thread.map((e) => `${e.author}:${e.kind === 'event' ? e.event.type : ''}`)).toEqual(['claude:created', 'claude:deleted', 'claude:restored']);
    const moved = store.findList(ME, '移した先')!;
    expect([moved.createdBy, moved.description]).toEqual(['claude', '']);
    expect(moved.cards[0].thread.at(-1)).toMatchObject({ author: 'claude', event: { type: 'moved' } });
    expect(store.findList(ME, '新しいリスト')!.createdBy).toBe('claude');
    // コピーも、Claude がしたもの
    await call('cards_copy', { from_list: 'やること', numbers: '1', to_session: PEER, notify: false });
    const copied = store.findList(PEER, 'やること')!.cards[0];
    expect([copied.readByHuman, copied.readByClaude > 0, copied.thread.at(-1)?.author]).toEqual([0, true, 'claude']);
  });

  it('移す・消す・返信の結果の文。枚数に合わせて単数・複数を書き分ける', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }] });
    expect(first(await call('card_reply', { list: 'やること', number: 1, text: 'x' }))).toBe('Replied in the thread of "やること" #1.');
    expect(first(await call('card_move', { list: 'やること', numbers: '2', to_list: '移した先' }))).toBe('Moved #2 from "やること" to "移した先" (new number: #1).');
    expect(first(await call('card_delete', { list: 'やること', numbers: '1' }))).toBe('Moved #1 in "やること" to the trash (restore it with card_restore).');
    expect(first(await call('card_move', { list: 'やること', numbers: '3-4', to_list: '移した先' }))).toBe('Moved #3, #4 from "やること" to "移した先" (new numbers: #2, #3).');
    expect(first(await call('card_delete', { list: '移した先', numbers: '1-3' }))).toBe('Moved #1-3 in "移した先" to the trash (restore them with card_restore).');
    expect(first(await call('card_restore', { list: '移した先', numbers: '1-3' }))).toBe('Restored #1-3 in "移した先".');
  });

  it('checklist_overview: リストごとに進み具合・説明（無ければ「なし」）・チェックの印を書き、リストのあいだは空行で分ける', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }] });
    await call('card_check', { list: 'やること', numbers: '1' });
    await call('list_create', { name: '完了', description: '終える前に' });
    expect(first(await call('checklist_overview'))).toBe(
      ['## やること (1/2 checked)', 'Description: (none)', '- [x] #1 A', '- [ ] #2 B', '', '## 完了 (0/0 checked)', 'Description: 終える前に', '(no cards)'].join('\n'),
    );
  });

  it('card_get: カードの中身を決まった形で書く。人の返信は、Claude が読むまで未読と書く', async () => {
    const at = new Date(2026, 9, 7, 9, 5).getTime();
    const timed = new ChecklistStore(join(dir, 'timed'), () => {}, () => at);
    const c = new ChecklistControl({ store: timed, host, enabled: () => true, notifyDelayMs: 10 });
    try {
      await c.handle(ME, 'card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] });
      const list = timed.findList(ME, 'やること')!;
      timed.reply(ME, 'human', list.id, list.cards[0].id, 'メモ\n2 行目');
      await c.handle(ME, 'card_check', { list: 'やること', numbers: '1' });
      const card = (r: ToolResult) => (r.content[0] as { text: string }).text;
      const expected = (mark: string) =>
        [
          '## "やること" #1 A',
          '- Status: checked (by Claude, 2026-10-07 09:05)',
          '- Created by: Claude',
          '',
          '### Body',
          '(none)',
          '',
          '### Thread',
          '- 2026-10-07 09:05 Claude created the card',
          `- 2026-10-07 09:05 The user replied${mark}:`,
          '  メモ',
          '  2 行目',
          '- 2026-10-07 09:05 Claude checked the card',
        ].join('\n');
      expect(card(await c.handle(ME, 'card_get', { list: 'やること', numbers: '1' }))).toBe(expected(' (unread)'));
      expect(card(await c.handle(ME, 'card_get', { list: 'やること', numbers: '1' }))).toBe(expected(''));
      await c.handle(ME, 'card_uncheck', { list: 'やること', numbers: '1', reason: '戻す' });
      expect(card(await c.handle(ME, 'card_get', { list: 'やること', numbers: '1' }))).toContain('\n- Status: not checked\n');
    } finally {
      c.dispose();
      timed.flush();
    }
  });

  it('card_get: 長すぎる結果は、60,000 文字で切って、省いた文字数を書く', async () => {
    const list = store.createList(ME, 'human', 'やること', '');
    store.addCards(
      ME,
      'human',
      list.id,
      Array.from({ length: 20 }, (_, i) => ({ title: `カード ${i + 1}`, body: 'あ'.repeat(4000) })),
    );
    const each: string[] = [];
    for (let n = 1; n <= 20; n++) each.push(first(await call('card_get', { list: 'やること', numbers: String(n) })));
    const full = each.join('\n\n---\n\n');
    expect(first(await call('card_get', { list: 'やること', numbers: '1-20' }))).toBe(`${full.slice(0, 60_000)}\n…(${full.length - 60_000} characters omitted)`);
  });

  it('人の書き換えは、新しい 30 件までを 1 行ずつ添える', async () => {
    await call('list_create', { name: 'やること' });
    const list = store.findList(ME, 'やること')!;
    for (let i = 1; i <= 35; i++) store.addCards(ME, 'human', list.id, [{ title: `c${i}` }]);
    const result = await call('checklist_overview');
    const lines = (result.content[1] as { text: string }).text.split('\n');
    expect(lines[0]).toBe('(Since your previous tool call, the user changed the checklists)');
    expect(lines.slice(1)).toHaveLength(30);
    expect(lines[1]).toBe('- The user added #6 "c6" to "やること"');
    expect(lines.at(-1)).toBe('- The user added #35 "c35" to "やること"');
  });

  it('cards_copy: 結果に、作ったリストと、知らせることを書く。セッションの ID は前後の空白を除き、大文字でも探す', async () => {
    host.add(TWIN);
    await call('card_add', { list: '確認', list_description: '', cards: [{ title: 'A' }] });
    expect(first(await call('cards_copy', { from_list: '確認', numbers: '1', to_session: ' 22222222-FFFF ' }))).toBe(
      'Copied #1 of "確認" in session "s-11" to "確認" in session "s-22" (22222222) as #1. (The list "確認" did not exist, so it was created.) Claude in the destination session will be notified when it is idle.',
    );
    expect(store.findList(TWIN, '確認')!.cards).toHaveLength(1);
    expect(store.lists(PEER)).toEqual([]);
  });

  it('dispose のあとは、返信の知らせを送らない', async () => {
    const list = store.createList(ME, 'human', '確認', '');
    const [card] = store.addCards(ME, 'claude', list.id, [{ title: 'x' }]);
    control.apply(ME, { type: 'card-reply', listId: list.id, cardId: card.id, text: '見て', notify: true });
    control.dispose();
    await settle();
    expect(host.submitted).toEqual([]);
  });
});

describe('画面からのコピー（知らせの中身）', () => {
  it('人がしたコピーとして写す。続けたコピーは 1 つの知らせにまとめ、届いたカードの題を並べる。開く場所は 20 枚まで', async () => {
    const list = store.createList(ME, 'human', '確認', '');
    const cards = store.addCards(
      ME,
      'claude',
      list.id,
      Array.from({ length: 23 }, (_, i) => ({ title: `c${i + 1}` })),
    );
    control.copy({ fromSession: ME, listId: list.id, cardIds: [cards[0].id, cards[1].id], toSession: PEER, notify: true });
    control.copy({ fromSession: ME, listId: list.id, cardIds: cards.slice(2).map((c) => c.id), toSession: PEER, notify: true });
    const copied = store.findList(PEER, '確認')!.cards;
    expect([copied[0].readByHuman > 0, copied[0].readByClaude, copied[0].thread.at(-1)?.author]).toEqual([true, 0, 'human']);
    await settle();
    expect(host.submitted).toHaveLength(1);
    const event = parseChecklistEvent(host.submitted[0].text)!;
    expect(event.message).toContain('セッション「s-11」から「確認」に #1, #2（「c1」、「c2」）が届きました。');
    expect(event.message).toContain('セッション「s-11」から「確認」に #3〜23（');
    // 開く場所は、知らせごとに 20 枚まで（2 枚と、21 枚のうちの 20 枚）
    expect(event.cards).toHaveLength(22);
    expect(event.cards.slice(2)).toEqual(copied.slice(2, 22).map((c) => ({ listId: store.findList(PEER, '確認')!.id, cardId: c.id })));
  });
});
