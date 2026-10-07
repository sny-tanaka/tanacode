import { describe, expect, it } from 'vitest';
import { checkCopyRequest, checkOp, eventText, humanUnread, parseNumbers, withParticle, type Checklist, type ChecklistOp } from '../src/shared/checklist';
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
  it('どの記録も、主語を付けた文にする。英字・数字で終わる名前は、助詞の前に空白を入れる', () => {
    expect(eventText({ type: 'created' }, 'Claude')).toBe('Claude が作りました');
    expect(eventText({ type: 'checked' }, 'あなた')).toBe('あなたがチェックしました');
    expect(eventText({ type: 'unchecked' }, '人')).toBe('人がチェックを外しました');
    expect(eventText({ type: 'title', from: '古い題' }, 'Claude')).toBe('Claude がタイトルを変えました（前: 古い題）');
    expect(eventText({ type: 'body' }, '人')).toBe('人が説明文を変えました');
    expect(eventText({ type: 'moved', fromList: 'やること', fromNumber: 3 }, '人')).toBe('人が「やること」#3 から移しました');
    expect(eventText({ type: 'copied', fromSessionTitle: 'ログイン', fromList: '確認', fromNumber: 2 }, 'Claude')).toBe(
      'Claude がセッション「ログイン」の「確認」#2 からコピーしました',
    );
    expect(eventText({ type: 'deleted' }, '人')).toBe('人がゴミ箱に入れました');
    expect(eventText({ type: 'restored' }, '人')).toBe('人がゴミ箱から戻しました');
    expect(withParticle('tanacode2', 'の')).toBe('tanacode2 の');
  });

  it('who を省くと主語を付けない', () => {
    expect(eventText({ type: 'deleted' })).toBe('ゴミ箱に入れました');
    expect(eventText({ type: 'title', from: 'A' }, '')).toBe('タイトルを変えました（前: A）');
  });

  it('番号の配列に読めないものが 1 つでもあれば、全体を読めないとする', () => {
    expect(parseNumbers([1, 0])).toBeNull();
    expect(parseNumbers([1, 'x'])).toBeNull();
    expect(parseNumbers([])).toEqual([]);
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
    book.apply(S, { type: 'card-delete', listId: list.id, cardIds: [b.id] });
    book.apply(S, { type: 'list-delete', listId: done.id });
    book.apply(S, { type: 'trash-empty' });
    expect(book.lists(S).map((l) => l.name)).toEqual(['やること']);
    expect(list.cards.map((c) => c.title)).toEqual(['A2']);
    expect(changes).toHaveLength(17);
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
    expect(book.takeHumanActivity(S)).toEqual(['人がリスト「ToDo」の名前を「メモ (3)」に変えました', '人がリスト「メモ (3)」の説明を変えました: 新しいルール']);
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
    book.updateCard(S, 'human', list.id, card.id, { body: '新しい説明' });
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
    expect(activity[0]).toBe('人が「やること」#1「A」に返信しました: 返信 5');
    expect(activity.at(-1)).toBe('人が「やること」#1「A」に返信しました: 返信 204');
    book.reply(S, 'human', list.id, card.id, `${'あ'.repeat(250)}\n続き`);
    expect(book.takeHumanActivity(S)).toEqual([`人が「やること」#1「A」に返信しました: ${'あ'.repeat(200)}…`]);
    // スレッドには、切らずに残す
    expect(card.thread.at(-1)).toMatchObject({ text: `${'あ'.repeat(250)}\n続き` });
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
