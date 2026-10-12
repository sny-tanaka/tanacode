import type { ContextItem } from '@shared/context';
import { isFastForward, sleep } from '../../director';
import { statusLine } from '../../scenarios/claude';
import { MAIN, type Story } from '../story';

// 章 7「整理して振り返る」: コンテキストの中身を見て、最適化圧縮（会話を消して、チェックリストから再開）する →
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

const COMPACT_BUTTON = '.claude-header button[aria-label="最適化圧縮"]';

// 最適化圧縮の仕上げで、Claude が書く「いまの状態」
const STATE_LIST = 'いまの状態';
const STATE_DESCRIPTION = '会話が無くても続きができるように、今の状態を書く。変わったら書き換える。';
const STATE_CARDS = [
  { title: '税込価格・アレルギー表示・テイクアウトの価格まで実装済み。次は PR の説明', body: '`npm test` は通っている。' },
  { title: '場所: src/lib/price.ts（withTax）・src/components/MenuCard.tsx', body: '確かめ方: `npm test`、`npm run dev` で http://localhost:5173/' },
];

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

  // 2. 最適化圧縮。要約は作らず、続きに要ることを Claude がチェックリストに書いてから、会話を消して再開する
  d.caption('「最適化圧縮」は、会話を要約にしません。続きに要ることを Claude がチェックリストに書いてから、会話を消して、チェックリストから再開します', COMPACT_BUTTON);
  const started = new Promise<void>((resolve) => {
    backend.onCompactStart = () => resolve();
  });
  await d.click(COMPACT_BUTTON, { ms: 900 });
  await started;
  backend.setCompactPhase(id, 'finalizing');
  backend.push(id, { type: 'notice', id: claude.next('handoff'), text: '最適化圧縮: 続きに要ることを、チェックリストに書くよう頼みました', compact: 'handoff' });
  claude.startWorking();
  await sleep(1400);
  const state = backend.checklists.createList(id, 'claude', STATE_LIST, STATE_DESCRIPTION, 'state');
  backend.checklists.addCards(id, 'claude', state.id, STATE_CARDS);
  await sleep(1600);
  claude.stopWorking();
  claude.say('続きに要ることを「いまの状態」に書きました。');
  backend.push(id, { type: 'turn-end' });
  await sleep(900);

  // 3. 会話を消して、チェックリストから再開する
  backend.setCompactPhase(id, 'clearing');
  await sleep(900);
  backend.push(id, { type: 'reset', compact: true });
  const files = backend.sessions.get(id)!.knowledge;
  backend.know(id, Object.fromEntries(Object.keys(files).map((path) => [path, 'stale' as const])), 9_000);
  backend.setStatusLine(id, statusLine(5, 9_000));
  backend.setContext(id, [ITEM('t-resume', 'topic', '最適化圧縮: 会話を消して、チェックリストから再開しました', 4_200, 1)]);
  backend.setCompactPhase(id, 'resuming');
  backend.push(id, { type: 'notice', id: claude.next('resume'), text: '最適化圧縮: 会話を消して、チェックリストから再開しました', compact: 'resume' });
  claude.startWorking();
  await sleep(1600);
  claude.stopWorking();
  backend.setCompactPhase(id, null);
  claude.say(
    ['チェックリストを読んで、引き継ぎました。', '', '- 税込価格・アレルギー表示・テイクアウトの価格は実装済みで、テストも通っています', '- 残りは、PR の説明を書くことです', '', '続けてよければ、指示をください。'].join('\n'),
  );
  backend.push(id, { type: 'turn-end' });
  d.caption('Claude の会話は空になり、メーターが下がります（チャットの表示は残ります）。決めたことと今の状態はチェックリストに残っているので、Claude はそこから続けます', '.claude-header button.context-meter');
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
