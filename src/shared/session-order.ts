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

// セッション一覧の 1 行。depth 1 は親の下にぶら下げる子。children: 親の行なら、ぶら下げる子（畳んでいても入れる）。
// parent: 親の下に出せない子（親を一覧から削除した・親と区分が違う）の親。一覧に無ければ null。ぶら下げた子の行では、上の親の行
export type SessionTreeRow = { session: SessionSummary; depth: 0 | 1; children: SessionSummary[]; parent: SessionSummary | null };

// 区分（アクティブ・アーカイブ済み）の中の並び。list はその区分のセッションを、今の一覧の並び（最終更新の新しい順。ロック中はロックした並び）で。
// 親子のない行と親の行は list の並びのまま、子は親の直後に list の並びで（新しい順）出す。collapsed（畳んだ親の id）の子は出さない。
// 親が同じ区分にいない子は、いちばん上の段に出す。all は親の名前を引くための、全セッション
export function sessionTree(list: SessionSummary[], all: SessionSummary[], collapsed: ReadonlySet<string>): SessionTreeRow[] {
  const inList = new Map(list.map((s) => [s.id, s]));
  const byId = new Map(all.map((s) => [s.id, s]));
  // 親の下にぶら下げるか。親が同じ区分にいて、親自身はぶら下げない行のとき（親子は 1 段まで。孫や、親子が輪になったものは上の段に出す）
  const nested = (s: SessionSummary): boolean => {
    const parent = s.parentId ? inList.get(s.parentId) : undefined;
    return !!parent && !(parent.parentId && inList.has(parent.parentId));
  };
  const childrenOf = new Map<string, SessionSummary[]>();
  for (const s of list) {
    if (nested(s)) childrenOf.set(s.parentId!, [...(childrenOf.get(s.parentId!) ?? []), s]);
  }
  const rows: SessionTreeRow[] = [];
  for (const s of list) {
    if (nested(s)) continue;
    const children = childrenOf.get(s.id) ?? [];
    rows.push({ session: s, depth: 0, children, parent: s.parentId ? (byId.get(s.parentId) ?? null) : null });
    if (!collapsed.has(s.id)) for (const child of children) rows.push({ session: child, depth: 1, children: [], parent: s });
  }
  return rows;
}
