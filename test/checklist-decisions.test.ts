import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeCards, checkOp, eventText, kindOf, liveCards, traitsOf, type Card, type Checklist } from '../src/shared/checklist';
import { ChecklistBook, ChecklistError } from '../src/shared/checklist-book';
import { checklistReminder, MAX_REMINDER_CHARS, type TurnActivity } from '../src/shared/checklist-reminder';
import { CHECKLIST_MCP_INSTRUCTIONS, CHECKLIST_REMINDER_TAG, CHECKLIST_TOOLS } from '../src/shared/checklist-tools';
import type { SessionSummary } from '../src/shared/ipc';
import type { ScreenInfo } from '../src/shared/screen';
import type { SessionState } from '../src/shared/session-tools';
import { ChecklistControl } from '../src/main/checklist-control';
import { ChecklistStore } from '../src/main/checklist-store';
import type { ToolResult } from '../src/main/mcp-bridge';
import type { NoticeHost } from '../src/main/session-notices';

// 決定事項（チェックで消えないリスト）。会話の圧縮で消えると困る「決まったこと」を残す場所。
// - ふつうのリストは、チェックしたカードが毎回の知らせから消える。人が承認（チェック）した判断ほど、Claude に見えなくなっていた
// - 決定事項のリストのカードはチェックが無く、有効なかぎり、毎回の知らせに出る。Claude は足すことと、理由つきの取り消し（ゴミ箱に入る）と、
//   取り消したカードの削除だけができる
// - 確認事項のリストで人がチェックしたカードは、決定事項に移る

const S = 'session-1';
const T = 'session-2';
const NONE: TurnActivity = { turn: 0, checklist: 0 };

function make() {
  return new ChecklistBook(() => {}, () => 1000);
}

// 決定事項のリストに、Claude がカードを足したところ
function withDecisions(titles: string[] = ['決済には触らない', '端数は切り捨て']) {
  const book = make();
  const list = book.createList(S, 'claude', '決定事項', '決まったこと', 'decisions');
  const cards = book.addCards(S, 'claude', list.id, titles.map((title) => ({ title })));
  return { book, list, cards };
}

const denied = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof ChecklistError) return error.message;
    throw error;
  }
  return null;
};

describe('リストの種類', () => {
  it('種類の無いリスト（種類を足す前のデータ）と、知らない種類は、ふつうのリストとして読む', () => {
    expect(kindOf({})).toBe('normal');
    expect(kindOf({ kind: 'unknown' as never })).toBe('normal');
    expect(traitsOf({})).toEqual({ checkable: true, pinned: false, locked: false, approves: false });
  });

  it('性質は種類ごとに別々に持つ（いつも出す・チェックが無い・Claude が書き換えられない・承認で移す）', () => {
    expect(traitsOf({ kind: 'decisions' })).toEqual({ checkable: false, pinned: true, locked: true, approves: false });
    expect(traitsOf({ kind: 'review' })).toEqual({ checkable: true, pinned: false, locked: false, approves: true });
  });

  it('ふつうのリストは、種類を保存しない（古いバージョンのアプリが読むデータの形を変えない）', () => {
    const book = make();
    expect('kind' in book.createList(S, 'human', 'やること', '')).toBe(false);
    expect(book.createList(S, 'human', '決定事項', '', 'decisions').kind).toBe('decisions');
  });

  it('種類を変えられるのは人だけ。ふつうのリストに戻すと、取り消しの印は外す', () => {
    const { book, list, cards } = withDecisions();
    // 人が取り消したもの（Claude が取り消したものはゴミ箱に入るので、画面に残るのはこちら）
    book.revokeCards(S, 'human', list.id, [cards[1].id], '四捨五入に変わった');
    expect(denied(() => book.updateList(S, 'claude', list.id, { kind: 'normal' }))).toBe('Only the user can change the kind of a list (in the side panel).');
    expect(list.kind).toBe('decisions');
    // 同じ種類を渡すだけなら断らない（名前だけを変える呼び出し）
    book.updateList(S, 'claude', list.id, { name: '決めたこと', kind: 'decisions' });
    book.apply(S, { type: 'list-update', listId: list.id, kind: 'normal' });
    expect('kind' in list).toBe(false);
    expect(list.cards.every((c) => !c.revoked)).toBe(true);
    expect(book.takeHumanActivity(S)).toContain('The user changed the kind of the list "決めたこと" to an ordinary list');
  });
});

