// README の紹介画像（design/screenshot.png）を撮る（npm run screenshot）。
// Storybook（npm run storybook）の「紹介画像」のストーリーを Electron の画面の外で描き、場面ができたら（window.__showcaseReady）PNG に保存する。
// 1440×900 の画面を 1.5 倍の解像度（2160×1350）で撮る。
//
// 例: npm run screenshot
//     npm run screenshot -- --out design/screenshot.png --scale 1.5
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// このスクリプトより後ろの引数（electron の実行ファイルのパスなどは除く）
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('capture-screenshot.mjs')) + 1);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const width = Number(option('width', 1440));
const height = Number(option('height', 900));
const scale = Number(option('scale', 1.5));
const base = option('storybook', 'http://localhost:6006');
const out = resolve(option('out', 'design/screenshot.png'));
// 場面ができないときに止める時間
const LIMIT_MS = 2 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    await fetch(`${base}/index.json`);
  } catch {
    console.error(`Storybook（${base}）に繋がりません。先に npm run storybook を起動してください`);
    app.exit(1);
    return;
  }
  const win = new BrowserWindow({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    show: false,
    // 最初に描かれるまでの地の色（白く光らないよう、アプリの地の色にする）
    backgroundColor: '#111111',
    // 保存領域は毎回まっさらにする（persist: を付けないパーティションはメモリの中だけ）
    webPreferences: { offscreen: true, partition: `screenshot-${Date.now()}` },
  });
  const url = `${base}/iframe.html?viewMode=story&id=${encodeURIComponent('紹介画像--紹介画像')}`;
  await win.loadURL(url);
  // 拡大して描き、アプリの画面としては 1440×900 にする
  win.webContents.setZoomFactor(scale);
  const started = Date.now();
  for (;;) {
    const ready = await win.webContents
      .executeJavaScript("window.__showcaseReady === true && document.fonts.status === 'loaded'")
      .catch(() => false);
    if (ready) break;
    if (Date.now() - started > LIMIT_MS) {
      console.error('紹介画像の場面ができませんでした。Storybook の「紹介画像」を開いて、コンソールの demo failed を確かめてください');
      app.exit(1);
      return;
    }
    await sleep(200);
  }
  win.webContents.invalidate();
  await sleep(300);
  const image = await win.webContents.capturePage();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, image.toPNG());
  const size = image.getSize();
  console.log(`紹介画像を保存しました（${size.width}×${size.height}）: ${out}`);
  app.quit();
});
