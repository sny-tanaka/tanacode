import { RESOLVE_FILES_MAX } from '@shared/ipc';

// main に実在を確かめたパス（セッションごとに、候補 → 絶対パス）。同じ本文を描き直すとき（セッションの切り替えなど）に、
// 確かめ直して後からリンクになる、という遅れを出さないために覚えておく。実在しなかったものは覚えない
// （Claude が、あとからそのファイルを作ることがある）
const found = new Map<string, Map<string, string>>();
const MAX_REMEMBERED = 5000;
const NONE: ReadonlyMap<string, string> = new Map();

// 今までに実在を確かめられたパス
export function foundFiles(sessionId: string): ReadonlyMap<string, string> {
  return found.get(sessionId) ?? NONE;
}

// 候補のうち実在するファイルを main に確かめ、確かめられたパス全体（前のものも含む）を返す。確かめられなければ、前のまま
export async function resolveFiles(sessionId: string, candidates: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const asked = candidates.slice(0, RESOLVE_FILES_MAX);
  let resolved: (string | null)[] | undefined;
  try {
    resolved = await window.tanacode.workspace.resolveFiles(sessionId, asked);
  } catch {
    return foundFiles(sessionId);
  }
  if (!Array.isArray(resolved)) return foundFiles(sessionId);
  let files = found.get(sessionId);
  if (!files || files.size >= MAX_REMEMBERED) found.set(sessionId, (files = new Map()));
  for (const [i, path] of asked.entries()) {
    const abs = resolved[i];
    if (abs) files.set(path, abs);
  }
  return files;
}
