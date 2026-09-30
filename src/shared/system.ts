// この Mac の CPU・メモリの使用状況（フッターに出す）

export type ProcessUsage = { name: string; cpu: number; memBytes: number };

export type SystemStats = {
  // 全コアをならした使用率（0〜100）
  cpuPercent: number;
  // アクティビティモニタの「使用済みメモリ」（アプリメモリ + 確保されているメモリ + 圧縮）
  memUsed: number;
  memTotal: number;
  // CPU・メモリを多く使っているプロセス（上位 5 件ずつ）
  topCpu: ProcessUsage[];
  topMem: ProcessUsage[];
};
