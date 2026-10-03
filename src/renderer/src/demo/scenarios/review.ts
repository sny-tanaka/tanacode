import { monaco } from '../../editor/monaco';
import type { DemoBackend } from '../backend';
import { MENU_CARD_WITH_TAKEOUT, PRICE_TEST_WITH_TAKEOUT, PRICE_WITH_TAKEOUT } from '../data';
import { sleep, type Director } from '../director';
import { Claude, pastTurn, statusLine } from './claude';

// 動画 2「ローカルのプルリクエストとレビュー」: ブランチの変更を PR のように見て、差分の行にコメントを付け、まとめて Claude に直してもらう。
// ステータスバーのブランチ名 → ソース管理の「ブランチの変更」→ 差分に ＋ でコメント → ↓ で次のファイル → もう 1 件 →
// コメントを添えて送る → Claude が直し、開いている差分も書き換わる

export const REVIEW_SESSION = 'demo-review';

const COMMENT_CARD = 'テイクアウトの税込価格も、ここに並べて出してください';
const COMMENT_PRICE = 'テイクアウトは軽減税率の 8% です。税率を引数で渡せるようにしてください';
const PROMPT = 'コメントの点を直して';

export function setupReview(backend: DemoBackend): void {
  const hour = 3600_000;
  backend.addSession('demo-readme', { title: 'README のセットアップ手順を見直す', updatedAt: Date.now() - 5 * hour });
  backend.addSession('demo-images', { title: 'メニュー画像を遅延読み込みにする', updatedAt: Date.now() - 26 * hour });
  backend.addSession(
    REVIEW_SESSION,
    { title: 'メニューに税込価格を出す' },
    pastTurn(
      'past',
      'メニューの価格を税込みでも表示して。税率は 10%、1 円未満は切り捨てで。',
      [
        ['Grep', 'formatPrice', 900],
        ['Read', 'src/components/MenuCard.tsx', 800],
        ['Read', 'src/lib/price.ts', 700],
        ['Edit', 'src/lib/price.ts', 900],
        ['Edit', 'src/components/MenuCard.tsx', 900],
        ['Edit', 'src/styles.css', 700],
        ['Agent', '税込計算のテストを追加して流す', 5000],
      ],
      [
        'メニューに税込価格を出しました。',
        '',
        '- `withTax` を追加（税率 10%、1 円未満は切り捨て）',
        '- カードは「¥572（税抜 ¥520）」の形で、税抜を小さく添えています',
        '- `withTax` のテストを追加し、`npm test` が通ることを確かめました',
      ].join('\n'),
    ),
  );
  backend.know(REVIEW_SESSION, {
    'src/components/MenuCard.tsx': 'edited',
    'src/lib/price.ts': 'edited',
    'src/styles.css': 'edited',
    'src/lib/price.test.ts': 'edited',
  });
  backend.setStatusLine(REVIEW_SESSION, statusLine(24, 47_000));
}

// 差分の右側（変更後）で、text を含む行（空白は無視して比べる）
const squash = (s: string) => s.replace(/[\s ]/g, '');
function lineOf(text: string): () => Element | null {
  return () =>
    [...document.querySelectorAll('.diff-pane .modified-in-monaco-diff-editor .view-line')].find((e) =>
      squash(e.textContent ?? '').includes(squash(text)),
    ) ?? null;
}

