import { monaco } from '../../../editor/monaco';
import { type Director, sleep } from '../../director';
import { MENU_CARD_WITH_TAKEOUT, PRICE_TEST_WITH_TAKEOUT, PRICE_WITH_TAKEOUT } from '../files';
import { MAIN, type Story } from '../story';

// 章 5「レビューして直す」: ブランチの変更を PR のように見て、差分の行にコメントを付け、まとめて直してもらう。
// 直したあと、回答のコマンドを ▶ でターミナルで流し、落ちたテストの出力を選んで「Claude へ送る」

const COMMENT_CARD = 'テイクアウトの税込価格も、ここに並べて出してください';
const COMMENT_PRICE = 'テイクアウトは軽減税率の 8% です。税率を引数で渡せるようにしてください';
const PROMPT = 'コメントの点を直して';

// テストの期待値を間違えたもの（あとでターミナルで落ちる）
const PRICE_TEST_WRONG = PRICE_TEST_WITH_TAKEOUT.replace('toBe(561)', 'toBe(562)');

// npm test の出力（1 件目は落ちる。直したあとは通る）
const TEST_FAILED = [
  '',
  '\x1b[7m\x1b[1m\x1b[36m RUN \x1b[0m \x1b[36mv3.2.4 \x1b[0m\x1b[90m/Users/demo/work/cafe-menu\x1b[0m',
  '',
  ' \x1b[31m❯\x1b[0m src/lib/price.test.ts \x1b[2m(3 tests | \x1b[0m\x1b[31m1 failed\x1b[0m\x1b[2m)\x1b[0m',
  '   \x1b[31m×\x1b[0m withTax > テイクアウトは 8% で計算する',
  '     → expected 561 to be 562 // Object.is equality',
  '',
  '\x1b[2m Test Files \x1b[0m \x1b[1m\x1b[31m1 failed\x1b[0m\x1b[90m (1)\x1b[0m',
  '\x1b[2m      Tests \x1b[0m \x1b[1m\x1b[31m1 failed\x1b[0m\x1b[2m | \x1b[0m\x1b[1m\x1b[32m2 passed\x1b[0m\x1b[90m (3)\x1b[0m',
  '',
  '$ ',
].join('\r\n');

// 差分の右側（変更後）で、text を含む行（空白は無視して比べる）
const squash = (s: string) => s.replace(/[\s ]/g, '');
function lineOf(text: string): () => Element | null {
  return () =>
    [...document.querySelectorAll('.diff-pane .modified-in-monaco-diff-editor .view-line')].find((e) => squash(e.textContent ?? '').includes(squash(text))) ?? null;
}

// 行番号の横の ＋ を押してコメントを書く
async function comment(d: Director, text: string, body: string): Promise<void> {
  const line = await d.find(lineOf(text));
  const editorEl = line.closest('.monaco-editor')!;
  const glyph = editorEl.querySelector('.glyph-margin')!.getBoundingClientRect();
  const r = line.getBoundingClientRect();
  const y = r.top + r.height / 2;
  await d.moveToPoint(r.left + 120, y, 800);
  await sleep(500);
  await d.clickPoint(glyph.left + glyph.width / 2, y, 400);
  // 合成したクリックを Monaco が受け取らなかったときは、右クリックメニューの項目と同じ操作で書き始める
  try {
    await d.find('.comment-box.draft textarea', 700);
  } catch {
    const editor = monaco.editor.getEditors().find((e) => e.getDomNode()?.contains(line));
    const model = editor?.getModel();
    const lineNumber = model?.getLinesContent().findIndex((l) => squash(l).includes(squash(text)));
    if (!editor || lineNumber === undefined || lineNumber < 0) throw new Error('demo: コメントを付ける行が見つかりません');
    editor.setPosition({ lineNumber: lineNumber + 1, column: 1 });
    await editor.getAction('tanacode.addComment')?.run();
  }
  await sleep(300);
  await d.type('.comment-box.draft textarea', body, 40);
  await sleep(300);
  await d.click('.comment-box.draft [aria-label="コメントを追加"]', { ms: 500 });
}

