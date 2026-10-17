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
    this.schedule(target);
  }

  remove(target: string, key: string): void {
    this.pending.get(target)?.delete(key);
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
    if (!this.deps.enabled() || !session || session.archived || host.stateOf(target) === 'exited') {
      this.pending.delete(target);
      return;
    }
    if (host.stateOf(target) === 'terminal') {
      const pasteable = new Map([...queue].filter(([, item]) => this.deps.pasteInTerminal?.(item) ?? false));
      const text = pasteable.size > 0 ? this.deps.compose(target, pasteable) : null;
      // 貼れなかったら（メニューを出している間）、貼るものだけ残して、次に状態が変わったとき（watchState）に貼り直す
      if (text && host.pasteIntoTerminal?.(target, text) === false) {
        this.pending.set(target, pasteable);
        return;
      }
      this.pending.delete(target);
      return;
    }
    // 作業中なら、手が空いたときに送る（watchState）
    const state = host.stateOf(target);
    if (!state || !RECEIVE_STATES.has(state)) return;
    this.pending.delete(target);
    const text = this.deps.compose(target, queue);
    if (!text) return;
    await host.submitWhenReady(target, text, NOTIFY_TIMEOUT_MS).catch(() => {});
  }
}
