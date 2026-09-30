// README のデモ動画を録る（npm run demo:record -- <ストーリー名>）。
// Storybook（npm run storybook）の「デモ」のストーリーを Electron の画面の外で描き、描き直しのたびにコマを保存して、
// 台本が終わったら（window.__demoDone）ffmpeg で MP4 にする。コマは時刻付きで保存するので、動画は実時間どおりの長さになる。
//
// 例: npm run demo:record -- 基本
//     npm run demo:record -- 基本 --width 1440 --height 900 --scale 1.5
import { app, BrowserWindow } from 'electron';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// このスクリプトより後ろの引数（electron の実行ファイルのパスなどは除く）
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('record-demo.mjs')) + 1);
const story = args[0] && !args[0].startsWith('--') ? args[0] : '基本';
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
// 画面を広く使う動画は、描く幅を広げて倍率を下げ、出来上がりの大きさ（2160×1350）をほかとそろえる
const SIZES = {
  ワークフロー: { width: 2000, height: 1250, scale: 1.08 },
};
const size = SIZES[story] ?? { width: 1440, height: 900, scale: 1.5 };
const width = Number(option('width', size.width));
const height = Number(option('height', size.height));
const scale = Number(option('scale', size.scale));
const fps = Number(option('fps', 30));
const base = option('storybook', 'http://localhost:6006');
const outDir = resolve(option('out', 'demo-videos'));
const frames = join(outDir, `${story}.frames`);
const video = join(outDir, `${story}.mp4`);
// 台本が終わらないときに止める時間
const LIMIT_MS = 5 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    await fetch(`${base}/index.json`);
  } catch {
    console.error(`Storybook（${base}）に繋がりません。先に npm run storybook を起動してください`);
    app.exit(1);
    return;
  }
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });

  const win = new BrowserWindow({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    show: false,
    // 最初に描かれるまでの地の色（白く光らないよう、アプリの地の色にする）
    backgroundColor: '#111111',
    // 保存領域は毎回まっさらにする（persist: を付けないパーティションはメモリの中だけ）
    webPreferences: { offscreen: true, partition: `demo-${Date.now()}` },
  });
  win.webContents.setFrameRate(fps);
  const shots = [];
  let recording = false;
  let last = 0;
  win.webContents.on('paint', (_event, _dirty, image) => {
    const now = Date.now();
    if (!recording || now - last < 1000 / fps) return;
    last = now;
    const name = `f${String(shots.length).padStart(5, '0')}.jpg`;
    writeFileSync(join(frames, name), image.toJPEG(92));
    shots.push({ name, at: now });
  });

  const url = `${base}/iframe.html?viewMode=story&id=${encodeURIComponent(`デモ--${story}`)}`;
  await win.loadURL(url);
  win.webContents.setZoomFactor(scale);
  // Storybook は、ストーリーを組み立てる間に白い読み込み中の画面を出す。アプリの画面が描かれ、字の形が揃ってから録り始める
  for (let waited = 0; waited < 20_000; waited += 100) {
    const ready = await win.webContents
      .executeJavaScript("!!document.querySelector('.app .sidebar') && document.fonts.status === 'loaded'")
      .catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  await sleep(300);
  recording = true;
  const started = Date.now();
  console.log(`録画を始めました: ${url}`);
  for (;;) {
    await sleep(500);
    const done = await win.webContents.executeJavaScript('window.__demoDone === true').catch(() => false);
    if (done || Date.now() - started > LIMIT_MS) break;
  }
  // 最後のコマを少し見せる
  await sleep(600);
  win.webContents.invalidate();
  await sleep(200);
  recording = false;
  const ended = Date.now();

  // 各コマを、次のコマまでの長さで並べる（ffmpeg の concat）
  const list = shots
    .map((shot, i) => {
      const next = shots[i + 1]?.at ?? ended;
      return `file '${shot.name}'\nduration ${((next - shot.at) / 1000).toFixed(3)}`;
    })
    .join('\n');
  writeFileSync(join(frames, 'frames.txt'), `${list}\nfile '${shots[shots.length - 1].name}'\n`);
  console.log(`コマ ${shots.length} 枚（${((ended - started) / 1000).toFixed(1)} 秒）: ${frames}`);

  const encode = ['-y', '-f', 'concat', '-safe', '0', '-i', join(frames, 'frames.txt'), '-vf', `fps=${fps},format=yuv420p`, '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', video];
  if (hasFfmpeg()) {
    execFileSync('ffmpeg', encode, { stdio: 'inherit' });
    console.log(`動画を作りました: ${video}`);
  } else {
    console.log('ffmpeg が見つからないので、コマだけ残しました。ffmpeg を入れてから、次で動画にできます:');
    console.log(`ffmpeg ${encode.map((a) => (/[\s']/.test(a) ? `"${a}"` : a)).join(' ')}`);
  }
  app.quit();
});
