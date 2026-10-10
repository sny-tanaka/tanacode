import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toChatEvents, isHumanPrompt, transcriptTitle, type TranscriptEntry } from '../src/shared/chat';
import { checkOp, claudeUnread, formatNumbers, humanUnread, parseNumbers, unreadCount } from '../src/shared/checklist';
import {
  CHECKLIST_MCP,
  CHECKLIST_EVENT_TAG,
  cardOfTool,
  checklistEventText,
  checklistTarget,
  checklistToolId,
  parseChecklistEvent,
} from '../src/shared/checklist-tools';
import { allowedToolIds } from '../src/shared/mcp-tools';
import type { SessionSummary } from '../src/shared/ipc';
import type { ScreenInfo } from '../src/shared/screen';
import type { SessionState } from '../src/shared/session-tools';
import { AppSettings } from '../src/main/app-settings';
import { ChecklistControl } from '../src/main/checklist-control';
import { ChecklistStore } from '../src/main/checklist-store';
import { claudeArgs } from '../src/main/claude-session';
import { respond } from '../src/main/mcp-relay';
import { textResult, type ToolResult } from '../src/main/mcp-bridge';
import type { NoticeHost } from '../src/main/session-notices';

// チェックリスト（人と Claude が一緒に見て、編集するリスト）。保存と書き換え・番号の読み方・MCP のツール・Claude への知らせ・
// 別のセッションへのコピー・起動の引数・会話ログの見分け

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ME = '11111111-0000-4000-8000-000000000001';
const PEER = '22222222-0000-4000-8000-000000000002';
const OTHER_REPO = '33333333-0000-4000-8000-000000000003';
const ARCHIVED = '44444444-0000-4000-8000-000000000004';

describe('番号の読み方', () => {
  it('1 つ・範囲・列挙・# 付き・全角・波ダッシュを読む。重なりは 1 つにする', () => {
    expect(parseNumbers('3')).toEqual([3]);
    expect(parseNumbers('#3')).toEqual([3]);
    expect(parseNumbers('5-8')).toEqual([5, 6, 7, 8]);
    expect(parseNumbers('5〜8, 10')).toEqual([5, 6, 7, 8, 10]);
    expect(parseNumbers('５，７')).toEqual([5, 7]);
    expect(parseNumbers('5,5,6')).toEqual([5, 6]);
    expect(parseNumbers(4)).toEqual([4]);
    expect(parseNumbers([1, '3-4'])).toEqual([1, 3, 4]);
  });

  it('読めないものは null（0・逆の範囲・文字・広すぎる範囲）', () => {
    for (const bad of ['', '0', '8-5', 'abc', '1-5000', -1, 1.5, null, {}]) expect(parseNumbers(bad)).toBeNull();
  });

  it('短く書く', () => {
    expect(formatNumbers([5, 6, 7, 8, 10])).toBe('#5〜8, #10');
    expect(formatNumbers([2, 3])).toBe('#2, #3');
    expect(formatNumbers([4])).toBe('#4');
  });
});

