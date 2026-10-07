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
    expect(first(await call('list_create', { name: 'やること' }))).toBe('リスト「やること」を作りました。');
    expect(store.findList(ME, 'やること')!.description).toBe('');
  });

  it('list_update・list_delete: 名前と説明を変え、ゴミ箱に入れる。リストが 1 つも無ければ、そう返す', async () => {
    expect(first(await call('list_update', { list: 'やること', name: 'x' }))).toBe('リスト「やること」がありません。リストはまだありません。');
    await call('list_create', { name: 'やること', description: '上から' });
    expect(first(await call('list_update', { list: 'やること', name: '完了前チェック', description: '終える前に確かめる' }))).toBe('リスト「完了前チェック」を変えました。');
    expect(store.findList(ME, '完了前チェック')).toMatchObject({ description: '終える前に確かめる' });
    // 文字でない値は、変えないものとして扱う
    await call('list_update', { list: '完了前チェック', name: 1, description: null });
    expect(store.findList(ME, '完了前チェック')).toMatchObject({ description: '終える前に確かめる' });
    expect(first(await call('list_delete', { list: '完了前チェック' }))).toBe('リスト「完了前チェック」をゴミ箱に入れました（人が画面から戻せます）。');
    expect(store.findList(ME, '完了前チェック')).toBeUndefined();
    expect(store.lists(ME)[0].deletedAt).toBeDefined();
  });

  it('card_update: タイトルと説明文を変える。省いたものは変えない', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A', body: '前' }] });
    expect(first(await call('card_update', { list: 'やること', number: '#1', body: '後' }))).toBe('「やること」#1 を変えました。');
    expect(store.findList(ME, 'やること')!.cards[0]).toMatchObject({ title: 'A', body: '後' });
    await call('card_update', { list: 'やること', number: 1, title: 'B' });
    expect(store.findList(ME, 'やること')!.cards[0]).toMatchObject({ title: 'B', body: '後' });
    expect(first(await call('card_update', { list: 'やること', number: 2, title: 'C' }))).toContain('#2 はありません');
  });

  it('card_add: cards が無い・空・配列でないときと、タイトルが文字でないカードは断る。本文が文字でなければ省く', async () => {
    await call('list_create', { name: 'やること' });
    for (const cards of [undefined, [], 'A']) {
      const result = await call('card_add', { list: 'やること', cards });
      expect(result.isError).toBe(true);
      expect(first(result)).toBe('cards に、足すカードを 1 つ以上渡してください');
    }
    expect(first(await call('card_add', { list: 'やること', cards: [{ title: 1 }] }))).toBe('タイトルが空のカードは作れません');
    expect(first(await call('card_add', { list: 'やること', cards: [null] }))).toBe('タイトルが空のカードは作れません');
    expect(first(await call('card_add', { list: 'やること', cards: [{ title: 'A', body: 3 }] }))).toBe('「やること」に #1「A」 を足しました。');
    expect(store.findList(ME, 'やること')!.cards.map((c) => [c.number, c.title, c.body])).toEqual([[1, 'A', '']]);
  });

  it('card_check・card_uncheck: もとからその状態のカードは、そう返す', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }] });
    await call('card_check', { list: 'やること', numbers: '1' });
    expect(first(await call('card_check', { list: 'やること', numbers: '1-2' }))).toBe(
      '「やること」の #2 のチェックを付けました。#1 は、もとからチェック済みです。 「やること」の残りは 0 枚です。',
    );
    expect(first(await call('card_check', { list: 'やること', numbers: '1' }))).toBe('#1 は、もとからチェック済みです。 「やること」の残りは 0 枚です。');
    expect(first(await call('card_uncheck', { list: 'やること', numbers: '1', reason: 'やり直す' }))).toBe('「やること」の #1 のチェックを外しました。');
    expect(first(await call('card_uncheck', { list: 'やること', numbers: '1', reason: 'やり直す' }))).toBe('#1 は、もとからチェックなしです。');
  });

  it('card_move: 同じリスト（書き方が違うだけの名前も）へは移さない', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] });
    const result = await call('card_move', { list: 'やること', numbers: '1', to_list: ' やること ' });
    expect(result.isError).toBe(true);
    expect(first(result)).toBe('移す先が同じリストです');
  });

  it('card_restore: ゴミ箱に無い番号は、ゴミ箱に無いと返す', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }] });
    await call('card_delete', { list: 'やること', numbers: '1' });
    expect(first(await call('card_restore', { list: 'やること', numbers: '1-2' }))).toBe('「やること」のゴミ箱に #2 はありません。checklist_overview で番号を確かめてください');
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
    expect(one).toMatch(/^## 「やること」#1 A\n- 状態: チェック済み（Claude・\d{4}-\d\d-\d\d \d\d:\d\d）\n- 作った人: Claude\n/);
    expect(one).toMatch(/- \d{4}-\d\d-\d\d \d\d:\d\d Claude の返信:\n {2}1 行目\n {2}2 行目$/);
    expect(two).toMatch(/- 状態: チェック済み（人・.+）\n- 作った人: 人\n\n### 説明文\n（なし）/);
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
    expect(got).toMatch(/\n…（\d+ 文字を省略）$/);
    expect(got.length).toBeLessThan(60_100);
    expect(got).toContain('## 「やること」#1 カード 1');
    expect(got).not.toContain('## 「やること」#20 カード 20');
  });

  it('cards_copy: 先に同じ名前のリストがあればそこに足す。notify: false なら知らせない', async () => {
    await call('card_add', { list: '確認', list_description: '', cards: [{ title: 'A' }] });
    store.createList(PEER, 'human', '確認', '');
    expect(first(await call('cards_copy', { from_list: '確認', numbers: '1', to_session: PEER, notify: false }))).toBe(
      'セッション「s-11」の「確認」#1 を、セッション「s-22」（22222222）の「確認」に #1 としてコピーしました。',
    );
    expect(store.findList(PEER, '確認')!.cards.map((c) => c.title)).toEqual(['A']);
    await settle();
    expect(host.submitted).toEqual([]);
  });

  it('cards_copy: 名前の無いセッションは「新しいセッション」と書く', async () => {
    const list = store.createList(UNTITLED, 'human', '確認', '');
    store.addCards(UNTITLED, 'human', list.id, [{ title: 'A' }]);
    expect(first(await call('cards_copy', { from_session: UNTITLED, from_list: '確認', numbers: '1' }))).toBe(
      'セッション「新しいセッション」の「確認」#1 を、このセッションの「確認」に #1 としてコピーしました。（「確認」は無かったので作りました）',
    );
  });

  it('cards_copy: 短い ID・先頭が重なる ID のセッションは断る', async () => {
    await call('card_add', { list: '確認', list_description: '', cards: [{ title: 'A' }] });
    host.add(TWIN);
    expect(first(await call('cards_copy', { from_list: '確認', numbers: '1', to_session: '2222' }))).toBe('セッションの ID は、先頭 8 文字以上で渡してください');
    expect(first(await call('cards_copy', { from_list: '確認', numbers: '1', to_session: '22222222' }))).toBe(
      'ID が 22222222 で始まるセッションが 2 つ以上あります。もっと長く渡してください',
    );
    expect(store.lists(PEER)).toEqual([]);
  });

  it('知らないセッション・知らないツールは断る。思いがけない失敗は、ツールの結果にせずに投げる', async () => {
    expect(first(await control.handle('nobody', 'checklist_overview', {}))).toBe('このセッションは tanacode にありません');
    expect(first(await call('rm'))).toBe('知らないツールです: rm');
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
    expect(await control.handle('nobody', 'checklist_overview', {})).toEqual(textResult('このセッションは tanacode にありません', true));
    expect(await call('rm')).toEqual(textResult('知らないツールです: rm', true));
  });

  it('文字の引数が無い・空白だけのときは、どの引数かを添えて断る', async () => {
    expect(first(await call('list_create', { name: '  ' }))).toBe('name を渡してください');
    expect(first(await call('card_add', { cards: [{ title: 'A' }] }))).toBe('list を渡してください');
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] });
    expect(first(await call('card_get', { numbers: '1' }))).toBe('list を渡してください');
    expect(first(await call('card_uncheck', { list: 'やること', numbers: '1', reason: ' ' }))).toBe('reason を渡してください');
    expect(first(await call('card_reply', { list: 'やること', number: 1 }))).toBe('text を渡してください');
    expect(first(await call('card_move', { list: 'やること', numbers: '1' }))).toBe('to_list を渡してください');
    // 無いリストは、あるリストを並べて教える
    await call('list_create', { name: '完了' });
    expect(first(await call('card_get', { list: 'ない', numbers: '1' }))).toBe('リスト「ない」がありません。あるのは「やること」、「完了」です。');
    // 無い番号は、そのリストに無いと返す（ゴミ箱とは書かない）
    expect(first(await call('card_check', { list: 'やること', numbers: '1-3' }))).toBe('「やること」の #2, #3 はありません。checklist_overview で番号を確かめてください');
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

  it('移す・消す・返信の結果の文', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }] });
    expect(first(await call('card_reply', { list: 'やること', number: 1, text: 'x' }))).toBe('「やること」#1 のスレッドに返信しました。');
    expect(first(await call('card_move', { list: 'やること', numbers: '2', to_list: '移した先' }))).toBe('「やること」の #2 を「移した先」に移しました（新しい番号: #1）。');
    expect(first(await call('card_delete', { list: 'やること', numbers: '1' }))).toBe('「やること」の #1 をゴミ箱に入れました（card_restore で戻せます）。');
  });

  it('checklist_overview: リストごとに進み具合・説明（無ければ「なし」）・チェックの印を書き、リストのあいだは空行で分ける', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }] });
    await call('card_check', { list: 'やること', numbers: '1' });
    await call('list_create', { name: '完了', description: '終える前に' });
    expect(first(await call('checklist_overview'))).toBe(
      ['## やること（1/2 チェック済み）', '説明: （なし）', '- [x] #1 A', '- [ ] #2 B', '', '## 完了（0/0 チェック済み）', '説明: 終える前に', '（カードはありません）'].join('\n'),
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
          '## 「やること」#1 A',
          '- 状態: チェック済み（Claude・2026-10-07 09:05）',
          '- 作った人: Claude',
          '',
          '### 説明文',
          '（なし）',
          '',
          '### スレッド',
          '- 2026-10-07 09:05 Claude が作りました',
          `- 2026-10-07 09:05 人の返信${mark}:`,
          '  メモ',
          '  2 行目',
          '- 2026-10-07 09:05 Claude がチェックしました',
        ].join('\n');
      expect(card(await c.handle(ME, 'card_get', { list: 'やること', numbers: '1' }))).toBe(expected('（未読）'));
      expect(card(await c.handle(ME, 'card_get', { list: 'やること', numbers: '1' }))).toBe(expected(''));
      await c.handle(ME, 'card_uncheck', { list: 'やること', numbers: '1', reason: '戻す' });
      expect(card(await c.handle(ME, 'card_get', { list: 'やること', numbers: '1' }))).toContain('\n- 状態: チェックなし\n');
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
    expect(first(await call('card_get', { list: 'やること', numbers: '1-20' }))).toBe(`${full.slice(0, 60_000)}\n…（${full.length - 60_000} 文字を省略）`);
  });

  it('人の書き換えは、新しい 30 件までを 1 行ずつ添える', async () => {
    await call('list_create', { name: 'やること' });
    const list = store.findList(ME, 'やること')!;
    for (let i = 1; i <= 35; i++) store.addCards(ME, 'human', list.id, [{ title: `c${i}` }]);
    const result = await call('checklist_overview');
    const lines = (result.content[1] as { text: string }).text.split('\n');
    expect(lines[0]).toBe('（前回のツールの呼び出しから、人がチェックリストを変えました）');
    expect(lines.slice(1)).toHaveLength(30);
    expect(lines[1]).toBe('- 人が「やること」に #6「c6」 を足しました');
    expect(lines.at(-1)).toBe('- 人が「やること」に #35「c35」 を足しました');
  });

  it('cards_copy: 結果に、作ったリストと、知らせることを書く。セッションの ID は前後の空白を除き、大文字でも探す', async () => {
    host.add(TWIN);
    await call('card_add', { list: '確認', list_description: '', cards: [{ title: 'A' }] });
    expect(first(await call('cards_copy', { from_list: '確認', numbers: '1', to_session: ' 22222222-FFFF ' }))).toBe(
      `セッション「s-11」の「確認」#1 を、セッション「s-22」（22222222）の「確認」に #1 としてコピーしました。（「確認」は無かったので作りました）コピー先の Claude に、手が空いたら知らせます。`,
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
