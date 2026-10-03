import { useEffect, useState } from 'react';
import type { ProcessUsage, SystemStats as Stats } from '@shared/system';

// フッターに出す CPU・メモリの使用率。マウスを乗せると多く使っているプロセスを出す
export function SystemStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => window.tanacode.system.onStats(setStats), []);
  if (!stats) return null;
  const memPercent = Math.round((stats.memUsed / stats.memTotal) * 100);
  return (
    <>
      <span className="system-stat" title={`CPU を多く使っているプロセス\n${list(stats.topCpu, (p) => `${p.cpu.toFixed(1)}%`)}`}>
        CPU
        <Meter percent={stats.cpuPercent} />
        <Value text={`${stats.cpuPercent}%`} widest="100%" />
      </span>
      <span className="system-stat" title={`メモリを多く使っているプロセス\n${list(stats.topMem, (p) => gb(p.memBytes))}`}>
        メモリ
        <Meter percent={memPercent} />
        <span>
          <Value text={gb(stats.memUsed)} widest={gb(stats.memTotal)} /> / {gb(stats.memTotal)}
        </span>
      </span>
    </>
  );
}

// 桁数が変わっても右隣の項目が動かないよう、いちばん広くなる文字列（widest）の幅を取っておき、値は右にそろえる
function Value({ text, widest }: { text: string; widest: string }) {
  return (
    <span className="system-value">
      <span className="system-value-widest" aria-hidden>
        {widest}
      </span>
      <span>{text}</span>
    </span>
  );
}

function Meter({ percent }: { percent: number }) {
  const level = percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low';
  return (
    <span className={`system-meter ${level}`}>
      <span style={{ width: `${Math.min(100, Math.max(percent, 2))}%` }} />
    </span>
  );
}

function list(procs: ProcessUsage[], value: (p: ProcessUsage) => string): string {
  return procs.map((p) => `${value(p).padStart(7)}  ${p.name}`).join('\n');
}

function gb(bytes: number): string {
  const g = bytes / 1024 ** 3;
  return g >= 1 ? `${g.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
