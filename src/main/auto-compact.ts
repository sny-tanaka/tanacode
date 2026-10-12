import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { contextPercent, contextUsage } from '@shared/context';
import type { SessionSummary } from '@shared/ipc';
import type { SessionKnowledge } from '@shared/knowledge';
import { midTurnPercent, type AutoCompactTrigger, type CompactFailure, type CompactStatus } from '@shared/optimized-compact';
import type { ScreenInfo } from '@shared/screen';
import type { SessionState } from '@shared/session-tools';
import type { StatusLineInfo } from '@shared/statusline';

// 最適化圧縮を、自動で始める。コンテキストの割合を見て、流れ（OptimizedCompact）を呼ぶ。流れそのものは、手動のボタンと同じ。
// - ターンの終わり: 待機に戻ったときに、設定の大きさを超えていたら始める（切り替えたあと、Claude は報告して待つ）
// - ターンの途中: 1 つのターンが長くて、設定より 10 ポイント上（上限 90%）を超えたら、止めるファイルを書く。ツールのあとのフック
//   （statusline.ts の AUTO_COMPACT_STOP_COMMAND）が、次のツールの切れ目でターンを止める。止まったら始める（切り替えたあと、続きを進めさせる）
// - 備え: Claude Code の自動の圧縮（要約）が先に始まろうとしたら、圧縮の前のフックで止めて（preCompact）、同じ流れに入る
// 割合を見て決めるのはアプリ。ツールのあとのフックは、ファイルを見るだけ（ツールの呼び出しのたびに、アプリに聞くプロセスを起こさない）

// 続けて何度も起きないための決まり:
// - 流れが進んでいる間は、始めない（止めるファイルも書かない）
// - 始めたら、割合が「設定より 10 ポイント下」を一度下回るまで、次は始めない（切り替えた直後にまだ超えていても、繰り返さない）
// - 取りやめた・失敗したときは、次のターンの終わりにもう 1 回だけ試す。続けて 2 回だめなら、そのセッションでは休む
//   （休んでいる間は、Claude Code の自動の圧縮を止めない。上限で詰まらないように）。手動で成功するか、トグルを入れ直すと戻る
// 人のじゃまをしないための決まり（ターンの終わりの切り替えだけ。アプリが途中で止めたターンは、止めたままにしないよう、必ず始める）:
// - 人が中断（Esc）して終わったターンでは、始めない（中断した人は、すぐ次の発言を打つ。仕上げが取りやめになるだけ）
// - 入力欄に書きかけの文字があるあいだは、始めない（仕上げの頼みを打てずに、失敗に数えられる）
const REARM_MARGIN = 10;
const MAX_FAILURES = 2;
// ターンが終わってから、最後の応答の使用量が届くまで待つ時間。statusLine は、ターンの終わりより少し遅れて書かれる
// （ターンが終わった時点では、まだ前の応答の量のまま）。この間に届いた量も、ターンの終わりの量として見る
const SETTLE_MS = 10_000;

// SessionManager のうち、使うもの
export type AutoCompactHost = {
  summary(id: string): SessionSummary | undefined;
  stateOf(id: string): SessionState | null;
  statusLine(id: string): StatusLineInfo | null;
  knowledge(id: string): SessionKnowledge;
  screen(id: string): ScreenInfo | null;
  // 最後に終わったターンが、人の中断（Esc）で終わったか
  lastTurnInterrupted(id: string): boolean;
};

type Deps = {
  host: AutoCompactHost;
  // 流れ（OptimizedCompact）
  compact: { start(id: string, auto: AutoCompactTrigger): CompactStatus; status(id: string): CompactStatus; running(id: string): boolean };
  // 自動で始める大きさ（コンテキストの割合。アプリ全体の設定）
  percent: () => number;
  // 止めるファイルと、フックが止めた印のファイル（StatusLineWatcher の stopFileFor・stopHitFileFor）
  stopFile: (id: string) => string;
  stopHitFile: (id: string) => string;
  // 休んだ・戻ったとき（画面のトグルに出す）
  onChange: (id: string) => void;
  // 今の時刻（テストで進める）
  now?: () => number;
};

