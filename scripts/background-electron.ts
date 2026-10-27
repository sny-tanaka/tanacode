import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

// 裏で起動する（TANACODE_BACKGROUND=1）ときの Electron。開発用の Electron.app を写し、Info.plist に LSUIElement を足したもの（macOS だけ）。
// 写さずに起動すると、macOS は、JavaScript が動く前の 0.1 秒ほど、アプリを Dock に出る種類（regular）として扱う
// （src/main/index.ts の app.dock.hide() はそのあと。実測で 10 回のうち 10 回）。LSUIElement があれば、はじめから Dock に出ない種類（accessory）で起動する。
// 写すのは、APFS のクローン（cp -c）なので、ほとんど場所を取らない。node_modules の Electron の Info.plist は書き換えない（ふつうの起動の動きを変えないため）。
// 使う側: test/e2e/app.ts（E2E）と electron.vite.config.ts（npm run dev・npm start。electron-vite の ELECTRON_EXEC_PATH）

// 写しの実行ファイルのパス（root はリポジトリのフォルダ）。macOS でなければ null。写しが無いか、Electron のバージョンが変わっていれば作り直す
export function backgroundElectron(root: string): string | null {
  if (process.platform !== 'darwin') return null;
  const electron = createRequire(join(root, 'package.json'))('electron') as string;
  // …/Electron.app/Contents/MacOS/Electron → …/Electron.app
  const source = resolve(dirname(electron), '..', '..');
  const version = readFileSync(join(source, '..', 'version'), 'utf8').trim();
  const dir = join(root, 'node_modules', '.cache', 'tanacode-background-electron');
  const bundle = join(dir, 'Electron.app');
  const executable = join(bundle, 'Contents', 'MacOS', 'Electron');
  const stamp = join(dir, 'version');
  if (existsSync(executable) && existsSync(stamp) && readFileSync(stamp, 'utf8') === version) return executable;
  // 別のフォルダに作ってから入れ替える（作る途中のものを、ほかの起動が使わないように）
  const work = join(dir, `work-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const copy = join(work, 'Electron.app');
  try {
    execFileSync('cp', ['-c', '-R', source, copy], { stdio: 'ignore' });
  } catch {
    // APFS でない（クローンできない）ときは、ふつうに写す
    rmSync(copy, { recursive: true, force: true });
    execFileSync('cp', ['-R', source, copy], { stdio: 'ignore' });
  }
  execFileSync('plutil', ['-replace', 'LSUIElement', '-bool', 'YES', join(copy, 'Contents', 'Info.plist')]);
  rmSync(bundle, { recursive: true, force: true });
  renameSync(copy, bundle);
  rmSync(work, { recursive: true, force: true });
  writeFileSync(stamp, version);
  return executable;
}
