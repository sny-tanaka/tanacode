import type { SessionSummary } from './ipc';

// 最近のフォルダから外したフォルダ → 外した時刻（ミリ秒）
export type HiddenFolders = Record<string, number>;

// 最近使ったフォルダ（新しい順）。worktree のセッションは、worktree ではなく元のフォルダ。
// 外したフォルダは出さない。セッションは消さないので、外したあとにそのフォルダで新しいセッションを作る（取り込む）と、また出る
export function listRecentFolders(sessions: SessionSummary[], hidden: HiddenFolders): string[] {
  // 並びは、フォルダのセッションが最初に出てくる順（sessions は新しい順）。外したあとのセッションがあるフォルダだけ残す
  const shown = new Map<string, boolean>();
  for (const s of sessions) {
    const dir = s.worktree?.root ?? s.cwd;
    const hiddenAt = hidden[dir];
    shown.set(dir, shown.get(dir) === true || hiddenAt === undefined || s.createdAt > hiddenAt);
  }
  return [...shown].filter(([, visible]) => visible).map(([dir]) => dir);
}

// 保存した JSON から読み直す。壊れていたり、型が違ったりするものは捨てる
export function parseHiddenFolders(raw: string | null): HiddenFolders {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === 'number' && Number.isFinite(at)));
  } catch {
    return {};
  }
}
