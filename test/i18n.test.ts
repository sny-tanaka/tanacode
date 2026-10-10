import { afterEach, describe, expect, it } from 'vitest';
import { fill, language, locale, message, resolveLanguage, setLanguage, t, tFor } from '@shared/i18n';
import en from '../src/shared/locales/en.json';
import ja from '../src/shared/locales/ja.json';

// 画面の文言（src/shared/i18n.ts と src/shared/locales/）

afterEach(() => setLanguage('ja'));

type Tree = { [key: string]: string | Tree };
const leaves = (tree: Tree, prefix = ''): [string, string][] =>
  Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[prefix + key, value] as [string, string]] : leaves(value, `${prefix}${key}.`)));
const jaMap = new Map(leaves(ja));
const enMap = new Map(leaves(en));
const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('文言を読む', () => {
  it('キーの文言を返す。既定は日本語', () => {
    expect(language()).toBe('ja');
    expect(t('common.cancel')).toBe('キャンセル');
  });

  it('言語を切り替えると、その言語の文言を返す', () => {
    setLanguage('en');
    expect(t('common.cancel')).toBe('Cancel');
    expect(locale()).toBe('en-US');
    setLanguage('ja');
    expect(locale()).toBe('ja-JP');
  });

  it('無いキーは、キーのまま返す（型チェックを抜けてきたとき）。英語でも同じ', () => {
    expect(message('common.nope' as never)).toBe('common.nope');
    expect(message('common.cancel.more' as never)).toBe('common.cancel.more');
    setLanguage('en');
    expect(message('common.nope' as never)).toBe('common.nope');
  });

  it('tFor は、今の言語によらず、指定した言語の文言に埋め込む', () => {
    expect(tFor('en', 'main.notification.images', { count: 2 })).toBe(fill(enMap.get('main.notification.images')!, { count: 2 }));
    expect(tFor('en', 'common.cancel')).toBe('Cancel');
    expect(language()).toBe('ja');
  });

  it('count が 1 なら単数形（_one）を使う。無い言語やキーでは、ふつうの形', () => {
    setLanguage('en');
    expect(t('main.notification.images', { count: 1 })).toBe(fill(enMap.get('main.notification.images_one')!, { count: 1 }));
    expect(t('main.notification.images', { count: 2 })).toBe(fill(enMap.get('main.notification.images')!, { count: 2 }));
    setLanguage('ja');
    expect(t('main.notification.images', { count: 1 })).toBe(fill(jaMap.get('main.notification.images')!, { count: 1 }));
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

describe('使う言語の決め方', () => {
  it('日本語・英語を選んでいれば、その言語', () => {
    expect(resolveLanguage('ja', ['en-US'])).toBe('ja');
    expect(resolveLanguage('en', ['ja-JP'])).toBe('en');
  });

  it('システムに合わせるなら、Mac の優先する言語に日本語があれば日本語（2 番目以降でも）、無ければ英語', () => {
    expect(resolveLanguage('system', ['ja-JP'])).toBe('ja');
    expect(resolveLanguage('system', ['en-US', 'ja'])).toBe('ja');
    expect(resolveLanguage('system', ['en-GB', 'fr-FR'])).toBe('en');
    expect(resolveLanguage('system', ['jv-ID'])).toBe('en');
    expect(resolveLanguage('system', [])).toBe('en');
  });
});

describe('言語ごとの JSON', () => {
  it('日本語と英語で、キーが過不足なくそろっている（英語の単数形 _one を除く）', () => {
    expect([...enMap.keys()].filter((key) => !key.endsWith('_one') && !jaMap.has(key))).toEqual([]);
    expect([...jaMap.keys()].filter((key) => !enMap.has(key))).toEqual([]);
  });

  it('埋め込む値（{name}）が、日本語と英語で同じ', () => {
    const differ = [...jaMap].filter(([key, text]) => enMap.has(key) && names(enMap.get(key)!).join() !== names(text).join()).map(([key]) => key);
    expect(differ).toEqual([]);
  });

  it('単数形（_one）は、{count} を埋め込む文言にだけあり、埋め込む値も同じ', () => {
    const wrong = [...enMap]
      .filter(([key]) => key.endsWith('_one'))
      .filter(([key, text]) => {
        const base = enMap.get(key.slice(0, -4));
        return !base || !names(base).includes('count') || names(base).join() !== names(text).join();
      })
      .map(([key]) => key);
    expect(wrong).toEqual([]);
  });

  it('英語に、日本語の文字や記号が残っていない', () => {
    expect([...enMap].filter(([, text]) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}（）「」、。]/u.test(text)).map(([key]) => key)).toEqual([]);
  });

  it('hooks の確認の理由は、シェルと JSON に埋め込むので、引用符とバックスラッシュを含まない', () => {
    for (const map of [jaMap, enMap]) {
      const reasons = [...map].filter(([key]) => key.startsWith('main.hooks.'));
      expect(reasons.length).toBeGreaterThan(0);
      for (const [key, text] of reasons) expect([key, /['"\\]/.test(text)]).toEqual([key, false]);
    }
  });
});
