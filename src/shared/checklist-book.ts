import {
  cleanName,
  cleanTitle,
  liveLists,
  nameKey,
  type Author,
  type Card,
  type CardEvent,
  type Checklist,
  type ChecklistOp,
} from './checklist';
import { t } from './i18n';

// チェックリストの書き換え。画面（IPC）と Claude（MCP）の両方から、同じものを書き換える。
// メモリの上だけで持ち、書き換えるたびに onChange で知らせる。ファイルへの保存は main の ChecklistStore が受け持つ
// （デモのサイトの作り物の API は、これをそのまま使う）。
// 書き換えの記録（log）は Claude だけが読むので、英語で書く（画面の言語によらない）。ChecklistError は画面（IPC）にも出るので、文言から作る

// Claude に「前回から人が変えたもの」を伝えるための、書き換えの記録（新しいものだけ残す）
type Activity = { at: number; author: Author; text: string };

// セッションごとに持つもの（保存するときの形）
export type ChecklistDoc = {
  version: 1;
  lists: Checklist[];
  activity: Activity[];
  // Claude が最後にツールを呼んだ時刻（そのあとの人の書き換えを伝える）
  claudeSeenAt: number;
};

const MAX_ACTIVITY = 200;

export class ChecklistError extends Error {}

export function emptyChecklistDoc(): ChecklistDoc {
  return { version: 1, lists: [], activity: [], claudeSeenAt: 0 };
}

export class ChecklistBook {
  protected readonly docs = new Map<string, ChecklistDoc>();
  // 時刻を、書き換えのたびに必ず進める（同じミリ秒の書き換えでも、未読の判定が前後を取り違えないように）
  private last = 0;

  constructor(
    private readonly onChange: (sessionId: string, lists: Checklist[]) => void = () => {},
    private readonly clock: () => number = Date.now,
  ) {}

  lists(sessionId: string): Checklist[] {
    return this.doc(sessionId).lists;
  }

  // チェックリストを持っているセッション（読み込んだもの）。セッション一覧の未読の数を出すため、保存してあるものも読む
  loadAll(sessionIds: string[]): Map<string, Checklist[]> {
    return new Map(sessionIds.map((id) => [id, this.lists(id)]));
  }

  // --- 画面からの書き換え ---

  apply(sessionId: string, op: ChecklistOp, author: Author = 'human'): void {
    switch (op.type) {
      case 'list-create':
        this.createList(sessionId, author, op.name, op.description);
        return;
      case 'list-update':
        this.updateList(sessionId, author, op.listId, op);
        return;
      case 'list-delete':
        this.deleteList(sessionId, author, op.listId);
        return;
      case 'list-restore':
        this.restoreList(sessionId, author, op.listId);
        return;
      case 'card-add':
        this.addCards(sessionId, author, op.listId, [{ title: op.title, body: op.body }]);
        return;
      case 'card-update':
        this.updateCard(sessionId, author, op.listId, op.cardId, op);
        return;
      case 'card-check':
        this.setChecked(sessionId, author, op.listId, op.cardIds, op.checked);
        return;
      case 'card-reply':
        this.reply(sessionId, author, op.listId, op.cardId, op.text, op.notify);
        return;
      case 'card-move':
        this.moveCards(sessionId, author, op.listId, op.cardIds, op.toListId, op.before ?? null);
        return;
      case 'card-delete':
        this.deleteCards(sessionId, author, op.listId, op.cardIds);
        return;
      case 'card-restore':
        this.restoreCards(sessionId, author, op.listId, op.cardIds);
        return;
      case 'card-read':
        this.markRead(sessionId, author, op.listId, op.cardId);
        return;
      case 'trash-empty':
        this.emptyTrash(sessionId);
        return;
    }
  }

  // --- リスト ---

  createList(sessionId: string, author: Author, rawName: string, description: string): Checklist {
    const doc = this.doc(sessionId);
    const name = this.freeName(doc, rawName);
    const list: Checklist = { id: crypto.randomUUID(), name, description: description.trim(), nextNumber: 1, cards: [], createdBy: author, createdAt: this.now() };
    doc.lists.push(list);
    this.log(doc, author, `created the list "${name}"`);
    this.changed(sessionId);
    return list;
  }

  updateList(sessionId: string, author: Author, listId: string, change: { name?: string; description?: string }): Checklist {
    const doc = this.doc(sessionId);
    const list = this.list(doc, listId);
    if (change.name !== undefined && nameKey(change.name) !== nameKey(list.name)) {
      const before = list.name;
      list.name = this.freeName(doc, change.name, list.id);
      this.log(doc, author, `renamed the list "${before}" to "${list.name}"`);
    }
    if (change.description !== undefined && change.description.trim() !== list.description) {
      list.description = change.description.trim();
      this.log(doc, author, `changed the description of the list "${list.name}" to: ${list.description}`);
    }
    this.changed(sessionId);
    return list;
  }