describe('決定事項のリスト（Claude ができること）', () => {
  it('足すことはできる。チェック・書き換え・有効なカードの削除・外への移動・リストの削除は断り、取り消しを案内する', () => {
    const { book, list, cards } = withDecisions();
    const other = book.createList(S, 'claude', 'やること', '');
    const id = cards[0].id;
    expect(denied(() => book.setChecked(S, 'claude', list.id, [id], true))).toContain('have no checks');
    expect(denied(() => book.updateCard(S, 'claude', list.id, id, { title: '決済に触ってよい' }))).toContain('cannot rewrite its cards; only the user can');
    expect(denied(() => book.deleteCards(S, 'claude', list.id, [id]))).toContain('You can delete only revoked cards from it, and #1 "決済には触らない" is in force.');
    expect(denied(() => book.moveCards(S, 'claude', list.id, [id], other.id))).toContain('cannot move its cards out');
    expect(denied(() => book.deleteList(S, 'claude', list.id))).toContain('cannot delete the list');
    expect(denied(() => book.updateCard(S, 'claude', list.id, id, { body: 'x' }))).toContain('card_revoke');
    // 何も変わっていない
    expect(liveCards(list).map((c) => [c.title, c.body, c.checked])).toEqual([
      ['決済には触らない', '', false],
      ['端数は切り捨て', '', false],
    ]);
    expect(list.deletedAt).toBeUndefined();
    // ほかのリストから移してくる（足す）のはできる
    const [todo] = book.addCards(S, 'claude', other.id, [{ title: 'テストは Vitest で書く' }]);
    book.moveCards(S, 'claude', other.id, [todo.id], list.id);
    expect(liveCards(list)).toHaveLength(3);
  });

  // 直す前: Claude が取り消したカードは画面に残り続け、人が 1 枚ずつ消すしかなかった
  it('取り消しは理由が要る。Claude が取り消したカードは、理由をスレッドに残してゴミ箱に入る（画面にたまらない）', () => {
    const { book, list, cards } = withDecisions();
    expect(denied(() => book.revokeCards(S, 'claude', list.id, [cards[1].id], '  '))).toBe('reason is required.');
    const revoked = book.revokeCards(S, 'claude', list.id, [cards[1].id], '経理の指示で四捨五入に変わった');
    expect(revoked).toHaveLength(1);
    expect(cards[1].revoked).toMatchObject({ by: 'claude', reason: '経理の指示で四捨五入に変わった' });
    expect(cards[1].deletedAt).toBeDefined();
    expect(liveCards(list).map((c) => c.title)).toEqual(['決済には触らない']);
    expect(activeCards(list).map((c) => c.title)).toEqual(['決済には触らない']);
    expect(cards[1].thread.slice(-2)).toMatchObject([
      { kind: 'event', author: 'claude', event: { type: 'revoked', reason: '経理の指示で四捨五入に変わった' } },
      { kind: 'event', author: 'claude', event: { type: 'deleted' } },
    ]);
    // 取り消し済みのものは、もう一度取り消さない
    expect(book.revokeCards(S, 'claude', list.id, [cards[1].id], '別の理由')).toEqual([]);
    expect(cards[1].revoked!.reason).toBe('経理の指示で四捨五入に変わった');
  });

  it('Claude は、画面に残っている取り消したカード（人が取り消したもの・前のバージョンで取り消したもの）を消せる。有効なカードが混じれば、どれも消さない', () => {
    const { book, list, cards } = withDecisions(['A', 'B', 'C']);
    book.apply(S, { type: 'card-revoke', listId: list.id, cardIds: [cards[0].id, cards[1].id] });
    expect(denied(() => book.deleteCards(S, 'claude', list.id, [cards[1].id, cards[2].id]))).toBe(
      '"決定事項" is a decisions list: permanent, no checks. You can delete only revoked cards from it, and #3 "C" is in force. If a decision no longer holds, revoke it with card_revoke and a reason; that also moves it to the trash.',
    );
    expect(liveCards(list)).toHaveLength(3);
    expect(book.deleteCards(S, 'claude', list.id, [cards[0].id, cards[1].id])).toHaveLength(2);
    expect(liveCards(list).map((c) => c.title)).toEqual(['C']);
    expect(cards[0].thread.at(-1)).toMatchObject({ author: 'claude', event: { type: 'deleted' } });
    // 人は、ゴミ箱から戻せる（取り消したまま戻る）
    book.apply(S, { type: 'card-restore', listId: list.id, cardIds: [cards[0].id] });
    expect(cards[0].deletedAt).toBeUndefined();
    expect(cards[0].revoked).toMatchObject({ by: 'human' });
  });

  it('取り消しを戻せるのは人だけ。Claude が取り消してゴミ箱に入ったカードは、人がゴミ箱から戻して、有効に戻す', () => {
    const { book, list, cards } = withDecisions();
    book.revokeCards(S, 'claude', list.id, [cards[0].id], '間違い');
    expect(denied(() => book.reinstateCards(S, 'claude', list.id, [cards[0].id]))).toContain('Only the user can reinstate');
    expect(denied(() => book.restoreCards(S, 'claude', list.id, [cards[0].id]))).toContain('cannot restore its cards from the trash; only the user can');
    book.takeHumanActivity(S);
    book.apply(S, { type: 'card-restore', listId: list.id, cardIds: [cards[0].id] });
    book.apply(S, { type: 'card-reinstate', listId: list.id, cardIds: [cards[0].id] });
    expect(cards[0].deletedAt).toBeUndefined();
    expect(cards[0].revoked).toBeUndefined();
    expect(activeCards(list).map((c) => c.title)).toEqual(['決済には触らない', '端数は切り捨て']);
    expect(cards[0].thread.at(-1)).toMatchObject({ author: 'human', event: { type: 'reinstated' } });
    expect(book.takeHumanActivity(S)).toEqual([
      'The user restored #1 "決済には触らない" in "決定事項" from the trash',
      'The user reinstated #1 "決済には触らない" in "決定事項" (in force again)',
    ]);
  });

  // 人が消した決定を Claude が戻せると、その決定がまた有効になる（取り消しを戻せるのが人だけなのと同じ）
  it('人がゴミ箱に入れたカードを、Claude は戻せない。人は戻せる', () => {
    const { book, list, cards } = withDecisions();
    book.apply(S, { type: 'card-delete', listId: list.id, cardIds: [cards[0].id] });
    const message = denied(() => book.restoreCards(S, 'claude', list.id, [cards[0].id]));
    expect(message).toContain('cannot restore its cards from the trash; only the user can');
    expect(message).toContain('If the decision holds again, add it as a new card.');
    expect(cards[0].deletedAt).toBeDefined();
    expect(activeCards(list).map((c) => c.title)).toEqual(['端数は切り捨て']);
    book.apply(S, { type: 'card-restore', listId: list.id, cardIds: [cards[0].id] });
    expect(cards[0].deletedAt).toBeUndefined();
  });

  it('人がリストごとゴミ箱に入れたとき、Claude はカードを戻せない（リストも一緒に戻ってしまう）・リストも戻せない。人は戻せる', () => {
    const { book, list, cards } = withDecisions();
    book.apply(S, { type: 'card-delete', listId: list.id, cardIds: [cards[0].id] });
    book.apply(S, { type: 'list-delete', listId: list.id });
    expect(denied(() => book.restoreCards(S, 'claude', list.id, [cards[0].id]))).toContain('cannot restore its cards from the trash');
    expect(denied(() => book.restoreList(S, 'claude', list.id))).toContain('cannot restore the list from the trash; only the user can');
    expect(list.deletedAt).toBeDefined();
    expect(cards[0].deletedAt).toBeDefined();
    expect(book.findList(S, '決定事項')).toBeUndefined();
    book.apply(S, { type: 'card-restore', listId: list.id, cardIds: [cards[0].id] });
    expect(list.deletedAt).toBeUndefined();
    expect(cards[0].deletedAt).toBeUndefined();
  });

  it('ふつうのリストでは、これまでどおり Claude もゴミ箱から戻せる', () => {
    const book = make();
    const list = book.createList(S, 'claude', 'やること', '');
    const [card] = book.addCards(S, 'claude', list.id, [{ title: 'A' }]);
    book.deleteCards(S, 'claude', list.id, [card.id]);
    expect(book.restoreCards(S, 'claude', list.id, [card.id])).toHaveLength(1);
    book.deleteList(S, 'claude', list.id);
    book.restoreList(S, 'claude', list.id);
    expect(list.deletedAt).toBeUndefined();
  });

  it('ふつうのリストのカードは取り消せない', () => {
    const book = make();
    const list = book.createList(S, 'claude', 'やること', '');
    const [card] = book.addCards(S, 'claude', list.id, [{ title: 'A' }]);
    expect(denied(() => book.revokeCards(S, 'claude', list.id, [card.id], '理由'))).toContain('is an ordinary list');
    expect(denied(() => book.apply(S, { type: 'card-revoke', listId: list.id, cardIds: [card.id] }))).toBe('「やること」のカードは取り消せません（取り消せるのは、決定事項のリストのカードだけです）');
  });
});

