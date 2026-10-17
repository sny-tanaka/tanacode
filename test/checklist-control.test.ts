import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveCards } from '../src/shared/checklist';
import { parseChecklistEvent } from '../src/shared/checklist-tools';
import type { SessionSummary } from '../src/shared/ipc';
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
      state: null,
      mode: null,
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

  // セッションの状態（無ければ idle）。ターミナルモードの TUI に貼ったもの（pasteOk が false なら、メニューを出していて貼れない）
  states = new Map<string, SessionState>();
  pasted: { id: string; text: string }[] = [];
  pasteOk = true;
  private readonly watchers = new Set<(id: string) => void>();

  list = () => this.sessions;
  stateOf = (id: string): SessionState => this.states.get(id) ?? 'idle';
  submitWhenReady = async (id: string, text: string) => void this.submitted.push({ id, text });
  pasteIntoTerminal = (id: string, text: string) => {
    if (!this.pasteOk) return false;
    this.pasted.push({ id, text });
    return true;
  };
  watchState = (listener: (id: string) => void) => {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  };
  // 状態が変わった（SessionManager の changed）
  changed(id: string): void {
    this.watchers.forEach((l) => l(id));
  }
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
    expect(first(await call('list_delete', { list: '完了前チェック' }))).toBe('Moved the list "完了前チェック" to the trash (restore it with list_restore).');
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

  it('card_move: 先に同じリスト（書き方が違うだけの名前も）を渡すと、to_list を省いたときと同じく、リストの中で並べ替える', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }] });
    const result = await call('card_move', { list: 'やること', numbers: '1', to_list: ' やること ' });
    expect(result.isError).toBeUndefined();
    expect(first(result)).toBe('Put #1 in "やること" at the end (the numbers stay). Order of "やること" now: #2, #1.');
    expect(store.lists(ME)).toHaveLength(1);
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