describe('保存と書き換え（ChecklistStore）', () => {
  let changes: string[];
  let store: ChecklistStore;
  beforeEach(() => {
    changes = [];
    store = new ChecklistStore(dir, (id) => changes.push(id));
  });

  it('番号は使い回さない。消しても、移しても、並べ替えても変わらない（移した先では振り直す）', () => {
    const list = store.createList(ME, 'human', 'やること', '上から順に');
    const [a, b, c] = store.addCards(ME, 'human', list.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
    expect([a.number, b.number, c.number]).toEqual([1, 2, 3]);
    store.deleteCards(ME, 'human', list.id, [c.id]);
    const [d] = store.addCards(ME, 'claude', list.id, [{ title: 'D' }]);
    expect(d.number).toBe(4);
    // 並べ替え（D を A の前に）
    store.moveCards(ME, 'human', list.id, [d.id], list.id, a.id);
    expect(store.lists(ME)[0].cards.map((x) => x.title)).toEqual(['D', 'A', 'B', 'C']);
    expect(d.number).toBe(4);
    // 別のリストへ移すと、移した先で振り直し、記録を残す
    const other = store.createList(ME, 'human', '完了前チェック', '');
    store.moveCards(ME, 'claude', list.id, [b.id], other.id);
    expect(b.number).toBe(1);
    expect(b.thread.at(-1)).toMatchObject({ kind: 'event', author: 'claude', event: { type: 'moved', fromList: 'やること', fromNumber: 2 } });
    expect(changes.every((id) => id === ME)).toBe(true);
  });

  it('名前が重なるリストは「名前 (2)」にする。比べるときは全角半角・大文字小文字・前後の空白を区別しない', () => {
    store.createList(ME, 'human', 'ToDo', '');
    expect(store.createList(ME, 'claude', ' ｔｏｄｏ ', '').name).toBe('ｔｏｄｏ (2)');
    expect(store.findList(ME, 'TODO')?.name).toBe('ToDo');
    expect(() => store.createList(ME, 'human', '  ', '')).toThrow('名前が空');
  });

  it('チェックの付け外しは、誰がいつ付けたかと記録を残す。comment は返信として残る', () => {
    const list = store.createList(ME, 'human', '完了前チェック', '');
    const [card] = store.addCards(ME, 'human', list.id, [{ title: '税率0%でも壊れないこと' }]);
    store.setChecked(ME, 'claude', list.id, [card.id], true, '`npm test -- tax` が通った');
    expect(card).toMatchObject({ checked: true, checkedBy: 'claude' });
    expect(card.thread.map((e) => (e.kind === 'event' ? e.event.type : `reply:${e.author}`))).toEqual(['created', 'checked', 'reply:claude']);
    // 同じ状態にしても記録は増えない
    expect(store.setChecked(ME, 'claude', list.id, [card.id], true)).toEqual([]);
    store.setChecked(ME, 'human', list.id, [card.id], false);
    expect(card.checked).toBe(false);
    expect(card.checkedBy).toBeUndefined();
  });

  it('未読: 人は Claude の返信を、Claude は人の返信を数える。自分の返信は読んだことになる', () => {
    const list = store.createList(ME, 'human', '確認事項', '');
    const [card] = store.addCards(ME, 'claude', list.id, [{ title: '端数の処理' }]);
    store.reply(ME, 'claude', list.id, card.id, '切り捨てにしました');
    expect(humanUnread(card)).toBe(1);
    expect(unreadCount(store.lists(ME))).toBe(1);
    store.markRead(ME, 'human', list.id, card.id);
    expect(humanUnread(card)).toBe(0);
    store.reply(ME, 'human', list.id, card.id, '四捨五入にして', true);
    expect(claudeUnread(card)).toBe(1);
    expect(humanUnread(card)).toBe(0);
    store.markRead(ME, 'claude', list.id, card.id);
    expect(claudeUnread(card)).toBe(0);
  });

  it('ゴミ箱: カードとリストを戻せる。リストごと消したカードを戻すと、リストも戻る。空にすると消える', () => {
    const list = store.createList(ME, 'human', 'やること', '');
    const [card] = store.addCards(ME, 'human', list.id, [{ title: 'A' }]);
    store.deleteCards(ME, 'claude', list.id, [card.id]);
    store.deleteList(ME, 'human', list.id);
    expect(store.findList(ME, 'やること')).toBeUndefined();
    store.restoreCards(ME, 'human', list.id, [card.id]);
    expect(store.findList(ME, 'やること')?.cards[0].deletedAt).toBeUndefined();
    store.deleteCards(ME, 'human', list.id, [card.id]);
    store.emptyTrash(ME);
    expect(store.lists(ME)[0].cards).toEqual([]);
  });

  it('ファイルに保存し、読み直せる。壊れたファイルは空から始める。セッションを消せばファイルも消す', () => {
    const list = store.createList(ME, 'human', 'やること', 'ルール');
    store.addCards(ME, 'human', list.id, [{ title: 'A', body: '**説明**' }]);
    store.flush();
    const file = join(dir, `${ME}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, lists: [{ name: 'やること', cards: [{ title: 'A', body: '**説明**' }] }] });
    expect(new ChecklistStore(dir).lists(ME)[0].description).toBe('ルール');
    store.remove(ME);
    expect(readdirSync(dir)).toEqual([]);
    expect(() => store.lists('../etc')).toThrow();
  });

  it('Claude に伝える人の書き換えは、Claude が前に呼んだあとのものだけ', () => {
    const list = store.createList(ME, 'human', 'やること', '');
    expect(store.takeHumanActivity(ME)).toEqual(['The user created the list "やること"']);
    store.addCards(ME, 'claude', list.id, [{ title: 'A' }]);
    expect(store.takeHumanActivity(ME)).toEqual([]);
    store.addCards(ME, 'human', list.id, [{ title: 'B' }]);
    expect(store.takeHumanActivity(ME)).toEqual(['The user added #2 "B" to "やること"']);
  });
});

class FakeHost implements NoticeHost {
  sessions: SessionSummary[] = [];
  states = new Map<string, SessionState>();
  screens = new Map<string, ScreenInfo>();
  submitted: { id: string; text: string }[] = [];
  private listeners = new Set<(id: string) => void>();

  add(id: string, cwd: string, patch: Partial<SessionSummary> = {}): void {
    this.sessions.push({
      id,
      title: `s-${id.slice(0, 2)}`,
      cwd,
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
    this.states.set(id, 'idle');
    this.screens.set(id, { state: { kind: 'prompt' }, model: null, effort: null, mode: null, draft: '', ready: true });
  }

  set(id: string, state: SessionState): void {
    this.states.set(id, state);
    this.listeners.forEach((l) => l(id));
  }

  list = () => this.sessions;
  stateOf = (id: string) => this.states.get(id) ?? null;
  screen = (id: string) => this.screens.get(id) ?? null;
  submitWhenReady = async (id: string, text: string) => void this.submitted.push({ id, text });
  watchState = (listener: (id: string) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

const textOf = (result: ToolResult) => result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('MCP のツール（ChecklistControl）', () => {
  let host: FakeHost;
  let store: ChecklistStore;
  let control: ChecklistControl;
  let enabled: boolean;
  const call = (name: string, args: Record<string, unknown> = {}, caller = ME) => control.handle(caller, name, args);

  beforeEach(() => {
    host = new FakeHost();
    host.add(ME, '/work/shop');
    host.add(PEER, '/work/shop/.claude/worktrees/tc-1', { worktree: { name: 'tc-1', branch: 'worktree-tc-1', root: '/work/shop', preparing: null } });
    host.add(OTHER_REPO, '/work/other');
    host.add(ARCHIVED, '/work/shop', { archived: true });
    store = new ChecklistStore(dir);
    enabled = true;
    control = new ChecklistControl({ store, host, enabled: () => enabled, notifyDelayMs: 10 });
  });
  afterEach(() => control.dispose());

  it('リストを作り、カードを足し、一覧で名前・説明・進み具合・番号を読める', async () => {
    expect(textOf(await call('checklist_overview'))).toContain('has no checklists yet');
    await call('list_create', { name: '完了前チェック', description: '作業を終える前に、すべて満たされているか確かめる' });
    const added = textOf(await call('card_add', { list: '完了前チェック', cards: [{ title: '税込表示が整数であること' }, { title: '税率0%でも壊れないこと', body: '0 除算に注意' }] }));
    expect(added).toContain('#1 "税込表示が整数であること", #2 "税率0%でも壊れないこと"');
    const overview = textOf(await call('checklist_overview'));
    expect(overview).toContain('## 完了前チェック (0/2 checked)');
    expect(overview).toContain('Description: 作業を終える前に、すべて満たされているか確かめる');
    expect(overview).toContain('- [ ] #2 税率0%でも壊れないこと');
  });

  it('無いリストにカードを足すときは、説明を渡せば作り、渡さなければ断ってあるリストを教える', async () => {
    await call('list_create', { name: 'やること', description: '' });
    const refused = await call('card_add', { list: '確認事項', cards: [{ title: 'x' }] });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('Existing lists: "やること"');
    const created = textOf(await call('card_add', { list: '確認事項', list_description: '判断を書く', cards: [{ title: 'x' }] }));
    expect(created).toContain('Created the list "確認事項"');
  });

  it('チェック・外す（理由は必須）・返信・読む。読んだら Claude の未読は消える', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
    expect(textOf(await call('card_check', { list: 'やること', numbers: '1-2', comment: 'テストが通った' }))).toContain('Checked #1, #2 in "やること"');
    expect((await call('card_uncheck', { list: 'やること', numbers: '1' })).isError).toBe(true);
    expect(textOf(await call('card_uncheck', { list: 'やること', numbers: '1', reason: '#3 の変更で崩れた' }))).toContain('Unchecked #1 in "やること"');
    const list = store.findList(ME, 'やること')!;
    store.reply(ME, 'human', list.id, list.cards[2].id, 'これは後回しで');
    expect(textOf(await call('checklist_overview'))).toContain('#3 C (1 unread reply)');
    store.reply(ME, 'human', list.id, list.cards[2].id, '理由は返信に');
    expect(textOf(await call('checklist_overview'))).toContain('#3 C (2 unread replies)');
    const got = textOf(await call('card_get', { list: 'やること', numbers: '1,3' }));
    expect(got).toContain('テストが通った');
    expect(got).toContain('#3 の変更で崩れた');
    expect(got).toContain('The user replied (unread)');
    expect(textOf(await call('checklist_overview'))).not.toContain('unread');
  });

  it('無い番号・読めない番号・無いリストは、理由を返す', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] });
    expect(textOf(await call('card_check', { list: 'やること', numbers: '1-3' }))).toContain('#2, #3 are not in "やること"');
    expect(textOf(await call('card_check', { list: 'やること', numbers: 'ぜんぶ' }))).toContain('"5-8"');
    expect(textOf(await call('card_get', { list: 'ないリスト', numbers: '1' }))).toContain('There is no list "ないリスト"');
  });

  it('移す・消す・戻す', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }, { title: 'B' }] });
    expect(textOf(await call('card_move', { list: 'やること', numbers: '2', to_list: '人のやること' }))).toContain('new number: #1');
    expect(textOf(await call('card_delete', { list: 'やること', numbers: '1' }))).toContain('to the trash');
    expect(textOf(await call('checklist_overview'))).toContain('(no cards)');
    expect(textOf(await call('card_restore', { list: 'やること', numbers: '1' }))).toContain('Restored #1');
  });

  it('結果の最後に、前回の呼び出しから人が変えたものを添える', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] });
    const list = store.findList(ME, 'やること')!;
    store.apply(ME, { type: 'card-check', listId: list.id, cardIds: [list.cards[0].id], checked: true });
    const result = await call('checklist_overview');
    expect(result.content).toHaveLength(2);
    expect(textOf(result)).toContain('The user checked #1 "A" in "やること"');
    expect((await call('checklist_overview')).content).toHaveLength(1);
  });

  it('メニューでオフにしていれば、メニューの項目の名前（画面の言語）を添えて断る', async () => {
    enabled = false;
    const result = await call('checklist_overview');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('turned off "Claude にチェックリストを扱わせる" in the tanacode menu');
  });

  describe('Claude への知らせ', () => {
    it('「Claude に通知する」で返信したら、手の空いた Claude に、カードの場所を持つ知らせを送る。続けた返信は 1 つにまとめる', async () => {
      const list = store.createList(ME, 'human', '確認事項', '');
      const [card] = store.addCards(ME, 'claude', list.id, [{ title: '端数の処理' }]);
      control.apply(ME, { type: 'card-reply', listId: list.id, cardId: card.id, text: '四捨五入にして', notify: true });
      control.apply(ME, { type: 'card-reply', listId: list.id, cardId: card.id, text: '税込で', notify: true });
      await settle();
      expect(host.submitted).toHaveLength(1);
      const event = parseChecklistEvent(host.submitted[0].text);
      expect(event?.cards).toEqual([{ listId: list.id, cardId: card.id }]);
      expect(event?.message).toContain('「確認事項」#1「端数の処理」に人が返信しました: 「四捨五入にして」');
      expect(event?.message).toContain('「税込で」');
    });

    it('通知しない返信は送らない。作業中なら手が空いてから送る', async () => {
      const list = store.createList(ME, 'human', '確認事項', '');
      const [card] = store.addCards(ME, 'claude', list.id, [{ title: 'x' }]);
      control.apply(ME, { type: 'card-reply', listId: list.id, cardId: card.id, text: 'メモ', notify: false });
      host.set(ME, 'working');
      control.apply(ME, { type: 'card-reply', listId: list.id, cardId: card.id, text: '見て', notify: true });
      await settle();
      expect(host.submitted).toEqual([]);
      host.set(ME, 'idle');
      await settle();
      expect(host.submitted).toHaveLength(1);
      expect(host.submitted[0].text).not.toContain('メモ');
    });

    it('止まっているセッションには送らない（未読の印は残る）', async () => {
      host.set(ME, 'exited');
      const list = store.createList(ME, 'human', '確認事項', '');
      const [card] = store.addCards(ME, 'claude', list.id, [{ title: 'x' }]);
      control.apply(ME, { type: 'card-reply', listId: list.id, cardId: card.id, text: '見て', notify: true });
      await settle();
      expect(host.submitted).toEqual([]);
      expect(claudeUnread(card)).toBe(1);
    });
  });

  describe('別のセッションへのコピー', () => {
    beforeEach(async () => {
      await call('card_add', { list: '完了前チェック', list_description: '終える前に確かめる', cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
      await call('card_check', { list: '完了前チェック', numbers: '2', comment: '確かめた' });
    });

    it('渡す: 同じ名前のリストを作り、チェックとスレッドごと写し、先の Claude に知らせる。元は残る', async () => {
      const text = textOf(await call('cards_copy', { from_list: '完了前チェック', numbers: '2-3', to_session: PEER.slice(0, 8) }));
      expect(text).toContain('as #1, #2.');
      expect(text).toContain('so it was created');
      const copied = store.findList(PEER, '完了前チェック')!;
      expect(copied.description).toBe('終える前に確かめる');
      expect(copied.cards.map((c) => [c.number, c.title, c.checked])).toEqual([
        [1, 'B', true],
        [2, 'C', false],
      ]);
      expect(copied.cards[0].thread.at(-1)).toMatchObject({ kind: 'event', event: { type: 'copied', fromList: '完了前チェック', fromNumber: 2 } });
      expect(copied.cards[0].thread.some((e) => e.kind === 'reply' && e.text === '確かめた')).toBe(true);
      expect(store.findList(ME, '完了前チェック')!.cards).toHaveLength(3);
      await settle();
      expect(host.submitted.map((s) => s.id)).toEqual([PEER]);
      expect(host.submitted[0].text).toContain(`<${CHECKLIST_EVENT_TAG} cards="`);
      expect(host.submitted[0].text).toContain('が届きました');
    });

    it('持ってくる: from_session を渡して、このセッションへ。自分には知らせない', async () => {
      const text = textOf(await call('cards_copy', { from_session: ME, from_list: '完了前チェック', numbers: '1', to_list: '引き継ぎ' }, PEER));
      expect(text).toContain('to "引き継ぎ" in this session');
      expect(store.findList(PEER, '引き継ぎ')!.cards[0].title).toBe('A');
      await settle();
      expect(host.submitted).toEqual([]);
    });

    it('見えないセッション（別のリポジトリ）・アーカイブしたセッション・同じセッションへは断る', async () => {
      expect(textOf(await call('cards_copy', { from_list: '完了前チェック', numbers: '1', to_session: OTHER_REPO }))).toContain('No visible session');
      expect(textOf(await call('cards_copy', { from_list: '完了前チェック', numbers: '1', to_session: ARCHIVED }))).toContain('archived session');
      expect(textOf(await call('cards_copy', { from_list: '完了前チェック', numbers: '1', to_session: ME }))).toContain('same session');
    });

    it('画面からのコピーも同じ。知らせるかは選べる', async () => {
      const list = store.findList(ME, '完了前チェック')!;
      control.copy({ fromSession: ME, listId: list.id, cardIds: [list.cards[0].id], toSession: PEER, toList: 'もらったもの', notify: false });
      expect(store.findList(PEER, 'もらったもの')!.cards[0].title).toBe('A');
      await settle();
      expect(host.submitted).toEqual([]);
      expect(() => control.copy({ fromSession: ME, listId: list.id, cardIds: [list.cards[0].id], toSession: OTHER_REPO, notify: false })).toThrow('同じフォルダ');
    });
  });
});