describe('決定事項のリスト（人ができること）', () => {
  it('人は、直す・消す・取り消す（理由なしでも）・戻す・外へ移す・リストを消す、がすべてできる', () => {
    const { book, list, cards } = withDecisions(['A', 'B', 'C']);
    const other = book.createList(S, 'human', 'やること', '');
    book.apply(S, { type: 'card-update', listId: list.id, cardId: cards[0].id, title: 'A（直した）' });
    expect(cards[0].title).toBe('A（直した）');
    book.apply(S, { type: 'card-revoke', listId: list.id, cardIds: [cards[1].id] });
    expect(cards[1].revoked).toMatchObject({ by: 'human', reason: '' });
    // 人が取り消したものは、ゴミ箱に入れず、画面に残す
    expect(cards[1].deletedAt).toBeUndefined();
    book.apply(S, { type: 'card-delete', listId: list.id, cardIds: [cards[2].id] });
    expect(cards[2].deletedAt).toBeDefined();
    // 外へ移すと、取り消しの印は外す（ふつうのリストに、取り消しは無い）
    book.apply(S, { type: 'card-move', listId: list.id, cardIds: [cards[1].id], toListId: other.id });
    expect(cards[1].revoked).toBeUndefined();
    book.apply(S, { type: 'list-delete', listId: list.id });
    expect(list.deletedAt).toBeDefined();
  });

  it('人でも、チェックは付けられない（チェックで消すリストではないため）', () => {
    const { book, list, cards } = withDecisions();
    expect(denied(() => book.apply(S, { type: 'card-check', listId: list.id, cardIds: [cards[0].id], checked: true }))).toBe('「決定事項」のカードには、チェックがありません');
    expect(cards[0].checked).toBe(false);
  });

  it('画面から届いた書き換えの形を確かめる（種類・取り消し）', () => {
    expect(checkOp({ type: 'list-create', name: 'A', description: '', kind: 'decisions' })).toMatchObject({ kind: 'decisions' });
    expect(() => checkOp({ type: 'list-create', name: 'A', description: '', kind: 'permanent' })).toThrow();
    expect(() => checkOp({ type: 'list-update', listId: 'l', kind: 1 })).toThrow();
    expect(checkOp({ type: 'card-revoke', listId: 'l', cardIds: ['c'] })).toMatchObject({ type: 'card-revoke' });
    expect(() => checkOp({ type: 'card-revoke', listId: 'l', cardIds: ['c'], reason: 1 })).toThrow();
    expect(() => checkOp({ type: 'card-reinstate', listId: 'l', cardIds: 'c' })).toThrow();
  });
});

