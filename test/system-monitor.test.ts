import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemStats } from '../src/shared/system';
import { SystemMonitor } from '../src/main/system-monitor';

// フッターの CPU・メモリの使用状況（SystemMonitor）。vm_stat・ps は macOS のコマンドなので、出力と CPU の時間はテストが決める

type Times = { user: number; nice: number; sys: number; irq: number; idle: number };
const fake = vi.hoisted(() => ({
  // コマンドの標準出力。null は失敗（コマンドが無いなど）
  outputs: {} as Record<string, string | null>,
  calls: [] as { cmd: string; args: string[]; options: Record<string, unknown> }[],
  cpus: [] as Times[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], options: Record<string, unknown>, callback: (err: Error | null, out: string) => void) => {
      fake.calls.push({ cmd, args, options });
      const out = fake.outputs[cmd];
      if (out === null || out === undefined) callback(new Error(`${cmd}: command not found`), '');
      else callback(null, out);
    },
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, cpus: () => fake.cpus.map((times) => ({ model: 'cpu', speed: 0, times })), totalmem: () => 16 * 1024 ** 3 };
});

const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
  'Pages free:                               1000.',
  'Anonymous pages:                          5000.',
  'Pages purgeable:                           200.',
  'Pages wired down:                          300.',
  'Pages occupied by compressor:               50.',
].join('\n');

// ps -Aceo pcpu=,rss=,comm= の出力（rss は KB）
const PS = [
  '  12.5   1024 Google Chrome Helper',
  '  30.0   2048 node',
  '   2.5   4096 Google Chrome Helper',
  '   1.0 900000 WindowServer',
  '   5.0    512 Code Helper',
  '   7.0    256 claude',
  '   0.5    128 launchd',
  '読めない行',
  '',
].join('\n');

const KB = 1024;

beforeEach(() => {
  fake.outputs = { ps: PS, vm_stat: VM_STAT };
  fake.calls = [];
  fake.cpus = [{ user: 0, nice: 0, sys: 0, irq: 0, idle: 0 }];
});
afterEach(() => vi.useRealTimers());

function monitor() {
  const stats: SystemStats[] = [];
  return { stats, monitor: new SystemMonitor((s) => stats.push(s)) };
}

describe('SystemMonitor', () => {
  it('CPU は、前に測ったときからの増え分の割合（全コアをならす）。メモリはアクティビティモニタの数え方。プロセスは名前でまとめて上位 5 件ずつ', async () => {
    fake.cpus = [
      { user: 100, nice: 0, sys: 50, irq: 0, idle: 850 },
      { user: 0, nice: 0, sys: 0, irq: 0, idle: 1000 },
    ];
    const { stats, monitor: m } = monitor();
    // 1 つ目のコアは 50 すべて使い、2 つ目は 50 のうち 25 を使った
    fake.cpus = [
      { user: 130, nice: 10, sys: 55, irq: 5, idle: 850 },
      { user: 20, nice: 0, sys: 5, irq: 0, idle: 1025 },
    ];
    m.start();
    m.stop();
    await vi.waitFor(() => expect(stats).toHaveLength(1));
    expect(stats[0]).toEqual({
      cpuPercent: 75,
      // （アプリメモリ 5000 − 200）+ 確保 300 + 圧縮 50 のページ
      memUsed: (5000 - 200 + 300 + 50) * 4096,
      memTotal: 16 * 1024 ** 3,
      topCpu: [
        { name: 'node', cpu: 30, memBytes: 2048 * KB },
        { name: 'Google Chrome Helper', cpu: 15, memBytes: 5120 * KB },
        { name: 'claude', cpu: 7, memBytes: 256 * KB },
        { name: 'Code Helper', cpu: 5, memBytes: 512 * KB },
        { name: 'WindowServer', cpu: 1, memBytes: 900000 * KB },
      ],
      topMem: [
        { name: 'WindowServer', cpu: 1, memBytes: 900000 * KB },
        { name: 'Google Chrome Helper', cpu: 15, memBytes: 5120 * KB },
        { name: 'node', cpu: 30, memBytes: 2048 * KB },
        { name: 'Code Helper', cpu: 5, memBytes: 512 * KB },
        { name: 'claude', cpu: 7, memBytes: 256 * KB },
      ],
    });
    expect(fake.calls.map((c) => [c.cmd, c.args])).toEqual([
      ['ps', ['-Aceo', 'pcpu=,rss=,comm=']],
      ['vm_stat', []],
    ]);
    // 返事が無いコマンドを待ち続けない
    expect(fake.calls[0].options).toMatchObject({ timeout: 5000 });
  });

  it('2 秒ごとに測る。プロセスの一覧は 2 回に 1 回だけ取り直す。start を重ねても間隔は増えず、stop で止まる', async () => {
    vi.useFakeTimers();
    fake.outputs.ps = '1.0 100 a';
    const { stats, monitor: m } = monitor();
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(stats.map((s) => s.topCpu.map((p) => p.name))).toEqual([['a']]);
    fake.outputs.ps = '2.0 200 b';
    await vi.advanceTimersByTimeAsync(2000);
    // 2 回目は、前に取った一覧のまま
    expect(stats.map((s) => s.topCpu.map((p) => p.name))).toEqual([['a'], ['a']]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stats.map((s) => s.topCpu.map((p) => p.name))).toEqual([['a'], ['a'], ['b']]);
    expect(fake.calls.filter((c) => c.cmd === 'ps')).toHaveLength(2);
    expect(fake.calls.filter((c) => c.cmd === 'vm_stat')).toHaveLength(3);
    // 重ねて start すると、その場で 1 回測るが、間隔は 1 つのまま
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(stats).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stats).toHaveLength(5);
    m.stop();
    m.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stats).toHaveLength(5);
  });

  it('コマンドが無い・失敗したとき（macOS 以外など）は、メモリ 0・プロセス無しとして知らせる。CPU の時間が進んでいなければ 0%', async () => {
    fake.outputs = { ps: null, vm_stat: null };
    const { stats, monitor: m } = monitor();
    m.start();
    m.stop();
    await vi.waitFor(() => expect(stats).toHaveLength(1));
    expect(stats[0]).toEqual({ cpuPercent: 0, memUsed: 0, memTotal: 16 * 1024 ** 3, topCpu: [], topMem: [] });
  });

  it('パージできるページがアプリのページより多くても、アプリメモリは 0 より小さくしない。ページの大きさが書かれていなければ 16KB', async () => {
    fake.outputs.vm_stat = 'Anonymous pages: 10.\nPages purgeable: 50.\nPages wired down: 2.\nPages occupied by compressor: 1.\n';
    const { stats, monitor: m } = monitor();
    m.start();
    m.stop();
    await vi.waitFor(() => expect(stats).toHaveLength(1));
    expect(stats[0].memUsed).toBe((0 + 2 + 1) * 16384);
  });
});
