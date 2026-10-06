import type { ModelCatalog } from '@shared/models';
import type { UsageLimits } from '@shared/usage';
import type { DemoProject } from './backend';

// デモ用の作り物のプロジェクト（カフェのメニューを出す小さな React のアプリ）。実在の情報は含めない

export const ROOT = '/Users/demo/work/cafe-menu';

const menuCard = `import { formatPrice } from '../lib/price';
import type { MenuItem } from '../types';

export function MenuCard({ item }: { item: MenuItem }) {
  const { name, note, price } = item;
  return (
    <article className="menu-card">
      <h3>{name}</h3>
      <p className="note">{note}</p>
      <p className="price">{formatPrice(price)}</p>
    </article>
  );
}
`;

const price = `// 金額を「¥1,200」の形にする
export function formatPrice(yen: number): string {
  return \`¥\${yen.toLocaleString('ja-JP')}\`;
}
`;

const menuList = `import { MenuCard } from './MenuCard';
import type { MenuItem } from '../types';

export function MenuList({ items }: { items: MenuItem[] }) {
  return (
    <section className="menu-list">
      {items.map((item) => (
        <MenuCard key={item.id} item={item} />
      ))}
    </section>
  );
}
`;

const types = `export type MenuItem = {
  id: string;
  name: string;
  note: string;
  // 税抜の価格（円）
  price: number;
};
`;

const app = `import { MenuList } from './components/MenuList';
import { menu } from './data/menu';

export function App() {
  return (
    <main>
      <h1>Café Hinata</h1>
      <MenuList items={menu} />
    </main>
  );
}
`;

const menuData = `import type { MenuItem } from '../types';

export const menu: MenuItem[] = [
  { id: 'latte', name: 'カフェラテ', note: '自家焙煎', price: 520 },
  { id: 'toast', name: 'あんバタートースト', note: '粒あん', price: 680 },
  { id: 'tart', name: '季節のタルト', note: '日替わり', price: 750 },
];
`;

const priceTest = `import { describe, expect, it } from 'vitest';
import { formatPrice } from './price';

describe('formatPrice', () => {
  it('3 桁ごとに区切る', () => {
    expect(formatPrice(1200)).toBe('¥1,200');
  });
});
`;

const css = `.menu-card {
  display: grid;
  gap: 8px;
  padding: 16px;
  border-radius: 12px;
  background: #fffaf3;
}

.menu-card .price {
  font-weight: 600;
}
`;

const readme = `# cafe-menu

Café Hinata のメニューを表示するサイト。

\`\`\`bash
npm install
npm run dev
\`\`\`
`;

const pkg = `{
  "name": "cafe-menu",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run"
  }
}
`;

export function cafeProject(): DemoProject {
  const files: Record<string, string> = {
    'README.md': readme,
    'package.json': pkg,
    'src/App.tsx': app,
    'src/types.ts': types,
    'src/data/menu.ts': menuData,
    'src/components/MenuCard.tsx': menuCard,
    'src/components/MenuList.tsx': menuList,
    'src/lib/price.ts': price,
    'src/lib/price.test.ts': priceTest,
    'src/styles.css': css,
  };
  return { root: ROOT, name: 'cafe-menu', branch: 'feature/tax-included-price', baseRef: 'main', files: { ...files }, base: { ...files } };
}

// Claude が書き換えたあとのファイル
export const PRICE_WITH_TAX = `// 金額を「¥1,200」の形にする
export function formatPrice(yen: number): string {
  return \`¥\${yen.toLocaleString('ja-JP')}\`;
}

// 消費税率（10%）
export const TAX_RATE = 0.1;

// 税込の金額。1 円未満は切り捨てる
export function withTax(yen: number): number {
  return Math.floor(yen * (1 + TAX_RATE));
}
`;

export const MENU_CARD_WITH_TAX = `import { formatPrice, withTax } from '../lib/price';
import type { MenuItem } from '../types';

export function MenuCard({ item }: { item: MenuItem }) {
  const { name, note, price } = item;
  return (
    <article className="menu-card">
      <h3>{name}</h3>
      <p className="note">{note}</p>
      <p className="price">
        {formatPrice(withTax(price))}
        <small>（税抜 {formatPrice(price)}）</small>
      </p>
    </article>
  );
}
`;

export const PRICE_TEST_WITH_TAX = `import { describe, expect, it } from 'vitest';
import { formatPrice, withTax } from './price';

describe('formatPrice', () => {
  it('3 桁ごとに区切る', () => {
    expect(formatPrice(1200)).toBe('¥1,200');
  });
});

describe('withTax', () => {
  it('10% を足して、1 円未満を切り捨てる', () => {
    expect(withTax(520)).toBe(572);
    expect(withTax(755)).toBe(830);
  });
});
`;

export const CSS_WITH_TAX = `.menu-card {
  display: grid;
  gap: 8px;
  padding: 16px;
  border-radius: 12px;
  background: #fffaf3;
}

.menu-card .price {
  font-weight: 600;
}

.menu-card .price small {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: #8a7f72;
}
`;

export function demoUsage(): UsageLimits {
  const now = Date.now();
  return {
    limits: [
      { label: '5時間', percent: 18, resetsAt: now + 3 * 3600_000 + 12 * 60_000 },
      { label: '週', percent: 37, resetsAt: now + 4 * 86400_000 },
    ],
    updatedAt: now,
    source: 'statusline',
  };
}

export const DEMO_CATALOG: ModelCatalog = {
  choices: [
    { value: 'default', name: '既定', detail: '', disabled: false, efforts: ['low', 'medium', 'high', 'xhigh'] },
    { value: 'opus', name: 'Opus 5.5', detail: '', disabled: false, efforts: ['low', 'medium', 'high', 'xhigh'] },
    { value: 'sonnet', name: 'Sonnet 5.5', detail: '', disabled: false, efforts: ['low', 'medium', 'high'] },
  ],
  updatedAt: Date.now(),
};

// レビューのコメントを受けて直したあと（章 5）
export const PRICE_WITH_TAKEOUT = `// 金額を「¥1,200」の形にする
export function formatPrice(yen: number): string {
  return \`¥\${yen.toLocaleString('ja-JP')}\`;
}

// 消費税率（店内 10%・テイクアウトは軽減税率 8%）
export const TAX_RATE = 0.1;
export const TAKEOUT_TAX_RATE = 0.08;

// 税込の金額。1 円未満は切り捨てる
export function withTax(yen: number, rate = TAX_RATE): number {
  return Math.floor(yen * (1 + rate));
}
`;

export const PRICE_TEST_WITH_TAKEOUT = `import { describe, expect, it } from 'vitest';
import { formatPrice, TAKEOUT_TAX_RATE, withTax } from './price';

describe('formatPrice', () => {
  it('3 桁ごとに区切る', () => {
    expect(formatPrice(1200)).toBe('¥1,200');
  });
});

describe('withTax', () => {
  it('10% を足して、1 円未満を切り捨てる', () => {
    expect(withTax(520)).toBe(572);
    expect(withTax(755)).toBe(830);
  });

  it('テイクアウトは 8% で計算する', () => {
    expect(withTax(520, TAKEOUT_TAX_RATE)).toBe(561);
  });
});
`;

// スマホで税抜が価格の下の行に出るようにしたあと（章 4）
export const CSS_PRICE_STACKED = `.menu-card {
  display: grid;
  gap: 8px;
  padding: 16px;
  border-radius: 12px;
  background: #fffaf3;
}

.menu-card .price {
  font-weight: 600;
}

.menu-card .price small {
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: #8a7f72;
}
`;
