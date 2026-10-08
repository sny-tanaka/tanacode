import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import type { BashTask } from '@shared/task';
import { BashTaskTracker } from '../src/main/bash-task-tracker';
import type { SubagentTracker } from '../src/main/subagent-tracker';
import { taskNotificationOf, TaskRouter } from '../src/main/task-router';
import type { WorkflowTracker } from '../src/main/workflow-tracker';

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

it('完了通知が、出力ファイルの終わりの印より先に届いても、通知に書かれた終了コードで終わる。印が書かれていれば、印のほうを使う', async () => {
  // Claude Code は、完了通知を出してから出力ファイルに終わりの印を書くことがある（CI の macOS の test:cli で、印の無いまま完了になった）
  dir = mkdtempSync(join(tmpdir(), 'tanacode-bash-'));
  const early = join(dir, 'early.output');
  const marked = join(dir, 'marked.output');
  writeFileSync(early, 'bg-done\n');
  writeFileSync(marked, 'エラー\n[exited with code 2]\n');
  let tasks: BashTask[] = [];
  const tracker = new BashTaskTracker((next) => (tasks = next));
  const find = (id: string) => tasks.find((t) => t.toolUseId === id);
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 80 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  };
  tracker.start('toolu_early', { command: 'early' }, { backgroundTaskId: 'b1' }, `Output is being written to: ${early}`, false);
  tracker.start('toolu_marked', { command: 'marked' }, { backgroundTaskId: 'b2' }, `Output is being written to: ${marked}`, false);
  await waitFor(() => find('toolu_early')?.output === 'bg-done\n' && find('toolu_marked')?.state === 'failed');
  tracker.notified('toolu_early', 'completed', 0);
  tracker.notified('toolu_marked', 'failed', 1);
  await waitFor(() => find('toolu_early')?.state === 'completed');
  tracker.dispose();
  expect(find('toolu_early')).toMatchObject({ state: 'completed', exitCode: 0, output: 'bg-done\n' });
  expect(find('toolu_marked')).toMatchObject({ state: 'failed', exitCode: 2 });
});

// 完了通知の形は、Claude Code 2.1.292 をモックの API で動かして取った会話ログに合わせた（パスは短くした）
const BASH_NOTICE = [
  '<task-notification>',
  '<task-id>blktx4qxr</task-id>',
  '<tool-use-id>toolu_bg</tool-use-id>',
  '<output-file>/tmp/claude-0/-work-app/s1/tasks/blktx4qxr.output</output-file>',
  '<status>completed</status>',
  '<summary>Background command "裏で待つ" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\n');

it('完了通知の要約に書かれた終了コード（exit code N）を読み、Bash の追跡に渡す。要約に無ければ null（結果の文の中の同じ文字は読まない）', () => {
  expect(taskNotificationOf({ type: 'queue-operation', operation: 'enqueue', content: BASH_NOTICE } as TranscriptEntry)).toMatchObject({
    toolUseId: 'toolu_bg',
    status: 'completed',
    exitCode: 0,
  });
  // 失敗したときの要約の言い回しは控えに無いので、「exit code」に続く数字を読むことだけを確かめる
  const failed = BASH_NOTICE.replace('<status>completed</status>', '<status>failed</status>').replace('completed (exit code 0)', 'failed with exit code 127');
  expect(taskNotificationOf({ type: 'user', message: { content: failed } })).toMatchObject({ status: 'failed', exitCode: 127 });
  const agent = BASH_NOTICE.replace(/<summary>.*<\/summary>/, '<summary>Agent "調べもの" finished</summary>\n<result>exit code 3 で終わりました</result>');
  expect(taskNotificationOf({ type: 'user', message: { content: agent } })?.exitCode).toBeNull();

  const bashTasks = { start: vi.fn(), notified: vi.fn() };
  const router = new TaskRouter({
    workflows: { add: vi.fn(), notified: vi.fn() } as unknown as WorkflowTracker,
    subagents: { start: vi.fn(), resume: vi.fn(), finish: vi.fn(), notified: vi.fn() } as unknown as SubagentTracker,
    bashTasks: bashTasks as unknown as BashTaskTracker,
    screen: () => null,
    sessionDir: () => '/home/me/.claude/projects/-work-app/s1',
  });
  router.track({ type: 'user', origin: { kind: 'task-notification' }, message: { content: BASH_NOTICE } }, false, false);
  expect(bashTasks.notified).toHaveBeenLastCalledWith('toolu_bg', 'completed', 0);
});
