import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, type SessionRecord } from '../src/main/session-store';

// セッションの記録（userData/sessions.json）。一覧のすべてなので、読めないファイルを上書きして消さない

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-store-'));
  file = join(dir, 'sessions.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const record = (id: string): SessionRecord => ({
  id,
  claudeSessionId: `c-${id}`,
  cwd: '/work',
  title: null,
  titlePriority: 0,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
});

describe('SessionStore', () => {
  it('ファイルが無ければ空で始め、書き換えは保存して読み直せる', () => {
    const store = new SessionStore(file);
    expect(store.all()).toEqual([]);
    store.add(record('a'));
    store.add(record('b'));
    store.update('a', { title: 'ログイン' });
    store.remove('b');
    store.flush();
    expect(new SessionStore(file).all()).toEqual([{ ...record('a'), title: 'ログイン' }]);
  });

  it.each([
    ['壊れた JSON', '{"version":1,"sessions":[{"id":'],
    ['形の違う中身', '{"version":1,"sessions":"a"}'],
  ])('%sは空として読むが、次の保存で消さないよう、元の中身を横に控えておく', (_label, broken) => {
    writeFileSync(file, broken);
    const store = new SessionStore(file);
    expect(store.all()).toEqual([]);
    store.add(record('a'));
    store.flush();
    const backups = readdirSync(dir).filter((name) => name.startsWith('sessions.json.broken-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]), 'utf8')).toBe(broken);
    expect(new SessionStore(file).all().map((r) => r.id)).toEqual(['a']);
  });

  it('保存は書きかけのファイルを残さない（一時ファイルに書いてから置き換える）', () => {
    const store = new SessionStore(file);
    store.add(record('a'));
    store.flush();
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, sessions: [{ id: 'a' }] });
  });
});
