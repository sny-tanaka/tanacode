import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFocusLog } from '../src/main/focus-log';

// チャットの入力欄から急にフォーカスが外れたときのログ（userData/focus.log）。1 行に「時刻 JSON」。大きくなったら focus.log.1 に回す

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'focus-log-'));
  path = join(dir, 'focus.log');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('focus.log', () => {
  it('知らせを 1 行ずつ「時刻 JSON」で足す。オブジェクトでないものは書かない', async () => {
    await appendFocusLog(path, { reason: 'focusout', to: 'body' }, new Date('2026-10-27T01:02:03.000Z'));
    await appendFocusLog(path, 'x');
    await appendFocusLog(path, [1]);
    await appendFocusLog(path, { reason: 'removed' }, new Date('2026-10-27T01:02:04.000Z'));
    expect(readFileSync(path, 'utf8')).toBe(
      '2026-10-27T01:02:03.000Z {"reason":"focusout","to":"body"}\n2026-10-27T01:02:04.000Z {"reason":"removed"}\n',
    );
  });

  it('同時に来た知らせも、来た順に 1 行ずつ書く（回すのと書くのがぶつからない）', async () => {
    writeFileSync(path, 'old\n'.repeat(70_000));
    await Promise.all([1, 2, 3, 4, 5].map((n) => appendFocusLog(path, { n }, new Date('2026-10-27T00:00:00.000Z'))));
    expect(readFileSync(path, 'utf8')).toBe([1, 2, 3, 4, 5].map((n) => `2026-10-27T00:00:00.000Z {"n":${n}}\n`).join(''));
  });

  it('長すぎる知らせは切る。ファイルが大きくなったら focus.log.1 に回して書き直す', async () => {
    await appendFocusLog(path, { stack: 'x'.repeat(20_000) });
    expect(readFileSync(path, 'utf8').length).toBeLessThan(9_000);
    writeFileSync(path, 'old\n'.repeat(70_000));
    await appendFocusLog(path, { reason: 'focusout' }, new Date('2026-10-27T00:00:00.000Z'));
    expect(readFileSync(`${path}.1`, 'utf8').startsWith('old\n')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('2026-10-27T00:00:00.000Z {"reason":"focusout"}\n');
  });
});