type State = {
  // 次に超えたら始めてよい（始めたあとは、割合が下がるまで false）
  armed: boolean;
  // 作業中だった（待機に戻ったときが、ターンの終わり）
  working: boolean;
  // ターンが終わった時刻（始めなかったとき。使用量が遅れて届くのを待つ。SETTLE_MS）
  endedAt: number | null;
  // 続けて取りやめた・失敗した回数
  failures: number;
  paused: boolean;
  // Claude Code の自動の圧縮を止めた。次の切れ目（かターンの終わり）で、割合に関係なく始める
  preCompact: boolean;
  // 止めるファイルを書いた（フックが掴んだかを、ファイルで確かめるのは、この間だけ）
  stopWritten: boolean;
};

const IDLE_STATES = new Set<SessionState>(['idle', 'background']);

// 圧縮の前のフックに返す、止める理由（Claude Code の画面に出る）
const PRECOMPACT_REASON = 'tanacode resets the conversation and resumes from the checklists instead of compacting (optimized compaction is set to automatic for this session).';

export class AutoCompact {
  private readonly states = new Map<string, State>();

  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
  }

  // 画面に出す状態（始める大きさ・休んでいるか）
  status(id: string): { percent: number; paused: boolean } {
    return { percent: this.deps.percent(), paused: this.states.get(id)?.paused ?? false };
  }

  // セッションの状態・コンテキストの量が変わった（SessionManager の watchState・knowledge・statusLine から呼ぶ）
  check(id: string): void {
    const { host, compact } = this.deps;
    const state = host.stateOf(id);
    if (state === null || state === 'archived' || state === 'exited') return this.forget(id);
    const s = this.state(id);
    const percent = this.percentOf(id);
    const threshold = this.deps.percent();
    // 割合が下がったら、また始めてよい
    if (percent !== null && percent < threshold - REARM_MARGIN) s.armed = true;
    if (!this.active(id) || compact.running(id)) {
      // 流れの途中のターン（仕上げ・再開）は、作業中に数えない
      s.working = false;
      s.endedAt = null;
      return this.clearStop(id);
    }
    if (state === 'working') {
      s.working = true;
      s.endedAt = null;
      // 1 つのターンが長い。次のツールの切れ目で止める
      if ((s.preCompact || (s.armed && percent !== null && percent >= midTurnPercent(threshold))) && !this.stopPending(id)) this.writeStop(id, percent);
      return;
    }
    if (!IDLE_STATES.has(state)) return;
    // 待機に戻った。フックが止めた印があれば、アプリが途中で止めたターン
    const stopped = existsSync(this.deps.stopHitFile(id));
    if (s.working || stopped) s.endedAt = this.now();
    const ended = s.endedAt !== null && this.now() - s.endedAt <= SETTLE_MS;
    s.working = false;
    this.clearStop(id);
    if (!ended) return;
    if (!stopped) {
      if (host.lastTurnInterrupted(id)) {
        s.endedAt = null;
        return;
      }
      // 書きかけが消えたら（使用量を待つ間なら）始める
      if (host.screen(id)?.draft) return;
    }
    const over = s.armed && percent !== null && percent >= threshold;
    if (!stopped && !over && !s.preCompact) return;
    s.armed = false;
    s.preCompact = false;
    s.endedAt = null;
    compact.start(id, { percent: percent ?? threshold, midTurn: stopped });
  }

  // 流れが終わった（手動のものも）。続けて失敗したら、このセッションでは休む
  finished(id: string, failure: CompactFailure | null, auto: AutoCompactTrigger | null): void {
    const s = this.state(id);
    const wasPaused = s.paused;
    if (failure === null) {
      s.failures = 0;
      s.paused = false;
    } else if (auto) {
      s.failures += 1;
      if (s.failures >= MAX_FAILURES) s.paused = true;
      // 次のターンの終わりに、もう 1 回試す
      else s.armed = true;
    }
    if (s.paused !== wasPaused) this.deps.onChange(id);
  }

  // トグルを切り替えた。入れ直したら、休んでいたのをやめる
  toggled(id: string): void {
    const s = this.state(id);
    const wasPaused = s.paused;
    s.failures = 0;
    s.paused = false;
    s.armed = true;
    s.preCompact = false;
    if (!this.active(id)) this.clearStop(id);
    if (wasPaused) this.deps.onChange(id);
    this.check(id);
  }

  // 圧縮の前のフック（PreCompact・auto）に答える。自動がオンで使えるセッションなら、止める理由を返す（Claude Code は要約を作らない）。
  // 止めたら、次のツールの切れ目（かターンの終わり）で、同じ流れに入る。オフ・使えない・休んでいるセッションと、
  // 切り替えたばかりのセッションでは止めない（空を返す）
  preCompact(id: string): string {
    if (!this.active(id)) return '';
    // 流れの途中（仕上げのターン）なら、止めるだけ。このあと会話を消す
    if (this.deps.compact.running(id)) return PRECOMPACT_REASON;
    const s = this.state(id);
    // 切り替えたばかりで、まだ割合が下がっていない（次は始めない決まり）のに、Claude Code が圧縮しようとしている。
    // 止めても切り替えられないので、止めない（Claude Code の圧縮に任せる。止め続けると、上限で詰まる・切り替えを繰り返す）
    if (!s.armed) return '';
    s.preCompact = true;
    this.check(id);
    return PRECOMPACT_REASON;
  }

  forget(id: string): void {
    if (!this.states.delete(id)) return;
    this.clearStop(id);
  }

  // アプリが止めたターンが、流れに入るのを待っている（フックが止めるファイルを掴んでから、ターンが終わって流れが始まるまで）。
  // ターンが終わって「待機」に戻っても、このあと流れが始まるので、ほかのセッションからは「作業中」に見せる（outward-state.ts）
  stopping(id: string): boolean {
    return !!this.states.get(id)?.stopWritten && existsSync(this.deps.stopHitFile(id));
  }

  // 自動で始めるセッションか。トグルがオン・チェックリストが使える・休んでいない
  private active(id: string): boolean {
    const summary = this.deps.host.summary(id);
    if (!summary || summary.archived || summary.autoCompact === false) return false;
    return !this.state(id).paused && this.deps.compact.status(id).unavailable === null;
  }

  // コンテキストの割合（ヘッダーのメーターと同じ出し方）。分からなければ null
  private percentOf(id: string): number | null {
    const { host } = this.deps;
    return contextPercent(contextUsage(host.summary(id)?.model ?? null, host.screen(id)?.model ?? null, host.statusLine(id), host.knowledge(id).contextTokens));
  }

  private state(id: string): State {
    let s = this.states.get(id);
    if (!s) {
      s = { armed: true, working: false, endedAt: null, failures: 0, paused: false, preCompact: false, stopWritten: false };
      this.states.set(id, s);
    }
    return s;
  }

  // 止めるファイルを書いてある・フックがもう止めた
  private stopPending(id: string): boolean {
    return existsSync(this.deps.stopFile(id)) || existsSync(this.deps.stopHitFile(id));
  }

  // 止めるファイル。フックが、この中身をそのまま出す（Claude Code がターンを止める）
  private writeStop(id: string, percent: number | null): void {
    const file = this.deps.stopFile(id);
    const reason = `tanacode: the context is ${percent === null ? 'almost' : `${Math.round(percent)}%`} full, so tanacode stops here to reset the conversation and resume from the checklists (optimized compaction).`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ continue: false, stopReason: reason }), { mode: 0o600 });
      this.state(id).stopWritten = true;
    } catch {
      // 書けなければ、ターンの終わりを待つ
    }
  }

  private clearStop(id: string): void {
    const s = this.states.get(id);
    if (s) s.stopWritten = false;
    rmSync(this.deps.stopFile(id), { force: true });
    rmSync(this.deps.stopHitFile(id), { force: true });
  }
}
