// main から届くタスクの一覧（サブエージェント・ワークフロー・Bash）は、届くたびに全部が新しいオブジェクトになる。
// 中身が変わっていないものは前のオブジェクトを使い回し、何も変わっていなければ前の Map をそのまま返す。
// こうすると、変わっていないタスクの行（memo した部品）は描き直されず、App も描き直されない
export function stableRuns<T extends { toolUseId: string }>(prev: ReadonlyMap<string, T> | undefined, list: T[]): ReadonlyMap<string, T> {
  let changed = !prev || prev.size !== list.length;
  const next = new Map<string, T>();
  for (const item of list) {
    const old = prev?.get(item.toolUseId);
    const same = old !== undefined && JSON.stringify(old) === JSON.stringify(item);
    if (!same) changed = true;
    next.set(item.toolUseId, same ? old : item);
  }
  return changed || !prev ? next : prev;
}

