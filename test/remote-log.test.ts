import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanName, REMOTE_LOG_RECENT, RemoteLog } from '../src/main/remote-log';

// 遠隔操作の記録（src/main/remote-log.ts。Issue #464 の「気づき方と止め方」「記録」）

const dirs: string[] = [];
const tempLog = () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-log-'));
  dirs.push(dir);
  return join(dir, 'remote.log');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('RemoteLog', () => {
  it('1 行に 1 つの JSON で足し（時刻・何が起きたか・名前だけ）、新しいものから出す。自分だけが読めるファイルにする', async () => {
    const path = tempLog();
    let now = 1000;
    const log = new RemoteLog(path, () => now);
    log.add('pairing-approved', 'iPhone');
    now = 2000;
    log.add('login', 'iPhone');
    log.add('disconnect-all');
    await log.flush();
    expect(log.recent()).toEqual([
      { at: 2000, kind: 'disconnect-all' },
      { at: 2000, kind: 'login', name: 'iPhone' },
      { at: 1000, kind: 'pairing-approved', name: 'iPhone' },
    ]);
    expect(readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { at: 1000, kind: 'pairing-approved', name: 'iPhone' },
      { at: 2000, kind: 'login', name: 'iPhone' },
      { at: 2000, kind: 'disconnect-all' },
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('起動し直したら、ひとつ前のファイルと合わせて読み直す。壊れた行・知らない種類は飛ばす。出すのは新しいものから決めた数まで', () => {
    const path = tempLog();
    const lines = (from: number, count: number) => Array.from({ length: count }, (_, i) => JSON.stringify({ at: from + i, kind: 'login', name: 'x' })).join('\n');
    writeFileSync(`${path}.1`, `${lines(0, 40)}\n`);
    writeFileSync(path, `${lines(100, 20)}\n{broken\n${JSON.stringify({ at: 999, kind: 'nope' })}\n${JSON.stringify({ at: 'x', kind: 'login' })}\n`);
    const recent = new RemoteLog(path).recent();
    expect(recent).toHaveLength(REMOTE_LOG_RECENT);
    expect(recent[0]).toEqual({ at: 119, kind: 'login', name: 'x' });
    expect(recent.at(-1)?.at).toBe(10);
    expect(new RemoteLog(tempLog()).recent()).toEqual([]);
  });

  it('大きくなりすぎたら、ひとつ前のもの（.1）に回して書き直す', async () => {
    const path = tempLog();
    writeFileSync(path, 'x'.repeat(300 * 1024));
    const log = new RemoteLog(path);
    log.add('login', 'iPhone');
    await log.flush();
    expect(statSync(`${path}.1`).size).toBe(300 * 1024);
    expect(readFileSync(path, 'utf8')).toContain('"kind":"login"');
  });

  it('書けなくても、手元の一覧は続け、失敗を知らせる', async () => {
    const errors: unknown[] = [];
    const log = new RemoteLog(join(tempLog(), 'no-dir', 'remote.log'), Date.now, (error) => errors.push(error));
    log.add('login', 'iPhone');
    await log.flush();
    expect(log.recent()).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('端末の名前は、制御文字（改行を含む）を除いて 64 文字までにする', () => {
    expect(cleanName('i\nPhone\u0000\u202a')).toBe('iPhone\u202a');
    expect(cleanName('あ'.repeat(100))).toHaveLength(64);
    const path = tempLog();
    const log = new RemoteLog(path);
    expect(log.add('login', 'a\r\nb').name).toBe('ab');
  });
});
