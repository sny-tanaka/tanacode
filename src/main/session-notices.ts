import type { SessionSummary } from '@shared/ipc';
import type { SessionState } from '@shared/session-tools';

// アプリから Claude への知らせ（子の作業が終わった・チェックリストに返信があった など）を、手の空いたセッションに送る列。
// 作業中なら手が空くまで待つ。続けて届いた知らせは 1 つにまとめる。
// 送り先が止まっている・アーカイブした・使わない設定にしたときは、送らずに捨てる。送り先がターミナルモードなら、捨てるか（親への知らせ・
// Claude からの知らせ。預からない。決めたこと）、TUI の入力欄に貼るだけにする（人がボタンで頼んだもの。Enter は人が押す。設計書 9 節）。
// TUI が確認・質問のメニューを出している間は貼らずに待つ（貼った文字がメニューの選択になるため）

// SessionManager のうち、知らせに使うもの
export type NoticeHost = {
  list(): SessionSummary[];
  stateOf(id: string): SessionState | null;
  submitWhenReady(id: string, text: string, timeoutMs: number): Promise<void>;
  watchState(listener: (id: string) => void): () => void;
  // ターミナルモードの TUI の入力欄に貼る（Enter は送らない）。貼れなければ（メニューを出している間など）false
  pasteIntoTerminal?(id: string, text: string): boolean;
  // 送る前にアプリを終えた知らせ（channel: 列の名前）を読む・残す（送り先の記録に。SessionManager）。無ければ残さない
  savedNotices?(channel: string): { target: string; items: [string, unknown][] }[];
  saveNotices?(channel: string, target: string, items: [string, unknown][]): void;
};

type Deps<T> = {
  host: NoticeHost;
  // 送るか（メニューでオフにしていれば捨てる）
  enabled: () => boolean;
  // たまった知らせ（キー → 中身）から、送る文を作る。null なら送らない（もう読んだものだけだった など）
  compose: (target: string, items: Map<string, T>) => string | null;
  // まとめるまでの待ち（テストでは短くする）
  delayMs?: number;
  // 送り先がターミナルモードのとき、TUI の入力欄に貼る知らせか（人がボタンで頼んだもの）。省くと、どれも捨てる
  pasteInTerminal?: (item: T) => boolean;
  // 手が空いていても、まだ送らずに預かるか（送り先が利用枠で止まって、再開を待っている間など）。次に状態が変わったときと、
  // recheck を呼んだときに見直す
  holds?: (target: string) => boolean;
  // 送り先が止まっている（Claude Code が動いていない）とき、捨てずに預けるか。次に起動して手が空いたら送る（人が画面で頼んだもので、
  // 止まっている間に頼んでも届けたいもの）。省くと捨てる
  keepWhileStopped?: boolean;
  // 列の名前。付けると、預かっている知らせを送り先の記録に残し（host.saveNotices）、アプリを終えても次のアプリが戻して送る。
  // 中身（T）は JSON にできるものにする
  channel?: string;
};

// 知らせを受け取れる状態（ターンの外）
const RECEIVE_STATES = new Set<SessionState>(['idle', 'background']);
// 受け付けられるようになるまで待つ上限
const NOTIFY_TIMEOUT_MS = 10_000;
const NOTIFY_DELAY_MS = 1500;

export class SessionNotices<T> {
  // 送り先の ID → キー → 中身
  private readonly pending = new Map<string, Map<string, T>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly unwatch: () => void;

  constructor(private readonly deps: Deps<T>) {
    // 前のアプリが送る前に終えた知らせを戻す。送るのは、送り先の手が空いたとき（引き継いだ claude が受け付けるようになった・
    // 止まっていたセッションを開き直した）。まだ引き継いでいないうちに送ろうとすると、止まっているとみなして捨ててしまう
    if (deps.channel) {
      for (const { target, items } of deps.host.savedNotices?.(deps.channel) ?? []) this.pending.set(target, new Map(items as [string, T][]));
    }
    // 送り先の手が空いたら、たまっている知らせを送る
    this.unwatch = deps.host.watchState((id) => {
      const state = deps.host.stateOf(id);
      if (state && (RECEIVE_STATES.has(state) || state === 'terminal') && this.pending.has(id)) this.schedule(id);
    });
  }

  dispose(): void {
    this.unwatch();
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }

  // 同じキーの知らせは、新しいもので置き換える
  add(target: string, key: string, item: T): void {
    const queue = this.pending.get(target) ?? new Map<string, T>();
    queue.set(key, item);
    this.pending.set(target, queue);
    this.keep(target);
    this.schedule(target);
  }

  // 預かっている知らせを、送れるか見直す（預かる理由が、送り先の状態でないところで変わったとき。送り先の再開の予約が無くなったなど）
  recheck(): void {
    for (const target of this.pending.keys()) this.schedule(target);
  }

  remove(target: string, key: string): void {
    this.pending.get(target)?.delete(key);
    this.keep(target);
  }

  // 当てはまる知らせをまとめて取り下げる
  removeWhere(target: string, match: (key: string, item: T) => boolean): void {
    const queue = this.pending.get(target);
    if (!queue) return;
    for (const [key, item] of queue) if (match(key, item)) queue.delete(key);
    this.keep(target);
  }

  // 預かっている知らせを、送り先の記録に残す（列の名前があるときだけ）
  private keep(target: string): void {
    if (this.deps.channel) this.deps.host.saveNotices?.(this.deps.channel, target, [...(this.pending.get(target) ?? [])]);
  }

  private schedule(target: string): void {
    clearTimeout(this.timers.get(target));
    this.timers.set(
      target,
      setTimeout(() => {
        this.timers.delete(target);
        void this.deliver(target);
      }, this.deps.delayMs ?? NOTIFY_DELAY_MS),
    );
  }

  private async deliver(target: string): Promise<void> {
    const { host } = this.deps;
    const queue = this.pending.get(target);
    if (!queue || queue.size === 0) return;
    const session = host.list().find((s) => s.id === target);
    // 止まっている送り先に預けるなら、起動して手が空いたとき（watchState）に送る
    if (this.deps.keepWhileStopped && this.deps.enabled() && session && !session.archived && host.stateOf(target) === 'exited') return;
    if (!this.deps.enabled() || !session || session.archived || host.stateOf(target) === 'exited') {
      this.pending.delete(target);
      this.keep(target);
      return;
    }
    if (host.stateOf(target) === 'terminal') {
      const pasteable = new Map([...queue].filter(([, item]) => this.deps.pasteInTerminal?.(item) ?? false));
      const text = pasteable.size > 0 ? this.deps.compose(target, pasteable) : null;
      // 貼れなかったら（メニューを出している間）、貼るものだけ残して、次に状態が変わったとき（watchState）に貼り直す
      if (text && host.pasteIntoTerminal?.(target, text) === false) {
        this.pending.set(target, pasteable);
        this.keep(target);
        return;
      }
      this.pending.delete(target);
      this.keep(target);
      return;
    }
    // 作業中なら、手が空いたときに送る（watchState）。預かるあいだも同じ
    const state = host.stateOf(target);
    if (!state || !RECEIVE_STATES.has(state) || this.deps.holds?.(target)) return;
    this.pending.delete(target);
    this.keep(target);
    const text = this.deps.compose(target, queue);
    if (!text) return;
    await host.submitWhenReady(target, text, NOTIFY_TIMEOUT_MS).catch(() => {});
  }
}
