import { open, stat } from 'node:fs/promises';
import type { BashTask } from '@shared/task';

const POLL_MS = 1000;
// 画面に出す出力の末尾の長さ
const MAX_OUTPUT_BYTES = 256 * 1024;

type Tracked = { task: BashTask; outputFile: string | null; size: number };

// 裏で動いている Bash（run_in_background で起動したもの・時間切れで裏に回されたもの）と、Monitor の見張りを追跡する。
// 起動時の結果に書かれる出力ファイル（<tmp>/<cwd>/<session>/tasks/<id>.output）を読み、完了通知で終わりを知る。
// Monitor は起動時の結果に出力ファイルが無いので、終わるまでは途中の知らせ（<event>）を出力に足し、終わりの知らせの出力ファイルを読む
export class BashTaskTracker {
  private readonly tasks = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  // 読んでいる途中の読み込みと、そのあとに読む予定の読み込み
  private running: Promise<void> = Promise.resolve();
  private next: Promise<void> | null = null;

  constructor(private readonly onChange: (tasks: BashTask[]) => void) {}

  all(): BashTask[] {
    return [...this.tasks.values()].map((t) => t.task);
  }

  // Bash ツールの結果に backgroundTaskId があれば、裏で動いているもの（run_in_background で起動した・時間切れで裏に回された）
  start(toolUseId: string, input: { command?: unknown; description?: unknown }, result: unknown, resultText: string, fromHistory: boolean): void {
    const r = (result && typeof result === 'object' ? result : {}) as { backgroundTaskId?: unknown };
    if (typeof r.backgroundTaskId !== 'string') return;
    const outputFile = resultText.match(/Output is being written to: (\S+?)\.?(?:\s|$)/)?.[1] ?? null;
    this.add(toolUseId, r.backgroundTaskId, input, outputFile, fromHistory);
  }

  // Monitor ツールの結果に taskId があれば、見張りを始めたもの（{"taskId":"…","timeoutMs":…,"persistent":false}）
  startMonitor(toolUseId: string, input: { command?: unknown; description?: unknown }, result: unknown, fromHistory: boolean): void {
    const r = (result && typeof result === 'object' ? result : {}) as { taskId?: unknown };
    if (typeof r.taskId !== 'string') return;
    this.add(toolUseId, r.taskId, input, null, fromHistory);
  }

  // Monitor の途中の知らせ（見張りの出力）。出力ファイルが分かるまでは、知らせの中身を出力に足していく
  event(taskId: string, text: string): void {
    const t = [...this.tasks.values()].find((t) => t.task.taskId === taskId);
    if (!t || t.outputFile) return;
    const output = `${t.task.output}${text.replace(/\n*$/, '\n')}`;
    const truncated = t.task.truncated || output.length > MAX_OUTPUT_BYTES;
    t.task = { ...t.task, output: output.length > MAX_OUTPUT_BYTES ? output.slice(-MAX_OUTPUT_BYTES) : output, truncated };
    this.onChange(this.all());
  }

  private add(toolUseId: string, taskId: string, input: { command?: unknown; description?: unknown }, outputFile: string | null, fromHistory: boolean): void {
    if (this.tasks.has(toolUseId)) return;
    this.tasks.set(toolUseId, {
      task: {
        toolUseId,
        taskId,
        command: typeof input.command === 'string' ? input.command : '',
        description: typeof input.description === 'string' ? input.description : null,
        // 過去の会話にあるものは、完了通知が無ければもう動いていない
        state: fromHistory ? 'stopped' : 'running',
        startedAt: fromHistory ? null : Date.now(),
        endedAt: null,
        exitCode: null,
        output: '',
        truncated: false,
      },
      outputFile,
      size: -1,
    });
    void this.poll();
    if (!fromHistory) this.timer ??= setInterval(() => void this.poll(), POLL_MS);
    this.onChange(this.all());
  }

  // 完了通知（<task-notification>）。出力ファイルの最後（終了コード）を読んでから、終わったことにして知らせる
  // （先に終わったことにすると、読んでいる途中の読み込みが、終了コードの無いまま「完了」を知らせてしまう）。
  // Claude Code は、通知を出してから終わりの印を書くことがあるので、印がまだ無ければ通知の要約に書かれた終了コード（exitCode）を使う。
  // outputFile: 通知に書かれた出力ファイル。起動時に分からなかったもの（Monitor）は、ここで知って読む
  notified(toolUseId: string, status: string, exitCode: number | null = null, outputFile: string | null = null): void {
    const t = this.tasks.get(toolUseId);
    if (!t) return;
    t.outputFile ??= outputFile;
    const state = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'killed' ? 'killed' : 'stopped';
    const notifiedAt = Date.now();
    t.size = -1;
    void this.poll().then(() => {
      t.task = { ...t.task, state, exitCode: t.task.exitCode ?? exitCode, endedAt: t.task.endedAt ?? (t.task.startedAt ? notifiedAt : null) };
      this.onChange(this.all());
    });
  }

  stopRunning(): void {
    let changed = false;
    for (const t of this.tasks.values()) {
      if (t.task.state !== 'running') continue;
      t.task = { ...t.task, state: 'stopped' };
      changed = true;
    }
    this.stopTimer();
    if (changed) this.onChange(this.all());
  }

  dispose(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // 読み込みは一度に一つずつ。読んでいる途中に頼まれたら、それが終わってからもう一度読む（頼まれたあとの中身を読む）。
  // 途中の読み込みに任せると、完了通知の前に読んだ中身（終了コードの無いもの）で終わり、そのまま読み直さないことがある
  private poll(): Promise<void> {
    if (this.next) return this.next;
    const next = this.running.then(() => {
      this.next = null;
      return this.pollOnce();
    });
    this.next = next;
    this.running = next.catch(() => undefined);
    return next;
  }

  private async pollOnce(): Promise<void> {
    let changed = false;
    for (const t of this.tasks.values()) changed = (await this.read(t)) || changed;
    if (changed) this.onChange(this.all());
    if (![...this.tasks.values()].some((t) => t.task.state === 'running')) this.stopTimer();
  }

  private async read(t: Tracked): Promise<boolean> {
    if (!t.outputFile) return false;
    const size = await stat(t.outputFile).then((s) => s.size, () => null);
    if (size === null || size === t.size) return false;
    const start = Math.max(0, size - MAX_OUTPUT_BYTES);
    // 大きさを見たあとに消えた・読めないものに置き換わったときは、今回は読まない（例外にすると、完了通知が終わったことにできず、
    // ほかのタスクの読み込みも止まる）
    const text = await readRange(t.outputFile, start, size).catch(() => null);
    if (text === null) return false;
    t.size = size;
    // 終わると最後に「[exited with code N]」が書かれる。止められたとき（TaskStop など）は「[killed]」で、完了通知は届かない
    const exit = text.match(/\n?\[(?:exited with code (-?\d+)|killed)\]\s*$/);
    const exitCode = exit?.[1] !== undefined ? Number(exit[1]) : t.task.exitCode;
    let state = t.task.state;
    if (exit && state === 'running') state = exit[1] === undefined ? 'killed' : exitCode === 0 ? 'completed' : 'failed';
    t.task = {
      ...t.task,
      state,
      exitCode,
      endedAt: state !== 'running' && !t.task.endedAt && t.task.startedAt ? Date.now() : t.task.endedAt,
      output: exit ? text.slice(0, exit.index) : text,
      truncated: start > 0,
    };
    return true;
  }
}

// path の start から end の手前までを読む
async function readRange(path: string, start: number, end: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    await handle.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}
