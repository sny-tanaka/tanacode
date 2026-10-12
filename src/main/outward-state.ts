import type { SessionState } from '@shared/session-tools';

// ほかのセッション・アプリが打つ知らせから見た、セッションの状態。
// 最適化圧縮の流れ（仕上げ → /clear → 再開の文）の間は、ターンとターンのすき間で、セッションが一瞬「待機」に戻る。
// そこを手が空いたと見ると、親に「終わった」と知らせが行く・wait_sessions が返る・end_session が通る・アプリの知らせ
// （子の知らせ・チェックリストの知らせ）が流れに割り込む。流れの間は、手が空いていても「作業中」に見せる。
// 人が答える待ち（質問・許可の確認・ターミナルでの操作）と、終了・アーカイブは、そのまま見せる（親が答える・片付けるため）
export function outwardState(state: SessionState | null, compacting: boolean): SessionState | null {
  return compacting && (state === 'idle' || state === 'background') ? 'working' : state;
}

// SessionManager の、stateOf だけを差し替えたもの（ほかは、そのまま元を呼ぶ）。
// compacting: そのセッションで、最適化圧縮の流れが進んでいるか（アプリが止めたターンが、流れに入るのを待っている間も）
export function outwardHost<T extends { stateOf(id: string): SessionState | null }>(host: T, compacting: (id: string) => boolean): T {
  return new Proxy(host, {
    get(target, prop) {
      if (prop === 'stateOf') return (id: string) => outwardState(target.stateOf(id), compacting(id));
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