  deleteList(sessionId: string, author: Author, listId: string): void {
    const doc = this.doc(sessionId);
    const list = this.list(doc, listId);
    list.deletedAt = this.now();
    this.log(doc, author, `moved the list "${list.name}" to the trash`);
    this.changed(sessionId);
  }

  restoreList(sessionId: string, author: Author, listId: string): void {
    const doc = this.doc(sessionId);
    const list = doc.lists.find((l) => l.id === listId);
    if (!list?.deletedAt) return;
    delete list.deletedAt;
    // 戻している間に同じ名前のリストを作っていれば、名前を変えて戻す
    list.name = this.freeName(doc, list.name, list.id);
    this.log(doc, author, `restored the list "${list.name}" from the trash`);
    this.changed(sessionId);
  }

  // 名前の付いたリスト（ゴミ箱のものは除く）
  findList(sessionId: string, name: string): Checklist | undefined {
    const key = nameKey(name);
    return liveLists(this.doc(sessionId).lists).find((l) => nameKey(l.name) === key);
  }

  // --- カード ---

  addCards(sessionId: string, author: Author, listId: string, cards: { title: string; body?: string }[]): Card[] {
    const doc = this.doc(sessionId);
    const list = this.list(doc, listId);
    const added = cards.map(({ title, body }) => {
      const clean = cleanTitle(title);
      if (!clean) throw new ChecklistError(t('checklist.errors.emptyCardTitle'));
      const at = this.now();
      const card: Card = {
        id: crypto.randomUUID(),
        number: list.nextNumber++,
        title: clean,
        body: (body ?? '').trim(),
        checked: false,
        createdBy: author,
        createdAt: at,
        updatedAt: at,
        thread: [{ id: crypto.randomUUID(), at, author, kind: 'event', event: { type: 'created' } }],
        // 作った人は、もう見ている
        readByHuman: author === 'human' ? at : 0,
        readByClaude: author === 'claude' ? at : 0,
      };
      list.cards.push(card);
      return card;
    });
    this.log(doc, author, `added ${cardRefs(added)} to "${list.name}"`);
    this.changed(sessionId);
    return added;
  }

  updateCard(sessionId: string, author: Author, listId: string, cardId: string, change: { title?: string; body?: string }): Card {
    const doc = this.doc(sessionId);
    const list = this.list(doc, listId);
    const card = this.card(list, cardId);
    if (change.title !== undefined) {
      const title = cleanTitle(change.title);
      if (!title) throw new ChecklistError(t('checklist.errors.emptyTitle'));
      if (title !== card.title) {
        this.event(card, author, { type: 'title', from: card.title });
        card.title = title;
        this.log(doc, author, `changed the title of "${list.name}" #${card.number} to "${title}"`);
      }
    }
    if (change.body !== undefined && change.body.trim() !== card.body) {
      card.body = change.body.trim();
      this.event(card, author, { type: 'body' });
      this.log(doc, author, `edited the body of "${list.name}" #${card.number} "${card.title}"`);
    }
    this.changed(sessionId);
    return card;
  }

  // comment: チェックと一緒にスレッドに書く返信（どう確かめたか・なぜ外したか）
  setChecked(sessionId: string, author: Author, listId: string, cardIds: string[], checked: boolean, comment?: string): Card[] {
    const doc = this.doc(sessionId);
    const list = this.list(doc, listId);
    const cards = cardIds.map((id) => this.card(list, id));
    const changed = cards.filter((c) => c.checked !== checked);
    for (const card of changed) {
      card.checked = checked;
      if (checked) {
        card.checkedBy = author;
        card.checkedAt = this.now();
      } else {
        delete card.checkedBy;
        delete card.checkedAt;
      }
      this.event(card, author, { type: checked ? 'checked' : 'unchecked' });
    }
    if (comment?.trim()) for (const card of cards) this.addReply(card, author, comment.trim(), false);
    if (changed.length > 0) {
      this.log(doc, author, `${checked ? 'checked' : 'unchecked'} ${cardRefs(changed)} in "${list.name}"${comment?.trim() ? ` (${comment.trim()})` : ''}`);
    }
    this.changed(sessionId);
    return changed;
  }

  reply(sessionId: string, author: Author, listId: string, cardId: string, rawText: string, notify = false): Card {
    const text = rawText.trim();
    if (!text) throw new ChecklistError(t('checklist.errors.emptyReply'));
    const doc = this.doc(sessionId);
    const list = this.list(doc, listId);
    const card = this.card(list, cardId);
    this.addReply(card, author, text, notify);
    this.log(doc, author, `replied to "${list.name}" #${card.number} "${card.title}": ${clip(text, 200)}`);
    this.changed(sessionId);
    return card;
  }

