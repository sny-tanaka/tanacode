import { describe, expect, it } from 'vitest';
import { fill, language, message, t } from '@shared/i18n';

// 画面の文言（src/shared/i18n.ts と src/shared/locales/）

describe('文言を読む', () => {
  it('キーの文言を返す。既定は日本語', () => {
    expect(language()).toBe('ja');
    expect(t('common.cancel')).toBe('キャンセル');
  });

  it('無いキーは、キーのまま返す（型チェックを抜けてきたとき）', () => {
    expect(message('common.nope' as never)).toBe('common.nope');
    expect(message('common.cancel.more' as never)).toBe('common.cancel.more');
  });
});

describe('値の埋め込み', () => {
  it('{name} を値で置き換える。数も文字にする', () => {
    expect(fill('{count} 件のファイル（{path}）', { count: 3, path: 'src' })).toBe('3 件のファイル（src）');
  });

  it('同じ名前は何度でも置き換え、無い名前はそのまま残す', () => {
    expect(fill('{a}/{a}/{b}', { a: 'x' })).toBe('x/x/{b}');
  });

  it('値の中の {…} や $ は、そのまま入れる（置き換えの記号として読まない）', () => {
    expect(fill('「{name}」', { name: '{count} $& $1' })).toBe('「{count} $& $1」');
  });
});
