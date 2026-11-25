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
