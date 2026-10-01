import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { BashTask } from '@shared/task';
import { BashTaskTracker } from '../src/main/bash-task-tracker';

// バックグラウンドの Bash の追跡（出力ファイルの読み込みと、完了通知の重なり）

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

it('完了通知が、読んでいる途中の読み込みと重なっても、終わったあとの出力から終了コードを読む', async () => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-bash-'));
  const file = join(dir, 'b1.output');
  writeFileSync(file, 'hello\n');
  let tasks: BashTask[] = [];
  const tracker = new BashTaskTracker((next) => (tasks = next));
  // 1 回目の読み込みを、ファイルを読んだあと（終了コードが書かれる前の中身で）止めておく
  const read = tracker['read'].bind(tracker);
  let readOnce!: () => void;
  const firstRead = new Promise<void>((resolve) => (readOnce = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  tracker['read'] = async (t: Parameters<typeof read>[0]) => {
    const changed = await read(t);
    if (first) {
      first = false;
      readOnce();
      await gate;
    }
    return changed;
  };
  tracker.start('toolu_1', { command: 'echo hello' }, { backgroundTaskId: 'b1' }, `Output is being written to: ${file}`, false);
  await firstRead;
  // 読んでいる途中に、コマンドが終わって完了通知が届く
  appendFileSync(file, '[exited with code 0]\n');
  tracker.notified('toolu_1', 'completed');
  release();
  for (let i = 0; i < 40 && tasks[0]?.exitCode == null; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  tracker.dispose();
  expect(tasks[0]).toMatchObject({ state: 'completed', exitCode: 0, output: 'hello' });
});
