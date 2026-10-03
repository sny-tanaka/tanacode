import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unix ソケットのパスの長さの上限（macOS は 104 バイト）
const MAX_SOCKET_PATH = 100;

// アプリのソケット（pty ホスト・アプリ内ブラウザの中継）の置き場所。ふだんは dir（userData）の <name>.sock。
// パスが長すぎるときは、一時フォルダに dir ごとの名前（tanacode-<short>-<ハッシュ>.sock）で置く
export function socketPathIn(dir: string, name: string, short: string): string {
  const path = join(dir, `${name}.sock`);
  if (Buffer.byteLength(path) <= MAX_SOCKET_PATH) return path;
  return join(tmpdir(), `tanacode-${short}-${createHash('sha1').update(dir).digest('hex').slice(0, 12)}.sock`);
}
