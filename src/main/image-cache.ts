// 会話ログに埋め込まれた画像（ユーザーが添付したもの・ツールの結果のスクリーンショットなど）。
// チャットのイベントには鍵だけを載せ、画面が表示するときにここから取る（履歴の読み込みで大量の画像を送らないため）。
// 古いものから捨てる（捨てたあとは、会話ログを読み直すまで表示できない）
const MAX_BYTES = 200 * 1024 * 1024;

const images = new Map<string, string>();
let total = 0;

export function rememberImage(key: string, dataUrl: string): void {
  const before = images.get(key);
  if (before !== undefined) {
    images.delete(key);
    total -= before.length;
  }
  images.set(key, dataUrl);
  total += dataUrl.length;
  for (const [oldKey, oldUrl] of images) {
    if (total <= MAX_BYTES) break;
    images.delete(oldKey);
    total -= oldUrl.length;
  }
}

export function imageOf(key: string): string | null {
  return images.get(key) ?? null;
}
