import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSavedJson } from '../src/main/saved-json';

// アプリが保存している JSON のファイルの読み方。無ければ空から始めて保存してよい。読めない・壊れたファイルは、上書きしない

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-saved-json-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('readSavedJson', () => {
  it('読めたら中身を返す。無い（途中がファイルでたどれないときも）なら空で、保存してよい', () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, '{"version":1}');
    expect(readSavedJson(file, 'テスト')).toEqual({ data: { version: 1 }, writable: true });
    expect(readSavedJson(join(dir, 'none.json'), 'テスト')).toEqual({ data: null, writable: true });
    expect(readSavedJson(join(file, 'under.json'), 'テスト')).toEqual({ data: null, writable: true });
  });

  it('読めない（フォルダ・権限が無い）ファイルは、空で始めても保存しない', () => {
    mkdirSync(join(dir, 'folder.json'));
    expect(readSavedJson(join(dir, 'folder.json'), 'テスト')).toEqual({ data: null, writable: false });
    expect(console.error).toHaveBeenCalled();
  });

  it('壊れたファイルは横に移してから空で始める。移せなければ保存しない', () => {
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{壊れた');
    expect(readSavedJson(file, 'テスト')).toEqual({ data: null, writable: true });
    expect(readdirSync(dir).filter((name) => name.startsWith('broken.json.broken-'))).toHaveLength(1);
    // 移せない（フォルダに書けない）
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'broken.json'), '{壊れた');
    chmodSync(locked, 0o500);
    try {
      expect(readSavedJson(join(locked, 'broken.json'), 'テスト')).toEqual({ data: null, writable: false });
      expect(readFileSync(join(locked, 'broken.json'), 'utf8')).toBe('{壊れた');
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
