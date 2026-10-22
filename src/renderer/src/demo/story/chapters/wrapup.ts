import type { ContextItem } from '@shared/context';
import { t } from '@shared/i18n';
import { carriedMessages, handoffText, lastReply, parseCompactMessage, resumeText } from '@shared/optimized-compact';
import { isFastForward, sleep } from '../../director';
import { statusLine } from '../../scenarios/claude';
import { addCards, readOverview, showPanel, STATE_LIST } from '../checklist';
import { MAIN, type Story } from '../story';

// 章 7「整理して振り返る」: コンテキストの中身を見て、最適化圧縮（会話を消して、チェックリストから再開）する →
// 再開のあとに、チェックリストの決定事項と「いまの状態」の 4 枚を見る →
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

// 最適化圧縮の仕上げで、Claude が書く「いまの状態」。本物の仕上げの頼み（handoffText）は、4 つの項目を別々のカードに書かせる
// （いまの状態・答え待ち・試してやめたこと・場所と手順）。再開のあとに作業を続けるか待つかは、「答え待ち」のカードで決まる。
// ここでは、PR の説明を書くかを人にまだ聞いていないので、待っている（再開した Claude は、指示を待つ）
const STATE_CARDS = [
  {
    title: 'いまの状態: 実装は済み。次は PR の説明',
    body: '税込価格・アレルギー表示・スマホの表示・テイクアウトの価格は実装済みで、`npm test` は通っている。子セッション 2 件（README の表記ルール・アクセシビリティの点検）も完了。コミット・push はまだ。次の一手は、PR の説明を書くこと。',
  },
  {
    title: '答え待ち: 待っている（PR の説明を書くか、まだ聞いていない）',
    body: '子セッションの結果を報告したところ。次に PR の説明を書くかは、人にまだ聞いていない。人の指示があるまで、新しい作業は始めない。',
  },
  {
    title: '試してやめたこと: カードごとに税率を書く案',
    body: 'カードごとに `* 1.1` と書く案は、テイクアウトの 8% を足すときに直す所が増えるのでやめ、`withTax(yen, rate)` にまとめた。',
  },
  {
    title: '場所と手順: src/lib/price.ts（withTax）・src/components/MenuCard.tsx',
    body: '確かめ方: `npm test`、`npm run dev` で http://localhost:5173/\nブランチ: worktree-tc-1004-k3x9',
  },
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

  // 2. 最適化圧縮。要約は作らず、続きに要ることを Claude がチェックリストに書いてから、会話を消して再開する。右には、自動で始めるスイッチ
  d.caption(
    '「最適化圧縮」は、会話を要約にしません。続きに要ることを Claude がチェックリストに書いてから、会話を消して、チェックリストから再開します。右の「自動」は、コンテキストが 80% を超えたら自動で始めるスイッチです',
    '.claude-header .compact-capsule',
  );
  const started = new Promise<void>((resolve) => {
    backend.onCompactStart = () => resolve();
  });
  await d.click(COMPACT_BUTTON, { ms: 900 });
  await started;
  backend.setCompactPhase(id, 'finalizing');
  // 仕上げの頼みと再開の文は、アプリが Claude に送る文（開くと全文が読める）。本物と同じ関数で作る
  backend.push(id, { type: 'notice', id: claude.next('handoff'), text: t('chat.transcript.compactHandoff'), detail: parseCompactMessage(handoffText())?.body, compact: 'handoff' });
  claude.startWorking();
  story.toBottom();
  d.caption('まず Claude がチェックリストを読み、「いまの状態」に 4 つのカードを書きます（いまの状態・答え待ち・試してやめたこと・場所と手順）', () => [...document.querySelectorAll('.claude .tool-group')].at(-1));
  await sleep(900);
  await readOverview(story, 700);
  await addCards(story, STATE_LIST, STATE_CARDS, 1100);
  story.toBottom();
  await sleep(1500);
  claude.stopWorking();
  claude.say('続きに要ることを「いまの状態」に書きました。');
  backend.push(id, { type: 'turn-end' });
  story.toBottom();
  await sleep(900);

  // 3. 会話を消して、チェックリストから再開する。再開の文には、決定事項と「いまの状態」のカード・人の発言の原文が入る
  backend.setCompactPhase(id, 'clearing');
  await sleep(900);
  const before = backend.sessions.get(id)!.events;
  const resume = parseCompactMessage(resumeText({ lists: backend.checklists.lists(id), messages: carriedMessages(before), tasks: [], reply: lastReply(before) }))?.body ?? '';
  backend.push(id, { type: 'reset', compact: true });
  const files = backend.sessions.get(id)!.knowledge;
  backend.know(id, Object.fromEntries(Object.keys(files).map((path) => [path, 'stale' as const])), 9_000);
  backend.setStatusLine(id, statusLine(5, 9_000));
  backend.setContext(id, [ITEM('t-resume', 'topic', '最適化圧縮: 会話を消して、チェックリストから再開しました', 4_200, 1)]);
  backend.setCompactPhase(id, 'resuming');
  backend.push(id, { type: 'notice', id: claude.next('resume'), text: t('chat.transcript.compactResume'), detail: resume, compact: 'resume' });
  claude.startWorking();
  await sleep(700);
  await readOverview(story, 700);
  await sleep(500);
  claude.stopWorking();
  backend.setCompactPhase(id, null);
  claude.say(
    [
      'チェックリストを読んで、引き継ぎました。',
      '',
      '- 税込価格・アレルギー表示・テイクアウトの価格は実装済みで、テストも通っています',
      '- 子セッション 2 件の作業は終わっています',
      '- 決定事項: アレルギーは特定原材料の 8 品目だけを出す（承認済み）',
      '',
      '「答え待ち」のとおり、PR の説明を書くかは、まだ決まっていません。指示があるまで、新しい作業は始めません。続けてよければ、指示をください。',
    ].join('\n'),
  );
  backend.push(id, { type: 'turn-end' });
  story.toBottom();
  d.caption('Claude の会話は空になり、メーターが下がります（チャットの表示は残ります）。決めたことと今の状態はチェックリストに残っているので、Claude はそこから続けます', '.claude-header button.context-meter');
  await sleep(3200);

  // 3b. チェックリストを開いて、決定事項と「いまの状態」を見る
  await showPanel(d, 'チェックリスト', 900);
  d.caption(
    '決定事項（章 5 で承認した判断）と「いまの状態」の 4 枚が残っています。決定事項は、人が発言するたびと、圧縮の直後に、全部 Claude に渡されます',
    '.checklist-panel',
  );
  await sleep(4600);
  d.caption('「答え待ち」のカードが、再開したあとに作業を続けるか、人の答えを待つかを決めます。ここでは待っているので、Claude は指示を待ちます', d.byText('.checklist-card', '答え待ち'));
  await sleep(4200);

  // 3c. 再開の文は、知らせを開くと全文を読める。決定事項と「いまの状態」のカードが、そのまま入っている
  const resumeNotice = d.byText('.chat-notice.expandable', t('chat.transcript.compactResume'));
  d.caption('チャットの知らせを開くと、tanacode が Claude に送った再開の文の全文が読めます。決定事項と「いまの状態」のカードが、そのまま入っています', resumeNotice);
  await sleep(300);
  await d.click(() => resumeNotice()?.querySelector('summary'), { ms: 800 });
  // 全文は、指示の文・決定事項と「いまの状態」のカード・人の発言の原文の順。カードのところまで送って見せる
  const detail = await d.find(() => resumeNotice()?.querySelector('pre.chat-notice-detail'));
  await sleep(1200);
  const at = resume.indexOf(t('chat.compactPrompt.resume.listHeading', { name: t('checklist.decisions.defaultName'), kind: t('chat.compactPrompt.resume.kindDecisions') }));
  if (at > 0) detail.scrollTo({ top: (at / resume.length) * detail.scrollHeight - 8, behavior: 'smooth' });
  await sleep(2600);
  await d.click(() => resumeNotice()?.querySelector('summary'), { ms: 600 });
  story.toBottom();
  await sleep(400);

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
