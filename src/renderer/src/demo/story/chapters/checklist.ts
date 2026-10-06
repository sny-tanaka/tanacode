import type { Checklist } from '@shared/checklist';
import { sleep } from '../../director';
import { statusLine } from '../../scenarios/claude';
import { MAIN, type Story } from '../story';

// 章 4「チェックリストで確かめる」: ここまでの要件を、Claude に「完了前チェック」のリストにまとめさせ、満たしているかを確かめさせる。
// 迷うところは質問させずに「確認事項」のリストに残させ、人はあとでカードのスレッドで答える（「Claude に通知する」で Claude に届く）。
// スマホの幅は確かめていないので、#4 はチェックを付けずに残る（章 5 で、ブラウザで確かめて付ける）

const PROMPT = 'ここまでの要件を「完了前チェック」のリストにして、満たしているか確かめて。迷うところは質問せずに判断して、「確認事項」に残しておいて';
export const DONE_LIST = '完了前チェック';
const ASK_LIST = '確認事項';
const ASK_TITLE = 'アレルギーは、特定原材料の 8 品目だけを出す';
const ANSWER = '8 品目だけで大丈夫です。お店の表示もそうしています';

// リストの名前と番号から、カードの id（台本の Claude が書き換えるとき）
export function cardIds(lists: Checklist[], name: string, numbers: number[]): { listId: string; cardIds: string[] } {
  const list = lists.find((l) => !l.deletedAt && l.name === name);
  if (!list) throw new Error(`demo: リストが見つかりません: ${name}`);
  return { listId: list.id, cardIds: numbers.map((n) => list.cards.find((c) => c.number === n)!.id) };
}

