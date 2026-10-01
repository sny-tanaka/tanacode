import { execFile } from 'node:child_process';

// 入っている Claude Code の版。Claude Code は勝手に更新されることがあるので、ときどき確かめ直す
const INTERVAL_MS = 10 * 60_000;

// `claude --version` の版（例: 2.1.286）。見つからない・読めないときは null
export function claudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : (stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null)));
  });
}

// 起動時と一定の間隔（と refresh を呼んだとき）に版を確かめ、変わったら知らせる
export class ClaudeVersionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<string | null> | null = null;
  private last: string | null | undefined = undefined;

  constructor(private readonly onChange: (version: string | null) => void) {}

  start(): void {
    this.timer ??= setInterval(() => void this.refresh(), INTERVAL_MS);
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // 今わかっている版。まだ確かめていなければ、確かめ終わるのを待つ
  get(): Promise<string | null> {
    return this.last !== undefined ? Promise.resolve(this.last) : this.refresh();
  }

  // 確かめている途中なら、それを待つ（同時に何度も実行しない）
  refresh(): Promise<string | null> {
    this.current ??= claudeVersion().then((version) => {
      this.current = null;
      if (version !== this.last) {
        this.last = version;
        this.onChange(version);
      }
      return version;
    });
    return this.current;
  }
}