describe('承認した判断を、決定事項に移す', () => {
  function withReview() {
    const book = make();
    const review = book.createList(S, 'claude', '確認事項', '判断と理由を書く', 'review');
    const cards = book.addCards(S, 'claude', review.id, [{ title: '端数は四捨五入にした', body: '経理の指示' }, { title: '税率は設定ファイルに置いた' }]);
    return { book, review, cards };
  }

  it('確認事項のリストで人がチェックすると、決定事項のリストに移る。決定事項のリストが無ければ作る', () => {
    const { book, review, cards } = withReview();
    book.takeHumanActivity(S);
    book.apply(S, { type: 'card-check', listId: review.id, cardIds: [cards[0].id], checked: true });
    const decisions = book.findList(S, '決定事項')!;
    expect(decisions).toMatchObject({ kind: 'decisions', createdBy: 'human' });
    expect(decisions.description).not.toBe('');
    expect(liveCards(review).map((c) => c.title)).toEqual(['税率は設定ファイルに置いた']);
    expect(activeCards(decisions).map((c) => [c.number, c.title, c.body])).toEqual([[1, '端数は四捨五入にした', '経理の指示']]);
    // スレッドは残り、承認と移動の記録が付く
    expect(cards[0].thread.map((e) => (e.kind === 'event' ? e.event.type : 'reply'))).toEqual(['created', 'checked', 'moved']);
    expect(cards[0].thread.at(-1)).toMatchObject({ author: 'human', event: { type: 'moved', fromList: '確認事項', fromNumber: 1 } });
    // Claude には、次のツールの結果で伝わる
    const activity = book.takeHumanActivity(S).join('\n');
    expect(activity).toContain('The user checked #1 "端数は四捨五入にした" in "確認事項"');
    expect(activity).toContain('The user moved 1 card from "確認事項" to "決定事項" (#1 "端数は四捨五入にした")');
  });

  it('すでにある決定事項のリストに足す（名前は問わない）。まとめて承認したものは、まとめて移る', () => {
    const { book, review, cards } = withReview();
    const kept = book.createList(S, 'claude', '決めたこと', '', 'decisions');
    book.addCards(S, 'claude', kept.id, [{ title: '決済には触らない' }]);
    book.apply(S, { type: 'card-check', listId: review.id, cardIds: cards.map((c) => c.id), checked: true });
    expect(book.findList(S, '決定事項')).toBeUndefined();
    expect(activeCards(kept).map((c) => `#${c.number} ${c.title}`)).toEqual(['#1 決済には触らない', '#2 端数は四捨五入にした', '#3 税率は設定ファイルに置いた']);
    expect(liveCards(review)).toEqual([]);
  });

  it('Claude がチェックしても移さない（承認は人のもの）。チェックを外しても移さない', () => {
    const { book, review, cards } = withReview();
    book.setChecked(S, 'claude', review.id, [cards[0].id], true);
    expect(liveCards(review)).toHaveLength(2);
    expect(book.lists(S)).toHaveLength(1);
    book.apply(S, { type: 'card-check', listId: review.id, cardIds: [cards[0].id], checked: false });
    expect(liveCards(review)).toHaveLength(2);
    // すでにチェック済みのカードを人がチェックしても、変わっていないので移さない
    book.setChecked(S, 'claude', review.id, [cards[1].id], true);
    book.apply(S, { type: 'card-check', listId: review.id, cardIds: [cards[1].id], checked: true });
    expect(liveCards(review)).toHaveLength(2);
  });

  it('ふつうのリスト（種類の無い、古い「確認事項」も）では、人がチェックしても移さない', () => {
    const book = make();
    const list = book.createList(S, 'claude', '確認事項', '');
    const [card] = book.addCards(S, 'claude', list.id, [{ title: 'A' }]);
    book.apply(S, { type: 'card-check', listId: list.id, cardIds: [card.id], checked: true });
    expect(liveCards(list)).toHaveLength(1);
    expect(book.lists(S)).toHaveLength(1);
    // 人が種類を確認事項に変えれば、次の承認から移る
    book.apply(S, { type: 'list-update', listId: list.id, kind: 'review' });
    const [next] = book.addCards(S, 'claude', list.id, [{ title: 'B' }]);
    book.apply(S, { type: 'card-check', listId: list.id, cardIds: [next.id], checked: true });
    expect(activeCards(book.findList(S, '決定事項')!).map((c) => c.title)).toEqual(['B']);
  });
});

