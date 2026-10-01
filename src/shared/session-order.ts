import type { SessionSummary } from './ipc';

// 並びをロックしているときの一覧。order（ロックした時点の id の並び）にあるものは、その順のまま動かさない。
// order に無いもの（ロックしたあとにできたセッション）は、sessions の並び（最終更新の新しい順）のまま先頭に置く。
// 消えたセッションの id は、order にあっても出てこない
export function inLockedOrder(sessions: SessionSummary[], order: string[]): SessionSummary[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  const added = sessions.filter((s) => !rank.has(s.id));
  const kept = sessions.filter((s) => rank.has(s.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...added, ...kept];
}
