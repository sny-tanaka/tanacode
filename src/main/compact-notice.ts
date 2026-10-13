import type { AutoCompactTrigger, CompactFailure } from '@shared/optimized-compact';

// ターンが終わったときに、人に出す通知の種類。work: 「作業が完了しました」/ compact: 「コンテキストの最適化が完了しました」
export type TurnNotice = 'work' | 'compact';

// 最適化圧縮の流れ（仕上げ → /clear → 再開の文）の間の、人への完了の通知。
// 流れの間は、ターンが 2〜3 回終わる（アプリが途中で止めたターン・仕上げのターン・再開のターン）。ターンの終わりのたびに
// 「作業が完了しました」と鳴らすと、まだ切り替えの途中（/clear を打つところ）なのに、完了と知らせることになる。
// 鳴らすのは、流れが最後まで終わったときの 1 回にする:
// - 報告して待つ再開（手動・ターンの終わりの自動）: 再開のターンの終わりに「コンテキストの最適化が完了しました」
// - 続きを進める再開（ターンの途中で止めた自動）: 続きのターンの終わりに、ふつうの「作業が完了しました」
// - 取りやめた・失敗した: 途中で出さなかった通知があれば、流れが終わったときに、取りやめたことを知らせる
//   （出さないと、アプリが途中で止めた作業が、止まったまま気づかれない）
export class CompactNotice {
  // 流れの間にターンが終わって、通知を出さなかったセッション
  private readonly held = new Set<string>();
  // 流れが終わって、報告して待つ再開のターンが進んでいるセッション
  private readonly resuming = new Set<string>();

  // compacting: そのセッションで、流れが進んでいるか（アプリが止めたターンが、流れに入るのを待っている間も）
  constructor(private readonly compacting: (id: string) => boolean) {}

  // ターンが終わった。出す通知の種類を返す（null なら出さない）。ターンの終わりごとに、1 回だけ呼ぶ
  turnEnded(id: string): TurnNotice | null {
    if (this.compacting(id)) {
      this.held.add(id);
      return null;
    }
    this.held.delete(id);
    return this.resuming.delete(id) ? 'compact' : 'work';
  }

  // 流れが終わった（failure: 取りやめた・失敗した理由。auto: 自動で始めたもの）。取りやめたことを知らせるなら true
  finished(id: string, failure: CompactFailure | null, auto: AutoCompactTrigger | null): boolean {
    const held = this.held.delete(id);
    if (failure) return held;
    if (!auto?.midTurn) this.resuming.add(id);
    return false;
  }

  // セッションが終了した・アーカイブされた
  forget(id: string): void {
    this.held.delete(id);
    this.resuming.delete(id);
  }
}
