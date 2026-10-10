import { t } from './i18n';

// チェックリスト（人と Claude が一緒に見て、編集するリスト）のデータの形と、main・画面・MCP で使う読み方。
// 1 つのセッションに名前の付いたリストをいくつも持ち、リストはカード（タイトル・説明文・チェック・スレッド）を並べる。
// 保存と書き換えは main の ChecklistStore が受け持つ

// 書いた人。human: アプリの画面から / claude: MCP のツールから
export type Author = 'human' | 'claude';

// スレッドに残す記録（チェック・編集・移動・コピーなど）
export type CardEvent =
  | { type: 'created' }
  | { type: 'checked' }
  | { type: 'unchecked' }
  | { type: 'title'; from: string }
  | { type: 'body' }
  | { type: 'moved'; fromList: string; fromNumber: number }
  | { type: 'copied'; fromSessionTitle: string; fromList: string; fromNumber: number }
  | { type: 'deleted' }
  | { type: 'restored' };

// スレッドの 1 つ。reply: 返信（notify: Claude に知らせた）/ event: 記録の行
export type ThreadEntry =
  | { id: string; at: number; author: Author; kind: 'reply'; text: string; notify?: boolean }
  | { id: string; at: number; author: Author; kind: 'event'; event: CardEvent };

export type Card = {
  id: string;
  // リストの中の番号（#1, #2…）。消しても使い回さず、並べ替えても変わらない
  number: number;
  title: string;
  // 説明文（Markdown）
  body: string;
  checked: boolean;
  checkedBy?: Author;
  checkedAt?: number;
  createdBy: Author;
  createdAt: number;
  updatedAt: number;
  // ゴミ箱に入れた時刻。無いものは表示中
  deletedAt?: number;
  thread: ThreadEntry[];
  // 人が最後にスレッドを開いた時刻・Claude が最後に card_get で読んだ時刻（未読の判定）
  readByHuman: number;
  readByClaude: number;
};

export type Checklist = {
  id: string;
  // セッションの中で重ならない名前（ゴミ箱のものは除く）
  name: string;
  // 使い方のルール（「作業を終える前に、すべて満たされているか確かめる」など）。Claude はリストを読むたびに一緒に読む
  description: string;
  // 次に振る番号
  nextNumber: number;
  // 並び順のまま（ゴミ箱のカードも含む）
  cards: Card[];
  createdBy: Author;
  createdAt: number;
  deletedAt?: number;
};

// セッションのチェックリスト（画面に送るもの）
export type SessionChecklists = { sessionId: string; lists: Checklist[] };

// セッションごとの、見ていない Claude の返信の数（セッション一覧とアクティビティバーの印）
export type ChecklistUnread = Record<string, number>;

// 画面からの書き換え。どれも書いた人は human
export type ChecklistOp =
  | { type: 'list-create'; name: string; description: string }
  | { type: 'list-update'; listId: string; name?: string; description?: string }
  | { type: 'list-delete'; listId: string }
  | { type: 'list-restore'; listId: string }
  | { type: 'card-add'; listId: string; title: string; body?: string }
  | { type: 'card-update'; listId: string; cardId: string; title?: string; body?: string }
  | { type: 'card-check'; listId: string; cardIds: string[]; checked: boolean }
  | { type: 'card-reply'; listId: string; cardId: string; text: string; notify: boolean }
  // 移す（同じリストの中なら並べ替え）。before: この前に入れるカード。無ければ最後に
  | { type: 'card-move'; listId: string; cardIds: string[]; toListId: string; before?: string | null }
  | { type: 'card-delete'; listId: string; cardIds: string[] }
  | { type: 'card-restore'; listId: string; cardIds: string[] }
  | { type: 'card-read'; listId: string; cardId: string }
  // ゴミ箱を空にする（戻せなくなる）
  | { type: 'trash-empty' };

