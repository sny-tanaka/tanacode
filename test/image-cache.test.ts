import { beforeEach, describe, expect, it, vi } from 'vitest';

// 会話ログに埋め込まれた画像の置き場（src/main/image-cache.ts）。上限は合わせて 200MB で、古いものから捨てる。
// 置き場はモジュールに 1 つなので、テストごとに読み込み直す

const MB = 1024 * 1024;
let cache: typeof import('../src/main/image-cache');
beforeEach(async () => {
  vi.resetModules();
  cache = await import('../src/main/image-cache');
});

describe('画像の置き場', () => {
  it('覚えた画像を鍵で返す。知らない鍵は null', () => {
    expect(cache.imageOf('a')).toBeNull();
    cache.rememberImage('a', 'data:image/png;base64,AAAA');
    cache.rememberImage('b', 'data:image/jpeg;base64,BBBB');
    expect(cache.imageOf('a')).toBe('data:image/png;base64,AAAA');
    expect(cache.imageOf('b')).toBe('data:image/jpeg;base64,BBBB');
    expect(cache.imageOf('c')).toBeNull();
  });

  it('同じ鍵で覚え直すと、新しいものに置き換える', () => {
    cache.rememberImage('a', 'data:image/png;base64,OLD');
    cache.rememberImage('a', 'data:image/png;base64,NEW');
    expect(cache.imageOf('a')).toBe('data:image/png;base64,NEW');
  });

  it('合わせて 200MB を超えたら、古いものから捨てる（ちょうど 200MB までは残す）', () => {
    // 同じ文字列を使い回す（大きさだけを数えるので、中身は同じでよい）
    const big = 'x'.repeat(70 * MB);
    cache.rememberImage('a', big);
    cache.rememberImage('b', big);
    expect(cache.imageOf('a')).toBe(big);
    cache.rememberImage('c', big);
    expect(cache.imageOf('a')).toBeNull();
    expect(cache.imageOf('b')).toBe(big);
    expect(cache.imageOf('c')).toBe(big);
    // 140MB + 60MB = ちょうど 200MB
    const rest = 'y'.repeat(60 * MB);
    cache.rememberImage('d', rest);
    expect([cache.imageOf('b'), cache.imageOf('c'), cache.imageOf('d')]).toEqual([big, big, rest]);
    // 1 文字でも超えたら、いちばん古い b を捨てる
    cache.rememberImage('e', 'z');
    expect(cache.imageOf('b')).toBeNull();
    expect(cache.imageOf('c')).toBe(big);
    expect(cache.imageOf('e')).toBe('z');
  });

  it('覚え直したものは新しいものとして数える（前の大きさは引き、捨てる順は後ろに回す）', () => {
    const big = 'x'.repeat(70 * MB);
    cache.rememberImage('a', big);
    cache.rememberImage('b', big);
    // a を覚え直しても、大きさは 140MB のまま（二重に数えない）。並びは b・a
    cache.rememberImage('a', big);
    expect(cache.imageOf('a')).toBe(big);
    expect(cache.imageOf('b')).toBe(big);
    // 210MB になるので、いちばん古い b を捨てる（覚え直した a は残す）
    cache.rememberImage('c', big);
    expect(cache.imageOf('b')).toBeNull();
    expect(cache.imageOf('a')).toBe(big);
    expect(cache.imageOf('c')).toBe(big);
  });

  it('小さい画像に置き換えたら、空いた分だけ、ほかの画像を捨てずに覚えられる', () => {
    const big = 'x'.repeat(70 * MB);
    cache.rememberImage('a', big);
    cache.rememberImage('b', big);
    cache.rememberImage('a', 'small');
    // 70MB + 5 文字 + 70MB < 200MB
    cache.rememberImage('c', big);
    expect([cache.imageOf('a'), cache.imageOf('b'), cache.imageOf('c')]).toEqual(['small', big, big]);
  });
});
