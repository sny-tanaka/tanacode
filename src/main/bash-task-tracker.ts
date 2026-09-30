import { open, stat } from 'node:fs/promises';
import type { BashTask } from '@shared/task';

const POLL_MS = 1000;
// 画面に出す出力の末尾の長さ
const MAX_OUTPUT_BYTES = 256 * 1024;

type Tracked = { task: BashTask; outputFile: string | null; size: number };

// run_in_background で起動した Bash を追跡する。
// 起動時の結果に書かれる出力ファイル（<tmp>/<cwd>/<session>/tasks/<id>.output）を読み、完了通知で終わりを知る
export class BashTaskTracker {
  private readonly tasks = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly onChange: (tasks: BashTask[]) => void) {}

  all(): BashTask[] {
    return [...this.tasks.values()].map((t) => t.task);
  }

  // Bash ツールの結果に backgroundTaskId があれば、バックグラウンドで起動したもの
  start(toolUseId: string, input: { command?: unknown; description?: unknown }, result: unknown, resultText: string, fromHistory: boolean): void {
    const r = (result && typeof result === 'object' ? result : {}) as { backgroundTaskId?: unknown };
    if (typeof r.backgroundTaskId !== 'string' || this.tasks.has(toolUseId)) return;
    const outputFile = resultText.match(/Output is being written to: (\S+?)\.?(?:\s|$)/)?.[1] ?? null;
    this.tasks.set(toolUseId, {
      task: {
        toolUseId,
        taskId: r.backgroundTaskId,
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

  // 完了通知（<task-notification>）
  notified(toolUseId: string, status: string): void {
    const t = this.tasks.get(toolUseId);
    if (!t) return;
    const state = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'killed' ? 'killed' : 'stopped';
    t.task = { ...t.task, state, endedAt: t.task.endedAt ?? (t.task.startedAt ? Date.now() : null) };
    // 出力ファイルの最後（終了コード）を読んでから知らせる
    t.size = -1;
    void this.poll().then(() => this.onChange(this.all()));
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

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let changed = false;
      for (const t of this.tasks.values()) changed = (await this.read(t)) || changed;
      if (changed) this.onChange(this.all());
      if (![...this.tasks.values()].some((t) => t.task.state === 'running')) this.stopTimer();
    } finally {
      this.polling = false;
    }
  }

  private async read(t: Tracked): Promise<boolean> {
    if (!t.outputFile) return false;
    const size = await stat(t.outputFile).then((s) => s.size, () => null);
    if (size === null || size === t.size) return false;
    t.size = size;
    const start = Math.max(0, size - MAX_OUTPUT_BYTES);
    const handle = await open(t.outputFile, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      await handle.close();
    }
    // 終わると最後に「[exited with code N]」が書かれる
    const exit = text.match(/\n?\[exited with code (-?\d+)\]\s*$/);
    const exitCode = exit ? Number(exit[1]) : t.task.exitCode;
    let state = t.task.state;
    if (exit && state === 'running') state = exitCode === 0 ? 'completed' : 'failed';
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
