// Electron の本体を落とす（npm install・npm ci のあとの postinstall）。
// Electron 45 から、npm install のときには本体を落とさず、初めて require('electron') したときに落とすようになった。
// electron-vite（npm run dev・npm start）は node_modules/electron/path.txt を直に読むので、本体が無いと「Electron uninstall」で止まる（#449）。
// そこで、Electron 44 までと同じく、入れたときに落としておく（もう同じバージョンの本体があれば、install.js は何もしない）。
// ELECTRON_SKIP_BINARY_DOWNLOAD があれば落とさない（CI で本体の要らないジョブ。.github/actions/npm-ci など）。
// 本体が要るところで落ちていなくても、require('electron') が落とすので困らない
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.log('ELECTRON_SKIP_BINARY_DOWNLOAD があるので、Electron の本体は落としません');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve('electron/install.js')], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error('Electron の本体を落とせませんでした。node node_modules/electron/install.js で落とし直せます');
  process.exit(result.status ?? 1);
}
