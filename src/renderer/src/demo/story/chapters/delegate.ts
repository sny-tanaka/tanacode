import type { Menu } from '@shared/screen';
import { ROOT } from '../../data';
import { sleep } from '../../director';
import { option, statusLine } from '../../scenarios/claude';
import { CSS_WITH_TAX, MENU_CARD_WITH_TAX, PRICE_TEST_WITH_TAX, PRICE_WITH_TAX } from '../files';
import { MAIN, type Story } from '../story';

// 章 2「指示して任せる」: 章 1 で送った指示（税込価格を出す）を、Claude が進める。
// ツールは「N件の操作」に畳まれる → 質問にボタンで答える → ファイルが書き換わる → サブエージェントがトレイに並ぶ → エディタで変わった行を見る

const QUESTION = '税込価格の見せ方はどうしますか？';
const ANSWER = '税込を大きく、税抜を小さく添える';

const QUESTION_MENU: Menu = {
  kind: 'question',
  tabs: [],
  title: QUESTION,
  context: [],
  options: [
    option('1', ANSWER, '「¥572（税抜 ¥520）」のように出す', 'カフェラテ\n¥572  （税抜 ¥520）\n\nあんバタートースト\n¥748  （税抜 ¥680）'),
    option('2', '税込だけを出す', '税抜の価格は出さない', 'カフェラテ\n¥572\n\nあんバタートースト\n¥748'),
    option('3', '税込・税抜を切り替えるボタンを付ける', 'ページの上に切り替えのボタンを置く', '[ 税込 | 税抜 ]\n\nカフェラテ\n¥572'),
  ],
  multiSelect: false,
  hint: 'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
  previewLayout: true,
};

