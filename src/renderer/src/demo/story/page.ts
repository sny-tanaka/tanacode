import type { DemoBackend } from '../backend';
import type { DemoPage } from '../webview';

// アプリ内ブラウザで開く、開発サーバー（Vite）のページの作り物。プロジェクトの今のファイルに合わせて中身が変わる
// （税込価格・アレルギー表示・テイクアウトの価格。見た目は styles.css に従う）。管理画面はログインのあとに開ける

export const DEV_URL = 'localhost:5173';
export const ADMIN_URL = 'localhost:5173/admin';

const ITEMS = [
  { name: 'カフェラテ', note: '自家焙煎', price: 520, hue: '#c8a27a', allergens: '乳' },
  { name: 'あんバタートースト', note: '粒あん', price: 680, hue: '#d9b27c', allergens: '小麦・乳' },
  { name: '季節のタルト', note: '日替わり', price: 750, hue: '#e0a3a0', allergens: '小麦・卵・乳' },
];

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

const BASE_CSS = `body { background: #f4ece1; color: #3b2f25; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", system-ui, sans-serif; }
header { padding: 22px 20px 0; }
h1 { margin: 0; font-size: 26px; letter-spacing: 0.02em; }
.lead { margin: 4px 0 0; font-size: 13px; color: #8a7f72; }
main { padding: 16px 20px 24px; }
.menu-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.thumb { height: 72px; border-radius: 8px; }
.menu-card h3 { margin: 0; font-size: 15px; }
.menu-card .note, .menu-card .allergens, .menu-card .takeout { margin: 0; font-size: 12px; color: #8a7f72; }
.menu-card .price { margin: 2px 0 0; font-size: 26px; line-height: 1.3; }
.login { max-width: 280px; margin: 40px auto; display: grid; gap: 10px; }
.login input { padding: 8px 10px; border: 1px solid #d8cbb9; border-radius: 6px; font: inherit; }
.login button { padding: 8px; border: 0; border-radius: 6px; background: #3b2f25; color: #fff; font: inherit; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px 6px; border-bottom: 1px solid #e3d7c6; text-align: left; }
@media (max-width: 480px) {
  header { padding: 18px 16px 0; }
  main { padding: 14px 16px 20px; }
  .menu-list { grid-template-columns: 1fr 1fr; }
}`;

export function cafePage(backend: DemoBackend, url: string): DemoPage | null {
  if (!url.includes(DEV_URL)) return null;
  const files = backend.project.files;
  const card = files['src/components/MenuCard.tsx'] ?? '';
  const css = `${BASE_CSS}\n${files['src/styles.css'] ?? ''}`;
  if (url.includes('/admin')) {
    // ログインのあと（台本が loggedIn にする）は、品目の管理の表を出す
    if (!loggedIn) {
      return {
        title: 'ログイン · Café Hinata',
        css,
        body: `<form class="login"><h1>管理画面</h1><input placeholder="メールアドレス"><input type="password" placeholder="パスワード"><button type="button">ログイン</button></form>`,
      };
    }
    const rows = ITEMS.map((item) => `<tr><td>${item.name}</td><td>${yen(item.price)}</td><td>${yen(Math.floor(item.price * 1.1))}</td></tr>`).join('');
    return {
      title: '管理画面 · Café Hinata',
      css,
      body: `<header><h1>メニューの管理</h1><p class="lead">価格は税抜で登録します</p></header><main><table><tr><th>品目</th><th>税抜</th><th>税込</th></tr>${rows}</table></main>`,
    };
  }
  const taxed = card.includes('withTax');
  const cards = ITEMS.map((item) => {
    const price = taxed ? `${yen(Math.floor(item.price * 1.1))}<small>（税抜 ${yen(item.price)}）</small>` : yen(item.price);
    const takeout = card.includes('takeout') ? `<p class="takeout">テイクアウト ${yen(Math.floor(item.price * 1.08))}</p>` : '';
    const allergens = card.includes('allergens') ? `<p class="allergens">アレルギー: ${item.allergens}</p>` : '';
    return `<article class="menu-card">
  <div class="thumb" style="background: linear-gradient(135deg, ${item.hue}, #f6e7d3)"></div>
  <h3>${item.name}</h3>
  <p class="note">${item.note}</p>
  <p class="price">${price}</p>${takeout}${allergens}
</article>`;
  }).join('\n');
  return {
    title: 'Café Hinata',
    css,
    body: `<header><h1>Café Hinata</h1><p class="lead">本日のメニュー</p></header>
<main><section class="menu-list">
${cards}
</section></main>`,
  };
}

// 管理画面にログインしたか（章 4 で、あなたの番の操作が終わったところで true にする）
let loggedIn = false;
export function setLoggedIn(value: boolean): void {
  loggedIn = value;
}
