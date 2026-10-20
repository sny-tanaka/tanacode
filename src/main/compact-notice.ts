import type { ChatEvent } from '@shared/chat';
import { CHECKLIST_MCP_SERVER } from '@shared/checklist-tools';
import { compactTriggerOf, type CompactFailure } from '@shared/optimized-compact';

// ターンが終わったときに、人に出す通知の種類。work: 「作業が完了しました」/ compact: 「コンテキストの最適化が完了しました」
export type TurnNotice = 'work' | 'compact';

// ターンを始めたもの。handoff: 最適化圧縮の仕上げの頼み / resume: 再開の文（まだ作業を続けていない。引き継いだことを報告して待つかもしれない）/
// other: ほか（人の発言・知らせ・ターンの途中で止めた作業の続きを進めさせる再開の文・作業を続けた再開の文）
export type TurnStarter = 'handoff' | 'resume' | 'other';

// 会話のイベント（発言・知らせ）が始めるターンの種類
export function turnStarterOf(event: ChatEvent): TurnStarter {
  if (event.type !== 'notice' || !event.compact) return 'other';
  if (event.compact === 'handoff') return 'handoff';
  return compactTriggerOf(event)?.midTurn ? 'other' : 'resume';
}

// 再開のターンで使っても、作業を続けたことにならないツール。引き継ぎを読む・直すもの（チェックリスト）と、
// その定義を読み込むもの（ToolSearch。MCP のツールが多いと、Claude Code はツールの定義をあとから読み込ませる）
function handoverTool(name: string): boolean {
  return name.startsWith(`mcp__${CHECKLIST_MCP_SERVER}__`) || name === 'ToolSearch';
}

// 再開の文が始めたターンで、作業を続けたことを示すイベントか（チェックリスト以外のツールを使った）。
// 再開の文は、続けるか待つかを Claude に決めさせる（チェックリストに、答えを待っていると書いてあれば待つ）ので、文からは分からない。
// 待つときは、リストを読んで報告するだけで、ほかのツールは使わない
export function continuesWork(event: ChatEvent): boolean {
  return event.type === 'tool-use' && !handoverTool(event.name);
}

// 再開の文（知らせ）のあとのイベント（turn。そのターンのぶん）から、そのターンで作業を続けたか。
// ターンの途中で止めた自動の再開は、止めたターンの続きなので、いつも続けたものとする
export function resumeContinued(resume: Extract<ChatEvent, { type: 'notice' }>, turn: ChatEvent[]): boolean {
  return !!compactTriggerOf(resume)?.midTurn || turn.some(continuesWork);
}

// 最適化圧縮の流れ（仕上げ → /clear → 再開の文）の間の、人への完了の通知。
// 流れの間は、ターンが 2〜3 回終わる（アプリが途中で止めたターン・仕上げのターン・再開のターン）。ターンの終わりのたびに
// 「作業が完了しました」と鳴らすと、まだ切り替えの途中（/clear を打つところ）なのに、完了と知らせることになる。
// 鳴らすのは、流れが最後まで終わったときの 1 回にする:
// - 報告して待った再開（再開のターンで、チェックリストしか使わなかった）: 再開のターンの終わりに「コンテキストの最適化が完了しました」
// - 作業を続けた再開（ターンの途中で止めた自動・再開のターンでほかのツールを使った）: そのターンの終わりに、ふつうの「作業が完了しました」
//   （SessionManager が、再開のターンでほかのツールを使ったら、始めたものを other に替える）
// - 取りやめた・失敗した: 途中で出さなかった通知があれば、流れが終わったときに、取りやめたことを知らせる
//   （出さないと、アプリが途中で止めた作業が、止まったまま気づかれない）
// どのターンの終わりかは、流れが進んでいるかではなく、そのターンを始めたもので見分ける。ターンの終わりの自動は、作業のターンが
// 終わってすぐに始まるので、流れが始まったあとに、作業のターンの終わりが会話ログから届くことがある（それは、作業の完了として知らせる）
export class CompactNotice {
  // 流れの間にターンが終わって、通知を出さなかったセッション
  private readonly held = new Set<string>();

  // stopped: アプリがターンの途中（ツールの切れ目）で止めたターンが、終わるところか（流れに入るのを待っている間と、その流れの間）
  constructor(private readonly stopped: (id: string) => boolean) {}

  // ターンが終わった。出す通知の種類を返す（null なら出さない）。ターンの終わりごとに、1 回だけ呼ぶ
  turnEnded(id: string, starter: TurnStarter): TurnNotice | null {
    if (starter === 'handoff' || this.stopped(id)) {
      this.held.add(id);
      return null;
    }
    this.held.delete(id);
    return starter === 'resume' ? 'compact' : 'work';
  }

  // 流れが終わった（failure: 取りやめた・失敗した理由）。取りやめたことを知らせるなら true
  finished(id: string, failure: CompactFailure | null): boolean {
    return this.held.delete(id) && failure !== null;
  }

  // セッションが終了した・アーカイブされた
  forget(id: string): void {
    this.held.delete(id);
  }
}
