// ビルドした tanacode.app を /Applications に入れる（npm run install-app から使う）。
// 動いているアプリや pty ホストのファイルを上書きすると、macOS が署名の確認でプロセスを止めることがある。
// そこで、新しいアプリを隣に別の名前でコピーしてから、名前の付け替えで入れ替える。
// 古いファイルは消えても、動いているプロセスはそのまま使い続けられる。次に起動したときから新しいアプリになる
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// 入れるアプリ。引数で別の .app も指定できる（例: release/mac-arm64/tanacode.app）
const source = process.argv[2] ?? join('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'tanacode.app');
const target = '/Applications/tanacode.app';
const incoming = '/Applications/.tanacode.app.incoming';
const outgoing = '/Applications/.tanacode.app.outgoing';

if (!existsSync(source)) {
  console.error(`${source} がありません。先に npm run dist でビルドしてください`);
  process.exit(1);
}

// 前回の途中で止まったときの残りを片付ける
for (const dir of [incoming, outgoing]) rmSync(dir, { recursive: true, force: true });

// ditto はシンボリックリンクや拡張属性ごと .app をコピーする
execFileSync('ditto', [source, incoming], { stdio: 'inherit' });
if (existsSync(target)) renameSync(target, outgoing);
renameSync(incoming, target);
rmSync(outgoing, { recursive: true, force: true });

console.log(`${target} に入れました。動いている tanacode は、終了のダイアログで「動かしたまま終了」を選んで起動し直すと、新しい版になります（Claude Code は止まりません）`);