describe('並べ替えとゴミ箱（card_move・checklist_trash・list_restore）', () => {
  const titles = (name: string, session = ME) => liveCards(store.findList(session, name)!).map((c) => `#${c.number} ${c.title}`);

  it('card_move: to_list を省くと、numbers に書いた順に並べ替える（番号はそのまま）。before を省くと最後に入れる', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }] });
    expect(first(await call('card_move', { list: 'やること', numbers: '3,1', before: 2 }))).toBe(
      'Put #3, #1 in "やること" before #2 (the numbers stay). Order of "やること" now: #3, #1, #2, #4.',
    );
    expect(first(await call('card_move', { list: 'やること', numbers: '2' }))).toBe('Put #2 in "やること" at the end (the numbers stay). Order of "やること" now: #3, #1, #4, #2.');
    expect(titles('やること')).toEqual(['#3 C', '#1 A', '#4 D', '#2 B']);
    // 一覧も、並べ替えた順に出す
    expect(first(await call('checklist_overview'))).toContain('- [ ] #3 C\n- [ ] #1 A\n- [ ] #4 D\n- [ ] #2 B');
    // 同じリストの中の並べ替えは、スレッドに記録を残さない
    expect(store.findList(ME, 'やること')!.cards.every((c) => c.thread.length === 1)).toBe(true);
  });

  it('card_move: before が移すカードそのものなら、そこから後ろの、移さない最初のカードの前に入れる（無ければ最後）', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }] });
    expect(first(await call('card_move', { list: 'やること', numbers: '4,1', before: 1 }))).toBe(
      'Put #4, #1 in "やること" before #2 (the numbers stay). Order of "やること" now: #4, #1-3.',
    );
    expect(first(await call('card_move', { list: 'やること', numbers: '2-3', before: '#3' }))).toBe(
      'Put #2, #3 in "やること" at the end (the numbers stay). Order of "やること" now: #4, #1-3.',
    );
  });

  it('card_move: ほかのリストへは、before の前に入れられる（番号は先で振り直す）。無い番号・まだ無いリスト・読めない before は断り、何も変えない', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
    await call('card_add', { list: '移した先', list_description: '', cards: [{ title: 'X' }, { title: 'Y' }] });
    expect(first(await call('card_move', { list: 'やること', numbers: '3,1', to_list: '移した先', before: 2 }))).toBe(
      'Moved #3, #1 from "やること" to "移した先" before #2 (new numbers: #3, #4). Order of "移した先" now: #1, #3, #4, #2.',
    );
    expect(titles('移した先')).toEqual(['#1 X', '#3 C', '#4 A', '#2 Y']);
    expect(first(await call('card_move', { list: 'やること', numbers: '2', to_list: '移した先', before: 9 }))).toBe(
      '#9 is not in "移した先". Check the numbers with checklist_overview.',
    );
    expect(first(await call('card_move', { list: 'やること', numbers: '2', to_list: '新しいリスト', before: 1 }))).toBe(
      'There is no list "新しいリスト" yet, so there is no #1 to put the cards before. Omit before to create the list.',
    );
    expect(first(await call('card_move', { list: 'やること', numbers: '2', before: '1-2' }))).toBe('before must be one card number, like 3.');
    expect(first(await call('card_move', { list: 'やること', numbers: '2', before: 0 }))).toBe('before must be one card number, like 3.');
    expect(store.findList(ME, '新しいリスト')).toBeUndefined();
    expect(titles('やること')).toEqual(['#2 B']);
    expect(titles('移した先')).toEqual(['#1 X', '#3 C', '#4 A', '#2 Y']);
  });

  it('card_move: 決定事項のリストの中では並べ替えられる。外へは、これまでどおり移せない', async () => {
    await call('card_add', { list: '決定事項', list_description: '', list_kind: 'decisions', cards: [{ title: 'A' }, { title: 'B' }] });
    expect(first(await call('card_move', { list: '決定事項', numbers: '2', before: 1 }))).toBe(
      'Put #2 in "決定事項" before #1 (the numbers stay). Order of "決定事項" now: #2, #1.',
    );
    const out = await call('card_move', { list: '決定事項', numbers: '1', to_list: 'やること' });
    expect(out.isError).toBe(true);
    expect(first(out)).toContain('but you cannot move its cards out; only the user can.');
    expect(titles('決定事項')).toEqual(['#2 B', '#1 A']);
  });

  it('checklist_trash: ゴミ箱のリスト（id・種類・消した人と時刻・中のカード）と、ほかのリストから消したカードを返す。決定事項のものには、戻せるのは人だけと添える', async () => {
    const at = new Date(2026, 9, 7, 9, 5).getTime();
    const timed = new ChecklistStore(join(dir, 'timed'), () => {}, () => at);
    const c = new ChecklistControl({ store: timed, host, enabled: () => true, notifyDelayMs: 10 });
    const run = async (name: string, args: Record<string, unknown> = {}) => first(await c.handle(ME, name, args));
    try {
      expect(await run('checklist_trash')).toBe('The trash is empty.');
      await run('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
      await run('card_delete', { list: 'やること', numbers: '2' });
      await run('list_delete', { list: 'やること' });
      await run('card_add', { list: '完了前チェック', list_description: '', cards: [{ title: 'D' }] });
      const done = timed.findList(ME, '完了前チェック')!;
      timed.deleteCards(ME, 'human', done.id, [done.cards[0].id]);
      await run('card_add', { list: '決定事項', list_description: '', list_kind: 'decisions', cards: [{ title: 'E' }] });
      await run('card_revoke', { list: '決定事項', numbers: '1', reason: '取り下げ' });
      const old = timed.createList(ME, 'human', '古い決定', '', 'decisions');
      timed.deleteList(ME, 'human', old.id);
      const todo = timed.lists(ME).find((l) => l.name === 'やること')!;
      expect(await run('checklist_trash')).toBe(
        [
          '## Lists in the trash',
          `- "やること" (id ${todo.id.slice(0, 8)}; ordinary list; deleted by Claude, 2026-10-07 09:05; restore it with list_restore): 2 cards`,
          '  - #1 A',
          '  - #3 C',
          '  - (1 card deleted before the list stays in the trash after list_restore)',
          `- "古い決定" (id ${old.id.slice(0, 8)}; decisions list; deleted by the user, 2026-10-07 09:05; only the user can restore it): 0 cards`,
          '',
          '## Cards in the trash (restore them with card_restore)',
          '- "完了前チェック" #1 D (deleted by the user, 2026-10-07 09:05)',
          '- "決定事項" #1 E (deleted by Claude, 2026-10-07 09:05; revoked; only the user can restore it)',
        ].join('\n'),
      );
      // 消した人を残す前に消したリストは、時刻だけ
      delete todo.deletedBy;
      expect(await run('checklist_trash')).toContain('; ordinary list; deleted 2026-10-07 09:05; restore it with list_restore): 2 cards');
    } finally {
      c.dispose();
      timed.flush();
    }
  });

  it('list_restore: ゴミ箱のリストを、消したときのカードごと戻す。同じ名前のリストがあれば名前を変え、先に消したカードはゴミ箱に残して、その数を返す', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
    await call('card_delete', { list: 'やること', numbers: '2' });
    await call('list_delete', { list: 'やること' });
    await call('list_create', { name: 'やること' });
    expect(first(await call('list_restore', { list: 'やること' }))).toBe(
      'Restored the list "やること (2)" from the trash with 2 cards (#1, #3). A list named "やること" already exists, so the restored list is named "やること (2)". 1 card deleted before the list stays in the trash (restore it with card_restore; checklist_trash shows it).',
    );
    const restored = store.findList(ME, 'やること (2)')!;
    expect([restored.deletedAt, restored.deletedBy]).toEqual([undefined, undefined]);
    expect(titles('やること (2)')).toEqual(['#1 A', '#3 C']);
    expect(first(await call('card_restore', { list: 'やること (2)', numbers: '2' }))).toBe('Restored #2 in "やること (2)".');
    expect(first(await call('checklist_trash'))).toBe('The trash is empty.');
  });

  it('list_restore: 同じ名前のリストがゴミ箱にいくつもあれば、checklist_trash の id で指してもらう。ゴミ箱に無い・決定事項のリストは断る', async () => {
    const one = store.createList(ME, 'human', '確認', '');
    store.deleteList(ME, 'human', one.id);
    const two = store.createList(ME, 'human', '確認', '');
    store.addCards(ME, 'human', two.id, [{ title: 'A' }]);
    store.deleteList(ME, 'human', two.id);
    const ids = [one, two].map((l) => l.id.slice(0, 8));
    expect(first(await call('list_restore', { list: '確認' }))).toBe(`More than one list in the trash matches "確認" (ids: ${ids.join(', ')}). Pass the id from checklist_trash.`);
    expect(first(await call('list_restore', { list: ` ${ids[1].toUpperCase()} ` }))).toBe('Restored the list "確認" from the trash with 1 card (#1).');
    expect(first(await call('list_restore', { list: '確認' }))).toBe(
      'Restored the list "確認 (2)" from the trash with 0 cards. A list named "確認" already exists, so the restored list is named "確認 (2)".',
    );
    expect(first(await call('list_restore', { list: '確認' }))).toBe('The list "確認" is not in the trash.');
    expect(first(await call('list_restore', { list: 'ない' }))).toBe('There is no list "ない" in the trash. The trash has no lists.');
    const decisions = store.createList(ME, 'human', '決定事項', '', 'decisions');
    store.deleteList(ME, 'human', decisions.id);
    const refused = await call('list_restore', { list: '決定事項' });
    expect(refused.isError).toBe(true);
    expect(first(refused)).toContain('you cannot restore the list from the trash; only the user can.');
    expect(store.findList(ME, '決定事項')).toBeUndefined();
    expect(first(await call('list_restore', { list: 'ない' }))).toBe(`There is no list "ない" in the trash. Lists in the trash: "決定事項" (${decisions.id.slice(0, 8)}).`);
  });

  it('ゴミ箱にあるリストを名前で指すと、先に list_restore で戻すよう返す（決定事項のリストは、戻せるのは人だけ）', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] });
    await call('card_delete', { list: 'やること', numbers: '1' });
    await call('list_delete', { list: 'やること' });
    expect(first(await call('card_restore', { list: 'やること', numbers: '1' }))).toBe(
      'There is no list "やること". The list "やること" is in the trash: restore it first with list_restore. There are no lists yet.',
    );
    const decisions = store.createList(ME, 'human', '決定事項', '', 'decisions');
    store.deleteList(ME, 'human', decisions.id);
    expect(first(await call('card_get', { list: '決定事項', numbers: '1' }))).toBe(
      'There is no list "決定事項". The list "決定事項" is in the trash, and only the user can restore it. There are no lists yet.',
    );
  });
});

