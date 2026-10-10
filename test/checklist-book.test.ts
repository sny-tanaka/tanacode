import { describe, expect, it } from 'vitest';
import { checkCopyRequest, checkOp, claudeNumbers, cleanName, cleanTitle, eventText, formatNumbers, humanUnread, parseNumbers, type Checklist, type ChecklistOp } from '../src/shared/checklist';
import { ChecklistBook, ChecklistError } from '../src/shared/checklist-book';

// チェックリストの書き換え（ChecklistBook。画面と Claude が同じものをメモリの上で書き換える）と、
// 記録の行の文・画面から届いた値の確かめ。ファイルへの保存と MCP のツールは test/checklist.test.ts

const S = 'session-1';
const T = 'session-2';

// 時刻は止めておく（それでも書き換えのたびに 1 ずつ進む）
function make() {
  const changes: { sessionId: string; lists: Checklist[] }[] = [];
  const book = new ChecklistBook((sessionId, lists) => changes.push({ sessionId, lists }), () => 1000);
  return { book, changes };
}

describe('記録の行の文（eventText）', () => {
  it('どの記録も、主語を付けた英語の文にする（Claude に返す文なので、画面の言語によらない）', () => {
    expect(eventText({ type: 'created' }, 'Claude')).toBe('Claude created the card');
    expect(eventText({ type: 'checked' }, 'The user')).toBe('The user checked the card');
    expect(eventText({ type: 'unchecked' }, 'The user')).toBe('The user unchecked the card');
    expect(eventText({ type: 'title', from: '古い題' }, 'Claude')).toBe('Claude changed the title from "古い題"');
    expect(eventText({ type: 'body' }, 'The user')).toBe('The user edited the body');
    expect(eventText({ type: 'moved', fromList: 'やること', fromNumber: 3 }, 'The user')).toBe('The user moved the card from "やること" #3');
    expect(eventText({ type: 'copied', fromSessionTitle: 'ログイン', fromList: '確認', fromNumber: 2 }, 'Claude')).toBe(
      'Claude copied the card from "確認" #2 in session "ログイン"',
    );
    expect(eventText({ type: 'deleted' }, 'The user')).toBe('The user moved the card to the trash');
    expect(eventText({ type: 'restored' }, 'The user')).toBe('The user restored the card from the trash');
  });

  it('who を省くと主語を付けず、文の頭を大文字にする', () => {
    expect(eventText({ type: 'deleted' })).toBe('Moved the card to the trash');
    expect(eventText({ type: 'title', from: 'A' }, '')).toBe('Changed the title from "A"');
  });

  it('番号の配列に読めないものが 1 つでもあれば、全体を読めないとする', () => {
    expect(parseNumbers([1, 0])).toBeNull();
    expect(parseNumbers([1, 'x'])).toBeNull();
    expect(parseNumbers([])).toEqual([]);
  });

  it('番号の読み方の境目: 2 桁の範囲・同じ数の範囲・幅 1000 までの範囲・末尾の区切りは読む。前後に余計な文字があれば読まない', () => {
    expect(parseNumbers('10-12')).toEqual([10, 11, 12]);
    expect(parseNumbers('5-5')).toEqual([5]);
    expect(parseNumbers('1-1001')).toHaveLength(1001);
    expect(parseNumbers('1-1002')).toBeNull();
    expect(parseNumbers('5,')).toEqual([5]);
    expect(parseNumbers('x5-8')).toBeNull();
    expect(parseNumbers('5-8x')).toBeNull();
  });

  it('番号を短く書く: 3 つ続けば範囲、2 つなら並べる。Claude に返す文の範囲は、画面の言語によらず番号の指定と同じ "-"', () => {
    expect(formatNumbers([7, 5, 6])).toBe('#5〜7');
    expect(formatNumbers([1, 2, 4, 5, 6, 9])).toBe('#1, #2, #4〜6, #9');
    expect(claudeNumbers([7, 5, 6])).toBe('#5-7');
    expect(claudeNumbers([1, 2, 4, 5, 6, 9])).toBe('#1, #2, #4-6, #9');
  });

  it('名前とタイトルは、改行・タブの続きを 1 つの空白にし、前後の空白を除いて、長さを切る（名前 80 文字・タイトル 300 文字）', () => {
    expect(cleanName(' 確認\r\n\t事項 ')).toBe('確認 事項');
    expect(cleanName('あ'.repeat(100))).toBe('あ'.repeat(80));
    expect(cleanTitle('税込\n\n表示')).toBe('税込 表示');
    expect(cleanTitle('あ'.repeat(400))).toBe('あ'.repeat(300));
  });
});