export async function runDelegate(story: Story): Promise<void> {
  const { backend, d } = story;
  const claude = story.claude();
  const id = MAIN;

  // 1. 調べる（畳んだ行の下に、動いているツールが 1 行ずつ出る）
  d.caption('Claude が使うツールは「N件の操作」の 1 行に畳まれ、動いているものだけが 1 行ずつ出ます', () => [...document.querySelectorAll('.claude .tool-group')].at(-1));
  await sleep(1000);
  await claude.tool('Grep', 'formatPrice', 900, { input: 'formatPrice', result: { output: 'src/lib/price.ts\nsrc/components/MenuCard.tsx' } });
  await claude.tool('Read', 'src/components/MenuCard.tsx', 800, { filePath: `${ROOT}/src/components/MenuCard.tsx` });
  backend.know(id, { 'src/components/MenuCard.tsx': 'read' }, 24_000);
  await claude.tool('Read', 'src/lib/price.ts', 700, { filePath: `${ROOT}/src/lib/price.ts` });
  backend.know(id, { 'src/lib/price.ts': 'read' }, 26_000);
  await sleep(600);
  claude.say('価格は `formatPrice` でまとめて整形しています。税込の見せ方だけ確認させてください。');
  await sleep(900);

  // 2. 質問にボタンで答える（選択肢にマウスを乗せると、プレビューが切り替わる）
  d.caption('Claude からの質問には、ボタンで答えられます。選択肢にマウスを乗せると、プレビューが切り替わります', '.menu-card');
  claude.stopWorking();
  const answered = story.nextChoice();
  backend.setScreen(id, { state: { kind: 'menu', menu: QUESTION_MENU } });
  backend.update(id, { attention: 'question' });
  await sleep(1200);
  await d.moveTo(d.byText('.menu-option', '税込だけ'), { ms: 800 });
  await sleep(1300);
  await d.moveTo(d.byText('.menu-option', '切り替える'), { ms: 500 });
  await sleep(1300);
  await d.click(d.byText('.menu-option', ANSWER), { ms: 600 });
  await answered;
  backend.setScreen(id, { state: { kind: 'prompt' } });
  backend.update(id, { attention: null });
  const ask = claude.next('ask');
  backend.push(id, { type: 'tool-use', id: ask, name: 'AskUserQuestion', target: QUESTION, input: QUESTION, at: Date.now() });
  backend.push(id, { type: 'tool-result', id: ask, isError: false, answers: [{ header: '見せ方', question: QUESTION, answer: ANSWER }], at: Date.now() });
  claude.startWorking();

  // 3. 書き換える（エクスプローラーに「書いた」の印と、ブランチの変更の M が付く）
  d.caption('ファイルを書き換えると、エクスプローラーに「書いた」の印と、変更の M が付きます', '.explorer');
  await sleep(1000);
  await claude.edit('src/lib/price.ts', PRICE_WITH_TAX, 900, ['+// 消費税率（10%）', '+export const TAX_RATE = 0.1;', '+', '+// 税込の金額。1 円未満は切り捨てる', '+export function withTax(yen: number): number {', '+  return Math.floor(yen * (1 + TAX_RATE));', '+}']);
  await claude.edit('src/components/MenuCard.tsx', MENU_CARD_WITH_TAX, 900, [
    "-import { formatPrice } from '../lib/price';",
    "+import { formatPrice, withTax } from '../lib/price';",
    '-      <p className="price">{formatPrice(price)}</p>',
    '+      <p className="price">',
    '+        {formatPrice(withTax(price))}',
    '+        <small>（税抜 {formatPrice(price)}）</small>',
    '+      </p>',
  ]);
  await claude.edit('src/styles.css', CSS_WITH_TAX, 700, ['+.menu-card .price small {', '+  margin-left: 6px;', '+  font-size: 12px;', '+  color: #8a7f72;', '+}']);
  backend.know(id, {}, 41_000);

  // 4. テストはサブエージェントに任せる（入力欄の上のトレイに並ぶ）
  d.caption('サブエージェントは、入力欄の上のトレイに並び、進み具合が見えます', '.task-tray');
  const agent = claude.next('agent');
  const startedAt = Date.now();
  backend.push(id, {
    type: 'tool-use',
    id: agent,
    name: 'Agent',
    target: '税込計算のテストを追加して流す',
    input: 'withTax のテストを src/lib/price.test.ts に足し、npm test で通ることを確かめて',
    description: '税込計算のテストを追加して流す',
    at: startedAt,
  });
  const run = (state: 'running' | 'done', toolCalls: number, recent: { name: string; target: string }[]) =>
    backend.setSubagents(id, [
      { toolUseId: agent, agentId: 'a1', description: '税込計算のテストを追加して流す', background: false, state, startedAt, model: 'claude-sonnet-5-5', toolCalls, recent, durationMs: state === 'done' ? Date.now() - startedAt : null, tokens: 12_000, result: null },
    ]);
  run('running', 1, [{ name: 'Read', target: 'src/lib/price.test.ts' }]);

  // 5. サブエージェントが動いている間に、書き換わったファイルをエディタで開く（変わった行に印が付く）
  await sleep(700);
  d.caption('待っている間に、書き換わったファイルをエディタで開きます。このブランチで変わった行に色が付きます', '.explorer');
  await story.expand('src');
  await story.expand('src/components', 400);
  run('running', 2, [{ name: 'Edit', target: 'src/lib/price.test.ts' }]);
  await d.click('.tree-row[title="src/components/MenuCard.tsx"]');
  await sleep(2600);
  run('running', 3, [{ name: 'Bash', target: 'npm test' }]);
  await sleep(2200);
  backend.writeFile('src/lib/price.test.ts', PRICE_TEST_WITH_TAX);
  run('done', 3, [{ name: 'Bash', target: 'npm test' }]);
  backend.push(id, { type: 'tool-result', id: agent, isError: false, output: 'テストを 1 件追加し、npm test で 2 件とも通りました。', at: Date.now() });
  backend.know(id, { 'src/lib/price.test.ts': 'edited' }, 47_000);

  // 6. 応答が届いて完了
  await sleep(1000);
  claude.stopWorking();
  claude.say(
    [
      'メニューに税込価格を出しました。',
      '',
      '- `withTax` を追加（税率 10%、1 円未満は切り捨て）',
      '- カードは「¥572（税抜 ¥520）」の形で、税抜を小さく添えています',
      '- `withTax` のテストを追加し、`npm test` が通ることを確かめました',
    ].join('\n'),
  );
  backend.push(id, { type: 'turn-end' });
  backend.setStatusLine(id, statusLine(24, 47_000));
  d.caption('応答が届いて完了。チャット・エディタ・エクスプローラーが、ひとつの画面にそろっています');
  await sleep(3000);
}
