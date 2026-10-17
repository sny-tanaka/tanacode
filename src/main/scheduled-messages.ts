import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { t } from '@shared/i18n';
import { SCHEDULE_LATE_MS, wakeupText, type ScheduledMessage } from '@shared/scheduled';
import type { SessionState } from '@shared/session-tools';

// 予約を送るのに使う、セッションの操作（SessionManager）
export type ScheduleHost = {
  // ツールで返す、今の状態（知らないセッションは null）
  stateOf(id: string): SessionState | null;
  // 止まっているセッションを起動（再開）する
  open(id: string): Promise<void>;
  // セッションの一覧の項目（ターミナルモードで止まっているか。止まっていても terminal が付く）
  summary(id: string): { terminal?: boolean } | undefined;
  // 手が空くのを待ってから送る。signal で、待っている間に取りやめる
  submitWhenReady(id: string, text: string, timeoutMs: number, options: { attachments?: string[]; pastes?: string[]; signal?: AbortSignal }): Promise<void>;
};

// setTimeout に渡せる待ち時間の上限（約 24.8 日）。それより先の予約は、途中で一度起きて測り直す
const MAX_TIMER_MS = 2 ** 31 - 1;

// 予約したメッセージ。ファイルに保存し、アプリを起動し直しても残す。
// 時刻になったら、Claude Code の手が空くのを待って送る（子セッションへの指示と同じ送り方。作業中に打つと、許可の確認の選択になってしまうことがある）。
// アプリが閉じていた・Mac がスリープしていたなどで、時刻を SCHEDULE_LATE_MS より過ぎてから気づいたものは、送らずに missed にする。
// Claude が自分に入れた予約（by: 'claude'。sessions-control.ts の schedule_wakeup）も同じ流れに乗せ、送るときだけ囲み（WAKEUP_TAG）に入れる
export class ScheduledMessages {
  private messages: ScheduledMessage[];
  private timer: NodeJS.Timeout | null = null;
  // 送っている途中のもの（手が空くのを待っている間に取り消せるように）
  private readonly sending = new Map<string, AbortController>();
  // 待ち直しを頼んである（変更が続いても、待ち直すのは一度だけ）
  private rearmQueued = false;
  private disposed = false;

  constructor(
    private readonly file: string,
    private readonly host: ScheduleHost,
    private readonly onChanged: (messages: ScheduledMessage[]) => void,
    // 送れなかった・時刻を過ぎていた（通知に使う）
    private readonly onTrouble: (message: ScheduledMessage) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    // 送っている途中でアプリを閉じたものは、まだ送っていない。時刻を待っていたものと同じに扱い、過ぎていれば missed にする
    this.messages = load(file).map((m) => (m.state === 'sending' ? { ...m, state: 'scheduled' } : m));
  }

  // 起動のあとに一度呼ぶ。時刻を過ぎたものを片付け、次の時刻を待つ
  start(): void {
    this.tick();
  }

  list(): ScheduledMessage[] {
    return this.messages;
  }

  // by: Claude が自分に入れる予約（数と時刻の決まりは、呼ぶ側の sessions-control.ts が確かめる）
  add(sessionId: string, text: string, attachments: string[], at: number, pastes: string[] = [], by?: 'claude'): ScheduledMessage {
    if (!this.accepts(sessionId)) throw new Error(t('main.scheduled.cannotSchedule'));
    if (!text.trim() && attachments.length === 0 && pastes.length === 0) throw new Error(t('main.scheduled.empty'));
    if (!Number.isFinite(at) || at <= this.now()) throw new Error(t('main.scheduled.pastTime'));
    const message: ScheduledMessage = {
      id: randomUUID(),
      sessionId,
      text,
      attachments,
      pastes,
      at,
      createdAt: this.now(),
      state: 'scheduled',
      error: null,
      ...(by ? { by } : {}),
    };
    this.messages = [...this.messages, message];
    this.changed();
    return message;
  }

  // 時刻を変える（送れなかったもの・時刻を過ぎていたものも、もう一度待つ）
  reschedule(id: string, at: number): void {
    const message = this.find(id);
    if (message.state === 'sending') throw new Error(t('main.scheduled.sending'));
    if (!Number.isFinite(at) || at <= this.now()) throw new Error(t('main.scheduled.pastTime'));
    this.update(id, { at, state: 'scheduled', error: null });
  }

  sendNow(id: string): void {
    const message = this.find(id);
    if (message.state === 'sending') return;
    void this.deliver(message);
  }

  // 取り消す。取り消した予約を返す（画面が入力欄に戻す。もう無ければ null）。
  // 手が空くのを待っている間なら、送るのもやめる（打ち込み始めたあとは止められないので、送られる）
  cancel(id: string): ScheduledMessage | null {
    const message = this.messages.find((m) => m.id === id) ?? null;
    if (!message) return null;
    this.sending.get(id)?.abort();
    this.remove(id);
    return message;
  }

  // そのセッションで待っている、Claude が自分に入れた予約（時刻を待っている・送っている途中。送れなかったもの・時刻を過ぎていたものは、もう待っていない）
  claudeWakeups(sessionId: string): ScheduledMessage[] {
    return this.messages.filter((m) => m.sessionId === sessionId && m.by === 'claude' && (m.state === 'scheduled' || m.state === 'sending'));
  }