  // 別のリストへ移す（同じリストなら並べ替え）。before: この前に入れる（無ければ最後に）。
  // 別のリストへ移すと、番号は移した先で振り直す
  moveCards(sessionId: string, author: Author, listId: string, cardIds: string[], toListId: string, before: string | null = null): Card[] {
    const doc = this.doc(sessionId);
    const from = this.list(doc, listId);
    const to = this.list(doc, toListId);
    const cards = cardIds.map((id) => this.card(from, id));
    if (before && cards.some((c) => c.id === before)) return cards;
    from.cards = from.cards.filter((c) => !cards.includes(c));
    if (from !== to) {
      for (const card of cards) {
        this.event(card, author, { type: 'moved', fromList: from.name, fromNumber: card.number });
        card.number = to.nextNumber++;
      }
      this.log(doc, author, `moved ${cardCount(cards.length)} from "${from.name}" to "${to.name}" (${cardRefs(cards)})`);
    }
    const at = before ? to.cards.findIndex((c) => c.id === before) : -1;
    to.cards.splice(at < 0 ? to.cards.length : at, 0, ...cards);
    this.changed(sessionId);
    return cards;
  }

  deleteCards(sessionId: string, author: Author, listId: string, cardIds: string[]): Card[] {
    const doc = this.doc(sessionId);
    const list = this.list(doc, listId);
    const cards = cardIds.map((id) => this.card(list, id)).filter((c) => !c.deletedAt);
    for (const card of cards) {
      card.deletedAt = this.now();
      this.event(card, author, { type: 'deleted' });
    }
    if (cards.length > 0) this.log(doc, author, `moved ${cardRefs(cards)} in "${list.name}" to the trash`);
    this.changed(sessionId);
    return cards;
  }

  // ゴミ箱から戻す。リストもゴミ箱にあれば、一緒に戻す
  restoreCards(sessionId: string, author: Author, listId: string, cardIds: string[]): Card[] {
    const doc = this.doc(sessionId);
    const list = doc.lists.find((l) => l.id === listId);
    if (!list) throw new ChecklistError(t('checklist.errors.listNotFound'));
    if (list.deletedAt) this.restoreList(sessionId, author, listId);
    const cards = cardIds.map((id) => list.cards.find((c) => c.id === id)).filter((c): c is Card => !!c?.deletedAt);
    for (const card of cards) {
      delete card.deletedAt;
      this.event(card, author, { type: 'restored' });
    }
    if (cards.length > 0) this.log(doc, author, `restored ${cardRefs(cards)} in "${list.name}" from the trash`);
    this.changed(sessionId);
    return cards;
  }

  // 読んだ印。人はスレッドを開いたとき、Claude は card_get で読んだとき
  markRead(sessionId: string, who: Author, listId: string, cardId: string): void {
    const doc = this.doc(sessionId);
    const card = doc.lists.find((l) => l.id === listId)?.cards.find((c) => c.id === cardId);
    if (!card) return;
    const at = this.now();
    if (who === 'human') {
      if (card.readByHuman >= lastReplyAt(card, 'claude')) return;
      card.readByHuman = at;
    } else {
      card.readByClaude = at;
    }
    this.changed(sessionId);
  }

  // ゴミ箱を空にする（ゴミ箱のリストと、カードを消す）
  emptyTrash(sessionId: string): void {
    const doc = this.doc(sessionId);
    doc.lists = doc.lists.filter((l) => !l.deletedAt);
    for (const list of doc.lists) list.cards = list.cards.filter((c) => !c.deletedAt);
    this.changed(sessionId);
  }

  // 別のセッションのカードを写す。先のリストは同じ名前のものに足し、無ければ作る（説明も写す）。
  // スレッドも写し、先頭（最後）に「コピーしました」の記録を足す。チェックの状態もそのまま
  copyCards(
    from: { sessionId: string; title: string; listId: string; cardIds: string[] },
    toSessionId: string,
    author: Author,
    toListName?: string,
  ): { list: Checklist; cards: Card[]; createdList: boolean } {
    const source = this.list(this.doc(from.sessionId), from.listId);
    const cards = from.cardIds.map((id) => this.card(source, id));
    const name = cleanName(toListName ?? source.name) || source.name;
    let list = this.findList(toSessionId, name);
    const createdList = !list;
    if (!list) list = this.createList(toSessionId, author, name, source.description);
    const doc = this.doc(toSessionId);
    const at = this.now();
    const copies = cards.map((card): Card => {
      const copy: Card = {
        ...structuredClone(card),
        id: crypto.randomUUID(),
        number: list.nextNumber++,
        updatedAt: at,
        readByHuman: author === 'human' ? at : 0,
        readByClaude: author === 'claude' ? at : 0,
      };
      delete copy.deletedAt;
      copy.thread.push({
        id: crypto.randomUUID(),
        at,
        author,
        kind: 'event',
        event: { type: 'copied', fromSessionTitle: from.title, fromList: source.name, fromNumber: card.number },
      });
      return copy;
    });
    list.cards.push(...copies);
    this.log(doc, author, `copied ${cardCount(copies.length)} from "${source.name}" in session "${from.title}" to "${list.name}" as ${cardRefs(copies)}`);
    this.changed(toSessionId);
    return { list, cards: copies, createdList };
  }

