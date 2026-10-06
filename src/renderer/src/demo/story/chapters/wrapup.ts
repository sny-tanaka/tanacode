import type { ContextItem } from '@shared/context';
import { isFastForward, sleep } from '../../director';
import { statusLine } from '../../scenarios/claude';
import { MAIN, type Story } from '../story';

// 章 7「整理して振り返る」: コンテキストの中身を見て「残す」「捨てる」を選んで圧縮する →
// 英語で返ってきた思考を日本語に訳して読む → 作業の流れを 1 枚の HTML に書き出して開く

// 英語の思考（翻訳のボタンで日本語に訳す）。対訳は作り物の翻訳が返す
const THINKING = [
  'The user wants a pull request description for today’s work.',
  'The branch adds tax-inclusive prices, allergen labels, a mobile layout fix, and takeout prices.',
  'I should group the changes by feature and mention the tests that cover the tax calculation.',
];
export const TRANSLATIONS: Record<string, string> = {
  [THINKING[0]]: 'ユーザーは、今日の作業の PR の説明を求めている。',
  [THINKING[1]]: 'このブランチでは、税込価格・アレルギー表示・スマホの表示の修正・テイクアウトの価格を足した。',
  [THINKING[2]]: '変更を機能ごとにまとめ、税の計算を確かめるテストにも触れるとよい。',
};

const PR_PROMPT = 'このブランチの PR の説明を書いて';

// 今のコンテキストの中身（大きさは見積もり。合計は全体の使用量より小さくする）
const ITEM = (id: string, kind: ContextItem['kind'], label: string, tokens: number, order: number, extra: Partial<ContextItem> = {}): ContextItem => ({
  id,
  kind,
  label,
  tokens,
  order,
  compacted: false,
  ...extra,
});
const BEFORE: ContextItem[] = [
  ITEM('t-tax', 'topic', 'メニューの価格を税込みでも表示して', 3_200, 1),
  ITEM('f-price', 'file', 'src/lib/price.ts', 2_400, 2, { edited: true }),
  ITEM('f-card', 'file', 'src/components/MenuCard.tsx', 6_800, 3, { edited: true }),
  ITEM('a-test', 'agent', '税込計算のテストを追加して流す', 2_900, 4),
  ITEM('t-allergen', 'topic', 'メニューに、アレルギーの表示も足して', 4_100, 5),
  ITEM('f-types', 'file', 'src/types.ts', 900, 6, { edited: true }),
  ITEM('f-menu', 'file', 'src/data/menu.ts', 1_300, 7, { edited: true }),
  ITEM('i-shot', 'image', 'http://localhost:5173/', 9_600, 8, { tool: 'screenshot' }),
  ITEM('f-css', 'file', 'src/styles.css', 1_700, 9, { edited: true }),
  ITEM('b-test', 'tool', 'npm test', 7_400, 10, { tool: 'Bash' }),
  ITEM('t-children', 'topic', '残りの作業を子セッションに分けて', 5_200, 11),
];