export async function runChecklist(story: Story): Promise<void> {
  const { backend, d } = story;
  const claude = story.claude();
  const id = MAIN;
  const book = backend.checklists;
  const check = (list: string, numbers: number[], comment: string) => {
    const { listId, cardIds: ids } = cardIds(book.lists(id), list, numbers);
    book.setChecked(id, 'claude', listId, ids, true, comment);
  };

  // 1. 要件をチェックリストにまとめて確かめるよう頼む
  d.caption('要件をチェックリストにまとめて、満たしているか確かめるよう頼みます。迷うところは、質問せずにリストに残してもらいます', '.chat-input');
  await story.send(PROMPT);
  claude.startWorking();
  await sleep(1200);

  // 2. Claude が MCP のツールでリストを作り、カードを足す。サイドパネルのチェックリストを開く
  const done = book.createList(id, 'claude', DONE_LIST, '作業を終える前に、すべて満たされているか確かめる');
  const doneCards = [
    { title: '税込価格を、1 円未満切り捨てで出す' },
    { title: '税抜の価格も、小さく添える' },
    { title: 'アレルギー物質の無い品目には、アレルギーの表示を出さない' },
    { title: 'スマホの幅でも、価格が読みやすく出る' },
  ];
  await claude.checklist('card_add', { list: DONE_LIST, list_description: done.description, cards: doneCards }, 900, () => {
    book.addCards(id, 'claude', done.id, doneCards);
    return `リスト「${DONE_LIST}」を作りました。「${DONE_LIST}」に #1〜4 を足しました。`;
  });
  d.caption('Claude は MCP のツールでチェックリストを書きます。リストはサイドパネルに並び、会話が圧縮されても消えません', '.activity-bar [aria-label^="チェックリスト"]');
  await sleep(600);
  await d.click('.activity-bar [aria-label^="チェックリスト"]', { ms: 900 });
  await sleep(1600);

  // 3. 確かめたものにチェックを付ける。確かめていないもの（スマホの幅）は残し、スレッドに理由を書く
  d.caption('確かめたカードには、Claude がチェックを付けます。どう確かめたかはカードのスレッドに残り、まだ読んでいない返信には青い点が付きます', '.checklist-panel');
  await claude.checklist('card_check', { list: DONE_LIST, numbers: '1-2', comment: '`withTax` のテストと、メニューのカードの表示で確かめました' }, 800, () => {
    check(DONE_LIST, [1, 2], '`withTax` のテストと、メニューのカードの表示で確かめました');
    return `「${DONE_LIST}」の #1, #2 のチェックを付けました。 「${DONE_LIST}」の残りは 2 枚です。`;
  });
  await sleep(500);
  await claude.checklist('card_check', { list: DONE_LIST, numbers: '3', comment: '`allergens` が無い品目では出さないことを、型チェックの hooks と表示で確かめました' }, 800, () => {
    check(DONE_LIST, [3], '`allergens` が無い品目では出さないことを、型チェックの hooks と表示で確かめました');
    return `「${DONE_LIST}」の #3 のチェックを付けました。 「${DONE_LIST}」の残りは 1 枚です。`;
  });
  await sleep(500);
  await claude.checklist('card_reply', { list: DONE_LIST, number: 4, text: 'スマホの幅では、まだ確かめていません。ブラウザで見て確かめる必要があります。' }, 700, () => {
    const { listId, cardIds: [cardId] } = cardIds(book.lists(id), DONE_LIST, [4]);
    book.reply(id, 'claude', listId, cardId, 'スマホの幅では、まだ確かめていません。ブラウザで見て確かめる必要があります。');
    return `「${DONE_LIST}」#4 のスレッドに返信しました。`;
  });
  await sleep(600);

  // 4. 迷ったところは、質問せずに判断して進め、「確認事項」に残す
  d.caption('迷ったところは、作業を止めて質問せずに判断して進め、「確認事項」のリストに残します', '.checklist-panel');
  const ask = { title: ASK_TITLE, body: '推奨表示の 20 品目（大豆・ごまなど）は出していません。出すなら `src/data/menu.ts` の `allergens` に足します。' };
  await claude.checklist('card_add', { list: ASK_LIST, list_description: '人に確かめたいこと。Claude は質問せずに判断して進め、ここに残す。人はよければチェックし、違えば返信する', cards: [ask] }, 900, () => {
    const list = book.createList(id, 'claude', ASK_LIST, '人に確かめたいこと。Claude は質問せずに判断して進め、ここに残す。人はよければチェックし、違えば返信する');
    book.addCards(id, 'claude', list.id, [ask]);
    return `リスト「${ASK_LIST}」を作りました。「${ASK_LIST}」に #1「${ASK_TITLE}」 を足しました。`;
  });
  await sleep(600);
  claude.stopWorking();
  claude.say(
    [
      '「完了前チェック」を作り、確かめました。',
      '',
      '- #1〜3 は満たしています（どう確かめたかは、各カードのスレッドに書きました）',
      '- #4 のスマホの幅は、まだ確かめていません',
      '',
      'アレルギーの表示を特定原材料の 8 品目だけにしたのは私の判断なので、「確認事項」に残しました。',
    ].join('\n'),
  );
  backend.push(id, { type: 'turn-end' });
  backend.setStatusLine(id, statusLine(37, 74_000));
  await sleep(1500);

  // 5. 人が見られるときに、確認事項のカードを開く。詳細とスレッドは、エディタの場所に出る
  d.caption('人は手が空いたときに、確認事項を見ます。カードを押すと、説明とスレッドがエディタの場所に開きます', d.byText('.checklist-card', ASK_TITLE));
  await sleep(600);
  await d.click(d.byText('.checklist-card', ASK_TITLE), { ms: 900 });
  await sleep(2200);

  // 6. スレッドに返信する。「Claude に通知する」にチェックがあると、手の空いた Claude に知らせが届く
  d.caption('スレッドに返信します。「Claude に通知する」にチェックがあれば、手の空いた Claude に返信の知らせが届きます', '.card-composer');
  const notified = new Promise<void>((resolve) => {
    backend.onChecklistNotify = (sessionId, notice) => {
      backend.push(sessionId, notice);
      resolve();
    };
  });
  await d.click('.card-composer textarea', { ms: 800 });
  await d.type('.card-composer textarea', ANSWER);
  await sleep(500);
  await d.moveTo('.card-composer .checklist-notify', { ms: 600 });
  await sleep(1200);
  await d.click('.card-composer-foot [aria-label="返信する"]', { ms: 600 });
  await notified;
  claude.startWorking();
  await sleep(800);

  // 7. Claude が知らせを受けてカードを読み、チェックを付けて、スレッドで答える
  d.caption('返信の知らせはチャットにも出て、「カードを開く」でカードに移れます。Claude はカードを読んで対応し、スレッドで答えます', () => [...document.querySelectorAll('.claude .chat-notice')].at(-1));
  story.toBottom();
  await claude.checklist('card_get', { list: ASK_LIST, numbers: '1' }, 800, () => {
    const { listId, cardIds: [cardId] } = cardIds(book.lists(id), ASK_LIST, [1]);
    book.markRead(id, 'claude', listId, cardId);
    return `## ${ASK_LIST} #1「${ASK_TITLE}」\n\n人の返信（未読）: ${ANSWER}`;
  });
  await sleep(400);
  await claude.checklist('card_check', { list: ASK_LIST, numbers: '1', comment: '了解しました。8 品目のままにします。' }, 800, () => {
    check(ASK_LIST, [1], '了解しました。8 品目のままにします。');
    return `「${ASK_LIST}」の #1 のチェックを付けました。 「${ASK_LIST}」の残りは 0 枚です。`;
  });
  await sleep(400);
  claude.stopWorking();
  claude.say('「確認事項」#1 は、8 品目のままにしてチェックを付けました。');
  backend.push(id, { type: 'turn-end' });
  d.caption('チェックとスレッドは、人と Claude のどちらが付けたかが分かる形で残ります', '.card-thread');
  story.toBottom();
  await sleep(3000);

  // 8. カードを閉じて、エクスプローラーに戻す（次の章は、エディタとエクスプローラーから始まる）
  await d.click('.card-pane [aria-label="閉じる"]', { ms: 700 });
  await sleep(400);
  await d.click('.activity-bar [aria-label="エクスプローラー"]', { ms: 700 });
  await sleep(600);
}
