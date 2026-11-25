// スマホの画面（遠隔の接続）で動いているか（Issue #464）。スマホの入口（remote/main.tsx）が、描く前に立てる。
// スマホでは、開いていないセッションのチャットの知らせが届かないので、開いたときに読み直す（chatState.ts）
let remote = false;

export function setRemoteMode(on: boolean): void {
  remote = on;
}

export function isRemoteMode(): boolean {
  return remote;
}