describe('中継・起動の引数・画面からの値', () => {
  it('tools/list: 読むツールに readOnlyHint を付ける。instructions は圧縮されても残る説明', async () => {
    const deps = { server: CHECKLIST_MCP, version: '1', call: async () => textResult('ok') };
    const init = await respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, deps);
    expect(init?.result).toMatchObject({ serverInfo: { name: 'tanacode-checklist' } });
    expect((init?.result as { instructions: string }).instructions).toContain('checklist_overview');
    const list = await respond({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps);
    const tools = (list?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort()).toEqual(['card_get', 'checklist_overview']);
  });

  it('起動の引数に足し、ツールはすべて許可済みにする（アプリのデータだけを変え、ゴミ箱から戻せるため）', () => {
    const launch = { command: '/Apps/tanacode Helper', script: '/Apps/out/main/checklist-mcp.js', socketPath: '/u/checklist.sock', version: '1.0.0' };
    const args = claudeArgs({ claudeSessionId: 'c1', resume: false, remoteControlName: null, model: null, effort: null, permissionMode: null, checklist: launch, sessionId: 's1' });
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(config.mcpServers['tanacode-checklist'].env).toMatchObject({ TANACODE_CHECKLIST_SOCKET: '/u/checklist.sock', TANACODE_CHECKLIST_SESSION: 's1' });
    const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
    expect(allowed).toEqual(allowedToolIds(CHECKLIST_MCP));
    expect(allowed).toHaveLength(CHECKLIST_MCP.tools.length);
    expect(allowed).toContain(checklistToolId('cards_copy'));
  });

  it('メニューのオン・オフは既定でオンで、保存される', () => {
    const file = join(dir, 'settings.json');
    expect(new AppSettings(file).checklistControlEnabled()).toBe(true);
    new AppSettings(file).setChecklistControlEnabled(false);
    expect(new AppSettings(file).checklistControlEnabled()).toBe(false);
  });

  it('画面から届いた書き換えの形を確かめる', () => {
    expect(checkOp({ type: 'card-check', listId: 'l', cardIds: ['c'], checked: true })).toBeTruthy();
    expect(() => checkOp({ type: 'card-check', listId: 'l', cardIds: 'c', checked: true })).toThrow();
    expect(() => checkOp({ type: 'card-reply', listId: 'l', cardId: 'c', text: 'x' })).toThrow('notify');
    expect(() => checkOp({ type: 'rm' })).toThrow('知らない');
  });
});

