import { formatNumbers, progressOf } from '@shared/checklist';
import type { Director } from '../director';
import { sleep } from '../director';
import { MAIN, type Story } from './story';

// ツアーのチェックリスト。章 2 で、指示どおり Claude が要件を「完了前チェック」に積み、終わる前に確かめる。
// 章 3 で、迷うところを質問せずに決めて「確認事項」に残す。章 4 で、残っていたスマホの幅のカードを確かめる。
// 章 5 で、人がレビューの前に確認事項のスレッドに答える。
// Claude の操作は、MCP のツール（tanacode-checklist）の呼び出しとして会話に足し、作り物の API のチェックリストを書き換える

export const DONE_LIST = '完了前チェック';
const DONE_DESCRIPTION = '作業を終える前に、すべて満たされているか確かめる';
export const ASK_LIST = '確認事項';
const ASK_DESCRIPTION = '人に確かめたいこと。Claude は質問せずに判断して進め、ここに残す。人はよければチェックし、違えば返信する';
const DESCRIPTIONS: Record<string, string> = { [DONE_LIST]: DONE_DESCRIPTION, [ASK_LIST]: ASK_DESCRIPTION };

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
  const input = { list, ...(exists ? {} : { list_description: DESCRIPTIONS[list] }), cards };
  await story.claude().checklist('card_add', input, ms, () => {
    const target = book.findList(MAIN, list) ?? book.createList(MAIN, 'claude', list, DESCRIPTIONS[list]);
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

// サイドパネルを切り替える（開いていれば何もしない。もう一度押すと閉じてしまうので）
export async function showPanel(d: Director, label: 'チェックリスト' | 'エクスプローラー', ms = 800): Promise<void> {
  const button = await d.find(`.activity-bar [aria-label^="${label}"]`);
  if (button.classList.contains('on')) return;
  await d.click(button, { ms });
  await sleep(400);
}
