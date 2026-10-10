import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Rect = { x: number; y: number; width: number; height: number };

// 次の起動で戻すウインドウの状態。bounds は最大化・フルスクリーンを解いたときの位置と大きさ、
// frame は実際に出ていた位置と大きさ（最大化・フルスクリーンなら画面いっぱい。そうでなければ bounds と同じ）
export type WindowState = { bounds: Rect; frame: Rect; maximized: boolean; fullScreen: boolean };

// 無い・読めない・形の違うときは null（初めての起動と同じく、既定の大きさで開く）
export function loadWindowState(file: string): WindowState | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { bounds?: unknown; frame?: unknown; maximized?: unknown; fullScreen?: unknown };
    const bounds = rectOf(data.bounds);
    if (!bounds) return null;
    // frame の無い（前のバージョンが書いた）ものは、bounds の位置に出ていたものとして扱う
    return { bounds, frame: rectOf(data.frame) ?? bounds, maximized: data.maximized === true, fullScreen: data.fullScreen === true };
  } catch {
    return null;
  }
}

export function saveWindowState(file: string, state: WindowState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2));
  renameSync(tmp, file);
}

// 覚えた位置と大きさ（bounds）を、今つながっている画面（workAreas: メニューバーと Dock を除いた範囲）に収める。
// 開く画面は、実際に出ていた位置（frame）といちばん重なる画面。最大化・フルスクリーンのまま別の画面へ移すと、
// bounds は前の画面に残るため。その画面がもう無ければ、bounds といちばん重なる画面。選んだ画面の中に bounds を入れ直す。
// どの画面とも重ならない（外したディスプレイにあった）ときは、位置を決めずに大きさだけ返す（Electron が主の画面の真ん中に出す）
export function placeWindow(
  saved: Pick<WindowState, 'bounds' | 'frame'> | null,
  workAreas: Rect[],
  fallback: { width: number; height: number },
): { x?: number; y?: number; width: number; height: number } {
  if (!saved) return fallback;
  const { bounds } = saved;
  const best = mostOverlapping(saved.frame, workAreas) ?? mostOverlapping(bounds, workAreas);
  if (!best) {
    const area = workAreas[0];
    if (!area) return { width: bounds.width, height: bounds.height };
    return { width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height) };
  }
  const width = Math.min(bounds.width, best.width);
  const height = Math.min(bounds.height, best.height);
  const x = clamp(bounds.x, best.x, best.x + best.width - width);
  const y = clamp(bounds.y, best.y, best.y + best.height - height);
  return { x, y, width, height };
}

function mostOverlapping(rect: Rect, areas: Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestOverlap = 0;
  for (const area of areas) {
    const overlap = overlapOf(rect, area);
    if (overlap > bestOverlap) {
      best = area;
      bestOverlap = overlap;
    }
  }
  return best;
}

function overlapOf(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function rectOf(value: unknown): Rect | null {
  const r = value as Partial<Record<keyof Rect, unknown>> | null;
  if (!r || typeof r !== 'object') return null;
  const { x, y, width, height } = r;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}
