import type { Menu } from '@shared/screen';
import type { DemoBackend } from '../backend';
import { CSS_WITH_TAX, MENU_CARD_WITH_TAX, PRICE_TEST_WITH_TAX, PRICE_WITH_TAX, ROOT } from '../data';
import { sleep, type Director } from '../director';
import { Claude, option, statusLine } from './claude';

// 動画 1「基本」: Claude Code がもともと持つ機能を、tanacode ではどう見せているか。
// 指示を送る → ツールが「N件の操作」の下で動く → 質問にボタンで答える → ファイルが書き換わり、エディタで変わった行が分かる →
// サブエージェントがトレイに並ぶ → 応答が届いて完了

export const BASIC_SESSION = 'demo-basic';

const PROMPT = 'メニューの価格を税込みでも表示して。税率は 10%、1 円未満は切り捨てで。';

const QUESTION = '税込価格の見せ方はどうしますか？';
const ANSWER = '税込を大きく、税抜を小さく添える';

export function setupBasic(backend: DemoBackend): void {
  const hour = 3600_000;
  backend.addSession('demo-readme', { title: 'README のセットアップ手順を見直す', updatedAt: Date.now() - 5 * hour });
  backend.addSession('demo-images', { title: 'メニュー画像を遅延読み込みにする', updatedAt: Date.now() - 26 * hour });
  backend.addSession(BASIC_SESSION, { title: 'メニューに税込価格を出す' });
  backend.setStatusLine(BASIC_SESSION, statusLine(9, 18_000));
}

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

export async function runBasic(backend: DemoBackend, d: Director): Promise<void> {
  const id = BASIC_SESSION;
  const claude = new Claude(backend, id);
  const sent = new Promise<void>((resolve) => {
    backend.onUserMessage = (_sid, text) => {
      claude.user(text);
      resolve();
    };
  });
  const answered = new Promise<void>((resolve) => {
    backend.onChoose = () => resolve();
  });

  // 1. 指示を打って送る
  await sleep(1200);
  await d.click('.chat-input textarea');
  await d.type('.chat-input textarea', PROMPT);
  await sleep(300);
  await d.click(d.byText('.send-button', '送信'));
  await sent;
  claude.startWorking();

  // 2. 調べる（畳んだ行の下に、動いているツールが 1 行ずつ出る）
  await sleep(1200);
  await claude.tool('Grep', 'formatPrice', 900, { input: 'formatPrice', result: { output: 'src/lib/price.ts\nsrc/components/MenuCard.tsx' } });
  await claude.tool('Read', 'src/components/MenuCard.tsx', 800, { filePath: `${ROOT}/src/components/MenuCard.tsx` });
  backend.know(id, { 'src/components/MenuCard.tsx': 'read' }, 24_000);
  await claude.tool('Read', 'src/lib/price.ts', 700, { filePath: `${ROOT}/src/lib/price.ts` });
  backend.know(id, { 'src/lib/price.ts': 'read' }, 26_000);
  await sleep(600);
  claude.say('価格は `formatPrice` でまとめて整形しています。税込の見せ方だけ確認させてください。');
  await sleep(900);

  // 3. 質問にボタンで答える（選択肢にホバーすると、プレビューが切り替わる）
  claude.stopWorking();
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

  // 4. 書き換える（エクスプローラーに「書いた」の印と、ブランチの変更の M が付く）
  await sleep(1200);
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

  // 5. テストはサブエージェントに任せる（入力欄の上のトレイに並ぶ）
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
      { toolUseId: agent, agentId: 'a1', description: '税込計算のテストを追加して流す', background: false, state, startedAt, model: 'claude-sonnet-5', toolCalls, recent, durationMs: state === 'done' ? Date.now() - startedAt : null, tokens: 12_000, result: null },
    ]);
  run('running', 1, [{ name: 'Read', target: 'src/lib/price.test.ts' }]);

  // 6. サブエージェントが動いている間に、書き換わったファイルをエディタで開く（変わった行に印が付く）
  await sleep(700);
  await d.click('.tree-row[title="src"]');
  await sleep(250);
  await d.click('.tree-row[title="src/components"]');
  await sleep(300);
  run('running', 2, [{ name: 'Edit', target: 'src/lib/price.test.ts' }]);
  await d.click('.tree-row[title="src/components/MenuCard.tsx"]');
  await sleep(2600);
  run('running', 3, [{ name: 'Bash', target: 'npm test' }]);
  await sleep(2400);
  backend.writeFile('src/lib/price.test.ts', PRICE_TEST_WITH_TAX);
  run('done', 3, [{ name: 'Bash', target: 'npm test' }]);
  backend.push(id, { type: 'tool-result', id: agent, isError: false, output: 'テストを 1 件追加し、npm test で 2 件とも通りました。', at: Date.now() });
  backend.know(id, { 'src/lib/price.test.ts': 'edited' }, 47_000);

  // 7. 応答が届いて完了
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
  await sleep(4000);
}
