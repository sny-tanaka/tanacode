import { execFile } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import type { ProcessUsage, SystemStats } from '@shared/system';

const INTERVAL_MS = 2000;
// プロセスの一覧は少し間を空けて取る
const PROCESS_EVERY = 2;
const TOP = 5;

// CPU・メモリの使用状況を一定間隔で知らせる
export class SystemMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastCpu = cpuTimes();
  private tick = 0;
  private processes: ProcessUsage[] = [];

  constructor(private readonly onChange: (stats: SystemStats) => void) {}

  start(): void {
    this.timer ??= setInterval(() => void this.sample(), INTERVAL_MS);
    void this.sample();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sample(): Promise<void> {
    const now = cpuTimes();
    const busy = now.busy - this.lastCpu.busy;
    const total = now.total - this.lastCpu.total;
    this.lastCpu = now;
    if (this.tick++ % PROCESS_EVERY === 0) this.processes = await readProcesses();
    const memUsed = await usedMemory();
    this.onChange({
      cpuPercent: total > 0 ? Math.round((busy / total) * 100) : 0,
      memUsed,
      memTotal: totalmem(),
      topCpu: [...this.processes].sort((a, b) => b.cpu - a.cpu).slice(0, TOP),
      topMem: [...this.processes].sort((a, b) => b.memBytes - a.memBytes).slice(0, TOP),
    });
  }
}

function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out)));
}

// アクティビティモニタの「使用済みメモリ」= アプリメモリ（匿名ページ − パージ可能）+ 確保されているメモリ + 圧縮されたメモリ
async function usedMemory(): Promise<number> {
  const out = await run('vm_stat', []);
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (label: string) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  const app = pages('Anonymous pages') - pages('Pages purgeable');
  return (Math.max(app, 0) + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize;
}

// 同じ名前のプロセス（Chrome のタブなど）はまとめる
async function readProcesses(): Promise<ProcessUsage[]> {
  const out = await run('ps', ['-Aceo', 'pcpu=,rss=,comm=']);
  const byName = new Map<string, ProcessUsage>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const name = m[3];
    const p = byName.get(name) ?? { name, cpu: 0, memBytes: 0 };
    p.cpu += Number(m[1]);
    p.memBytes += Number(m[2]) * 1024;
    byName.set(name, p);
  }
  return [...byName.values()];
}