export async function runWrapup(story: Story): Promise<void> {
  const { backend, d } = story;
  const claude = story.claude();
  const id = MAIN;
  backend.setStatusLine(id, statusLine(46, 92_000));
  backend.setContext(id, BEFORE);

  // 1. ヘッダーのメーターから、コンテキストの中身を開く
  d.caption('ヘッダーのメーターを押すと、今のコンテキストの中身と、それぞれのおよその大きさが並びます', '.claude-header button.context-meter');
  await sleep(900);
  await d.click('.claude-header button.context-meter', { ms: 900 });
  await sleep(1800);

  // 2. 残すもの・捨てるものに印を付ける
  d.caption('圧縮のときに残したいものには「残す」、もう要らないものには「捨てる」の印を付けます', '.context-list');
  const mark = async (label: string, kind: 'keep' | 'drop') => {
    await d.click(() => d.byText('.context-row', label)()?.querySelector(`.context-mark.${kind}`), { ms: 700 });
    await sleep(500);
  };
  await mark('MenuCard.tsx', 'keep');
  await mark('price.ts', 'keep');
  await mark('npm test', 'drop');
  await mark('localhost:5173', 'drop');
  await sleep(600);

  // 3. 印から指示の文を組み立てて、圧縮する
  d.caption('「この選び方で圧縮…」で、印から /compact に添える指示の文ができます。直してから送れます', '.context-compact .send-button');
  await d.click('.context-compact .send-button', { ms: 800 });
  await sleep(2200);
  const sent = story.nextSend();
  await d.click('.context-compact .send-button', { ms: 800 });
  await sent;
  claude.startWorking();
  await sleep(2400);
  claude.stopWorking();
  backend.push(id, { type: 'divider', id: claude.next('compact'), text: '会話を圧縮しました（92k tokens から）' });
  backend.push(id, { type: 'turn-end' });
  const files = backend.sessions.get(id)!.knowledge;
  backend.know(id, Object.fromEntries(Object.keys(files).map((path) => [path, 'stale' as const])), 21_000);
  backend.setStatusLine(id, statusLine(11, 21_000));
  backend.setContext(id, [
    ...BEFORE.map((item) => ({ ...item, compacted: true })),
    ITEM('s-1', 'summary', '会話の要約', 6_500, 12),
    ITEM('f-card-2', 'file', 'src/components/MenuCard.tsx', 6_800, 13, { edited: true }),
    ITEM('f-price-2', 'file', 'src/lib/price.ts', 2_400, 14, { edited: true }),
  ]);
  d.caption('圧縮すると、前のものは要約に置き換わり、メーターが下がります。エクスプローラーの点は白抜き（圧縮前に読んだだけ）になります', '.claude-header button.context-meter');
  await sleep(3200);

  // 4. 英語で返ってきた思考を、日本語に訳して読む
  d.caption('思考や応答が英語で返ってきても、翻訳のボタンで日本語に訳して読めます（macOS の翻訳で、Mac の中で訳します）', () => [...document.querySelectorAll('.chat-translate')].at(-1));
  await story.send(PR_PROMPT);
  claude.startWorking();
  await sleep(1400);
  backend.push(id, { type: 'thinking', id: claude.next('think'), text: THINKING.join('\n') });
  await sleep(800);
  claude.stopWorking();
  claude.say(
    [
      '## 概要',
      '',
      'メニューに税込価格・アレルギー表示・テイクアウトの価格を足し、スマホでの価格の表示を直しました。',
      '',
      '## 変更点',
      '',
      '- `withTax` を追加（店内 10%・テイクアウト 8%、1 円未満は切り捨て）',
      '- カードに「¥572（税抜 ¥520）」とテイクアウトの価格、アレルギーを表示',
      '- スマホでは税抜を価格の下の行に表示',
      '- `withTax` のテストを追加',
    ].join('\n'),
  );
  backend.push(id, { type: 'turn-end' });
  await sleep(900);
  await d.click(() => [...document.querySelectorAll('.chat-translate')].at(-1), { ms: 900 });
  await sleep(2800);

  // 5. 作業の流れを 1 枚の HTML に書き出す
  d.caption('「作業を書き出す」で、このセッションの流れを 1 枚の HTML に保存できます。チームへの共有や振り返りに使えます', '.claude-header button[aria-label="作業を書き出す…"]');
  await d.click('.claude-header button[aria-label="作業を書き出す…"]', { ms: 900 });
  await sleep(1800);
  const exported = new Promise<string>((resolve) => {
    backend.onExport = (html) => resolve(html);
  });
  await d.click('.export-dialog-foot .send-button', { ms: 800 });
  const html = await exported;
  await sleep(1000);
  d.caption('書き出した HTML は、ブラウザで開くだけで読めます。見た目はチャットと同じです');
  if (!isFastForward()) {
    story.showExport(html);
    await sleep(6000);
    story.hideExport();
  }
  await sleep(400);
  await d.click(() => [...document.querySelectorAll('.export-dialog-foot .send-button')].at(-1), { ms: 700 });
  await sleep(1000);
}
