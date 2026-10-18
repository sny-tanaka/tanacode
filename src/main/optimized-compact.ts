import type { ChatEvent } from '@shared/chat';
import type { Checklist } from '@shared/checklist';
import {
  IDLE_COMPACT_STATUS,
  autoHandoffText,
  carriedMessages,
  carriedOmitted,
  handoffText,
  lastReply,
  resumeText,
  stoppedAt,
  type AutoCompactTrigger,
  type CarriedTask,
  type CompactFailure,
  type CompactPhase,
  type CompactStatus,
  type CompactUnavailable,
} from '@shared/optimized-compact';
import type { SessionState } from '@shared/session-tools';

// 最適化圧縮の流れ。会話を要約にせず、会話を消して、チェックリストから再開する（文は @shared/optimized-compact）。
// 1. 仕上げ: セッションに、続きに要ることをチェックリストに書くよう頼み、そのターンが終わるのを待つ
// 2. 切り替え: /clear を送り、新しい会話になるのを待つ（人の確認は待たない）
// 3. 再開の文: 新しい会話の最初の発言として送る。仕上げが終わった時点（/clear の前）の会話とリストから組み立てておく
// 画面を切り替えても・ウィンドウを閉じても進むよう、main で動かす。画面には、段階と、取りやめた理由だけを知らせる。
// 会話を消すのは戻せないので、少しでも怪しいとき（人が中断した・人が発言した・Claude がチェックリストを使わなかった）は、消さずに取りやめる

// SessionManager のうち、流れに使うもの
export type CompactHost = {
  stateOf(id: string): SessionState | null;
  conversation(id: string): Promise<ChatEvent[]>;
  // 今の Claude Code の会話の ID（/clear で変わる）
  claudeSessionOf(id: string): string | null;
  hasChecklistMcp(id: string): boolean | null;
  runningTasks(id: string): CarriedTask[];
  submitWhenReady(id: string, text: string, timeoutMs: number): Promise<void>;
};

type Timings = {
  // 状態を見直す間隔
  pollMs: number;
  // 仕上げの頼み・/clear を、入力欄が受け付けるまで待つ上限
  submitMs: number;
  // 送った仕上げの頼みが、会話に出るまで待つ上限
  appearMs: number;
  // /clear を送ってから、新しい会話になるまで待つ上限
  clearMs: number;
  // 再開の文を送れなかったときに、試し直すまでの待ち
  retryMs: number;
  // 再開の文を送ってから、そのターンが始まるのを待つ上限
  startMs: number;
};

// clearMs: /clear は SessionEnd・SessionStart の hooks を走らせるので、使う人の hooks が遅い・マシンが重いと時間がかかる。
// 時間切れにすると、会話は消えたのに再開の文を送らないことになる（いちばん避けたい）。待っている間に失うものは無いので、長く待つ
const TIMINGS: Timings = { pollMs: 300, submitMs: 10_000, appearMs: 30_000, clearMs: 120_000, retryMs: 2000, startMs: 15_000 };

type Deps = {
  host: CompactHost;
  // セッションのチェックリスト
  lists: (id: string) => Checklist[];
  // その時刻よりあとに、Claude がチェックリストのツールを呼んだか（読むだけでも）
  usedSince: (id: string, at: number) => boolean;
  // 自動の最適化圧縮の、始める大きさと、このセッションで休んでいるか（画面のトグルに出す。AutoCompact が持つ）
  autoStatus?: (id: string) => { percent: number; paused: boolean };
  // 流れが終わった（failure: 取りやめた・失敗した理由。auto: 自動で始めたもの）。AutoCompact が、続けて失敗したら休むために受ける
  onFinish?: (id: string, failure: CompactFailure | null, auto: AutoCompactTrigger | null) => void;
  // メニューの「Claude にチェックリストを扱わせる」
  enabled: () => boolean;
  onChange: (id: string, status: CompactStatus) => void;
  timings?: Partial<Timings>;
};