// 別のセッションへのコピー（画面から）
export type ChecklistCopyRequest = {
  fromSession: string;
  listId: string;
  cardIds: string[];
  toSession: string;
  // 先のリストの名前（無ければ作る）。省くと元のリストと同じ名前
  toList?: string;
  // 先のセッションの Claude に知らせる
  notify: boolean;
};

// 名前の比べ方。前後の空白・全角半角・大文字小文字を区別しない
export function nameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export function liveLists(lists: Checklist[]): Checklist[] {
  return lists.filter((l) => !l.deletedAt);
}

export function liveCards(list: Checklist): Card[] {
  return list.cards.filter((c) => !c.deletedAt);
}

export function progressOf(list: Checklist): { done: number; total: number } {
  const cards = liveCards(list);
  return { done: cards.filter((c) => c.checked).length, total: cards.length };
}

// 人がまだ見ていない Claude の返信の数
export function humanUnread(card: Card): number {
  return card.thread.filter((e) => e.kind === 'reply' && e.author === 'claude' && e.at > card.readByHuman).length;
}

// Claude がまだ読んでいない人の返信の数
export function claudeUnread(card: Card): number {
  return card.thread.filter((e) => e.kind === 'reply' && e.author === 'human' && e.at > card.readByClaude).length;
}

// セッションのチェックリスト全体の、人が見ていない Claude の返信の数（ゴミ箱のものは数えない）
export function unreadCount(lists: Checklist[]): number {
  return liveLists(lists).reduce((sum, list) => sum + liveCards(list).reduce((n, c) => n + humanUnread(c), 0), 0);
}

// 番号の指定を読む。"5"・"#5"・"5-8"・"5〜8"・"5,7,9"・"5-8, 10"・数・数の配列。全角の数字も読む。
// 読めなければ null
export function parseNumbers(spec: unknown): number[] | null {
  if (typeof spec === 'number') return Number.isInteger(spec) && spec > 0 ? [spec] : null;
  if (Array.isArray(spec)) {
    const all = spec.map((v) => parseNumbers(v));
    return all.every((v): v is number[] => !!v) ? unique(all.flat()) : null;
  }
  if (typeof spec !== 'string') return null;
  const text = spec.normalize('NFKC').replace(/#/g, '').trim();
  if (!text) return null;
  const numbers: number[] = [];
  for (const part of text.split(/[,、\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*[-~〜～ー–—]\s*(\d+)$/);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from < 1 || to < from || to - from > 1000) return null;
      for (let n = from; n <= to; n++) numbers.push(n);
    } else if (/^\d+$/.test(part) && Number(part) > 0) {
      numbers.push(Number(part));
    } else {
      return null;
    }
  }
  return unique(numbers);
}

function unique(numbers: number[]): number[] {
  return [...new Set(numbers)];
}

// 番号を短く書く（[5,6,7,8,10] → "#5〜8, #10"）。range: 範囲の書き方（既定は画面の言語による）
export function formatNumbers(numbers: number[], range = (from: number, to: number) => t('checklist.numberRange', { from, to })): string {
  const sorted = unique(numbers).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j - i >= 2 ? range(sorted[i], sorted[j]) : j === i ? `#${sorted[i]}` : `#${sorted[i]}, #${sorted[j]}`);
    i = j;
  }
  return parts.join(', ');
}

// Claude に返す文の番号（[5,6,7,8,10] → "#5-8, #10"）。番号の指定（"5-8"）と同じ書き方で、画面の言語によらない
export function claudeNumbers(numbers: number[]): string {
  return formatNumbers(numbers, (from, to) => `#${from}-${to}`);
}

// 画面に出す、書いた人の名前
export function authorLabel(author: Author): string {
  return t(`checklist.author.${author}`);
}

