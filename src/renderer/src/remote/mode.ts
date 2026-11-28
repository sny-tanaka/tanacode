// スマホの画面（遠隔の接続）で動いているか（Issue #464）。スマホの入口（remote/main.tsx）が、描く前に立てる。
// スマホでは、開いていないセッションのチャットの知らせが届かないので、開いたときに読み直す（chatState.ts）
let remote = false;

export function setRemoteMode(on: boolean): void {
  remote = on;
}

export function isRemoteMode(): boolean {
  return remote;
}

// つなぎ直して画面を読み込み直す前に出す知らせ（チャットの入力欄が、打ちかけの文を控える）
export const BEFORE_RELOAD = 'tanacode:remote-before-reload';
const DRAFTS_KEY = 'tanacode.remote.drafts';

export type Draft = { text: string; attachments: string[]; pastes: string[] };

// 読み込み直す前に、セッションごとの下書きを控える（同じタブの間だけ残す sessionStorage）
export function saveDrafts(drafts: Record<string, Draft>): void {
  try {
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // 控えられなくても、読み込み直しは止めない
  }
}

// 控えた下書きを 1 回だけ取り出す（無ければ空）
export function takeDrafts(): Record<string, Draft> {
  try {
    const text = sessionStorage.getItem(DRAFTS_KEY);
    sessionStorage.removeItem(DRAFTS_KEY);
    const value = text ? (JSON.parse(text) as unknown) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Draft>) : {};
  } catch {
    return {};
  }
}

// スマホで見ているセッション。画面を読み込み直したとき（つなぎ直したとき・iOS が裏に回した画面を閉じて開き直したとき）に、
// 一覧の先頭ではなく、見ていたセッションに戻すために、手元に控える（localStorage。画面を閉じても残す）
const SELECTED_KEY = 'tanacode.remote.selected';

export function rememberSelected(sessionId: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, sessionId);
  } catch {
    // 控えられなくても、選ぶのは止めない
  }
}

export function rememberedSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

// Mac とつながっているか（スマホの画面の上の帯に出す）。運び役が変わるたびに知らせる
let connected = true;
const connectionListeners = new Set<(on: boolean) => void>();

export function setRemoteConnected(on: boolean): void {
  connected = on;
  for (const listener of connectionListeners) listener(on);
}

export function remoteConnected(): boolean {
  return connected;
}

export function onRemoteConnected(listener: (on: boolean) => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

// スマホが受け取った量（バイト。Issue #464 の通信量を見えるように）。session: この画面を開いてから / today: 今日の分（日ごとに手元に控える）。
// 数えるのは、Mac から届いた伝文の文字の数（ほとんどが ASCII なのでバイトとみなす）
const TRAFFIC_KEY = 'tanacode.remote.traffic';
let sessionBytes = 0;

const todayKey = (now: Date) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

function readToday(now: Date): number {
  try {
    const saved = JSON.parse(localStorage.getItem(TRAFFIC_KEY) ?? 'null') as { day?: unknown; bytes?: unknown } | null;
    return saved && saved.day === todayKey(now) && typeof saved.bytes === 'number' ? saved.bytes : 0;
  } catch {
    return 0;
  }
}

// 届くたびに書くと、絵やチャットの途中の文が続くときに同期の書き込みが重なるので、手元で数えて 1 秒に 1 回まとめて書く
const TRAFFIC_SAVE_MS = 1000;
let unsaved = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveTraffic(now = new Date()): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const bytes = unsaved;
  unsaved = 0;
  if (bytes === 0) return;
  try {
    localStorage.setItem(TRAFFIC_KEY, JSON.stringify({ day: todayKey(now), bytes: readToday(now) + bytes }));
  } catch {
    // 控えられなくても、数えるのは続ける
  }
}

export function addTraffic(bytes: number): void {
  sessionBytes += bytes;
  unsaved += bytes;
  saveTimer ??= setTimeout(() => saveTraffic(), TRAFFIC_SAVE_MS);
}

export function traffic(now = new Date()): { session: number; today: number } {
  return { session: sessionBytes, today: readToday(now) + unsaved };
}
