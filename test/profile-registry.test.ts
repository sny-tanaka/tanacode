import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { profileDataDir, ProfileRegistry } from '../src/main/profile-registry';

// 登録したプロファイル（userData の profiles.json）。名前・色・Claude Code の設定のフォルダだけを覚える

let root: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-profiles-'));
  file = join(root, 'userData', 'profiles.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ProfileRegistry', () => {
  it('はじめは既定のプロファイル（標準）だけ。足したものは名前・色・フォルダを覚え、読み直しても同じ', () => {
    const registry = new ProfileRegistry(file);
    expect(registry.list()).toEqual([{ id: 'default', name: '標準', color: '#6d9ccf', claudeDir: null }]);
    const dir = join(root, '.claude-work');
    const added = registry.add({ name: '  会社  ', color: '#D4835C', claudeDir: dir });
    expect(added).toEqual({ id: expect.any(String), name: '会社', color: '#d4835c', claudeDir: dir });
    // 無かったフォルダは、自分だけが読み書きできる権限で作る
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(new ProfileRegistry(file).list()).toEqual(registry.list());
    registry.update('default', { name: '個人', color: 'red' });
    // 色の書き方が違えば、既定の色
    expect(registry.get('default')).toEqual({ id: 'default', name: '個人', color: '#6d9ccf', claudeDir: null });
    registry.remove(added.id);
    expect(new ProfileRegistry(file).list().map((p) => p.id)).toEqual(['default']);
  });

  it('フォルダは絶対パスか ~/ で始まるパス。ほかのプロファイル・既定の ~/.claude と同じものは断る。ファイルは断る', () => {
    const registry = new ProfileRegistry(file);
    expect(() => registry.add({ name: 'a', color: '#6d9ccf', claudeDir: 'relative/dir' })).toThrow('絶対パスか ~/');
    expect(() => registry.add({ name: 'a', color: '#6d9ccf', claudeDir: '~/.claude' })).toThrow('ほかのプロファイルと同じフォルダです');
    const dir = join(root, 'x');
    registry.add({ name: 'a', color: '#6d9ccf', claudeDir: `${dir}/` });
    expect(() => registry.add({ name: 'b', color: '#6d9ccf', claudeDir: dir })).toThrow('ほかのプロファイルと同じフォルダです');
    writeFileSync(join(root, 'file'), '');
    expect(() => registry.add({ name: 'c', color: '#6d9ccf', claudeDir: join(root, 'file') })).toThrow('フォルダではありません');
    expect(() => registry.add({ name: '  ', color: '#6d9ccf', claudeDir: join(root, 'y') })).toThrow('名前を入れてください');
    expect(() => registry.update('nope', { name: 'z' })).toThrow('プロファイルが見つかりません');
    expect(() => registry.remove('default')).toThrow('標準のプロファイルは外せません');
  });

  it('~/ はホームから。既にあるフォルダはそのまま使う', () => {
    const registry = new ProfileRegistry(file);
    const name = `.claude-tanacode-test-${Date.now()}`;
    mkdirSync(join(homedir(), name), { recursive: true });
    try {
      expect(registry.add({ name: 'a', color: '#6d9ccf', claudeDir: `~/${name}` }).claudeDir).toBe(join(homedir(), name));
    } finally {
      rmSync(join(homedir(), name), { recursive: true, force: true });
    }
  });

  it('壊れた・形の違う profiles.json は、使えるものだけ読む', () => {
    mkdirSync(join(root, 'userData'), { recursive: true });
    writeFileSync(file, '{');
    expect(new ProfileRegistry(file).list()).toHaveLength(1);
    writeFileSync(
      file,
      JSON.stringify({
        default: { name: '' },
        profiles: [{ id: 'ok', name: '良い', color: '#5fb98a', claudeDir: '/a' }, { id: 'default', name: 'x', claudeDir: '/b' }, { id: 'rel', name: 'x', claudeDir: 'b' }, null],
      }),
    );
    expect(new ProfileRegistry(file).list()).toEqual([
      { id: 'default', name: '標準', color: '#6d9ccf', claudeDir: null },
      { id: 'ok', name: '良い', color: '#5fb98a', claudeDir: '/a' },
    ]);
    expect(JSON.parse(readFileSync(file, 'utf8')).profiles).toHaveLength(4);
  });

  it('データのフォルダは、既定のプロファイルなら userData、足したものは userData/profiles/<id>', () => {
    expect(profileDataDir('/u', 'default')).toBe('/u');
    expect(profileDataDir('/u', 'p2')).toBe(join('/u', 'profiles', 'p2'));
  });
});