// ターンの外（発言を受け付けられる）
const IDLE_STATES = new Set<SessionState>(['idle', 'background']);

// 仕上げのターンの終わり方。done: 終わった / again: 終わったあとに別のターン（タスクの完了の知らせなど）が続いて、それも終わった /
// api-error: API エラーで終わった（上限に当たったなど。Claude Code があきらめたもの）
type Finalized = 'done' | 'again' | 'api-error' | CompactFailure;

export class OptimizedCompact {
  private readonly phases = new Map<string, CompactPhase>();
  private readonly failures = new Map<string, CompactFailure>();
  // アプリがターンの途中で止めて始めた流れが、進んでいるセッション
  private readonly midTurns = new Set<string>();
  private readonly timings: Timings;
  private disposed = false;

  constructor(private readonly deps: Deps) {
    this.timings = { ...TIMINGS, ...deps.timings };
  }

  dispose(): void {
    this.disposed = true;
  }

  status(id: string): CompactStatus {
    const auto = this.deps.autoStatus?.(id) ?? { percent: IDLE_COMPACT_STATUS.autoPercent, paused: false };
    return { phase: this.phases.get(id) ?? null, failure: this.failures.get(id) ?? null, unavailable: this.unavailable(id), autoPercent: auto.percent, autoPaused: auto.paused };
  }

  // 設定が変わった（メニューのオン・オフ）ときに、画面に知らせ直す
  refresh(ids: string[]): void {
    for (const id of ids) this.deps.onChange(id, this.status(id));
  }

  // 進んでいる途中か（再開の文のターンが始まるまで）。この間、ほかのセッションからは「作業中」に見せる（main の outward-state.ts）
  running(id: string): boolean {
    return this.phases.has(id);
  }

  // アプリがターンの途中（ツールの切れ目）で止めて始めた流れが、進んでいるか。止めたターンの終わりは、作業の完了ではない
  // （会話ログに書かれるのが、流れが始まったあとになることがある。main の compact-notice.ts）
  stoppedMidTurn(id: string): boolean {
    return this.midTurns.has(id);
  }

  // 始める。使えない・もう進んでいるときは、何もしない。今の状態を返す。
  // auto: 自動で始めたとき（AutoCompact）。無ければ、人がボタンを押した
  start(id: string, auto: AutoCompactTrigger | null = null): CompactStatus {
    if (this.unavailable(id) || this.phases.has(id)) return this.status(id);
    this.failures.delete(id);
    if (auto?.midTurn) this.midTurns.add(id);
    this.setPhase(id, 'finalizing');
    void this.run(id, auto)
      .catch((error: unknown) => {
        console.error('[optimized-compact]', error);
        return 'busy' as const;
      })
      .then((failure) => {
        this.phases.delete(id);
        this.midTurns.delete(id);
        if (failure) this.failures.set(id, failure);
        this.deps.onFinish?.(id, failure, auto);
        this.deps.onChange(id, this.status(id));
      });
    return this.status(id);
  }

  private unavailable(id: string): CompactUnavailable | null {
    if (!this.deps.enabled()) return 'checklist-off';
    return this.deps.host.hasChecklistMcp(id) === false ? 'no-checklist' : null;
  }

  private setPhase(id: string, phase: CompactPhase): void {
    if (this.phases.get(id) === phase) return;
    this.phases.set(id, phase);
    this.deps.onChange(id, this.status(id));
  }

