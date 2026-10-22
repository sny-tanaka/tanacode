import { activeCards, formatNumbers, liveCards, liveLists, progressOf, traitsOf, type Checklist, type ListKind } from '@shared/checklist';
import type { Director } from '../director';
import { sleep } from '../director';
import { MAIN, type Story } from './story';

// ツアーのチェックリスト。章 2 で、指示どおり Claude が要件を「完了前チェック」に積み、終わる前に確かめる。
// 章 3 で、迷うところを質問せずに決めて、種類「確認事項」（review）のリストに残す。章 4 で、残っていたスマホの幅のカードを確かめる。
// 章 5 で、人がレビューの前に確認事項のスレッドに答え、Claude の返事を読んで承認（チェック）すると、カードが「決定事項」に移る。
// 章 7 の最適化圧縮で、Claude が「いまの状態」（種類 state）を書き、再開のあとに、決定事項と状態のカードを見せる。
// Claude の操作は、MCP のツール（tanacode-checklist）の呼び出しとして会話に足し、作り物の API のチェックリストを書き換える。
// 人の操作（チェック・返信）は、画面から本物と同じ ChecklistBook に届くので、承認でカードが決定事項に移る動きも、本物のまま

export const DONE_LIST = '完了前チェック';
export const ASK_LIST = '確認事項';
export const STATE_LIST = 'いまの状態';

// リストの説明（使い方のルール）と種類。Claude が作るとき（card_add の list_description・list_kind）にも、そのまま使う
const LISTS: Record<string, { description: string; kind?: ListKind }> = {
  [DONE_LIST]: { description: '作業を終える前に、すべて満たされているか確かめる' },
  [ASK_LIST]: { description: '迷ったら質問せずに判断して進め、判断と理由をここに書く。人があとでまとめて見て、承認（チェック）するか訂正する', kind: 'review' },
  [STATE_LIST]: { description: '会話が無くても続きができるように、今の状態を書く。変わったら書き換える。', kind: 'state' },
};

// 章 3 で Claude が確認事項に残す判断
export const ASK_TITLE = 'アレルギーは、特定原材料の 8 品目だけを出す';
export const ASK_BODY = '推奨表示の 20 品目（大豆・ごまなど）は出していません。出すなら `src/data/menu.ts` の `allergens` に足します。';

function cardsOf(story: Story, list: string, numbers: number[]): { listId: string; cardIds: string[] } {
  const found = story.backend.checklists.findList(MAIN, list);
  if (!found) throw new Error(`demo: リストが見つかりません: ${list}`);
  return { listId: found.id, cardIds: numbers.map((n) => found.cards.find((c) => c.number === n)!.id) };
}

// Claude がカードを足す（リストが無ければ、説明を付けて作る）
export async function addCards(story: Story, list: string, cards: { title: string; body?: string }[], ms = 900): Promise<void> {
  const book = story.backend.checklists;
  const exists = !!book.findList(MAIN, list);
  const { description, kind } = LISTS[list];
  const input = { list, ...(exists ? {} : { list_description: description, ...(kind ? { list_kind: kind } : {}) }), cards };
  await story.claude().checklist('card_add', input, ms, () => {
    const target = book.findList(MAIN, list) ?? book.createList(MAIN, 'claude', list, description, kind);
    const added = book.addCards(MAIN, 'claude', target.id, cards);
    return `${exists ? '' : `リスト「${list}」を作りました。`}「${list}」に ${added.map((c) => `#${c.number}「${c.title}」`).join('、')} を足しました。`;
  });
}

// Claude が確かめてチェックを付ける。comment: どう確かめたか（スレッドに残る）
export async function checkCards(story: Story, list: string, numbers: number[], comment: string, ms = 800): Promise<void> {
  const book = story.backend.checklists;
  await story.claude().checklist('card_check', { list, numbers: numbers.join(','), comment }, ms, () => {
    const { listId, cardIds } = cardsOf(story, list, numbers);
    book.setChecked(MAIN, 'claude', listId, cardIds, true, comment);
    const { done, total } = progressOf(book.findList(MAIN, list)!);
    return `「${list}」の ${formatNumbers(numbers)} のチェックを付けました。 「${list}」の残りは ${total - done} 枚です。`;
  });
}

// Claude がカードのスレッドに書く
export async function replyCard(story: Story, list: string, number: number, text: string, ms = 700): Promise<void> {
  await story.claude().checklist('card_reply', { list, number, text }, ms, () => {
    const { listId, cardIds } = cardsOf(story, list, [number]);
    story.backend.checklists.reply(MAIN, 'claude', listId, cardIds[0], text);
    return `「${list}」#${number} のスレッドに返信しました。`;
  });
}

// Claude がカードを読む（人の返信を読んだ印が付く）。result: ツールの結果の文
export async function readCard(story: Story, list: string, number: number, result: string, ms = 800): Promise<void> {
  await story.claude().checklist('card_get', { list, numbers: String(number) }, ms, () => {
    const { listId, cardIds } = cardsOf(story, list, [number]);
    story.backend.checklists.markRead(MAIN, 'claude', listId, cardIds[0]);
    return result;
  });
}

// checklist_overview の結果の文（main の checklist-control.ts の overview と同じ形。Claude が読む英語）
function overviewText(lists: Checklist[]): string {
  return liveLists(lists)
    .map((list) => {
      const traits = traitsOf(list);
      const { done, total } = progressOf(list);
      const cards = liveCards(list).map((c) => `- ${traits.checkable ? `[${c.checked ? 'x' : ' '}] ` : ''}#${c.number} ${c.title}`);
      const inForce = activeCards(list).length;
      const state = traits.checkable
        ? `${done}/${total} checked${traits.approves ? '; review list: cards the user checks move to the decisions list' : ''}`
        : traits.locked
          ? `decisions list: permanent, no checks; ${inForce} in force${total > inForce ? `, ${total - inForce} revoked` : ''}`
          : `state list: no checks, keep it current by rewriting its cards; ${total} ${total === 1 ? 'card' : 'cards'}`;
      return [`## ${list.name} (${state})`, `Description: ${list.description || '(none)'}`, ...(cards.length > 0 ? cards : ['(no cards)'])].join('\n');
    })
    .join('\n\n');
}

// Claude がリストの一覧を読む（checklist_overview）。いまのリストから結果の文を作る
export async function readOverview(story: Story, ms = 700): Promise<void> {
  await story.claude().checklist('checklist_overview', {}, ms, () => overviewText(story.backend.checklists.lists(MAIN)));
}

// サイドパネルを切り替える（開いていれば何もしない。もう一度押すと閉じてしまうので）
export async function showPanel(d: Director, label: 'チェックリスト' | 'エクスプローラー', ms = 800): Promise<void> {
  const button = await d.find(`.activity-bar [aria-label^="${label}"]`);
  if (button.classList.contains('on')) return;
  await d.click(button, { ms });
  await sleep(400);
}