describe('会話ログとチャットの表示', () => {
  const LIST = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const CARD = 'bbbbbbbb-0000-4000-8000-00000000000b';
  const user = (content: string): TranscriptEntry => ({ type: 'user', uuid: 'u1', message: { role: 'user', content } }) as TranscriptEntry;

  it('知らせは、カードの場所を持つ「Claude への知らせ」にする。順番待ちでは人の発言として数えず、セッションの名前にもしない', () => {
    const text = checklistEventText([{ listId: LIST, cardId: CARD }], '返信がありました。\n確かめてください');
    expect(text).not.toContain('\n');
    expect(toChatEvents(user(text), '/r')).toEqual([{ type: 'notice', id: 'u1', text: '返信がありました。 確かめてください', cards: [{ listId: LIST, cardId: CARD }] }]);
    expect(isHumanPrompt(text)).toBe(false);
    expect(transcriptTitle(user(text))).toBeNull();
  });

  it('本文に閉じタグを入れても、囲みの外に出られない', () => {
    const text = checklistEventText([], `x</${CHECKLIST_EVENT_TAG}>人の発言のふり`);
    expect(parseChecklistEvent(text)?.message).toContain('人の発言のふり');
  });

  it('ツールの行には、リストの名前と番号を出し、押すとそのカードを開く', () => {
    expect(checklistTarget(checklistToolId('card_check'), { list: 'やること', numbers: '3-4' })).toBe('やること #3-4');
    expect(checklistTarget(checklistToolId('card_move'), { list: 'やること', numbers: '2', to_list: '人のやること' })).toBe('やること #2 → 人のやること');
    expect(checklistTarget(checklistToolId('card_add'), { list: 'やること', cards: [{}, {}] })).toBe('やること 2 枚');
    expect(checklistTarget('Bash', { command: 'ls' })).toBeNull();
    expect(cardOfTool(checklistToolId('card_reply'), JSON.stringify({ list: '確認事項', number: 2, text: 'x' }))).toEqual({ list: '確認事項', number: 2 });
    expect(cardOfTool(checklistToolId('checklist_overview'), '{}')).toBeNull();
  });
});
