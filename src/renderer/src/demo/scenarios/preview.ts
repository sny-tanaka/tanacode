import type { DemoBackend } from '../backend';
import { CSS_PRICE_STACKED, ROOT } from '../data';
import { sleep, type Director } from '../director';
import { demoWebview, installDemoWebview, refreshDemoWebviews, type DemoPage } from '../webview';
import { Claude, pastTurn, statusLine } from './claude';

// 動画 5「アプリ内ブラウザ」: 開発中のページをアプリの中で開き、崩れている要素をクリックで選んで Claude に直してもらう。
// フッターの「ブラウザ」→ URL を開く → 表示幅をスマホに → 税込価格の行が折り返して崩れている → 「要素を選ぶ」で価格を選ぶ
// （入力欄にセレクタ・HTML と切り出した画像が入る）→ 書き足して送る → Claude が CSS を直し、ブラウザの表示が直る

export const PREVIEW_SESSION = 'demo-preview';

const URL = 'localhost:5173';
const PROMPT = 'スマホだと税抜の表示が途中で折り返して読みにくいので、税抜は価格の下の行に出して';

const ITEMS = [
  { name: 'カフェラテ', note: '自家焙煎', price: 520, hue: '#c8a27a' },
  { name: 'あんバタートースト', note: '粒あん', price: 680, hue: '#d9b27c' },
  { name: '季節のタルト', note: '日替わり', price: 750, hue: '#e0a3a0' },
];

// 開発サーバー（Vite）が出すメニューのページ。見た目はプロジェクトの styles.css に従う
function menuPage(backend: DemoBackend): DemoPage {
  const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;
  const cards = ITEMS.map(
    (item) => `<article class="menu-card">
  <div class="thumb" style="background: linear-gradient(135deg, ${item.hue}, #f6e7d3)"></div>
  <h3>${item.name}</h3>
  <p class="note">${item.note}</p>
  <p class="price">${yen(Math.floor(item.price * 1.1))}<small>（税抜 ${yen(item.price)}）</small></p>
</article>`,
  ).join('\n');
  return {
    title: 'Café Hinata',
    css: `body { background: #f4ece1; color: #3b2f25; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", system-ui, sans-serif; }
header { padding: 22px 20px 0; }
h1 { margin: 0; font-size: 26px; letter-spacing: 0.02em; }
.lead { margin: 4px 0 0; font-size: 13px; color: #8a7f72; }
main { padding: 16px 20px 24px; }
.menu-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.thumb { height: 72px; border-radius: 8px; }
.menu-card h3 { margin: 0; font-size: 15px; }
.menu-card .note { margin: 0; font-size: 12px; color: #8a7f72; }
.menu-card .price { margin: 2px 0 0; font-size: 26px; line-height: 1.3; }
@media (max-width: 480px) {
  header { padding: 18px 16px 0; }
  main { padding: 14px 16px 20px; }
  .menu-list { grid-template-columns: 1fr 1fr; }
}
${backend.project.files['src/styles.css'] ?? ''}`,
    body: `<header><h1>Café Hinata</h1><p class="lead">本日のメニュー</p></header>
<main><section class="menu-list">
${cards}
</section></main>`,
  };
}

export function setupPreview(backend: DemoBackend): void {
  const hour = 3600_000;
  backend.addSession('demo-readme', { title: 'README のセットアップ手順を見直す', updatedAt: Date.now() - 5 * hour });
  backend.addSession('demo-images', { title: 'メニュー画像を遅延読み込みにする', updatedAt: Date.now() - 26 * hour });
  backend.addSession(
    PREVIEW_SESSION,
    { title: 'メニューに税込価格を出す' },
    pastTurn(
      'past',
      'メニューの価格を税込みでも表示して。税率は 10%、1 円未満は切り捨てで。',
      [
        ['Grep', 'formatPrice', 900],
        ['Read', 'src/components/MenuCard.tsx', 800],
        ['Edit', 'src/lib/price.ts', 900],
        ['Edit', 'src/components/MenuCard.tsx', 900],
        ['Edit', 'src/styles.css', 700],
      ],
      'メニューに税込価格を出しました。カードは「¥572（税抜 ¥520）」の形で、税抜を小さく添えています。',
    ),
  );
  backend.know(PREVIEW_SESSION, { 'src/components/MenuCard.tsx': 'edited', 'src/lib/price.ts': 'edited', 'src/styles.css': 'edited' });
  backend.setStatusLine(PREVIEW_SESSION, statusLine(21, 42_000));
  installDemoWebview((url) => (url.includes(URL) ? menuPage(backend) : null));
}

