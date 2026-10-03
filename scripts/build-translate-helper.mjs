// 翻訳の補助プログラム（native/translate/main.swift）を作り、build/native/tanacode-translate に置く。
// Apple Silicon と Intel の両方で動くよう、2 つ作って lipo で 1 つにまとめ、ad-hoc で署名し直す（lipo のあとの署名が無いと、起動を止められることがある）。
// 元のファイルより新しいものがあれば作り直さない。
// macOS でない・swiftc が無い・作れないときは、警告だけ出して進める（翻訳のボタンが出ないだけ）。
// --require を付けたら（配布用のビルド）、失敗にする
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'native/translate/main.swift');
const outDir = join(root, 'build/native');
const output = join(outDir, 'tanacode-translate');
const required = process.argv.includes('--require');
// Translation フレームワークが使えるのは macOS 15 以降（それより前の macOS では、main が起動しない）
const MIN_MACOS = '15.0';
const ARCHS = ['arm64', 'x86_64'];

function skip(reason) {
  if (required) {
    console.error(`翻訳の補助プログラムを作れませんでした: ${reason}`);
    process.exit(1);
  }
  console.warn(`翻訳の補助プログラムを作らずに進めます（翻訳のボタンは出ません）: ${reason}`);
  process.exit(0);
}

if (process.platform !== 'darwin') skip('macOS ではありません');

const newest = Math.max(statSync(source).mtimeMs, statSync(fileURLToPath(import.meta.url)).mtimeMs);
if (existsSync(output) && statSync(output).mtimeMs >= newest) process.exit(0);

// Command Line Tools が無い Mac では、xcrun がインストールのダイアログを出すので、先に xcode-select で確かめる
try {
  execFileSync('xcode-select', ['-p'], { stdio: 'ignore' });
  execFileSync('xcrun', ['--sdk', 'macosx', '--find', 'swiftc'], { stdio: 'ignore' });
} catch {
  skip('swiftc がありません（Xcode Command Line Tools を入れてください: xcode-select --install）');
}

mkdirSync(outDir, { recursive: true });
const parts = ARCHS.map((arch) => join(outDir, `tanacode-translate-${arch}`));
const removeParts = () => parts.forEach((part) => rmSync(part, { force: true }));
try {
  ARCHS.forEach((arch, i) => {
    execFileSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-target', `${arch}-apple-macos${MIN_MACOS}`, '-o', parts[i], source], { stdio: 'inherit' });
  });
  execFileSync('lipo', ['-create', '-output', output, ...parts]);
  execFileSync('codesign', ['--force', '--sign', '-', output]);
  execFileSync('codesign', ['--verify', output]);
} catch (err) {
  // 古いものが残っていると、直したつもりのものが使われるので消す
  removeParts();
  rmSync(output, { force: true });
  skip(err instanceof Error ? err.message : String(err));
}
removeParts();
console.log(`翻訳の補助プログラムを作りました（${execFileSync('lipo', ['-archs', output], { encoding: 'utf8' }).trim()}）`);