  // --- Claude に伝える書き換え ---

  // Claude が前回ツールを呼んだあとの、人の書き換え（古い順）。呼ぶと、今を Claude が見た時刻にする
  takeHumanActivity(sessionId: string): string[] {
    const doc = this.doc(sessionId);
    const since = doc.claudeSeenAt;
    doc.claudeSeenAt = this.now();
    this.save(sessionId);
    return doc.activity.filter((a) => a.author === 'human' && a.at > since).map((a) => a.text);
  }

  // --- 保存 ---

  // セッションのものを初めて読むとき（保存してあるものを読む。既定は空）
  protected load(_sessionId: string): ChecklistDoc {
    return emptyChecklistDoc();
  }

  // 書き換えたあと（保存する。既定は何もしない）
  protected save(_sessionId: string): void {}

  protected doc(sessionId: string): ChecklistDoc {
    if (!/^[\w-]+$/.test(sessionId)) throw new ChecklistError(t('checklist.errors.badSessionId'));
    let doc = this.docs.get(sessionId);
    if (!doc) {
      doc = this.load(sessionId);
      this.docs.set(sessionId, doc);
    }
    return doc;
  }

  private changed(sessionId: string): void {
    this.save(sessionId);
    this.onChange(sessionId, this.doc(sessionId).lists);
  }

  private now(): number {
    this.last = Math.max(this.clock(), this.last + 1);
    return this.last;
  }

  private list(doc: ChecklistDoc, listId: string): Checklist {
    const list = doc.lists.find((l) => l.id === listId && !l.deletedAt);
    if (!list) throw new ChecklistError(t('checklist.errors.listGone'));
    return list;
  }

  private card(list: Checklist, cardId: string): Card {
    const card = list.cards.find((c) => c.id === cardId);
    if (!card) throw new ChecklistError(t('checklist.errors.cardNotFound', { list: list.name }));
    return card;
  }

  // 重ならない名前にする（重なれば「名前 (2)」）。except: 名前を変えるリスト自身
  private freeName(doc: ChecklistDoc, rawName: string, except?: string): string {
    const base = cleanName(rawName);
    if (!base) throw new ChecklistError(t('checklist.errors.emptyListName'));
    const taken = new Set(liveLists(doc.lists).filter((l) => l.id !== except).map((l) => nameKey(l.name)));
    if (!taken.has(nameKey(base))) return base;
    for (let n = 2; ; n++) {
      const name = `${base} (${n})`;
      if (!taken.has(nameKey(name))) return name;
    }
  }

  private event(card: Card, author: Author, event: CardEvent): void {
    const at = this.now();
    card.thread.push({ id: crypto.randomUUID(), at, author, kind: 'event', event });
    card.updatedAt = at;
  }

  private addReply(card: Card, author: Author, text: string, notify: boolean): void {
    const at = this.now();
    card.thread.push({ id: crypto.randomUUID(), at, author, kind: 'reply', text, ...(notify ? { notify } : {}) });
    card.updatedAt = at;
    // 自分の返信までは読んでいる
    if (author === 'human') card.readByHuman = at;
    else card.readByClaude = at;
  }

  // text: 主語に続ける文（"added #1 "A" to "To-do"" など）
  private log(doc: ChecklistDoc, author: Author, text: string): void {
    doc.activity.push({ at: this.now(), author, text: `${author === 'human' ? 'The user' : 'Claude'} ${text}` });
    if (doc.activity.length > MAX_ACTIVITY) doc.activity.splice(0, doc.activity.length - MAX_ACTIVITY);
  }
}

function lastReplyAt(card: Card, author: Author): number {
  return Math.max(0, ...card.thread.filter((e) => e.kind === 'reply' && e.author === author).map((e) => e.at));
}

// 記録に書くカード（#1 "A", #2 "B"）
function cardRefs(cards: Card[]): string {
  return cards.map((c) => `#${c.number} "${c.title}"`).join(', ');
}

function cardCount(count: number): string {
  return `${count} ${count === 1 ? 'card' : 'cards'}`;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