// ブラウザのページの中の要素へカーソルを動かす（ページには、動いた位置の出来事を送る）
async function moveInPage(d: Director, selector: string, ms = 700): Promise<{ x: number; y: number }> {
  const wv = demoWebview();
  const target = wv?.pageElement(selector);
  if (!wv || !target) throw new Error(`demo: ページの要素が見つかりません: ${selector}`);
  await d.moveToPoint(target.x, target.y, ms);
  wv.dispatchMouse('mousemove', target.x, target.y);
  return target;
}

export async function runPreview(backend: DemoBackend, d: Director): Promise<void> {
  const id = PREVIEW_SESSION;
  const claude = new Claude(backend, id);
  const sent = new Promise<void>((resolve) => {
    backend.onUserMessage = (_sid, text, images) => {
      backend.push(id, { type: 'user', id: claude.next('u'), text, images });
      resolve();
    };
  });

  // 1. フッターの「ブラウザ」を開き、開発サーバーの URL を開く
  await sleep(1000);
  await d.click(d.byText('.status-button', 'ブラウザ'), { ms: 900 });
  await sleep(700);
  await d.click('.preview-address input', { ms: 600 });
  await d.type('.preview-address input', URL, 70);
  await sleep(300);
  (document.querySelector('.preview-address') as HTMLFormElement).requestSubmit();
  await sleep(2200);

  // 2. 表示幅をスマホにすると、価格の行が折り返して崩れている
  await d.click('.preview-width', { ms: 700 });
  const select = document.querySelector('.preview-width') as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, '390');
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(1200);
  await moveInPage(d, '.menu-card:nth-child(1) .price', 900);
  await sleep(500);
  await moveInPage(d, '.menu-card:nth-child(2) .price', 500);
  await sleep(900);

  // 3. 「要素を選ぶ」で価格を選ぶ（入力欄にセレクタ・HTML と、切り出した画像が入る）
  await d.click(d.byText('.preview-pane .ghost-button', '要素を選ぶ'), { ms: 800 });
  await sleep(500);
  await moveInPage(d, '.menu-card:nth-child(2) .note', 600);
  await sleep(400);
  const price = await moveInPage(d, '.menu-card:nth-child(1) .price', 600);
  await sleep(900);
  d.press();
  demoWebview()!.dispatchMouse('click', price.x, price.y);
  await sleep(1400);

  // 4. 書き足して送る
  await d.click('.chat-input textarea', { ms: 800 });
  await d.type('.chat-input textarea', PROMPT);
  await sleep(300);
  await d.click(d.byText('.send-button', '送信'));
  await sent;
  claude.startWorking();

  // 5. Claude が CSS を直すと、開発サーバーの更新でブラウザの表示も直る
  await sleep(1500);
  await claude.tool('Read', 'src/styles.css', 700, { filePath: `${ROOT}/src/styles.css` });
  await claude.edit('src/styles.css', CSS_PRICE_STACKED, 1000, ['+  display: block;', '-  margin-left: 6px;']);
  refreshDemoWebviews();
  await sleep(900);
  claude.stopWorking();
  claude.say(
    [
      '税抜の表示を、価格の下の行に出すようにしました。',
      '',
      '- `.price small` を `display: block` にし、左の余白を外しました',
      '- スマホの 2 列でも、価格と税抜がそれぞれ 1 行に収まります',
    ].join('\n'),
  );
  backend.push(id, { type: 'turn-end' });
  await sleep(1000);
  await moveInPage(d, '.menu-card:nth-child(1) .price', 900);
  await sleep(3000);
}