describe('別のセッションへのコピー', () => {
  it('先にリストを作るときは、種類も写す。取り消しの印も写す', () => {
    const { book, list, cards } = withDecisions();
    book.revokeCards(S, 'claude', list.id, [cards[1].id], '変わった');
    const result = book.copyCards({ sessionId: S, title: '元', listId: list.id, cardIds: cards.map((c) => c.id) }, T, 'claude');
    expect(result.list.kind).toBe('decisions');
    expect(result.cards.map((c) => !!c.revoked)).toEqual([false, true]);
  });

  it('先がふつうのリストなら、取り消しの印は写さない', () => {
    const { book, list, cards } = withDecisions();
    book.revokeCards(S, 'claude', list.id, [cards[1].id], '変わった');
    book.createList(T, 'human', '決定事項', '');
    const result = book.copyCards({ sessionId: S, title: '元', listId: list.id, cardIds: [cards[1].id] }, T, 'claude');
    expect(result.cards[0].revoked).toBeUndefined();
  });
});

describe('記録の行の文', () => {
  it('取り消し・戻しを、英語の文にする', () => {
    expect(eventText({ type: 'revoked', reason: '変わった' }, 'Claude')).toBe('Claude revoked the card (変わった)');
    expect(eventText({ type: 'revoked', reason: '' }, 'The user')).toBe('The user revoked the card');
    expect(eventText({ type: 'reinstated' }, 'The user')).toBe('The user reinstated the card (it is in force again)');
  });
});

// --- 知らせ ---

const card = (number: number, title: string, extra: Partial<Card> = {}): Card => ({
  id: `c${number}`,
  number,
  title,
  body: '',
  checked: false,
  createdBy: 'claude',
  createdAt: 0,
  updatedAt: 0,
  thread: [],
  readByClaude: 0,
  readByHuman: 0,
  ...extra,
});
const list = (name: string, cards: Card[], extra: Partial<Checklist> = {}): Checklist => ({
  id: name,
  name,
  description: '',
  nextNumber: cards.length + 1,
  cards,
  createdBy: 'claude',
  createdAt: 0,
  ...extra,
});

const DECISIONS = list(
  '決定事項',
  [
    card(1, '決済には触らない'),
    card(2, '端数は切り捨て', { revoked: { by: 'claude', at: 1, reason: '四捨五入に変わった' } }),
    card(3, 'ゴミ箱の決定', { deletedAt: 1 }),
    // チェックの印が残っていても（承認して移したカード）、決定事項では関係ない
    card(4, '端数は四捨五入', { checked: true, checkedBy: 'human' }),
  ],
  { kind: 'decisions', description: '決まったこと' },
);
const TODO = list('やること', [card(1, '税率を変える', { checked: true }), card(2, 'README を直す')]);

describe('知らせに、有効な決定をいつも出す', () => {
  it('発言のとき: 有効なカードを全部、ほかのリストより先に出す。取り消したもの・ゴミ箱のものは出さない', () => {
    const text = checklistReminder('prompt', [TODO, DECISIONS], NONE)!;
    expect(text).toContain('## 決定事項 (decisions; 2 in force, 1 revoked and not shown)\nDescription: 決まったこと\n- #1 決済には触らない\n- #4 端数は四捨五入');
    expect(text).not.toContain('端数は切り捨て');
    expect(text).not.toContain('ゴミ箱の決定');
    expect(text.indexOf('## 決定事項')).toBeLessThan(text.indexOf('## やること'));
    expect(text).toContain('Decisions in force.');
    expect(text).toContain('## やること (1/2 checked)\n- [ ] #2 README を直す');
    expect(text).toContain('record it on the decisions list now');
  });

  it('圧縮の直後: 同じく出す', () => {
    const text = checklistReminder('compact', [TODO, DECISIONS], NONE)!;
    expect(text).toContain('- #1 決済には触らない\n- #4 端数は四捨五入');
    expect(text).not.toContain('端数は切り捨て');
    expect(text).toContain('- [x] #1 税率を変える');
  });

  it('決定事項のリストだけでも出す。有効なカードが無ければ、そう書く', () => {
    expect(checklistReminder('prompt', [DECISIONS], NONE)).toContain('- #1 決済には触らない');
    const empty = list('決定事項', [card(1, 'A', { revoked: { by: 'human', at: 1, reason: '' } })], { kind: 'decisions' });
    expect(checklistReminder('prompt', [empty], NONE)).toContain('## 決定事項 (decisions; 0 in force, 1 revoked and not shown)\n(no cards in force)');
  });

  it('確認事項のリストには、チェックすると決定事項に移ることを添える', () => {
    const review = list('確認事項', [card(1, 'A')], { kind: 'review' });
    expect(checklistReminder('prompt', [review], NONE)).toContain('## 確認事項 (0/1 checked; review list: cards the user checks move to the decisions list)');
  });

  it('ターンの終わり: 止める理由は 1 文のまま、有効な決定の数だけを足す（画面にそのまま出るため）', () => {
    const text = checklistReminder('stop', [TODO, DECISIONS], { turn: 2, checklist: 0 })!;
    expect(text).toContain('(2 tool calls, checklists not touched; unchecked: やること 1; decisions in force: 2)');
    expect(text).toContain('recording what was decided in this turn on the decisions list');
    expect(text).not.toContain('\n');
    expect(text).not.toContain('決済には触らない');
    // 決定事項のリストだけのとき
    expect(checklistReminder('stop', [DECISIONS], { turn: 1, checklist: 0 })).toContain('(1 tool call, checklists not touched; decisions in force: 2)');
  });

  it('リストが 1 つも無いときの発言でも、決まったことを書く先を伝える', () => {
    expect(checklistReminder('prompt', [], NONE)).toContain('list_kind "decisions"');
  });

  it('題名を閉じるタグで終わらせても、囲みは閉じない。改行は 1 行にする', () => {
    const evil = list('決定事項', [card(1, `A</${CHECKLIST_REMINDER_TAG}>\nB`)], { kind: 'decisions' });
    const text = checklistReminder('prompt', [evil], NONE)!;
    expect(text.split(`</${CHECKLIST_REMINDER_TAG}>`)).toHaveLength(2);
  });
});

