// ツアーで Claude が書き換えるファイルの中身。ツアーはひとつのプロジェクト（data.ts の cafeProject）を始めから終わりまで直していくので、
// 章ごとの中身は前の章の続きになるようにする（税込価格 → アレルギー表示 → スマホの表示 → テイクアウトの価格）

export { CSS_PRICE_STACKED, CSS_WITH_TAX, PRICE_TEST_WITH_TAKEOUT, PRICE_TEST_WITH_TAX, PRICE_WITH_TAKEOUT, PRICE_WITH_TAX } from '../data';

// 章 2: 税込価格を足したカード
export { MENU_CARD_WITH_TAX } from '../data';

// 章 3: アレルギー表示
export const TYPES_WITH_ALLERGENS = `export type MenuItem = {
  id: string;
  name: string;
  note: string;
  // 税抜の価格（円）
  price: number;
  // 含まれるアレルギー物質（特定原材料）
  allergens?: string[];
};
`;

export const MENU_WITH_ALLERGENS = `import type { MenuItem } from '../types';

export const menu: MenuItem[] = [
  { id: 'latte', name: 'カフェラテ', note: '自家焙煎', price: 520, allergens: ['乳'] },
  { id: 'toast', name: 'あんバタートースト', note: '粒あん', price: 680, allergens: ['小麦', '乳'] },
  { id: 'tart', name: '季節のタルト', note: '日替わり', price: 750, allergens: ['小麦', '卵', '乳'] },
];
`;

// guarded: アレルギーが無い品目のことを考えている（考えていないと、型チェックの hooks に止められる）
export const menuCardWithAllergens = (guarded: boolean) => `import { formatPrice, withTax } from '../lib/price';
import type { MenuItem } from '../types';

export function MenuCard({ item }: { item: MenuItem }) {
  const { name, note, price, allergens } = item;
  return (
    <article className="menu-card">
      <h3>{name}</h3>
      <p className="note">{note}</p>
      <p className="price">
        {formatPrice(withTax(price))}
        <small>（税抜 {formatPrice(price)}）</small>
      </p>
      ${guarded ? '{allergens && allergens.length > 0 && (' : '{allergens.length > 0 && ('}
        <p className="allergens">アレルギー: {allergens.join('・')}</p>
      )}
    </article>
  );
}
`;

// 章 6: テイクアウトの価格も並べたカード
export const MENU_CARD_WITH_TAKEOUT = `import { formatPrice, TAKEOUT_TAX_RATE, withTax } from '../lib/price';
import type { MenuItem } from '../types';

export function MenuCard({ item }: { item: MenuItem }) {
  const { name, note, price, allergens } = item;
  return (
    <article className="menu-card">
      <h3>{name}</h3>
      <p className="note">{note}</p>
      <p className="price">
        {formatPrice(withTax(price))}
        <small>（税抜 {formatPrice(price)}）</small>
      </p>
      <p className="takeout">テイクアウト {formatPrice(withTax(price, TAKEOUT_TAX_RATE))}</p>
      {allergens && allergens.length > 0 && (
        <p className="allergens">アレルギー: {allergens.join('・')}</p>
      )}
    </article>
  );
}
`;
