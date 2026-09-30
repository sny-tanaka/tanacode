// アプリのアイコン（build/icon.png と build/icon.icns）を build/icon-source.png から作る。
// 元画像は角丸の四角の周りが黒いので、その外側を透明にし、macOS の標準の大きさ（1024 の中に 824 の角丸）に合わせる。
// 画像の読み書きに Electron の nativeImage を使うので `electron scripts/make-icon.mjs` で動かす
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { app, nativeImage } from 'electron';

const SOURCE = 'build/icon-source.png';
// 元画像の中の角丸の四角（測った値）
const SOURCE_BOX = { x: 100, y: 98, width: 1054, height: 1054 };
const SOURCE_RADIUS = 266;
const SIZE = 1024;
const BOX = 824;
const MARGIN = (SIZE - BOX) / 2;
// 縁に黒が残らないよう少し内側で切る
const INSET = 3;

function makeIcon() {
  const scale = BOX / SOURCE_BOX.width;
  const art = nativeImage.createFromPath(SOURCE).crop(SOURCE_BOX).resize({ width: BOX, height: BOX, quality: 'best' });
  const src = art.toBitmap();
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const radius = SOURCE_RADIUS * scale - INSET;
  const lo = INSET + radius;
  const hi = BOX - INSET - radius;
  for (let y = 0; y < BOX; y++) {
    for (let x = 0; x < BOX; x++) {
      // 角丸の縁からの距離で、縁をなめらかにする
      const dx = Math.max(lo - (x + 0.5), x + 0.5 - hi, 0);
      const dy = Math.max(lo - (y + 0.5), y + 0.5 - hi, 0);
      const edge = dx || dy ? radius - Math.hypot(dx, dy) : Math.min(x + 0.5 - INSET, BOX - INSET - (x + 0.5), y + 0.5 - INSET, BOX - INSET - (y + 0.5));
      const alpha = Math.max(0, Math.min(1, edge + 0.5));
      if (!alpha) continue;
      const i = (y * BOX + x) * 4;
      const o = ((y + MARGIN) * SIZE + x + MARGIN) * 4;
      // nativeImage のビットマップは BGRA（アルファ乗算済み）
      out[o] = src[i] * alpha;
      out[o + 1] = src[i + 1] * alpha;
      out[o + 2] = src[i + 2] * alpha;
      out[o + 3] = 255 * alpha;
    }
  }
  const icon = nativeImage.createFromBitmap(out, { width: SIZE, height: SIZE });
  writeFileSync('build/icon.png', icon.toPNG());

  const set = 'build/icon.iconset';
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [name, px] of [[`icon_${s}x${s}.png`, s], [`icon_${s}x${s}@2x.png`, s * 2]]) {
      writeFileSync(`${set}/${name}`, icon.resize({ width: px, height: px, quality: 'best' }).toPNG());
    }
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', 'build/icon.icns']);
  rmSync(set, { recursive: true, force: true });
  console.log('build/icon.png, build/icon.icns');
}

app.whenReady().then(() => {
  try {
    makeIcon();
  } finally {
    app.quit();
  }
});