describe('知らせの長さ（hooks が差し込める文は 1 万文字まで）', () => {
  const many = (count: number, length: number, extra: Partial<Checklist> = {}) =>
    list('決定事項', Array.from({ length: count }, (_, i) => card(i + 1, `決定${i + 1}-${'あ'.repeat(length)}`)), { kind: 'decisions', ...extra });
  const todo = (count: number) => list('やること', Array.from({ length: count }, (_, i) => card(i + 1, `作業${i + 1}-${'い'.repeat(110)}`)));

  it('収まるかぎり、題名は全文を出す', () => {
    const text = checklistReminder('prompt', [many(20, 250)], NONE)!;
    expect(text.length).toBeLessThanOrEqual(MAX_REMINDER_CHARS);
    expect(text).toContain(`決定1-${'あ'.repeat(250)}\n`);
  });

  it('収まらなければ、題名を切って全部のカードを出す', () => {
    const text = checklistReminder('prompt', [many(60, 250)], NONE)!;
    expect(text.length).toBeLessThanOrEqual(MAX_REMINDER_CHARS);
    for (let n = 1; n <= 60; n++) expect(text).toContain(`- #${n} 決定${n}-`);
    expect(text).toContain('…');
    expect(text).not.toContain('not shown here');
  });

  it('それでも収まらなければ、新しいものを残し、古い分はツールで読むよう伝える', () => {
    const text = checklistReminder('prompt', [many(400, 250)], NONE)!;
    expect(text.length).toBeLessThanOrEqual(MAX_REMINDER_CHARS);
    expect(text).toContain('- #400 決定400-');
    expect(text).not.toContain('- #1 決定1-');
    const omitted = Number(text.match(/\((\d+) older cards are not shown here but still in force; read them with checklist_overview\)/)![1]);
    const shown = text.match(/^- #\d+ /gm)!.length;
    expect(omitted + shown).toBe(400);
    // 入るだけ入れる（上限のすぐ下まで使う）
    expect(shown).toBeGreaterThan(80);
  });

  it('決定が多くても、ほかのリストの分を残す。ほかのリストは、カードの数を減らして収める', () => {
    for (const event of ['prompt', 'compact'] as const) {
      const text = checklistReminder(event, [todo(40), many(400, 250), list('完了前チェック', todo(40).cards), list('人のやること', todo(40).cards)], NONE)!;
      expect(text.length).toBeLessThanOrEqual(MAX_REMINDER_CHARS);
      expect(text).toContain('- #400 決定400-');
      expect(text).toContain('## やること (0/40 checked)');
      expect(text).toContain('## 人のやること (0/40 checked)');
      expect(text).toContain('- [ ] #1 作業1-');
      expect(text).toMatch(/\(\d+ more cards; see checklist_overview\)/);
    }
  });

  it('決定事項が無くても、上限に収める（リストが多いと、これまでは 1 万文字を超えた）', () => {
    const lists = Array.from({ length: 12 }, (_, i) => list(`リスト${i}`, todo(40).cards, { description: 'う'.repeat(300) }));
    const text = checklistReminder('prompt', lists, NONE)!;
    expect(text.length).toBeLessThanOrEqual(MAX_REMINDER_CHARS);
    expect(text).toContain('## リスト11 (0/40 checked)');
  });

  it('リストの数だけで上限を超えるときも、上限で切って、囲みは閉じる', () => {
    const lists = Array.from({ length: 200 }, (_, i) => list(`リスト${i}`, [], { description: 'う'.repeat(300) }));
    const text = checklistReminder('prompt', [many(400, 250), ...lists], NONE)!;
    expect(text.length).toBeLessThanOrEqual(MAX_REMINDER_CHARS);
    expect(text.endsWith(`\n</${CHECKLIST_REMINDER_TAG}>`)).toBe(true);
    expect(text).toContain('(more lists; see checklist_overview)');
  });
});

// --- MCP のツール ---

const ME = '11111111-0000-4000-8000-000000000001';

class FakeHost implements NoticeHost {
  sessions: SessionSummary[] = [
    {
      id: ME,
      title: 's',
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
    },
  ];
  list = () => this.sessions;
  stateOf = (): SessionState => 'idle';
  screen = (): ScreenInfo => ({ state: { kind: 'prompt' }, model: null, effort: null, mode: null, draft: '', ready: true });
  submitWhenReady = async () => {};
  watchState = () => () => {};
}

describe('MCP のツール', () => {
  let dir: string;
  let store: ChecklistStore;
  let control: ChecklistControl;
  const call = (name: string, args: Record<string, unknown> = {}) => control.handle(ME, name, args);
  const first = (result: ToolResult) => (result.content[0] as { text: string }).text;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-decisions-'));
    store = new ChecklistStore(dir);
    control = new ChecklistControl({ store, host: new FakeHost(), enabled: () => true, notifyDelayMs: 10 });
  });
  afterEach(() => {
    control.dispose();
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('card_add の list_kind・list_create の kind で、決定事項と確認事項のリストを作る。知らない種類は断る', async () => {
    expect(first(await call('card_add', { list: '決定事項', list_description: '決まったこと', list_kind: 'decisions', cards: [{ title: '決済には触らない' }] }))).toBe(
      'Created the list "決定事項" as a decisions list (permanent, no checks; you can add cards and revoke them with card_revoke). Added #1 "決済には触らない" to "決定事項".',
    );
    expect(first(await call('list_create', { name: '確認事項', description: '', kind: 'review' }))).toBe('Created the list "確認事項" as a review list (cards the user checks move to the decisions list).');
    expect(store.findList(ME, '決定事項')!.kind).toBe('decisions');
    expect(store.findList(ME, '確認事項')!.kind).toBe('review');
    const bad = await call('list_create', { name: 'X', description: '', kind: 'permanent' });
    expect(bad.isError).toBe(true);
    expect(first(bad)).toBe('kind must be "decisions", "state" or "review" (omit it for an ordinary list).');
    expect(store.findList(ME, 'X')).toBeUndefined();
  });

  it('決定事項の有効なカードは、Claude のツールでは消せない・書き換えられない・チェックできない。断る文で card_revoke を案内する', async () => {
    await call('card_add', { list: '決定事項', list_description: '', list_kind: 'decisions', cards: [{ title: '決済には触らない' }] });
    for (const [name, args] of [
      ['card_delete', { list: '決定事項', numbers: '1' }],
      ['card_update', { list: '決定事項', number: 1, title: '決済に触ってよい' }],
      ['card_move', { list: '決定事項', numbers: '1', to_list: 'やること' }],
      ['card_check', { list: '決定事項', numbers: '1' }],
      ['card_uncheck', { list: '決定事項', numbers: '1', reason: 'x' }],
      ['list_delete', { list: '決定事項' }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(first(result), name).toContain('card_revoke');
    }
    const list = store.findList(ME, '決定事項')!;
    expect(activeCards(list).map((c) => c.title)).toEqual(['決済には触らない']);
  });

  it('card_restore: 人がゴミ箱に入れた決定事項のカードは、Claude のツールでは戻せない', async () => {
    await call('card_add', { list: '決定事項', list_description: '', list_kind: 'decisions', cards: [{ title: '決済には触らない' }] });
    const list = store.findList(ME, '決定事項')!;
    control.apply(ME, { type: 'card-delete', listId: list.id, cardIds: [list.cards[0].id] });
    const result = await call('card_restore', { list: '決定事項', numbers: '1' });
    expect(result.isError).toBe(true);
    expect(first(result)).toContain('you cannot restore its cards from the trash; only the user can');
    expect(list.cards[0].deletedAt).toBeDefined();
    expect(first(await call('hook:prompt', { turn: 0, checklist: 0 }))).not.toContain('決済には触らない');
  });

  it('card_revoke: 理由つきで取り消して、ゴミ箱に入れる。理由が無ければ断る。人が取り消して残っているものは、一覧とカードに理由が出て、card_delete で消せる', async () => {
    await call('card_add', {
      list: '決定事項',
      list_description: '決まったこと',
      list_kind: 'decisions',
      cards: [{ title: '決済には触らない' }, { title: '端数は切り捨て' }, { title: '税率は 10%' }],
    });
    const list = store.findList(ME, '決定事項')!;
    control.apply(ME, { type: 'card-revoke', listId: list.id, cardIds: [list.cards[2].id], reason: '税率は別の PR で' });
    const noReason = await call('card_revoke', { list: '決定事項', numbers: '2' });
    expect(noReason.isError).toBe(true);
    expect(first(noReason)).toBe('reason is required.');
    expect(first(await call('card_revoke', { list: '決定事項', numbers: '2,3', reason: '経理の指示で\n四捨五入に変わった' }))).toBe(
      'Revoked #2 in "決定事項" and moved it to the trash (no longer in force; the reason stays in the thread, and only the user can restore and reinstate it). #3 was already revoked. 1 card in force in "決定事項".',
    );
    expect(list.cards[1]).toMatchObject({ revoked: { by: 'claude', reason: '経理の指示で\n四捨五入に変わった' }, deletedAt: expect.any(Number) });
    expect(first(await call('checklist_overview'))).toBe(
      '## 決定事項 (decisions list: permanent, no checks; 1 in force, 1 revoked)\nDescription: 決まったこと\n- #1 決済には触らない\n- (revoked: 税率は別の PR で) #3 税率は 10%',
    );
    const got = first(await call('card_get', { list: '決定事項', numbers: '1,3' }));
    expect(got).toContain('## "決定事項" #1 決済には触らない\n- Status: in force');
    expect(got).toMatch(/## "決定事項" #3 税率は 10%\n- Status: revoked, no longer in force \(by the user, [\d: -]+: 税率は別の PR で\)/);
    expect(got).toContain('The user revoked the card (税率は別の PR で)');
    // 人が取り消したものは、Claude が消せる。戻せるのは人だけ
    expect(first(await call('card_delete', { list: '決定事項', numbers: '3' }))).toBe('Moved #3 in "決定事項" to the trash (the user can restore it in the app).');
    expect(first(await call('checklist_overview'))).toBe('## 決定事項 (decisions list: permanent, no checks; 1 in force)\nDescription: 決まったこと\n- #1 決済には触らない');
  });

  it('ふつうのリストでの card_revoke は断る。確認事項の一覧には、承認で移ることを書く', async () => {
    await call('card_add', { list: 'やること', list_description: '', cards: [{ title: 'A' }] });
    const result = await call('card_revoke', { list: 'やること', numbers: '1', reason: 'x' });
    expect(result.isError).toBe(true);
    expect(first(result)).toContain('is an ordinary list');
    await call('list_create', { name: '確認事項', description: '', kind: 'review' });
    expect(first(await call('checklist_overview'))).toContain('## 確認事項 (0/0 checked; review list: cards the user checks move to the decisions list)');
  });

  // 直す前: 人が承認（チェック）した判断は、そのあとの知らせから消えた（未チェックのカードだけを出すため）
  it('人が承認した判断は、そのあとの発言の知らせにも、圧縮の直後の知らせにも出続ける', async () => {
    await call('card_add', { list: '確認事項', list_description: '判断と理由', list_kind: 'review', cards: [{ title: '端数は四捨五入にした' }] });
    const review = store.findList(ME, '確認事項')!;
    control.apply(ME, { type: 'card-check', listId: review.id, cardIds: [review.cards[0].id], checked: true });
    for (const hook of ['hook:prompt', 'hook:compact']) {
      const text = first(await call(hook, { turn: 0, checklist: 0 }));
      expect(text, hook).toContain('## 決定事項 (decisions; 1 in force)');
      expect(text, hook).toContain('- #1 端数は四捨五入にした');
    }
    // Claude が取り消すと、有効な決定としては出なくなる
    await call('card_revoke', { list: '決定事項', numbers: '1', reason: 'ユーザーが切り捨てに戻した' });
    expect(first(await call('hook:prompt', { turn: 0, checklist: 0 }))).not.toContain('端数は四捨五入にした');
    // 人がゴミ箱から戻して、有効に戻すと、また出る
    const decisions = store.findList(ME, '決定事項')!;
    control.apply(ME, { type: 'card-restore', listId: decisions.id, cardIds: [decisions.cards[0].id] });
    control.apply(ME, { type: 'card-reinstate', listId: decisions.id, cardIds: [decisions.cards[0].id] });
    expect(first(await call('hook:prompt', { turn: 0, checklist: 0 }))).toContain('- #1 端数は四捨五入にした');
  });

  it('説明とツールの定義で、決まった時点で書くこと・書くもの・取り消し方を伝える', () => {
    expect(CHECKLIST_MCP_INSTRUCTIONS).toContain('Write a card the moment something is decided');
    expect(CHECKLIST_MCP_INSTRUCTIONS).toContain('a permission and its scope');
    expect(CHECKLIST_MCP_INSTRUCTIONS).toContain('an option that was rejected, with the reason');
    expect(CHECKLIST_MCP_INSTRUCTIONS).toContain('card_revoke');
    const tool = (name: string) => CHECKLIST_TOOLS.find((t) => t.name === name)!;
    expect(tool('card_revoke').inputSchema.required).toEqual(['list', 'numbers', 'reason']);
    expect(tool('card_revoke').description).toContain('move to the trash');
    expect(tool('card_delete').description).toContain('On a decisions list, you can delete only revoked cards');
    expect(tool('list_create').inputSchema.properties.kind).toMatchObject({ enum: ['decisions', 'state', 'review'] });
    expect(tool('card_add').inputSchema.properties.list_kind).toMatchObject({ enum: ['decisions', 'state', 'review'] });
  });
});

describe('すでにあるデータ', () => {
  it('種類の無いリスト（これまでのファイル）は、ふつうのリストとして読める。書き直しても種類は足さない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-old-'));
    try {
      mkdirSync(dir, { recursive: true });
      const old = {
        version: 1,
        lists: [{ id: 'l1', name: '確認事項', description: '', nextNumber: 2, cards: [card(1, '古い判断', { id: 'c1' })], createdBy: 'claude', createdAt: 0 }],
        activity: [],
        claudeSeenAt: 0,
      };
      writeFileSync(join(dir, `${S}.json`), JSON.stringify(old));
      const store = new ChecklistStore(dir);
      const [list] = store.lists(S);
      expect(kindOf(list)).toBe('normal');
      // これまでどおり、チェックでき、チェックしても移らない
      store.apply(S, { type: 'card-check', listId: 'l1', cardIds: ['c1'], checked: true });
      expect(store.lists(S)).toHaveLength(1);
      expect(list.cards[0].checked).toBe(true);
      expect('kind' in list).toBe(false);
      expect(checklistReminder('prompt', store.lists(S), NONE)).toContain('## 確認事項 (1/1 checked)\n(every card is checked)');
      store.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