  // 終わりまで進める。取りやめた・失敗したときは、その理由を返す
  private async run(id: string, auto: AutoCompactTrigger | null): Promise<CompactFailure | null> {
    const { host } = this.deps;
    // ターンの途中で止めたときは、止めた場所。ほかは、最後の応答（どちらも、仕上げの頼みを送る前の会話から、機械的に取り出す）
    const before = await host.conversation(id);
    const stopped = auto?.midTurn ? stoppedAt(before) : undefined;
    const reply = auto?.midTurn ? '' : lastReply(before);
    // 仕上げのあと、/clear を打つ前に別のターンが挟まったら、仕上げを 1 回だけやり直す（リストが、そのターンの分だけ古くなるため）
    for (let attempt = 0; ; attempt++) {
      this.setPhase(id, 'finalizing');
      const startedAt = Date.now();
      const base = (await host.conversation(id)).length;
      try {
        await host.submitWhenReady(id, auto ? autoHandoffText(auto) : handoffText(), this.timings.submitMs);
      } catch {
        return this.alive(id) ? 'busy' : 'exited';
      }
      const finalized = await this.untilFinalized(id, base);
      if (finalized === 'again') {
        if (attempt > 0) return 'interleaved';
        continue;
      }
      // 仕上げもできなかった（上限に当たったあとなど、仕上げのターンが API エラーで終わった）。自動のときは、仕上げを飛ばして、
      // 今あるリストと発言の原文だけで再開する（再開の文に、そう書く）。手動のときは、飛ばさない（下の not-used で取りやめる）
      const handoffSkipped = finalized === 'api-error' && !!auto;
      if (finalized !== 'done' && finalized !== 'api-error') return finalized;
      // Claude がチェックリストのツールを 1 回も呼ばなかったのに会話を消すと、何も引き継げない（チェックリストの MCP が足されていない
      // セッション・頼みを無視したとき）。読むだけでもよい: リストがもう最新なら、Claude は読んで「最新です」と答えるだけのことがある
      // （ふだんから書いているセッション・取りやめた直後の押し直し・仕上げのやり直し）。書き換えを求めると、押しても圧縮できなくなる
      if (!handoffSkipped && !this.deps.usedSince(id, startedAt)) return 'not-used';

      const conversation = await host.conversation(id);
      const resume = resumeText({
        lists: this.deps.lists(id),
        messages: carriedMessages(conversation),
        omitted: carriedOmitted(conversation),
        tasks: host.runningTasks(id),
        reply,
        ...(auto ? { auto, stopped, handoffSkipped } : {}),
      });
      this.setPhase(id, 'clearing');
      const before = host.claudeSessionOf(id);
      try {
        await host.submitWhenReady(id, '/clear', this.timings.submitMs);
      } catch {
        if (!this.alive(id)) return 'exited';
        // 別のターンが始まって打てなかった。そのターンが終わってから、仕上げをやり直す
        if (attempt > 0) return 'interleaved';
        if (!(await this.untilIdle(id))) return 'exited';
        continue;
      }
      const cleared = await this.until(id, this.timings.clearMs, () => host.claudeSessionOf(id) !== before);
      if (cleared === null) return 'exited';
      if (!cleared) return 'not-cleared';
      return this.resume(id, resume);
    }
  }

  // 再開の文を送る。送れないとき（手が空かないまま時間が過ぎた・ターミナルモードの間など）は、捨てずに、少し待って送り直す。
  // 捨てると、会話が空のまま残り、Claude は引き継ぎを受け取れない
  private async resume(id: string, text: string): Promise<CompactFailure | null> {
    this.setPhase(id, 'resuming');
    for (;;) {
      try {
        await this.deps.host.submitWhenReady(id, text, this.timings.submitMs);
        // 再開の文のターンが始まるまでを、流れのうちにする。送った直後は、まだ「待機」に見える。ここで流れを終えると、
        // ほかのセッションから、手が空いたように見える（親に「終わった」と知らせが行く・wait_sessions が返る・end_session が通る）
        await this.until(id, this.timings.startMs, () => !IDLE_STATES.has(this.deps.host.stateOf(id) ?? 'exited'));
        return null;
      } catch {
        if (!this.alive(id)) return 'exited';
        this.setPhase(id, 'waiting');
        await sleep(this.timings.retryMs);
      }
    }
  }