// ターミナルの、text を含む行
function terminalRow(text: string): Element | null {
  return [...document.querySelectorAll('.terminal-panel .terminal-instance:not([hidden]) .xterm-rows > div')].find((e) => e.textContent?.includes(text)) ?? null;
}

// ターミナルの出力を、from の行の頭から to の行の終わりまで、マウスで選ぶ
async function selectTerminal(d: Director, from: string, to: string): Promise<void> {
  const start = await d.find(() => terminalRow(from));
  const end = await d.find(() => terminalRow(to));
  const screen = start.closest('.xterm')!.querySelector('.xterm-screen')!;
  const a = start.getBoundingClientRect();
  const b = end.getBoundingClientRect();
  const span = [...end.querySelectorAll('span')].at(-1)?.getBoundingClientRect();
  const x0 = a.left + 2;
  const y0 = a.top + a.height / 2;
  const x1 = (span?.right ?? b.right) - 2;
  const y1 = b.top + b.height / 2;
  await d.moveToPoint(x0, y0, 700);
  const init = { bubbles: true, cancelable: true, button: 0, view: window };
  screen.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 1, buttons: 1, clientX: x0, clientY: y0 }));
  d.press();
  await d.moveToPoint(x1, y1, 900);
  document.dispatchEvent(new MouseEvent('mousemove', { ...init, buttons: 1, clientX: x1, clientY: y1 }));
  document.dispatchEvent(new MouseEvent('mouseup', { ...init, clientX: x1, clientY: y1 }));
  await sleep(300);
}