describe('画面から届いた値の確かめ', () => {
  it('checkOp: どの種類の書き換えも、形が合えばそのまま返す（省ける項目は省いても、null でない before も通す）', () => {
    const valid: ChecklistOp[] = [
      { type: 'list-create', name: 'n', description: 'd' },
      { type: 'list-update', listId: 'l' },
      { type: 'list-update', listId: 'l', name: 'n', description: 'd' },
      { type: 'list-delete', listId: 'l' },
      { type: 'list-restore', listId: 'l' },
      { type: 'card-add', listId: 'l', title: 't' },
      { type: 'card-add', listId: 'l', title: 't', body: 'b' },
      { type: 'card-update', listId: 'l', cardId: 'c' },
      { type: 'card-update', listId: 'l', cardId: 'c', title: 't', body: 'b' },
      { type: 'card-check', listId: 'l', cardIds: ['c'], checked: false },
      { type: 'card-reply', listId: 'l', cardId: 'c', text: 'x', notify: false },
      { type: 'card-move', listId: 'l', cardIds: ['c'], toListId: 'm' },
      { type: 'card-move', listId: 'l', cardIds: ['c'], toListId: 'm', before: null },
      { type: 'card-move', listId: 'l', cardIds: ['c'], toListId: 'm', before: 'd' },
      { type: 'card-delete', listId: 'l', cardIds: [] },
      { type: 'card-restore', listId: 'l', cardIds: ['c', 'd'] },
      { type: 'card-read', listId: 'l', cardId: 'c' },
      { type: 'trash-empty' },
    ];
    for (const op of valid) expect(checkOp(op)).toBe(op);
  });

  it('checkOp: 形が違えば、どの項目が違うかを添えて投げる', () => {
    const bad: [unknown, string][] = [
      [null, '書き換えの形が違います'],
      ['card-add', '書き換えの形が違います'],
      [{ type: 1 }, '書き換えの形が違います'],
      [{ type: 'list-create', name: 'n' }, 'description が文字ではありません'],
      [{ type: 'list-update', listId: 'l', name: 3 }, 'name が文字ではありません'],
      [{ type: 'list-update', listId: 'l', description: null }, 'description が文字ではありません'],
      [{ type: 'list-delete' }, 'listId が文字ではありません'],
      [{ type: 'list-restore', listId: 1 }, 'listId が文字ではありません'],
      [{ type: 'card-add', listId: 'l', title: 't', body: null }, 'body が文字ではありません'],
      [{ type: 'card-add', listId: 'l' }, 'title が文字ではありません'],
      [{ type: 'card-update', listId: 'l', title: 't' }, 'cardId が文字ではありません'],
      [{ type: 'card-update', listId: 'l', cardId: 'c', title: 1 }, 'title が文字ではありません'],
      [{ type: 'card-update', listId: 'l', cardId: 'c', body: 2 }, 'body が文字ではありません'],
      [{ type: 'card-check', listId: 'l', cardIds: ['c', 1], checked: true }, 'cardIds の形が違います'],
      [{ type: 'card-check', listId: 'l', cardIds: ['c'], checked: 'yes' }, 'checked の形が違います'],
      [{ type: 'card-reply', listId: 'l', cardId: 'c', notify: true }, 'text が文字ではありません'],
      [{ type: 'card-reply', listId: 'l', cardId: 'c', text: 'x', notify: 1 }, 'notify の形が違います'],
      [{ type: 'card-move', listId: 'l', cardIds: ['c'] }, 'toListId が文字ではありません'],
      [{ type: 'card-move', listId: 'l', cardIds: ['c'], toListId: 'm', before: 3 }, 'before の形が違います'],
      [{ type: 'card-delete', listId: 'l' }, 'cardIds の形が違います'],
      [{ type: 'card-restore', listId: 'l', cardIds: 'c' }, 'cardIds の形が違います'],
      [{ type: 'card-read', listId: 'l' }, 'cardId が文字ではありません'],
      [{ type: 'rm' }, '知らない書き換えです: rm'],
    ];
    for (const [op, message] of bad) expect(() => checkOp(op), JSON.stringify(op)).toThrow(message);
  });

  it('checkCopyRequest: 形が合えばそのまま返し、違えば投げる', () => {
    const ok = { fromSession: 'a', listId: 'l', cardIds: ['c'], toSession: 'b', notify: true };
    expect(checkCopyRequest(ok)).toBe(ok);
    expect(checkCopyRequest({ ...ok, toList: '引き継ぎ' })).toMatchObject({ toList: '引き継ぎ' });
    const bad = [
      null,
      { ...ok, fromSession: 1 },
      { ...ok, listId: undefined },
      { ...ok, toSession: null },
      { ...ok, cardIds: 'c' },
      { ...ok, cardIds: ['c', 2] },
      { ...ok, toList: 3 },
      { ...ok, notify: 'yes' },
    ];
    for (const raw of bad) expect(() => checkCopyRequest(raw), JSON.stringify(raw)).toThrow('コピーの指定の形が違います');
  });
});