  // Claude が自分に入れた予約が待っているか。待っている間のターンの終わりは、作業の完了ではない（時刻になると Claude が続きを始める）ので、
  // ふつうの完了の通知を出さない（profile.ts）
  hasClaudeWakeup(sessionId: string): boolean {
    return this.claudeWakeups(sessionId).length > 0;
  }

  // アーカイブした・一覧から消したセッションの予約を取り消す
  dropSession(sessionId: string): void {
    const dropped = this.messages.filter((m) => m.sessionId === sessionId);
    if (dropped.length === 0) return;
    for (const m of dropped) this.sending.get(m.id)?.abort();
    this.messages = this.messages.filter((m) => m.sessionId !== sessionId);
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.sending.values()) controller.abort();
  }

  // 時刻になったものを送り、次の時刻を待つ
  private tick(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    for (const message of this.messages) {
      if (message.state !== 'scheduled' || message.at > now) continue;
      if (now - message.at > SCHEDULE_LATE_MS) {
        this.update(message.id, { state: 'missed' });
        this.onTrouble(this.find(message.id));
      } else {
        void this.deliver(message);
      }
    }
    const next = Math.min(...this.messages.filter((m) => m.state === 'scheduled').map((m) => m.at));
    if (next === Infinity) return;
    this.timer = setTimeout(() => this.tick(), Math.min(Math.max(next - this.now(), 0), MAX_TIMER_MS));
  }

  private async deliver(message: ScheduledMessage): Promise<void> {
    const { id, sessionId } = message;
    if (!this.accepts(sessionId)) {
      this.remove(id);
      return;
    }
    const controller = new AbortController();
    this.sending.set(id, controller);
    this.update(id, { state: 'sending', error: null });
    try {
      // 止まっているセッションは、起動し直してから送る（起動が終わるまでは、submitWhenReady が待つ）。ターミナルモードで止まったものは、
      // 起動すると TUI になって送れないので、起動せずに断る（送れなかったものとして残る）
      if (this.host.stateOf(sessionId) === 'exited') {
        if (this.host.summary(sessionId)?.terminal) throw new Error(t('main.send.terminalMode'));
        await this.host.open(sessionId);
      }
      // 待つ時間の上限は設けない。質問や確認に答えるのを待っている間も、送らずに待つ（ターミナルモードの間は断られ、送れなかったものとして残る）
      // Claude の予約は、人の発言と見分けられるよう、囲みに入れて送る
      const text = message.by === 'claude' ? wakeupText(message.text) : message.text;
      await this.host.submitWhenReady(sessionId, text, Number.POSITIVE_INFINITY, {
        attachments: message.attachments,
        pastes: message.pastes,
        signal: controller.signal,
      });
      this.remove(id);
    } catch (error) {
      // 取り消した・セッションを閉じた（予約はもう外してある）
      if (controller.signal.aborted || !this.messages.some((m) => m.id === id)) return;
      this.update(id, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
      this.onTrouble(this.find(id));
    } finally {
      if (this.sending.get(id) === controller) this.sending.delete(id);
    }
  }

  private accepts(sessionId: string): boolean {
    const state = this.host.stateOf(sessionId);
    return state !== null && state !== 'archived';
  }

  private find(id: string): ScheduledMessage {
    const message = this.messages.find((m) => m.id === id);
    if (!message) throw new Error(t('main.scheduled.notFound'));
    return message;
  }

  private update(id: string, patch: Partial<ScheduledMessage>): void {
    this.messages = this.messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
    this.changed();
  }

  private remove(id: string): void {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.id !== id);
    if (this.messages.length !== before) this.changed();
  }

  // 保存して画面に知らせ、次の時刻を待ち直す。予約はたまにしか変わらないので、そのたびにすぐ書く（アプリを閉じる直前の変更も残す）
  private changed(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, messages: this.messages }, null, 2));
      renameSync(tmp, this.file);
    } catch (error) {
      console.error('予約したメッセージを保存できませんでした', error);
    }
    this.onChanged(this.messages);
    this.rearm();
  }

  // 待っている時刻が変わったかもしれないので、待ち直す
  private rearm(): void {
    if (this.disposed || this.rearmQueued) return;
    this.rearmQueued = true;
    queueMicrotask(() => {
      this.rearmQueued = false;
      this.tick();
    });
  }
}

function load(file: string): ScheduledMessage[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { messages?: unknown };
    // pastes は、前のバージョンで保存した予約には無い。by は Claude の予約だけに付ける（ほかの値は読み捨てる）
    return Array.isArray(data.messages)
      ? data.messages.filter(isMessage).map(({ by, ...m }) => ({ ...m, pastes: stringsOf(m.pastes), error: m.error ?? null, ...(by === 'claude' ? { by } : {}) }))
      : [];
  } catch {
    return [];
  }
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function isMessage(value: unknown): value is ScheduledMessage {
  const m = value as ScheduledMessage;
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof m.id === 'string' &&
    typeof m.sessionId === 'string' &&
    typeof m.text === 'string' &&
    Array.isArray(m.attachments) &&
    m.attachments.every((a) => typeof a === 'string') &&
    typeof m.at === 'number' &&
    typeof m.createdAt === 'number' &&
    ['scheduled', 'sending', 'missed', 'failed'].includes(m.state)
  );
}
