import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import license from 'rollup-plugin-license';
import { defineConfig } from 'vite';
import { licenseOf, thirdPartyNotices } from './scripts/third-party-notices';

// デモのサイト（GitHub Pages で公開する、ブラウザで動くデモ）。npm run demo:dev で開き、npm run demo:build で demo-site/ に書き出す。
// 画面はアプリと同じ部品で、window.tanacode を作り物（src/renderer/src/demo/backend.ts）に差し替えて動かす。
// 親のページ（index.html）が、アプリの画面（app.html）を iframe で決まった大きさのまま描き、縮小して画面に収める

const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
const outDir = resolve('demo-site');

export default defineConfig({
  root: resolve('src/renderer/src/demo/site'),
  // GitHub Pages では /tanacode/ の下に置かれるので、どこに置いても読めるよう相対パスにする
  base: './',
  publicDir: false,
  resolve: { alias: { '@shared': resolve('src/shared') } },
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 5180 },
  plugins: [
    react(),
    // 公開するページに入れる依存のライセンス表示を、アプリと同じ決まりで書き出す
    license({
      thirdParty: {
        includePrivate: false,
        allow: {
          test: (dependency) => {
            const kind = licenseOf(dependency.license, dependency.licenseText);
            return !!kind && !/GPL/i.test(kind);
          },
          failOnUnlicensed: true,
          failOnViolation: true,
        },
        output: { file: resolve(outDir, 'THIRD_PARTY_NOTICES.txt'), template: thirdPartyNotices },
      },
    }),
  ],
  // アプリの部品をまるごと入れるので、ひとつめの塊は 5MB ほどになる（大きさの警告は出さない）
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
    // 親のページ（上の帯・機能一覧）と、iframe の中のアプリの画面
    rollupOptions: { input: { index: resolve('src/renderer/src/demo/site/index.html'), app: resolve('src/renderer/src/demo/site/app.html') } },
  },
});