// 行番号の横の ＋ を押してコメントを書く
async function comment(d: Director, text: string, body: string): Promise<void> {
  const line = await d.find(lineOf(text));
  const editorEl = line.closest('.monaco-editor')!;
  const glyph = editorEl.querySelector('.glyph-margin')!.getBoundingClientRect();
  const r = line.getBoundingClientRect();
  const y = r.top + r.height / 2;
  // 行にマウスを乗せると ＋ が出る
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

export async function runReview(backend: DemoBackend, d: Director): Promise<void> {
  const id = REVIEW_SESSION;
  const claude = new Claude(backend, id);
  const sent = new Promise<void>((resolve) => {
    backend.onUserMessage = (_sid, text) => {
      claude.user(text);
      resolve();
    };
  });

  // 1. ステータスバーのブランチ名から、ソース管理の「ブランチの変更」を開く
  await sleep(1200);
  await d.click('.status-button[data-tip="ソース管理を開く"]', { ms: 900 });
  await sleep(1400);

  // 2. MenuCard.tsx の差分を開き、インラインにする
  await d.click('.scm-row[title^="src/components/MenuCard.tsx"]');
  await sleep(900);
  await d.click('.diff-pane-head [aria-label="インライン"]', { ms: 600 });
  await sleep(900);

  // 3. 行に ＋ でコメントを付ける（ソース管理の下と入力欄の上にたまる）
  await comment(d, '<small>（税抜', COMMENT_CARD);
  await sleep(1200);

  // 4. ↓ で次のファイルへ移り、price.ts にもう 1 件
  await d.click('.diff-pane-head [aria-label="次のファイル"]', { ms: 700 });
  await sleep(700);
  await d.click('.diff-pane-head [aria-label="次のファイル"]', { ms: 200 });
  await sleep(900);
  await comment(d, 'export const TAX_RATE', COMMENT_PRICE);
  await sleep(1400);

  // 5. コメントを添えて送る
  await d.click('.chat-input textarea', { ms: 800 });
  await d.type('.chat-input textarea', PROMPT);
  await sleep(300);
  await d.click('.chat-input-row [aria-label="送信"]');
  await sent;
  claude.startWorking();

  // 6. Claude が直す。開いている price.ts の差分も書き換わる
  await sleep(1400);
  await claude.edit('src/lib/price.ts', PRICE_WITH_TAKEOUT, 900, [
    '-// 消費税率（10%）',
    '+// 消費税率（店内 10%・テイクアウトは軽減税率 8%）',
    '+export const TAKEOUT_TAX_RATE = 0.08;',
    '-export function withTax(yen: number): number {',
    '-  return Math.floor(yen * (1 + TAX_RATE));',
    '+export function withTax(yen: number, rate = TAX_RATE): number {',
    '+  return Math.floor(yen * (1 + rate));',
  ]);
  await sleep(500);
  await claude.edit('src/components/MenuCard.tsx', MENU_CARD_WITH_TAKEOUT, 900, [
    "-import { formatPrice, withTax } from '../lib/price';",
    "+import { formatPrice, TAKEOUT_TAX_RATE, withTax } from '../lib/price';",
    '+      <p className="takeout">テイクアウト {formatPrice(withTax(price, TAKEOUT_TAX_RATE))}</p>',
  ]);
  await claude.edit('src/lib/price.test.ts', PRICE_TEST_WITH_TAKEOUT, 800, [
    "-import { formatPrice, withTax } from './price';",
    "+import { formatPrice, TAKEOUT_TAX_RATE, withTax } from './price';",
    '+',
    "+  it('テイクアウトは 8% で計算する', () => {",
    '+    expect(withTax(520, TAKEOUT_TAX_RATE)).toBe(561);',
    '+  });',
  ]);
  await claude.tool('Bash', 'npm test', 1600, { description: 'テストを流す', result: { output: ' ✓ src/lib/price.test.ts (3 tests)\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)' } });
  backend.setStatusLine(id, statusLine(28, 55_000));

  // 7. 応答が届いて完了。MenuCard.tsx の差分で、足された行を見る
  await sleep(700);
  claude.stopWorking();
  claude.say(
    [
      'レビューのコメント 2 件に対応しました。',
      '',
      '- `withTax` に税率の引数を足し、テイクアウト用に `TAKEOUT_TAX_RATE`（8%）を用意',
      '- カードの下に「テイクアウト ¥561」を並べて出すように',
      '- テイクアウトのテストを追加し、`npm test` が通ることを確かめました',
    ].join('\n'),
  );
  backend.push(id, { type: 'turn-end' });
  await sleep(1200);
  await d.click('.scm-row[title^="src/components/MenuCard.tsx"]', { ms: 800 });
  await sleep(3500);
}
