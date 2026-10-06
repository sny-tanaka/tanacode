import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// 画面（preload）が呼ぶ IPC のチャンネルに、main の受け口があるか。
// 受け口が無いと、画面の操作が「No handler registered」で失敗する。main の配線はほかのテストや Storybook を通らないので、ここで確かめる
const channelsIn = (source: string, pattern: RegExp) => new Set([...source.matchAll(pattern)].map((m) => m[1]));

it('preload が invoke・send するチャンネルには、main の ipcMain.handle・ipcMain.on がある', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8');
  const main = readdirSync('src/main')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join('src/main', f), 'utf8'))
    .join('\n');
  const invoked = channelsIn(preload, /ipcRenderer\.invoke\(IpcChannel\.(\w+)/g);
  const sent = channelsIn(preload, /ipcRenderer\.send\(IpcChannel\.(\w+)/g);
  const handled = channelsIn(main, /ipcMain\.handle\(\s*IpcChannel\.(\w+)/g);
  const listened = channelsIn(main, /ipcMain\.on\(\s*IpcChannel\.(\w+)/g);
  expect(invoked.size).toBeGreaterThan(0);
  expect([...invoked].filter((c) => !handled.has(c))).toEqual([]);
  expect([...sent].filter((c) => !listened.has(c))).toEqual([]);
});