// 記録の行の文（"Claude checked the card" など）。who を省くと主語を付けない（"Checked the card"）。
// Claude に返す文（MCP の card_get）に使うので、英語で書く。画面の記録の行は、文言（checklist.eventByHuman・eventByClaude）から作る
export function eventText(event: CardEvent, who?: string): string {
  const phrase = eventPhrase(event);
  return who ? `${who} ${phrase}` : `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
}

function eventPhrase(event: CardEvent): string {
  switch (event.type) {
    case 'created':
      return 'created the card';
    case 'checked':
      return 'checked the card';
    case 'unchecked':
      return 'unchecked the card';
    case 'title':
      return `changed the title from "${event.from}"`;
    case 'body':
      return 'edited the body';
    case 'moved':
      return `moved the card from "${event.fromList}" #${event.fromNumber}`;
    case 'copied':
      return `copied the card from "${event.fromList}" #${event.fromNumber} in session "${event.fromSessionTitle}"`;
    case 'deleted':
      return 'moved the card to the trash';
    case 'restored':
      return 'restored the card from the trash';
  }
}

// 名前に使えない文字を除く（改行など）。長すぎる名前も切る
export function cleanName(name: string): string {
  return name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
}

export function cleanTitle(title: string): string {
  return title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
}

// 画面から届いた書き換えを確かめる（形が違えば投げる）。main の IPC で使う
export function checkOp(raw: unknown): ChecklistOp {
  const op = raw as Record<string, unknown> | null;
  if (!op || typeof op !== 'object' || typeof op.type !== 'string') throw new Error(t('checklist.errors.badOp'));
  const str = (key: string, optional = false) => {
    const value = op[key];
    if (value === undefined && optional) return;
    if (typeof value !== 'string') throw new Error(t('checklist.errors.notString', { key }));
  };
  const ids = (key: string) => {
    const value = op[key];
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new Error(t('checklist.errors.badShape', { key }));
  };
  switch (op.type) {
    case 'list-create':
      str('name');
      str('description');
      break;
    case 'list-update':
      str('listId');
      str('name', true);
      str('description', true);
      break;
    case 'list-delete':
    case 'list-restore':
      str('listId');
      break;
    case 'card-add':
      str('listId');
      str('title');
      str('body', true);
      break;
    case 'card-update':
      str('listId');
      str('cardId');
      str('title', true);
      str('body', true);
      break;
    case 'card-check':
      str('listId');
      ids('cardIds');
      if (typeof op.checked !== 'boolean') throw new Error(t('checklist.errors.badShape', { key: 'checked' }));
      break;
    case 'card-reply':
      str('listId');
      str('cardId');
      str('text');
      if (typeof op.notify !== 'boolean') throw new Error(t('checklist.errors.badShape', { key: 'notify' }));
      break;
    case 'card-move':
      str('listId');
      ids('cardIds');
      str('toListId');
      if (op.before !== undefined && op.before !== null && typeof op.before !== 'string') throw new Error(t('checklist.errors.badShape', { key: 'before' }));
      break;
    case 'card-delete':
    case 'card-restore':
      str('listId');
      ids('cardIds');
      break;
    case 'card-read':
      str('listId');
      str('cardId');
      break;
    case 'trash-empty':
      break;
    default:
      throw new Error(t('checklist.errors.unknownOp', { type: op.type }));
  }
  return op as ChecklistOp;
}

export function checkCopyRequest(raw: unknown): ChecklistCopyRequest {
  const r = raw as Record<string, unknown> | null;
  if (
    !r ||
    typeof r.fromSession !== 'string' ||
    typeof r.listId !== 'string' ||
    typeof r.toSession !== 'string' ||
    !Array.isArray(r.cardIds) ||
    !r.cardIds.every((v) => typeof v === 'string') ||
    (r.toList !== undefined && typeof r.toList !== 'string') ||
    typeof r.notify !== 'boolean'
  ) {
    throw new Error(t('checklist.errors.badCopyRequest'));
  }
  return r as ChecklistCopyRequest;
}
