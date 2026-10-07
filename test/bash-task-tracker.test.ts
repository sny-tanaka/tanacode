import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

it('出力ファイルが読めなくなっても（消えた・別のものに置き換わった）、完了通知で終わったことにし、ほかのタスクの読み込みも止めない', async () => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-bash-'));
  // 大きさは読めるが中身は読めないもの（フォルダ）。読み込みの途中でファイルが消えたときと同じく、読む段で失敗する
  const unreadable = join(dir, 'b1.output');
  mkdirSync(unreadable);
  const other = join(dir, 'b2.output');
  writeFileSync(other, 'ok\n[exited with code 0]\n');
  let tasks: BashTask[] = [];
  const tracker = new BashTaskTracker((next) => (tasks = next));
  tracker.start('toolu_1', { command: 'npm run dev' }, { backgroundTaskId: 'b1' }, `Output is being written to: ${unreadable}`, false);
  tracker.start('toolu_2', { command: 'echo ok' }, { backgroundTaskId: 'b2' }, `Output is being written to: ${other}`, false);
  tracker.notified('toolu_1', 'completed');
  tracker.notified('toolu_2', 'completed');
  const find = (id: string) => tasks.find((t) => t.toolUseId === id);
  for (let i = 0; i < 40 && (find('toolu_1')?.state === 'running' || find('toolu_2')?.state === 'running'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  tracker.dispose();
  expect(find('toolu_1')).toMatchObject({ state: 'completed' });
  expect(find('toolu_2')).toMatchObject({ state: 'completed', exitCode: 0, output: 'ok' });
});

// 出力ファイルの中身は、Claude Code 2.1.292 をモックの API で動かして取ったもの（「出力\n\n[exited with code 0]\n」）に合わせた。
// 止められたときの「[killed]」は、その会話ログに出なかったので、src の読み取りに合わせて組み立てた
describe('BashTaskTracker の起動・完了・出力', () => {
  let tasks: BashTask[];
  let calls: number;
  let tracker: BashTaskTracker;
  const find = (id: string) => tasks.find((t) => t.toolUseId === id);
  const text = (file: string) => `Command running in background with ID: b1. Output is being written to: ${file}. You will be notified when it completes.`;
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 80 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-bash-'));
    tasks = [];
    calls = 0;
    tracker = new BashTaskTracker((next) => {
      tasks = next;
      calls++;
    });
  });
  afterEach(() => tracker.dispose());

  it('結果に backgroundTaskId がある Bash だけを、コマンドと説明と一緒に追う。同じものは 2 度追わない', () => {
    tracker.start('toolu_fg', { command: 'ls' }, { stdout: 'a.ts', stderr: '' }, 'a.ts', false);
    tracker.start('toolu_str', { command: 'ls' }, 'エラーの文', '', false);
    tracker.start('toolu_null', { command: 'ls' }, null, '', false);
    expect(calls).toBe(0);
    const result = { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'blktx4qxr' };
    tracker.start('toolu_bg', { command: 'echo bg-out && sleep 1 && echo bg-done', description: '裏で待つ' }, result, text(join(dir!, 'blktx4qxr.output')), false);
    tracker.start('toolu_bg', { command: 'ほかのもの' }, result, '', false);
    expect(tasks).toEqual([
      {
        toolUseId: 'toolu_bg',
        taskId: 'blktx4qxr',
        command: 'echo bg-out && sleep 1 && echo bg-done',
        description: '裏で待つ',
        state: 'running',
        startedAt: expect.any(Number),
        endedAt: null,
        exitCode: null,
        output: '',
        truncated: false,
      },
    ]);
    // コマンドが文字でない・説明が無い
    tracker.start('toolu_odd', { command: 42 }, { backgroundTaskId: 'b2' }, '', false);
    expect(find('toolu_odd')).toMatchObject({ command: '', description: null });
  });

  it('出力ファイルを読み、終わりの印で終了コードと状態を決める（0 は completed、ほかは failed、[killed] は killed）', async () => {
    const ok = join(dir!, 'ok.output');
    const ng = join(dir!, 'ng.output');
    const killed = join(dir!, 'killed.output');
    writeFileSync(ok, 'bg-out\nbg-done\n');
    writeFileSync(ng, 'エラー\n[exited with code 1]\n');
    writeFileSync(killed, '途中まで\n[killed]\n');
    tracker.start('toolu_ok', { command: 'ok' }, { backgroundTaskId: 'b1' }, text(ok), false);
    tracker.start('toolu_ng', { command: 'ng' }, { backgroundTaskId: 'b2' }, text(ng), false);
    tracker.start('toolu_killed', { command: 'killed' }, { backgroundTaskId: 'b3' }, text(killed), false);
    await waitFor(() => find('toolu_ok')?.output === 'bg-out\nbg-done\n' && find('toolu_killed')?.state !== 'running');
    expect(find('toolu_ok')).toMatchObject({ state: 'running', exitCode: null, endedAt: null });
    expect(find('toolu_ng')).toMatchObject({ state: 'failed', exitCode: 1, output: 'エラー' });
    expect(find('toolu_ng')!.endedAt).not.toBeNull();
    expect(find('toolu_killed')).toMatchObject({ state: 'killed', exitCode: null, output: '途中まで' });
    // 終わると最後に終了コードが書かれる
    appendFileSync(ok, '\n[exited with code 0]\n');
    await waitFor(() => find('toolu_ok')?.state !== 'running');
    expect(find('toolu_ok')).toMatchObject({ state: 'completed', exitCode: 0, output: 'bg-out\nbg-done\n' });
  });

  it('長い出力は末尾だけを読み、切り詰めたことを残す。変わっていなければ読み直さない', async () => {
    const file = join(dir!, 'long.output');
    writeFileSync(file, `${'x'.repeat(300 * 1024)}\n最後の行\n`);
    tracker.start('toolu_long', { command: 'yes' }, { backgroundTaskId: 'b1' }, text(file), false);
    await waitFor(() => !!find('toolu_long')?.truncated);
    expect(Buffer.byteLength(find('toolu_long')!.output)).toBe(256 * 1024);
    expect(find('toolu_long')!.output.endsWith('最後の行\n')).toBe(true);
    const before = calls;
    await (tracker as unknown as { poll: () => Promise<void> }).poll();
    expect(calls).toBe(before);
  });

  it('出力ファイルの場所が分からないもの・まだ無いものは、出力なしのまま。完了通知の状態で終わる', async () => {
    tracker.start('toolu_nofile', { command: 'x' }, { backgroundTaskId: 'b1' }, 'Command running in background with ID: b1.', false);
    tracker.start('toolu_missing', { command: 'y' }, { backgroundTaskId: 'b2' }, text(join(dir!, 'missing.output')), false);
    tracker.notified('toolu_nofile', 'failed');
    tracker.notified('toolu_missing', 'killed');
    await waitFor(() => find('toolu_nofile')?.state !== 'running' && find('toolu_missing')?.state !== 'running');
    expect(find('toolu_nofile')).toMatchObject({ state: 'failed', output: '', exitCode: null });
    expect(find('toolu_nofile')!.endedAt).not.toBeNull();
    expect(find('toolu_missing')).toMatchObject({ state: 'killed' });
    // そのほかの状態は stopped。知らないものの通知は無視する
    tracker.start('toolu_other', { command: 'z' }, { backgroundTaskId: 'b3' }, '', false);
    tracker.notified('toolu_other', 'stopped');
    tracker.notified('toolu_unknown', 'completed');
    await waitFor(() => find('toolu_other')?.state !== 'running');
    expect(find('toolu_other')?.state).toBe('stopped');
    expect(tasks.some((t) => t.toolUseId === 'toolu_unknown')).toBe(false);
  });

  it('過去の会話から読んだものは止まったものとして加え、時刻は分からない。完了通知が来ても終わりの時刻は付けない', async () => {
    const file = join(dir!, 'old.output');
    writeFileSync(file, 'old\n');
    tracker.start('toolu_old', { command: 'old' }, { backgroundTaskId: 'b1' }, text(file), true);
    expect(find('toolu_old')).toMatchObject({ state: 'stopped', startedAt: null });
    expect((tracker as unknown as { timer: unknown }).timer).toBeNull();
    tracker.notified('toolu_old', 'completed');
    await waitFor(() => find('toolu_old')?.state === 'completed');
    expect(find('toolu_old')).toMatchObject({ state: 'completed', endedAt: null, output: 'old\n' });
  });

  it('Claude Code が終わったら、動いているものを止まったことにする。動いているものが無ければ知らせない', () => {
    tracker.start('toolu_a', { command: 'a' }, { backgroundTaskId: 'b1' }, '', false);
    tracker.start('toolu_b', { command: 'b' }, { backgroundTaskId: 'b2' }, '', true);
    const before = calls;
    tracker.stopRunning();
    expect(calls).toBe(before + 1);
    expect(tasks.map((t) => t.state)).toEqual(['stopped', 'stopped']);
    expect((tracker as unknown as { timer: unknown }).timer).toBeNull();
    tracker.stopRunning();
    expect(calls).toBe(before + 1);
  });

  it('1 秒ごとに出力を読み直し、動いているものが無くなったら読むのをやめる', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const file = join(dir!, 'tick.output');
      writeFileSync(file, '1\n');
      tracker.start('toolu_tick', { command: 'tick' }, { backgroundTaskId: 'b1' }, text(file), false);
      await waitFor(() => find('toolu_tick')?.output === '1\n');
      appendFileSync(file, '2\n[exited with code 0]\n');
      vi.advanceTimersByTime(1000);
      await waitFor(() => find('toolu_tick')?.state === 'completed');
      expect(find('toolu_tick')).toMatchObject({ output: '1\n2', exitCode: 0 });
      expect((tracker as unknown as { timer: unknown }).timer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