describe('ほかのセッションのチェックリスト（session_id）', () => {
  const CHILD = '66666666-0000-4000-8000-000000000006';
  // アーカイブした子
  const GONE = '77777777-0000-4000-8000-000000000007';
  // 別のリポジトリのセッション（見えない）
  const FAR = '88888888-0000-4000-8000-000000000008';
  const NOT_CHILD = (title: string, id: string) =>
    `You can read the checklists of session "${title}" (${id.slice(0, 8)}), but you can change only those of this session and of your child sessions.`;
  beforeEach(() => {
    host.add(CHILD, { parentId: ME, cwd: '/work/shop/.claude/worktrees/child' });
    host.add(GONE, { parentId: ME, archived: true });
    host.add(FAR, { cwd: '/work/other' });
  });

  it('読む: 見えるセッション（同じフォルダ・子・親）のものを読める。未読の数と印は出さず、そのセッションの Claude が読んだことにもしない', async () => {
    const list = store.createList(PEER, 'claude', 'やること', '');
    const [card] = store.addCards(PEER, 'claude', list.id, [{ title: 'A' }]);
    store.reply(PEER, 'human', list.id, card.id, '見てください');
    const read = card.readByClaude;
    expect(first(await call('checklist_overview', { session_id: PEER.slice(0, 8) }))).toBe(
      ['# Session "s-22" (22222222)', '', '## やること (0/1 checked)', 'Description: (none)', '- [ ] #1 A'].join('\n'),
    );
    const got = first(await call('card_get', { list: 'やること', numbers: '1', session_id: PEER }));
    expect(got).toMatch(/^# Session "s-22" \(22222222\)\n\n## "やること" #1 A\n/);
    expect(got).toMatch(/The user replied:\n {2}見てください$/);
    expect(card.readByClaude).toBe(read);
    // そのセッションの Claude には、未読のまま
    expect(first(await call('checklist_overview', {}, PEER))).toContain('- [ ] #1 A (1 unread reply)');
    expect(first(await call('checklist_trash', { session_id: PEER }))).toBe('# Session "s-22" (22222222)\n\nThe trash is empty.');
    expect(first(await call('checklist_overview', { session_id: CHILD }))).toBe('# Session "s-66" (66666666)\n\nNo checklists yet.');
    // アーカイブした子も読める。子からは、親と兄弟のものも読める
    expect(first(await call('checklist_overview', { session_id: GONE }))).toBe('# Session "s-77" (77777777)\n\nNo checklists yet.');
    expect(first(await call('checklist_overview', { session_id: ME }, CHILD))).toBe('# Session "s-11" (11111111)\n\nNo checklists yet.');
    expect(first(await call('checklist_overview', { session_id: GONE }, CHILD))).toBe('# Session "s-77" (77777777)\n\nNo checklists yet.');
    // 自分の ID を渡したときは、渡さないときと同じ
    expect(first(await call('checklist_overview', { session_id: ME }))).toBe('This session has no checklists yet. You can create one with list_create.');
  });

  it('見えないセッション（別のリポジトリ）は、読むことも書くこともできない', async () => {
    const list = store.createList(FAR, 'human', 'やること', '');
    for (const [name, args] of [
      ['checklist_overview', {}],
      ['card_add', { list: 'やること', cards: [{ title: 'A' }] }],
    ] as const) {
      const result = await call(name, { ...args, session_id: FAR });
      expect(result.isError).toBe(true);
      expect(first(result)).toBe(`No visible session has the ID ${FAR} (check with list_sessions of tanacode-sessions).`);
    }
    expect(list.cards).toEqual([]);
  });

  it('書き換え: 自分の子のものだけ。同じフォルダのセッション・親・アーカイブした子は断り、何も変えない', async () => {
    const list = store.createList(PEER, 'human', 'やること', '');
    const refused = await call('card_add', { list: 'やること', cards: [{ title: 'A' }], session_id: PEER });
    expect(refused.isError).toBe(true);
    expect(first(refused)).toBe(NOT_CHILD('s-22', PEER));
    expect(first(await call('list_create', { name: '親のリスト', session_id: ME }, CHILD))).toBe(NOT_CHILD('s-11', ME));
    expect(first(await call('list_create', { name: '兄弟のリスト', session_id: GONE }, CHILD))).toBe(NOT_CHILD('s-77', GONE));
    expect(first(await call('list_create', { name: 'x', session_id: GONE }))).toBe('Can\'t change the checklists of "s-77" because it is an archived session.');
    expect(list.cards).toEqual([]);
    expect(store.lists(ME)).toEqual([]);
    expect(store.lists(GONE)).toEqual([]);
  });

  it('書き換え: 親は子のリストを作り・足し・チェックし・返信し・並べ替え・消し・戻せる。書いた人は Claude。子の Claude が人の返信を読んだことにはしない', async () => {
    const c = { session_id: CHILD };
    expect(first(await call('card_add', { ...c, list: 'やること', list_description: '子の作業', cards: [{ title: 'A' }, { title: 'B' }] }))).toBe(
      'Session "s-66" (66666666): Created the list "やること". Added #1 "A", #2 "B" to "やること".',
    );
    const list = store.findList(CHILD, 'やること')!;
    store.reply(CHILD, 'human', list.id, list.cards[0].id, '人から');
    await call('card_check', { ...c, list: 'やること', numbers: '1', comment: '親が確かめた' });
    await call('card_reply', { ...c, list: 'やること', number: 1, text: '親から' });
    expect(first(await call('card_move', { ...c, list: 'やること', numbers: '2', before: 1 }))).toBe(
      'Session "s-66" (66666666): Put #2 in "やること" before #1 (the numbers stay). Order of "やること" now: #2, #1.',
    );
    await call('card_delete', { ...c, list: 'やること', numbers: '2' });
    await call('card_restore', { ...c, list: 'やること', numbers: '2' });
    await call('list_update', { ...c, list: 'やること', description: '親が直した' });
    await call('list_delete', { ...c, list: 'やること' });
    expect(first(await call('list_restore', { ...c, list: 'やること' }))).toBe('Session "s-66" (66666666): Restored the list "やること" from the trash with 2 cards (#1, #2).');
    const restored = store.findList(CHILD, 'やること')!;
    expect(restored.description).toBe('親が直した');
    const a = restored.cards.find((card) => card.number === 1)!;
    expect(a.thread.map((e) => `${e.author}:${e.kind === 'event' ? e.event.type : e.text}`)).toEqual([
      'claude:created',
      'human:人から',
      'claude:checked',
      'claude:親が確かめた',
      'claude:親から',
    ]);
    // 子の Claude には、人の返信は未読のまま
    expect(first(await call('checklist_overview', {}, CHILD))).toContain('- [x] #1 A (1 unread reply)');
    // 親のセッションには、何も作らない
    expect(store.lists(ME)).toEqual([]);
  });

  it('書き換え: 子のリストにも、決定事項の決まりはそのまま効く。断る文の頭にセッションを書く', async () => {
    const c = { session_id: CHILD.slice(0, 8) };
    await call('card_add', { ...c, list: '決定事項', list_description: '', list_kind: 'decisions', cards: [{ title: '決済には触らない' }] });
    expect(first(await call('card_get', { ...c, list: 'ない', numbers: '1' }))).toBe('Session "s-66" (66666666): There is no list "ない". Existing lists: "決定事項".');
    for (const [name, args] of [
      ['card_update', { list: '決定事項', number: 1, title: '書き換え' }],
      ['card_delete', { list: '決定事項', numbers: '1' }],
      ['list_delete', { list: '決定事項' }],
      ['card_move', { list: '決定事項', numbers: '1', to_list: 'やること' }],
    ] as const) {
      const result = await call(name, { ...args, ...c });
      expect(result.isError, name).toBe(true);
      expect(first(result), name).toMatch(/^Session "s-66" \(66666666\): "決定事項" is a decisions list/);
    }
    // 取り消しはできる。取り消したものはゴミ箱に入り、戻せるのは人だけ
    expect(first(await call('card_revoke', { ...c, list: '決定事項', numbers: '1', reason: '親が取り消す' }))).toMatch(/^Session "s-66" \(66666666\): Revoked #1 in "決定事項"/);
    expect(first(await call('card_restore', { ...c, list: '決定事項', numbers: '1' }))).toMatch(/^Session "s-66" \(66666666\): "決定事項" is a decisions list.*only the user can/);
    expect(first(await call('checklist_trash', c))).toContain('- "決定事項" #1 決済には触らない (deleted by Claude, ');
  });

  it('前回から人が変えたものは、呼び出し元のものを添える（子のものは、子の Claude に残す）', async () => {
    const list = store.createList(CHILD, 'human', 'やること', '');
    store.addCards(CHILD, 'human', list.id, [{ title: '人が足した' }]);
    expect((await call('checklist_overview', { session_id: CHILD })).content).toHaveLength(1);
    const child = await call('checklist_overview', {}, CHILD);
    expect((child.content[1] as { text: string }).text).toContain('- The user added #1 "人が足した" to "やること"');
  });

  it('cards_copy は session_id を見ない（コピー元と先は from_session・to_session で決める）', async () => {
    await call('card_add', { list: '確認', list_description: '', cards: [{ title: 'A' }] });
    expect(first(await call('cards_copy', { from_list: '確認', numbers: '1', to_session: PEER, notify: false, session_id: FAR }))).toBe(
      'Copied #1 of "確認" in session "s-11" to "確認" in session "s-22" (22222222) as #1. (The list "確認" did not exist, so it was created.)',
    );
  });
});

describe('チェックリストを使い続けさせるフックへの返事', () => {
  const CHILD = '66666666-0000-4000-8000-000000000006';
  const worked = { turn: 4, checklist: 0 };

  it('今のチェックリストから、Claude に渡す文を返す。人の書き換えは添えず、次のツールの結果に残す', async () => {
    await call('card_add', { list: 'やること', list_description: '作業', cards: [{ title: '税率を変える' }] });
    control.apply(ME, { type: 'card-add', listId: store.findList(ME, 'やること')!.id, title: '人が足したカード' });
    const prompt = await call('hook:prompt', { turn: 0, checklist: 0 });
    expect(prompt.content).toHaveLength(1);
    expect(first(prompt)).toContain('- [ ] #1 税率を変える\n- [ ] #2 人が足したカード');
    expect(first(await call('hook:stop', worked))).toContain('Before you end this turn (4 tool calls, checklists not touched; unchecked: やること 2)');
    expect(first(await call('hook:compact', {}))).toContain('The conversation was just compacted.');
    expect((await call('checklist_overview')).content[1]).toMatchObject({ text: expect.stringContaining('user changed the checklists') });
  });

  it('渡すものが無いとき・数が数字でないときは、空を返す', async () => {
    expect(first(await call('hook:compact', {}))).toBe('');
    expect(first(await call('hook:stop', { turn: 9, checklist: 1 }))).toBe('');
    expect(first(await call('hook:stop', { turn: '9', checklist: null }))).toBe('');
    expect(first(await call('hook:stop', { turn: -3 }))).toBe('');
    expect(first(await call('hook:stop', { turn: 5.9, checklist: 0 }))).toContain('Before you end this turn (5 tool calls,');
  });

  it('会話ログがそろわなかったとき、このターンにチェックリストのツールを受けていれば止めない', async () => {
    // 会話ログは遅れて書かれる。フックが待っても、最後に使ったツール（card_add）の行が見えなかった
    const since = Date.now() - 1000;
    await call('card_add', { list: 'やること', list_description: '作業', cards: [{ title: '税率を変える' }] });
    expect(first(await call('hook:stop', { ...worked, since, settled: false }))).toBe('');
    // 次のターン（はじまりが、最後に受けたときよりあと）では、触れていないので止める
    expect(first(await call('hook:stop', { ...worked, since: Date.now() + 1000, settled: false }))).toContain('checklists not touched; unchecked: やること 1');
    // 会話ログがそろったときは、会話ログだけで決める（アプリは、本体とサブエージェントの呼び出しを見分けられない）
    expect(first(await call('hook:stop', { ...worked, since, settled: true }))).toContain('checklists not touched');
    // ターンのはじまりが分からないとき・ほかのセッションが使っただけのときは、触れたことにしない
    expect(first(await call('hook:stop', { ...worked, since: null, settled: false }))).toContain('checklists not touched');
    expect(first(await call('hook:stop', worked))).toContain('checklists not touched');
    expect(first(await call('hook:stop', { ...worked, since, settled: false }, PEER))).toContain('checklists not touched; there are no lists yet');
  });

  it('会話ログがそろわなかったとき、数えたのが前のターンなら止めない（このターンの行が、まだ 1 つも書かれていない）', async () => {
    // 人の発言のフックを受けた時刻より、数えたターンのはじまりがずっと前
    await call('hook:prompt', {});
    expect(first(await call('hook:stop', { ...worked, since: Date.now() - 60_000, settled: false }))).toBe('');
    // 発言の行の時刻と、フックが届く時刻の少しのずれ・知らせで始まったターン（発言のフックよりあと）は、このターンとして止める
    expect(first(await call('hook:stop', { ...worked, since: Date.now() - 1000, settled: false }))).toContain('checklists not touched');
    expect(first(await call('hook:stop', { ...worked, since: Date.now() + 60_000, settled: false }))).toContain('checklists not touched');
    // 会話ログがそろっていれば、作業の途中に人が発言していても（発言のフックのほうがあと）、会話ログで決める
    expect(first(await call('hook:stop', { ...worked, since: Date.now() - 60_000, settled: true }))).toContain('checklists not touched');
    // 発言のフックを受けていないセッション（アプリを起動し直した）では、数えたとおりに決める
    expect(first(await call('hook:stop', { ...worked, since: Date.now() - 60_000, settled: false }, PEER))).toContain('checklists not touched');
  });

  it('子セッションのターンの終わりは止めない。メニューでオフのとき・知らないセッションには、何も返さない', async () => {
    host.add(CHILD, { parentId: ME });
    expect(first(await call('hook:stop', { turn: 9, checklist: 0 }, CHILD))).toBe('');
    expect(first(await call('hook:prompt', {}, CHILD))).toContain('This session has no checklists yet.');
    expect(first(await call('hook:prompt', {}, 'いないセッション'))).toBe('');
    const off = new ChecklistControl({ store, host, enabled: () => false });
    expect(first(await off.handle(ME, 'hook:prompt', {}))).toBe('');
    off.dispose();
    // フックの呼び出しでない名前は、これまでどおり知らないツール
    expect(first(await call('hook:other'))).toBe('Unknown tool: hook:other');
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

describe('ターミナルモード（人が Claude Code の画面で操作している）の先への知らせ', () => {
  let request: Parameters<ChecklistControl['copy']>[0];
  beforeEach(() => {
    const list = store.createList(ME, 'human', '確認', '');
    const [card] = store.addCards(ME, 'human', list.id, [{ title: 'A' }]);
    request = { fromSession: ME, listId: list.id, cardIds: [card.id], toSession: PEER, notify: true };
    host.states.set(PEER, 'terminal');
  });

  it('人が画面で頼んだ知らせは、送らずに TUI の入力欄に貼る。メニューを出している間は待って、閉じたら貼る', async () => {
    host.pasteOk = false;
    control.copy(request);
    await settle();
    expect(host.pasted).toEqual([]);
    host.pasteOk = true;
    host.changed(PEER);
    await settle();
    expect(host.pasted.map((p) => p.id)).toEqual([PEER]);
    expect(parseChecklistEvent(host.pasted[0].text)?.message).toContain('セッション「s-11」から「確認」に #1（「A」）が届きました。');
    expect(host.submitted).toEqual([]);
  });

  it('Claude がしたコピーの知らせは貼らない（人の入力に割り込むため）。知らせなかったことを Claude に返す', async () => {
    const result = first(await call('cards_copy', { from_list: '確認', numbers: '1', to_session: PEER }));
    expect(result).toContain('was not notified: it is in terminal mode');
    await settle();
    expect(host.pasted).toEqual([]);
    expect(host.submitted).toEqual([]);
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
    expect(first(await call('list_restore', { list: ' ' }))).toBe('list is required.');
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

describe('チェックリストのファイルを読めず、保存しないセッション', () => {
  it('結果に、保存しないことを一言添える（ほかのセッションのものを扱うときも）。ふつうのセッションには添えない', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 新しいバージョンのアプリが書いた形（読めても、上書きしない）
    writeFileSync(join(dir, `${PEER}.json`), JSON.stringify({ version: 2, lists: [] }));
    const note = 'these checklists are not saved';
    const CHILD = '66666666-0000-4000-8000-000000000006';
    host.add(CHILD, { parentId: ME });
    writeFileSync(join(dir, `${CHILD}.json`), JSON.stringify({ version: 2, lists: [] }));
    expect(first(await call('checklist_overview', {}, PEER))).toContain(note);
    expect(first(await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] }, PEER))).toContain(note);
    expect(first(await call('card_add', { session_id: CHILD, list: 'やること', list_description: '', cards: [{ title: 'A' }] }))).toContain(note);
    expect(first(await call('checklist_overview'))).not.toContain(note);
    errors.mockRestore();
  });
});

describe('結果の文の細かいところ（取り消し・ゴミ箱・一覧・カード）', () => {
  it('card_revoke: もう取り消したカードは、そう返す。2 枚を取り消したら them と書く', async () => {
    const decisions = store.createList(ME, 'human', '決定事項', '', 'decisions');
    const cards = store.addCards(ME, 'human', decisions.id, ['A', 'B', 'C', 'D', 'E'].map((title) => ({ title })));
    // 人が取り消したものは、ゴミ箱に入れずに画面に残る（理由は省ける）
    store.revokeCards(ME, 'human', decisions.id, [cards[0].id, cards[1].id], '');
    expect(first(await call('card_revoke', { list: '決定事項', numbers: '1-3', reason: '取り下げ' }))).toBe(
      'Revoked #3 in "決定事項" and moved it to the trash (no longer in force; the reason stays in the thread, and only the user can restore and reinstate it). #1, #2 were already revoked. 2 cards in force in "決定事項".',
    );
    expect(first(await call('card_revoke', { list: '決定事項', numbers: '1', reason: '取り下げ' }))).toBe('#1 was already revoked. 2 cards in force in "決定事項".');
    expect(first(await call('card_revoke', { list: '決定事項', numbers: '4-5', reason: '取り下げ' }))).toBe(
      'Revoked #4, #5 in "決定事項" and moved them to the trash (no longer in force; the reason stays in the thread, and only the user can restore and reinstate them). 0 cards in force in "決定事項".',
    );
  });

  it('checklist_overview: 理由の無い取り消しは印だけ、長い理由は 200 文字で切る。いまの状態のリストのカードが 1 枚なら単数で書く', async () => {
    const decisions = store.createList(ME, 'human', '決定事項', '', 'decisions');
    const cards = store.addCards(ME, 'human', decisions.id, [{ title: 'A' }, { title: 'B' }]);
    store.revokeCards(ME, 'human', decisions.id, [cards[0].id], '');
    store.revokeCards(ME, 'human', decisions.id, [cards[1].id], `${'あ'.repeat(199)}い う`);
    const state = store.createList(ME, 'human', '状態', '', 'state');
    store.addCards(ME, 'human', state.id, [{ title: 'いまやっていること' }]);
    expect(first(await call('checklist_overview'))).toBe(
      [
        '## 決定事項 (decisions list: permanent, no checks; 0 in force, 2 revoked)',
        'Description: (none)',
        '- (revoked) #1 A',
        `- (revoked: ${'あ'.repeat(199)}い…) #2 B`,
        '',
        '## 状態 (state list: no checks, keep it current by rewriting its cards; 1 card)',
        'Description: (none)',
        '- #1 いまやっていること',
      ].join('\n'),
    );
  });

  it('card_get: 人がチェックしたカードと、人が理由なしで取り消したカード・Claude が理由つきで取り消したカードの書き方', async () => {
    const at = new Date(2026, 9, 7, 9, 5).getTime();
    const timed = new ChecklistStore(join(dir, 'timed'), () => {}, () => at);
    const c = new ChecklistControl({ store: timed, host, enabled: () => true, notifyDelayMs: 10 });
    const run = async (name: string, args: Record<string, unknown> = {}) => first(await c.handle(ME, name, args));
    try {
      const todo = timed.createList(ME, 'human', 'やること', '');
      const [task] = timed.addCards(ME, 'human', todo.id, [{ title: 'A' }]);
      timed.setChecked(ME, 'human', todo.id, [task.id], true);
      expect(await run('card_get', { list: 'やること', numbers: '1' })).toContain('\n- Status: checked (by the user, 2026-10-07 09:05)\n- Created by: the user\n');
      const decisions = timed.createList(ME, 'human', '決定事項', '', 'decisions');
      const cards = timed.addCards(ME, 'human', decisions.id, [{ title: 'B' }, { title: 'C' }]);
      timed.revokeCards(ME, 'human', decisions.id, [cards[0].id], '');
      expect(await run('card_get', { list: '決定事項', numbers: '1' })).toContain('\n- Status: revoked, no longer in force (by the user, 2026-10-07 09:05)\n');
      await run('card_revoke', { list: '決定事項', numbers: '2', reason: '取り下げ' });
      // 人がゴミ箱から戻しても、取り消したまま
      timed.restoreCards(ME, 'human', decisions.id, [cards[1].id]);
      expect(await run('card_get', { list: '決定事項', numbers: '2' })).toContain('\n- Status: revoked, no longer in force (by Claude, 2026-10-07 09:05: 取り下げ)\n');
    } finally {
      c.dispose();
      timed.flush();
    }
  });

  it('list_restore・checklist_trash: リストより前に消したカードが 2 枚なら、複数で書く', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
    await call('card_delete', { list: 'やること', numbers: '1-2' });
    await call('list_delete', { list: 'やること' });
    expect(first(await call('checklist_trash'))).toContain('  - #3 C\n  - (2 cards deleted before the list stay in the trash after list_restore)');
    expect(first(await call('list_restore', { list: 'やること' }))).toBe(
      'Restored the list "やること" from the trash with 1 card (#3). 2 cards deleted before the list stay in the trash (restore them with card_restore; checklist_trash shows them).',
    );
  });

  it('card_get: 上限を 1 文字だけ超えたら、単数で書く', async () => {
    const list = store.createList(ME, 'human', 'やること', '');
    store.addCards(ME, 'human', list.id, [{ title: 'A', body: 'あ'.repeat(60_000) }]);
    // 本文のほかの部分の長さ（本文が 60,000 文字なので、その分だけ超えている）
    const overhead = Number(/…\((\d+) characters omitted\)$/.exec(first(await call('card_get', { list: 'やること', numbers: '1' })))![1]);
    // 名前の長さが同じリストの、同じ形のカード
    const other = store.createList(ME, 'human', 'あとで書', '');
    store.addCards(ME, 'human', other.id, [{ title: 'A', body: 'あ'.repeat(60_001 - overhead) }]);
    expect(first(await call('card_get', { list: 'あとで書', numbers: '1' }))).toMatch(/\n…\(1 character omitted\)$/);
  });

  it('画面からのコピー: 名前の無いセッションからの知らせは「新しいセッション」と書く', async () => {
    const list = store.createList(UNTITLED, 'human', '確認', '');
    const [card] = store.addCards(UNTITLED, 'human', list.id, [{ title: 'A' }]);
    control.copy({ fromSession: UNTITLED, listId: list.id, cardIds: [card.id], toSession: PEER, notify: true });
    await settle();
    expect(parseChecklistEvent(host.submitted[0].text)?.message).toContain('セッション「新しいセッション」から「確認」に #1（「A」）が届きました。');
  });
});
