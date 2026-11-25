import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

// ログインしたスマホに、遠隔サーバーが /app/ で配る画面のファイル（Issue #464）。中身はビルドした out/renderer（入口は remote.html）。
// - 置き場所の外は読まない（.. や絶対パス、決めていない拡張子は断る）
// - assets/ のファイルは名前に中身の印が付くので、長くキャッシュさせる（スマホの通信量を増やさない）。入口の HTML はキャッシュさせない

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

export type AppFile = { type: string; body: Buffer; immutable: boolean };

// /app/ の下のパス（/app の後ろ）を、置き場所のファイルに当てる。当たらなければ null
export async function appFile(root: string, path: string): Promise<AppFile | null> {
  let rest: string;
  try {
    rest = decodeURIComponent(path.replace(/^\/app/, ''));
  } catch {
    return null;
  }
  if (rest === '' || rest === '/') rest = '/remote.html';
  const type = TYPES[extname(rest).toLowerCase()];
  if (!type || rest.includes('\0')) return null;
  const file = normalize(join(root, rest));
  // 配るのは、スマホの入口と、その assets だけ（.. をたどったあとのパスで見る。Mac の画面の入口などは出さない）
  const base = normalize(root) + sep;
  if (file !== base + 'remote.html' && !file.startsWith(base + 'assets' + sep)) return null;
  try {
    return { type, body: await readFile(file), immutable: file.startsWith(base + 'assets' + sep) };
  } catch {
    return null;
  }
}