describe('ChecklistBook', () => {
  it('apply: 画面からの書き換えを、種類ごとの書き換えに振り分ける（書いた人は human）。書き換えるたびに知らせる', () => {
    const { book, changes } = make();
    book.apply(S, { type: 'list-create', name: 'やること', description: ' 上から ' });
    book.apply(S, { type: 'list-create', name: '完了', description: '' });
    const list = book.findList(S, 'やること')!;
    const done = book.findList(S, '完了')!;
    expect(list).toMatchObject({ description: '上から', createdBy: 'human' });
    book.apply(S, { type: 'card-add', listId: list.id, title: 'A' });
    book.apply(S, { type: 'card-add', listId: list.id, title: 'B', body: ' 説明 ' });
    const [a, b] = list.cards;
    expect([a.createdBy, b.body]).toEqual(['human', '説明']);
    book.apply(S, { type: 'card-update', listId: list.id, cardId: a.id, title: 'A2' });
    expect(a.title).toBe('A2');
    book.apply(S, { type: 'card-check', listId: list.id, cardIds: [a.id], checked: true });
    expect(a).toMatchObject({ checked: true, checkedBy: 'human' });
    book.apply(S, { type: 'card-reply', listId: list.id, cardId: a.id, text: 'メモ', notify: true });
    expect(a.thread.at(-1)).toMatchObject({ kind: 'reply', author: 'human', text: 'メモ', notify: true });
    // before を渡すとその前に、省くと最後に
    book.apply(S, { type: 'card-move', listId: list.id, cardIds: [b.id], toListId: list.id, before: a.id });
    expect(list.cards.map((c) => c.title)).toEqual(['B', 'A2']);
    book.apply(S, { type: 'card-move', listId: list.id, cardIds: [b.id], toListId: list.id });
    expect(list.cards.map((c) => c.title)).toEqual(['A2', 'B']);
    book.apply(S, { type: 'card-delete', listId: list.id, cardIds: [b.id] });
    expect(b.deletedAt).toBeGreaterThan(0);
    expect(b.thread.at(-1)).toMatchObject({ author: 'human', event: { type: 'deleted' } });
    book.apply(S, { type: 'card-restore', listId: list.id, cardIds: [b.id] });
    expect(b.deletedAt).toBeUndefined();
    book.apply(S, { type: 'list-update', listId: done.id, name: '完了前', description: 'ルール' });
    expect(done).toMatchObject({ name: '完了前', description: 'ルール' });
    book.apply(S, { type: 'list-delete', listId: done.id });
    expect(book.findList(S, '完了前')).toBeUndefined();
    book.apply(S, { type: 'list-restore', listId: done.id });
    expect(book.findList(S, '完了前')).toBe(done);
    // 自分で返信したカードを開いても、新しく読むものは無いので知らせない
    const before = changes.length;
    book.apply(S, { type: 'card-read', listId: list.id, cardId: a.id });
    expect(changes).toHaveLength(before);
    // Claude の返信を、開いて読む
    book.reply(S, 'claude', list.id, a.id, '見ました');
    expect(humanUnread(a)).toBe(1);
    book.apply(S, { type: 'card-read', listId: list.id, cardId: a.id });
    expect(humanUnread(a)).toBe(0);
    book.apply(S, { type: 'card-delete', listId: list.id, cardIds: [b.id] });
    book.apply(S, { type: 'list-delete', listId: done.id });
    book.apply(S, { type: 'trash-empty' });
    expect(book.lists(S).map((l) => l.name)).toEqual(['やること']);
    expect(list.cards.map((c) => c.title)).toEqual(['A2']);
    expect(changes).toHaveLength(19);
    expect(changes.every((c) => c.sessionId === S)).toBe(true);
    // 知らせるのは、書き換えたあとのリスト
    expect(changes.at(-1)?.lists).toBe(book.lists(S));
  });

  it('時刻は、時計が止まっていても書き換えのたびに進む（同じミリ秒でも未読の判定を取り違えない）', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [a, b] = book.addCards(S, 'human', list.id, [{ title: 'A' }, { title: 'B' }]);
    expect(list.createdAt).toBe(1000);
    expect(b.createdAt).toBeGreaterThan(a.createdAt);
    book.reply(S, 'claude', list.id, a.id, '見てください');
    expect(humanUnread(a)).toBe(1);
    book.markRead(S, 'human', list.id, a.id);
    expect(humanUnread(a)).toBe(0);
  });

  it('リストの名前・説明の変更: 書き方が違うだけなら変えず、記録も残さない。重なる名前は空いている番号を足す', () => {
    const { book } = make();
    const a = book.createList(S, 'human', 'ToDo', 'ルール');
    book.createList(S, 'human', 'メモ', '');
    book.createList(S, 'human', 'メモ (2)', '');
    book.takeHumanActivity(S);
    book.updateList(S, 'human', a.id, { name: ' ｔｏｄｏ ', description: ' ルール ' });
    expect(a).toMatchObject({ name: 'ToDo', description: 'ルール' });
    expect(book.takeHumanActivity(S)).toEqual([]);
    book.updateList(S, 'human', a.id, { name: 'メモ' });
    expect(a.name).toBe('メモ (3)');
    book.updateList(S, 'human', a.id, { description: ' 新しいルール ' });
    expect(a.description).toBe('新しいルール');
    expect(book.takeHumanActivity(S)).toEqual(['The user renamed the list "ToDo" to "メモ (3)"', 'The user changed the description of the list "メモ (3)" to: 新しいルール']);
    expect(() => book.updateList(S, 'human', 'none', { name: 'x' })).toThrow(ChecklistError);
  });

  it('リストを戻す: 戻すまでに同じ名前のリストを作っていれば、名前を変えて戻す。ゴミ箱に無い・無いリストは何もしない', () => {
    const { book, changes } = make();
    const old = book.createList(S, 'human', '確認', '');
    book.deleteList(S, 'human', old.id);
    book.createList(S, 'human', '確認', '');
    book.restoreList(S, 'claude', old.id);
    expect(old.name).toBe('確認 (2)');
    expect(old.deletedAt).toBeUndefined();
    const count = changes.length;
    book.restoreList(S, 'human', old.id);
    book.restoreList(S, 'human', 'none');
    expect(changes).toHaveLength(count);
  });

  it('断るもの: 空のタイトル・空の返信・無いリスト・無いカード・正しくないセッションの ID', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [card] = book.addCards(S, 'human', list.id, [{ title: 'A' }]);
    expect(() => book.addCards(S, 'human', list.id, [{ title: ' \n ' }])).toThrow('タイトルが空のカードは作れません');
    expect(() => book.updateCard(S, 'human', list.id, card.id, { title: '\t' })).toThrow('タイトルを空にはできません');
    expect(() => book.reply(S, 'human', list.id, card.id, '  ')).toThrow('返信が空です');
    expect(() => book.addCards(S, 'human', 'none', [{ title: 'x' }])).toThrow('リストが見つかりません');
    expect(() => book.updateCard(S, 'human', list.id, 'none', {})).toThrow('「やること」にカードが見つかりません');
    expect(() => book.restoreCards(S, 'human', 'none', [])).toThrow('リストが見つかりません');
    expect(() => book.lists('../x')).toThrow('セッションの ID が正しくありません');
    // ゴミ箱のリストには足せない
    book.deleteList(S, 'human', list.id);
    expect(() => book.addCards(S, 'human', list.id, [{ title: 'B' }])).toThrow('ゴミ箱に入れたか');
    expect(card.title).toBe('A');
  });

  it('カードの変更: 変わったものだけ記録を残す（前後の空白だけの違いは変えたことにしない）', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [card] = book.addCards(S, 'claude', list.id, [{ title: 'A', body: '説明' }]);
    const before = card.thread.length;
    book.updateCard(S, 'human', list.id, card.id, { title: ' A ', body: ' 説明 ' });
    expect(card.thread).toHaveLength(before);
    book.updateCard(S, 'human', list.id, card.id, { body: ' 新しい説明 ' });
    expect(card).toMatchObject({ title: 'A', body: '新しい説明' });
    expect(card.thread.at(-1)).toMatchObject({ author: 'human', kind: 'event', event: { type: 'body' } });
    book.updateCard(S, 'claude', list.id, card.id, { title: 'B' });
    expect(card.thread.at(-1)).toMatchObject({ author: 'claude', event: { type: 'title', from: 'A' } });
    expect(card.updatedAt).toBe(card.thread.at(-1)?.at);
  });

  it('並べ替え: 動かすカードの前には入れられない（何も変えない）。無いカードの前なら最後に入れる', () => {
    const { book, changes } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [a, b] = book.addCards(S, 'human', list.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
    const count = changes.length;
    expect(book.moveCards(S, 'human', list.id, [a.id, b.id], list.id, b.id)).toEqual([a, b]);
    expect(list.cards.map((c) => c.title)).toEqual(['A', 'B', 'C']);
    expect(changes).toHaveLength(count);
    book.moveCards(S, 'human', list.id, [a.id], list.id, 'none');
    expect(list.cards.map((c) => c.title)).toEqual(['B', 'C', 'A']);
    // 同じリストの中の並べ替えでは、番号も記録も変えない
    expect(a.number).toBe(1);
    expect(a.thread.map((e) => e.kind === 'event' && e.event.type)).toEqual(['created']);
  });

  it('ゴミ箱: もう入っているカードは入れ直さず、入っていないカードは戻さない。どちらも記録を残さない', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [a, b] = book.addCards(S, 'human', list.id, [{ title: 'A' }, { title: 'B' }]);
    book.deleteCards(S, 'human', list.id, [a.id]);
    const deletedAt = a.deletedAt;
    book.takeHumanActivity(S);
    expect(book.deleteCards(S, 'human', list.id, [a.id])).toEqual([]);
    expect(a.deletedAt).toBe(deletedAt);
    expect(book.restoreCards(S, 'human', list.id, [b.id, 'none'])).toEqual([]);
    expect(book.takeHumanActivity(S)).toEqual([]);
  });

  it('読んだ印: 無いカードは何もしない。人は、まだ読んでいない Claude の返信があるときだけ付け直す。Claude はいつも付ける', () => {
    const { book, changes } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [card] = book.addCards(S, 'human', list.id, [{ title: 'A' }]);
    const count = changes.length;
    book.markRead(S, 'human', list.id, 'none');
    book.markRead(S, 'human', 'none', card.id);
    book.markRead(S, 'human', list.id, card.id);
    expect(changes).toHaveLength(count);
    const readByClaude = card.readByClaude;
    book.markRead(S, 'claude', list.id, card.id);
    expect(card.readByClaude).toBeGreaterThan(readByClaude);
    expect(changes).toHaveLength(count + 1);
  });

  it('コピー: 同じ名前のリストがあればそこに足す（説明は変えない）。名前が空になる指定は元の名前。ゴミ箱のカードも表に出して写す', () => {
    const { book, changes } = make();
    const src = book.createList(S, 'human', '確認', 'ルール');
    const [a, b] = book.addCards(S, 'human', src.id, [{ title: 'A' }, { title: 'B' }]);
    book.deleteCards(S, 'human', src.id, [b.id]);
    const existing = book.createList(T, 'human', '確認', '先のルール');
    const result = book.copyCards({ sessionId: S, title: 'ログイン', listId: src.id, cardIds: [a.id, b.id] }, T, 'claude', '\n\t');
    expect(result.createdList).toBe(false);
    expect(result.list).toBe(existing);
    expect(existing.description).toBe('先のルール');
    expect(result.cards.map((c) => [c.number, c.title, c.deletedAt, c.readByHuman])).toEqual([
      [1, 'A', undefined, 0],
      [2, 'B', undefined, 0],
    ]);
    expect(result.cards[0].readByClaude).toBeGreaterThan(0);
    expect(result.cards[0].id).not.toBe(a.id);
    expect(result.cards[1].thread.at(-1)).toMatchObject({ author: 'claude', event: { type: 'copied', fromSessionTitle: 'ログイン', fromList: '確認', fromNumber: 2 } });
    // 元のカードはそのまま
    expect(a.thread.at(-1)).toMatchObject({ event: { type: 'created' } });
    expect(b.deletedAt).toBeDefined();
    expect(changes.at(-1)?.sessionId).toBe(T);
  });

  it('記録は新しい 200 件だけ残す。長い返信は 1 行にして 200 文字で切る', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [card] = book.addCards(S, 'human', list.id, [{ title: 'A' }]);
    for (let i = 0; i < 205; i++) book.reply(S, 'human', list.id, card.id, `返信 ${i}`);
    const activity = book.takeHumanActivity(S);
    expect(activity).toHaveLength(200);
    expect(activity[0]).toBe('The user replied to "やること" #1 "A": 返信 5');
    expect(activity.at(-1)).toBe('The user replied to "やること" #1 "A": 返信 204');
    book.reply(S, 'human', list.id, card.id, `${'あ'.repeat(250)}\n続き`);
    expect(book.takeHumanActivity(S)).toEqual([`The user replied to "やること" #1 "A": ${'あ'.repeat(200)}…`]);
    // スレッドには、切らずに残す
    expect(card.thread.at(-1)).toMatchObject({ text: `${'あ'.repeat(250)}\n続き` });
  });

  it('Claude に伝える人の書き換えの記録: どの書き換えも、何をどうしたかを書く', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [a, b, c] = book.addCards(S, 'human', list.id, [{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
    book.updateCard(S, 'human', list.id, a.id, { title: 'A2', body: '説明' });
    book.setChecked(S, 'human', list.id, [a.id, b.id], true, '  確かめた  ');
    book.setChecked(S, 'human', list.id, [a.id], false);
    // 変わらなければ書かない
    book.setChecked(S, 'human', list.id, [a.id], false);
    book.reply(S, 'human', list.id, c.id, '複数\n\n行の   返信');
    const other = book.createList(S, 'human', '完了', '');
    book.moveCards(S, 'human', list.id, [b.id, c.id], other.id);
    book.deleteCards(S, 'human', other.id, [b.id, c.id]);
    book.restoreCards(S, 'human', other.id, [b.id, c.id]);
    book.deleteList(S, 'human', other.id);
    book.restoreList(S, 'human', other.id);
    book.copyCards({ sessionId: S, title: 'ログイン', listId: other.id, cardIds: [b.id, c.id] }, S, 'human', '控え');
    book.emptyTrash(S);
    expect(book.takeHumanActivity(S)).toEqual([
      'The user created the list "やること"',
      'The user added #1 "A", #2 "B", #3 "C" to "やること"',
      'The user changed the title of "やること" #1 to "A2"',
      'The user edited the body of "やること" #1 "A2"',
      'The user checked #1 "A2", #2 "B" in "やること" (確かめた)',
      'The user unchecked #1 "A2" in "やること"',
      'The user replied to "やること" #3 "C": 複数 行の 返信',
      'The user created the list "完了"',
      'The user moved 2 cards from "やること" to "完了" (#1 "B", #2 "C")',
      'The user moved #1 "B", #2 "C" in "完了" to the trash',
      'The user restored #1 "B", #2 "C" in "完了" from the trash',
      'The user moved the list "完了" to the trash',
      'The user restored the list "完了" from the trash',
      'The user created the list "控え"',
      'The user copied 2 cards from "完了" in session "ログイン" to "控え" as #1 "B", #2 "C"',
    ]);
  });

  it('Claude に伝える人の書き換えの記録: 1 枚の移動・コピーは単数で書く', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const other = book.createList(S, 'human', '完了', '');
    const [a] = book.addCards(S, 'human', list.id, [{ title: 'A' }]);
    book.takeHumanActivity(S);
    book.moveCards(S, 'human', list.id, [a.id], other.id);
    book.copyCards({ sessionId: S, title: 'ログイン', listId: other.id, cardIds: [a.id] }, S, 'human', '控え');
    expect(book.takeHumanActivity(S)).toEqual([
      'The user moved 1 card from "やること" to "完了" (#1 "A")',
      'The user created the list "控え"',
      'The user copied 1 card from "完了" in session "ログイン" to "控え" as #1 "A"',
    ]);
  });

  it('スレッドの記録: チェックを外したこと・戻したことを残す。チェックに添えた文は、知らせない返信として前後の空白を除いて残す', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [card] = book.addCards(S, 'human', list.id, [{ title: 'A' }]);
    book.setChecked(S, 'claude', list.id, [card.id], true, '  テストが通った  ');
    book.setChecked(S, 'human', list.id, [card.id], false);
    book.deleteCards(S, 'human', list.id, [card.id]);
    book.restoreCards(S, 'human', list.id, [card.id]);
    expect(card.thread.map((e) => (e.kind === 'event' ? `${e.author}:${e.event.type}` : `${e.author}:${e.text}:${e.notify ?? '-'}`))).toEqual([
      'human:created',
      'claude:checked',
      'claude:テストが通った:-',
      'human:unchecked',
      'human:deleted',
      'human:restored',
    ]);
    // reply は、既定では知らせない返信。書いたカードを返す
    expect(book.reply(S, 'claude', list.id, card.id, 'x')).toBe(card);
    expect(card.thread.at(-1)).not.toHaveProperty('notify');
  });

  it('作った人・コピーした人は、そのカードをもう読んでいる（相手はまだ読んでいない）', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [byHuman] = book.addCards(S, 'human', list.id, [{ title: 'A' }]);
    const [byClaude] = book.addCards(S, 'claude', list.id, [{ title: 'B' }]);
    expect([byHuman.readByHuman > 0, byHuman.readByClaude]).toEqual([true, 0]);
    expect([byClaude.readByHuman, byClaude.readByClaude > 0]).toEqual([0, true]);
    const { cards } = book.copyCards({ sessionId: S, title: 'x', listId: list.id, cardIds: [byClaude.id] }, T, 'human');
    expect([cards[0].readByHuman > 0, cards[0].readByClaude]).toEqual([true, 0]);
  });

  it('人が開いたときに読んだことにするのは、Claude の返信だけ（Claude のチェックなどの記録では、付け直さない）', () => {
    const { book, changes } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [card] = book.addCards(S, 'human', list.id, [{ title: 'A' }]);
    book.setChecked(S, 'claude', list.id, [card.id], true);
    const count = changes.length;
    book.markRead(S, 'human', list.id, card.id);
    expect(changes).toHaveLength(count);
    // Claude の返信を読んだあとに、もう一度開いても付け直さない
    book.reply(S, 'claude', list.id, card.id, '確かめました');
    book.markRead(S, 'human', list.id, card.id);
    const read = changes.length;
    book.markRead(S, 'human', list.id, card.id);
    expect(changes).toHaveLength(read);
  });

  it('別のリストへ移すと、移した先の最後に入れる', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const other = book.createList(S, 'human', '完了', '');
    book.addCards(S, 'human', other.id, [{ title: 'X' }, { title: 'Y' }]);
    const [a] = book.addCards(S, 'human', list.id, [{ title: 'A' }]);
    book.moveCards(S, 'human', list.id, [a.id], other.id);
    expect(other.cards.map((c) => [c.number, c.title])).toEqual([
      [1, 'X'],
      [2, 'Y'],
      [3, 'A'],
    ]);
    expect(list.cards).toEqual([]);
  });

  it('記録に書く返信は 200 文字ちょうどなら切らない', () => {
    const { book } = make();
    const list = book.createList(S, 'human', 'やること', '');
    const [card] = book.addCards(S, 'human', list.id, [{ title: 'A' }]);
    book.takeHumanActivity(S);
    book.reply(S, 'human', list.id, card.id, 'あ'.repeat(200));
    expect(book.takeHumanActivity(S)).toEqual([`The user replied to "やること" #1 "A": ${'あ'.repeat(200)}`]);
  });

  it('セッションの ID に、英数字・_・- 以外が混じれば断る（保存先のパスの外に出ない）', () => {
    const { book } = make();
    for (const id of ['../x', 'session-1/../../etc', 'a b', '']) expect(() => book.lists(id), id).toThrow('セッションの ID が正しくありません');
  });

  it('知らせる先を省いても使える。loadAll はセッションごとのリストを返す（無いセッションは空）', () => {
    const book = new ChecklistBook();
    const list = book.createList(S, 'human', 'x', '');
    expect(book.loadAll([S, T])).toEqual(
      new Map([
        [S, [list]],
        [T, []],
      ]),
    );
  });
});