export async function runReview(story: Story): Promise<void> {
  const { backend, d } = story;
  const claude = story.claude();
  const id = MAIN;

  // 1. ステータスバーのブランチ名から、ソース管理の「ブランチの変更」を開く
  d.caption('ステータスバーのブランチ名から、ソース管理の「ブランチの変更」を開きます。分岐したところからの変更が、PR のように並びます', '.status-button[data-tip$="ソース管理を開く"]');
  await sleep(1000);
  await d.click('.status-button[data-tip$="ソース管理を開く"]', { ms: 900 });
  await sleep(1400);

  // 2. MenuCard.tsx の差分を開き、インラインにする
  d.caption('変わったファイルを選ぶと、差分が開きます', '.scm-row[title^="src/components/MenuCard.tsx"]');
  await d.click('.scm-row[title^="src/components/MenuCard.tsx"]');
  await sleep(900);
  await d.click('.diff-pane-head [aria-label="インライン"]', { ms: 600 });
  await sleep(900);

  // 3. 行に ＋ でコメントを付ける（ソース管理の下と入力欄の上にたまる）
  d.caption('行番号の横の ＋ で、差分の行にコメントを付けます', '.diff-pane');
  await comment(d, '<small>（税抜', COMMENT_CARD);
  await sleep(1000);

  // 4. ↓ で次のファイルへ移り、price.ts にもう 1 件
  d.caption('↓ で次のファイルへ移り、もう 1 件。コメントは入力欄の上にたまります', '.diff-pane-head [aria-label="次のファイル"]');
  const next = '.diff-pane-head [aria-label="次のファイル"]';
  for (let i = 0; i < 4 && !document.querySelector('.diff-pane-head')?.textContent?.includes('price.ts'); i++) {
    await d.click(next, { ms: i === 0 ? 700 : 300 });
    await sleep(700);
  }
  await comment(d, 'export const TAX_RATE', COMMENT_PRICE);
  await sleep(1200);

  // 5. コメントを添えて送る
  d.caption('たまったコメントは、指示に添えてまとめて送れます', '.chat-input');
  await story.send(PROMPT);
  claude.startWorking();

  // 6. Claude が直す。開いている差分も書き換わる
  await sleep(1300);
  d.caption('Claude が直すと、開いている差分もその場で書き換わります', '.diff-pane');
  await claude.edit('src/lib/price.ts', PRICE_WITH_TAKEOUT, 900, [
    '-// 消費税率（10%）',
    '+// 消費税率（店内 10%・テイクアウトは軽減税率 8%）',
    '+export const TAKEOUT_TAX_RATE = 0.08;',
    '-export function withTax(yen: number): number {',
    '-  return Math.floor(yen * (1 + TAX_RATE));',
    '+export function withTax(yen: number, rate = TAX_RATE): number {',
    '+  return Math.floor(yen * (1 + rate));',
  ]);
  await sleep(400);
  await claude.edit('src/components/MenuCard.tsx', MENU_CARD_WITH_TAKEOUT, 900, [
    "-import { formatPrice, withTax } from '../lib/price';",
    "+import { formatPrice, TAKEOUT_TAX_RATE, withTax } from '../lib/price';",
    '+      <p className="takeout">テイクアウト {formatPrice(withTax(price, TAKEOUT_TAX_RATE))}</p>',
  ]);
  await claude.edit('src/lib/price.test.ts', PRICE_TEST_WRONG, 800, ["+  it('テイクアウトは 8% で計算する', () => {", '+    expect(withTax(520, TAKEOUT_TAX_RATE)).toBe(562);', '+  });']);
  await sleep(500);
  claude.stopWorking();
  claude.say(
    [
      'レビューのコメント 2 件に対応しました。',
      '',
      '- `withTax` に税率の引数を足し、テイクアウト用に `TAKEOUT_TAX_RATE`（8%）を用意',
      '- カードに「テイクアウト ¥561」を並べて出すように',
      '- テイクアウトのテストを追加',
      '',
      'テストは次で流せます。',
      '',
      '```bash',
      'npm test',
      '```',
    ].join('\n'),
  );
  backend.push(id, { type: 'turn-end' });
  await sleep(1200);

  // 7. 回答のコマンドを ▶ でターミナルで流す
  d.caption('回答のコマンドは、▶ でそのままターミナルで流せます', () => [...document.querySelectorAll('.markdown pre.runnable')].at(-1));
  let shell = '';
  backend.onShellWrite = (shellId, data) => {
    if (!data.includes('npm test')) return;
    shell = shellId;
    backend.shellOutput(shellId, `$ npm test\r\n\r\n> cafe-menu@0.0.0 test\r\n> vitest run\r\n`);
    setTimeout(() => backend.shellOutput(shellId, TEST_FAILED), 900);
  };
  story.toBottom();
  await sleep(600);
  await d.click(() => [...document.querySelectorAll('.markdown pre.runnable > button.code-run')].at(-1), { ms: 900 });
  await d.find(() => terminalRow('expected 561'));
  await sleep(1500);

  // 8. 落ちたテストの出力を選んで「Claude へ送る」
  d.caption('落ちたテストの出力を選んで「Claude へ送る」と、入力欄にそのまま貼られます', '.terminal-panel');
  await selectTerminal(d, 'src/lib/price.test.ts', 'expected 561');
  await sleep(500);
  await d.click('.terminal-panel [aria-label="Claude へ送る"]', { ms: 700 });
  await sleep(900);
  // 貼った出力の下の行に書き足す
  await story.send('\nこのテストが落ちています。直して');
  claude.startWorking();
  await sleep(1200);
  claude.say('期待値が間違っていました（520 × 1.08 = 561.6 を切り捨てて 561）。テストを直します。');
  await claude.edit('src/lib/price.test.ts', PRICE_TEST_WITH_TAKEOUT, 800, ['-    expect(withTax(520, TAKEOUT_TAX_RATE)).toBe(562);', '+    expect(withTax(520, TAKEOUT_TAX_RATE)).toBe(561);']);
  await claude.tool('Bash', 'npm test', 1400, { description: 'テストを流す', result: { output: ' ✓ src/lib/price.test.ts (3 tests)\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)' } });
  claude.stopWorking();
  claude.say('テストの期待値を 561 に直し、`npm test` で 3 件とも通ることを確かめました。');
  backend.push(id, { type: 'turn-end' });
  if (shell) backend.shellOutput(shell, '');
  d.caption('直った差分は、そのまま確かめられます', '.diff-pane');
  await sleep(1000);
  await d.click('.terminal-panel [aria-label="パネルを閉じる"]', { ms: 700 });
  await sleep(500);
  await d.click('.scm-row[title^="src/components/MenuCard.tsx"]', { ms: 800 });
  await sleep(2500);
}
