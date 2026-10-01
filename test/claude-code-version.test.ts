import { describe, expect, it } from 'vitest';
import { compareVersions, versionMatch } from '@shared/claude-code';

// ステータスバーで、入っている Claude Code の版を tanacode で動作確認済のバージョンと比べる
describe('versionMatch', () => {
  it('同じ版だけが same', () => {
    expect(versionMatch('2.1.286', '2.1.286')).toBe('same');
  });

  it('新しい版・古い版を見分ける（数字として比べる）', () => {
    expect(versionMatch('2.1.287', '2.1.286')).toBe('newer');
    expect(versionMatch('2.2.0', '2.1.286')).toBe('newer');
    expect(versionMatch('2.1.99', '2.1.286')).toBe('older');
    expect(versionMatch('1.9.999', '2.1.286')).toBe('older');
  });

  it('版が分からなければ missing', () => {
    expect(versionMatch(null, '2.1.286')).toBe('missing');
  });
});

describe('compareVersions', () => {
  it('桁の数が違っても比べられる', () => {
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('2.1.1', '2.1')).toBeGreaterThan(0);
  });
});
