import type { SessionState } from '@shared/session-tools';

// Claude がターンの終わりに預けた、人への短い報告（tanacode-sessions の report_result）。セッションごとに最後のものだけを持つ。
// ターンが終わったときの通知は、報告があればその文にして、ふつうの「作業が完了しました」は出さない（profile.ts）。
// 通知に使ったら捨てる。新しいターンが始まったときも、前のターンの報告は捨てる（使われずに残った報告が、別のターンの通知に出ないように）
export class TurnReports {
  private readonly reports = new Map<string, string>();
  // セッションの前の状態（新しいターンが始まったことを知るため）
  private readonly lastState = new Map<string, SessionState | null>();

  set(id: string, text: string): void {
    this.reports.set(id, text);
  }

  has(id: string): boolean {
    return this.reports.has(id);
  }

  // 報告を取り出して捨てる（通知に使う）
  take(id: string): string | null {
    const text = this.reports.get(id) ?? null;
    this.reports.delete(id);
    return text;
  }

  // セッションの状態が変わった。手の空いた状態などから作業中になったら、新しいターンが始まったので、前の報告は捨てる。
  // 質問・許可の確認・ターミナルやアプリ内ブラウザでの操作の待ちから作業中に戻ったのは、同じターンの続き（報告を預けたあとに確認が出ることもある）
  stateChanged(id: string, state: SessionState | null): void {
    const before = this.lastState.get(id);
    this.lastState.set(id, state);
    if (state === 'working' && before !== 'working' && !MID_TURN.has(before ?? 'exited')) this.reports.delete(id);
    // 一覧から消えた・アーカイブした・Claude Code が終わった
    if (state === null || state === 'archived' || state === 'exited') {
      this.reports.delete(id);
      if (state === null) this.lastState.delete(id);
    }
  }
}

// ターンの途中で、人の操作を待っている状態（browser は、ツールで見せる状態として渡されたとき）
const MID_TURN = new Set<SessionState>(['question', 'permission', 'terminal', 'browser']);
