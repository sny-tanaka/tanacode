import type { CustomPrompts } from '@shared/prompts';
import type { ScheduledMessage } from '@shared/scheduled';
import { USAGE_RESUME_DELAY_MS, USAGE_RESUME_STAGGER_MS, usageResumeText, type UsageLimitStop } from '@shared/usage-limit';
import type { ScheduledMessages } from './scheduled-messages';

// 利用枠で止まったときの、人への通知の中身。resumeAt: 再開の予約の時刻（入れなかったら null）/ resetsAt: 枠が戻る時刻（分からなければ null）
export type UsageLimitNotice = { resumeAt: number | null; resetsAt: number | null };

type Deps = {
  // このプロファイルの予約
  scheduled: () => ScheduledMessages | null;
  // メニューの「利用枠で止まったら、戻ったときに自動で再開する」
  enabled: () => boolean;
  // セッションの親（親を先に再開する）
  parentOf: (id: string) => string | null;
  // ターミナルモードのセッションか（予約しても、送るときに断られる）
  terminal: (id: string) => boolean;
  // 利用者が変えた、Claude に送る文（メニューの「Claude に送る文…」。無ければ既定の文）。予約を入れるときの文を、予約の本文にする
  prompts?: () => CustomPrompts;
  now?: () => number;
};

// 利用枠（5 時間・週）に当たって止まったセッションに、枠が戻る時刻の少しあと（USAGE_RESUME_DELAY_MS）に、続きを頼むメッセージを予約する
// （ScheduledMessages の by: 'usage-limit'。人の予約と同じく、チャットの末尾の行で、今すぐ送る・時刻を変える・取り消すができる）。
// 同じプロファイル（アカウント）で、同じ時刻に戻る枠で止まったセッションが複数あれば、親を先に、子はあとに 1 分ずつずらして並べる
// （戻った瞬間に一斉に動かないように。親は子の様子を見てから指示を出し直すことがある）。
// 予約しないとき: メニューでオフにしている・ターミナルモード（送るときに断られる）・枠が戻る時刻が分からない（古い Claude Code は
// 会話ログに時刻を書かない。文の「resets 5am」は日付も分からないので、読まない）・その時刻をもう過ぎている（同じ枠で当たり続けないように）
export class UsageLimitResume {
  // 最後のターンが利用枠で止まったセッションの、通知の中身
  private readonly stops = new Map<string, UsageLimitNotice>();
  // 止まった順（並べるとき、親子の深さが同じなら先に止まった方を先にする）
  private readonly stoppedOrder = new Map<string, number>();
  private seq = 0;

  constructor(private readonly deps: Deps) {}

  // ターンが終わった（モデルを呼んだターンだけ）。stop: 利用枠で止まったなら、その知らせ。止まらずに終わったら null
  // （作業が進んだので、待っている再開の予約は要らない。人が自分で続きを頼んだときなど）
  turnEnded(id: string, stop: UsageLimitStop | null): void {
    if (!stop) {
      this.progressed(id);
      return;
    }
    this.stops.set(id, { resumeAt: this.schedule(id, stop), resetsAt: stop.resetsAt });
  }

  // 最後のターンが利用枠で止まっていれば、その通知の中身（ターンの終わりの通知と、取りやめた最適化圧縮の通知に使う）
  noticeOf(id: string): UsageLimitNotice | null {
    return this.stops.get(id) ?? null;
  }

  // メニューでオフにした。待っている再開の予約を、すべて取り消す
  cancelAll(): void {
    const scheduled = this.deps.scheduled();
    for (const message of scheduled?.list().filter((m) => m.by === 'usage-limit') ?? []) scheduled?.cancel(message.id);
    for (const [id, notice] of this.stops) this.stops.set(id, { ...notice, resumeAt: null });
  }

  // セッションが終了した・アーカイブされた（予約は ScheduledMessages が、アーカイブのときに取り消す）
  forget(id: string): void {
    this.stops.delete(id);
    this.stoppedOrder.delete(id);
  }

  private progressed(id: string): void {
    this.stops.delete(id);
    this.stoppedOrder.delete(id);
    const scheduled = this.deps.scheduled();
    if (scheduled) this.cancelResumes(scheduled, id);
  }

  // そのセッションの再開の予約を取り消し、同じ時刻に戻る枠のほかの予約を前に詰める
  private cancelResumes(scheduled: ScheduledMessages, id: string): void {
    const groups = new Set<number>();
    for (const message of this.resumesOf(id)) {
      scheduled.cancel(message.id);
      if (message.limitResetsAt !== undefined) groups.add(message.limitResetsAt);
    }
    for (const resetsAt of groups) this.arrange(scheduled, resetsAt);
  }

  // 予約を入れて、同じ時刻に戻るものと並べ直す。入れた予約の時刻を返す（入れなかったら null）
  private schedule(id: string, stop: UsageLimitStop): number | null {
    const scheduled = this.deps.scheduled();
    const now = (this.deps.now ?? Date.now)();
    const resetsAt = stop.resetsAt;
    if (!scheduled || !this.deps.enabled() || this.deps.terminal(id) || resetsAt === null || resetsAt <= now) return null;
    // 前に止まったときの予約（まだ送っていない・送れなかったもの）は、入れ直す。1 つのセッションに 1 つだけ
    this.cancelResumes(scheduled, id);
    let added: ScheduledMessage;
    try {
      added = scheduled.add(id, usageResumeText(this.deps.prompts?.() ?? {}), [], resetsAt + USAGE_RESUME_DELAY_MS, [], 'usage-limit', resetsAt);
    } catch {
      // アーカイブしたセッションなど、予約を受け付けない
      return null;
    }
    this.stoppedOrder.set(id, ++this.seq);
    this.arrange(scheduled, resetsAt);
    return scheduled.list().find((m) => m.id === added.id)?.at ?? added.at;
  }

  // 同じ時刻に戻る枠の再開の予約（時刻を待っているもので、人が時刻を変えていないもの）を、親が先・子があとの順に 1 分ずつ並べる
  private arrange(scheduled: ScheduledMessages, resetsAt: number): void {
    const group = scheduled
      .list()
      .filter((m) => m.by === 'usage-limit' && m.state === 'scheduled' && m.limitResetsAt === resetsAt)
      .map((m) => ({ m, depth: this.depthOf(m.sessionId), order: this.stoppedOrder.get(m.sessionId) ?? 0 }))
      .sort((a, b) => a.depth - b.depth || a.order - b.order);
    group.forEach(({ m }, i) => scheduled.retime(m.id, resetsAt + USAGE_RESUME_DELAY_MS + i * USAGE_RESUME_STAGGER_MS));
  }

  // 親子の深さ（親のいないセッションが 0）
  private depthOf(id: string): number {
    let depth = 0;
    const seen = new Set([id]);
    for (let parent = this.deps.parentOf(id); parent && !seen.has(parent); parent = this.deps.parentOf(parent)) {
      seen.add(parent);
      depth += 1;
    }
    return depth;
  }

  // そのセッションの、利用枠の再開の予約（手が空くのを待って送っている途中のものも。止まり直した・作業が進んだなら、もう要らない）
  private resumesOf(id: string): ScheduledMessage[] {
    return this.deps.scheduled()?.list().filter((m) => m.sessionId === id && m.by === 'usage-limit') ?? [];
  }
}