  // 仕上げのターンが終わるのを待つ。base: 仕上げの頼みを送る前の、会話のイベントの数。
  // 許可の確認・質問が出ているあいだは、人が答えるまで待つ（時間切れにしない）
  private async untilFinalized(id: string, base: number): Promise<Finalized> {
    const { host } = this.deps;
    const sentAt = Date.now();
    let seen = false;
    for (;;) {
      if (!this.alive(id)) return 'exited';
      const events = await host.conversation(id);
      const at = handoffIndex(events, base);
      if (at === -1) {
        // 会話に出たあとで消えたのは、巻き戻した・/clear したとき
        if (seen) return 'interrupted';
        if (Date.now() - sentAt > this.timings.appearMs) return 'busy';
      } else {
        seen = true;
        const turn = turnAfter(events.slice(at + 1));
        if (turn.prompted) return 'prompted';
        if (turn.interrupted) return 'interrupted';
        const state = host.stateOf(id);
        if (turn.ended && state && IDLE_STATES.has(state)) return turn.followed ? 'again' : turn.apiError ? 'api-error' : 'done';
      }
      await sleep(this.timings.pollMs);
    }
  }

  // 手が空くのを待つ。セッションが終了したら false
  private async untilIdle(id: string): Promise<boolean> {
    for (;;) {
      if (!this.alive(id)) return false;
      const state = this.deps.host.stateOf(id);
      if (state && IDLE_STATES.has(state)) return true;
      await sleep(this.timings.pollMs);
    }
  }

  // 条件が成り立つのを待つ。時間切れは false、セッションが終了したら null
  private async until(id: string, timeoutMs: number, done: () => boolean): Promise<boolean | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (done()) return true;
      if (!this.alive(id)) return null;
      if (Date.now() > deadline) return false;
      await sleep(this.timings.pollMs);
    }
  }

  private alive(id: string): boolean {
    const state = this.deps.host.stateOf(id);
    return !this.disposed && state !== null && state !== 'exited' && state !== 'archived';
  }
}

// 送った仕上げの頼み（base よりあとの、いちばん新しいもの）の場所。まだ会話に出ていない（巻き戻した・/clear したあとも）なら -1
function handoffIndex(events: ChatEvent[], base: number): number {
  for (let i = events.length - 1; i >= base; i--) {
    const event = events[i];
    if (event.type === 'notice' && event.compact === 'handoff') return i;
  }
  return -1;
}

// 仕上げの頼みのあとに起きたこと。ended: ターンが終わった（最後のターンまで）/ followed: 仕上げのターンのあとに、別のターンが続いた /
// prompted: 人（または親セッション）が発言した・順番待ちに発言がある / interrupted: 人が中断した
function turnAfter(events: ChatEvent[]): { ended: boolean; followed: boolean; prompted: boolean; interrupted: boolean; apiError: boolean } {
  let apiError = false;
  let ended = false;
  let followed = false;
  let prompted = false;
  let interrupted = false;
  let queued = 0;
  for (const event of events) {
    if (event.type === 'user') prompted = true;
    else if (event.type === 'queue') queued = event.prompts.length;
    // あきらめた API エラー（再試行中のものは数えない）。そのあとに応答が来たら、立ち直っている
    else if (event.type === 'api-error') apiError = !event.retrying;
    else if (event.type === 'assistant-text' && !ended) apiError = false;
    else if (event.type === 'turn-end') {
      ended = true;
      if (event.interrupted) interrupted = true;
    } else if (event.type === 'notice' || event.type === 'turn-start') {
      // 仕上げのターンが終わったあとに届いた知らせ（タスクの完了など）で、次のターンが始まった
      if (ended) followed = true;
      ended = false;
    } else if (ended && (event.type === 'assistant-text' || event.type === 'tool-use')) {
      followed = true;
      ended = false;
    }
  }
  return { ended, followed, prompted: prompted || queued > 0, interrupted, apiError };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
