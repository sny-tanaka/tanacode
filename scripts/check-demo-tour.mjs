// デモのサイトのツアーが、最初から最後まで止まらずに流れるかを確かめる（npm run demo:check）。
// ビルドしたデモのサイト（既定は demo-check/）をこのスクリプトの中の小さなサーバーで配り、Electron の画面の外で #start から開いて、
// 上の帯に「ツアーが終わりました」が出たら成功、「ツアーが途中で止まりました」が出たか時間切れなら失敗にする。
// 待ち時間を 0 にしてビルドしたもの（VITE_DEMO_WAIT=0）を使うと、数十秒で流れ終わる（CONTRIBUTING の「デモのサイト」）。
//
// 例: VITE_DEMO_WAIT=0 DEMO_OUT_DIR=demo-check npm run demo:build && npm run demo:check
//     npm run demo:check -- --dir demo-check --chapter review
import { app, BrowserWindow } from 'electron';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

// このスクリプトより後ろの引数（electron の実行ファイルのパスなどは除く）
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('check-demo-tour.mjs')) + 1);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const dir = resolve(option('dir', 'demo-check'));
const chapter = option('chapter', 'start');
// ツアーが終わらないときに止める時間
const LIMIT_MS = Number(option('limit', 10 * 60_000));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ビルドしたデモのサイトを配る（ES モジュールは file:// では読めないため）
function serve() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)).replace(/^([/\\])+/, '');
    const file = join(dir, path || 'index.html');
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// プロキシは通さない（開くのは自分で立てたサーバーだけ）。CI の Linux ではサンドボックスを使えないので、npm run demo:check は --no-sandbox で起動する
app.commandLine.appendSwitch('no-proxy-server');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  if (!existsSync(join(dir, 'index.html'))) {
    console.error(`${dir} にデモのサイトがありません。先にビルドしてください（VITE_DEMO_WAIT=0 DEMO_OUT_DIR=demo-check npm run demo:build）`);
    app.exit(1);
    return;
  }
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/#${chapter}`;
  const win = new BrowserWindow({ width: 1920, height: 1080, show: false, webPreferences: { offscreen: true } });
  // iframe の中（アプリの画面）のエラーも拾う
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message);
  });
  await win.loadURL(url);
  console.log(`ツアーを流します: ${url}`);
  const started = Date.now();
  let last = '';
  // 最後に出た説明（止まったときに、どこまで進んだかを出す）
  let step = '';
  let result = 'timeout';
  for (;;) {
    await sleep(250);
    // いまの章と、帯の文言・説明の吹き出し
    const state = await win.webContents
      .executeJavaScript(
        "JSON.stringify({ chapter: document.querySelector('.demo-tour-title')?.textContent ?? '', status: document.querySelector('.demo-caption-text')?.textContent ?? '', callout: document.querySelector('.demo-callout-text')?.textContent ?? '' })",
      )
      .then(JSON.parse)
      .catch(() => null);
    if (state) {
      const line = `${state.chapter} ${state.callout || state.status}`.trim();
      if (state.callout) step = `${state.chapter} ${state.callout}`.trim();
      if (line && line !== last) {
        last = line;
        console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${line}`);
      }
      if (state.status.includes('ツアーが終わりました')) result = 'done';
      else if (state.status.includes('ツアーが途中で止まりました')) result = 'failed';
      if (result !== 'timeout') break;
    }
    if (Date.now() - started > LIMIT_MS) break;
  }
  server.close();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result === 'done') console.log(`ツアーが最後まで流れました（${seconds} 秒）`);
  else console.error(result === 'failed' ? `ツアーが途中で止まりました（${seconds} 秒）。直前の説明: ${step}` : `ツアーが ${LIMIT_MS / 1000} 秒で終わりませんでした。直前の説明: ${step}`);
  for (const message of errors) console.error(`コンソールのエラー: ${message}`);
  app.exit(result === 'done' ? 0 : 1);
});
