// デモのサイトのツアーが、スマホ（iPhone）でも最後まで流れ、メモリを食いすぎないかを確かめる（npm run demo:check:sp）。
// PC で流すほう（check-demo-tour.mjs。Electron）とは別に、iPhone の Safari と同じ WebKit（Playwright）を iPhone と同じ画面の大きさ・倍率で使う。
// iPhone の Safari は、ページの処理（WebContent のプロセス）がメモリの上限を超えると、そのプロセスを落として白くし、ページを読み込み直す。
// アプリの画面の縮め方によっては、WebKit が端末の解像度（3 倍）のまま描いてメモリが数 GB に膨らむ（Chromium では起きないので、PC で流すほうでは気づけない）。
// そこで、ページの処理のプロセスのメモリの最大（VmHWM）を測り、上限を超えたら失敗にする。プロセスが落ちても失敗にする。
//
// 例: VITE_DEMO_WAIT=0 DEMO_OUT_DIR=demo-check npm run demo:build && npm run demo:check:sp
//     npm run demo:check:sp -- --dir demo-check --chapter review --max-memory 1500
// WebKit が入っていなければ、先に npx playwright install --with-deps webkit で入れる（Linux だけで動く。メモリを /proc から読むため）
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { devices, webkit } from 'playwright';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const dir = resolve(option('dir', 'demo-check'));
const chapter = option('chapter', 'start');
// ツアーが終わらないときに止める時間
const LIMIT_MS = Number(option('limit', 10 * 60_000));
// ページの処理のプロセスのメモリの上限（MB）。いまの作りでは 1.4GB 前後。iframe を transform で縮めていたころは 2.8〜3.6GB（CONTRIBUTING の「デモのサイト」）
const MAX_MEMORY_MB = Number(option('max-memory', 2048));
// 見立てる端末。iPhone 13（390×664・倍率 3）
const DEVICE = 'iPhone 13';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ビルドしたデモのサイトを配る（check-demo-tour.mjs と同じ）
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

// ページの処理のプロセス（Linux の WebKit では WPEWebProcess）ごとの、これまでのメモリの最大（MB）。
// VmHWM は、プロセスが使ったメモリ（RSS）の最大なので、測る間隔の間の一瞬の山も取りこぼさない
function webProcessPeaks() {
  const peaks = new Map();
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!/WPEWebProcess|WebKitWebProcess/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) continue;
      const hwm = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmHWM:\s+(\d+)\s+kB/m);
      if (hwm) peaks.set(pid, Math.round(Number(hwm[1]) / 1024));
    } catch {
      // 測る間に終わったプロセスは飛ばす
    }
  }
  return peaks;
}

if (process.platform !== 'linux') {
  console.error('メモリを /proc から読むため、Linux でだけ動きます');
  process.exit(1);
}
if (!existsSync(join(dir, 'index.html'))) {
  console.error(`${dir} にデモのサイトがありません。先にビルドしてください（VITE_DEMO_WAIT=0 DEMO_OUT_DIR=demo-check npm run demo:build）`);
  process.exit(1);
}

const server = await serve();
const url = `http://127.0.0.1:${server.address().port}/#${chapter}`;
const browser = await webkit.launch();
const page = await (await browser.newContext({ ...devices[DEVICE] })).newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let crashed = false;
page.on('crash', () => (crashed = true));
await page.goto(url);
console.log(`ツアーを ${DEVICE} の画面で流します: ${url}`);

const started = Date.now();
let last = '';
let step = '';
let result = 'timeout';
// ページの処理のメモリの最大（MB）と、そのときの章・説明
let peak = 0;
let peakAt = '';
for (;;) {
  await sleep(250);
  if (crashed) {
    result = 'crashed';
    break;
  }
  const state = await page
    .evaluate(() => ({
      chapter: document.querySelector('.demo-tour-title')?.textContent ?? '',
      status: document.querySelector('.demo-caption-text')?.textContent ?? '',
      callout: document.querySelector('.demo-callout-text')?.textContent ?? '',
    }))
    .catch(() => null);
  // iframe（アプリの画面）の中も、同じページの処理のプロセスで描く
  for (const mb of webProcessPeaks().values()) {
    if (mb <= peak) continue;
    peak = mb;
    peakAt = step || last;
  }
  if (state) {
    const line = `${state.chapter} ${state.callout || state.status}`.trim();
    if (state.callout) step = `${state.chapter} ${state.callout}`.trim();
    if (line && line !== last) {
      last = line;
      console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${peak}MB ${line}`);
    }
    if (state.status.includes('ツアーが終わりました')) result = 'done';
    else if (state.status.includes('ツアーが途中で止まりました')) result = 'failed';
    if (result !== 'timeout') break;
  }
  if (Date.now() - started > LIMIT_MS) break;
}
await browser.close().catch(() => {});
server.close();

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const memory = `ページの処理のメモリの最大: ${peak}MB（上限 ${MAX_MEMORY_MB}MB）。そのときの説明: ${peakAt}`;
let ok = false;
if (result === 'crashed') console.error(`ページの処理が落ちました（${seconds} 秒）。iPhone の Safari では、白くなってページが読み込み直されます。直前の説明: ${step}`);
else if (result === 'failed') console.error(`ツアーが途中で止まりました（${seconds} 秒）。直前の説明: ${step}`);
else if (result === 'timeout') console.error(`ツアーが ${LIMIT_MS / 1000} 秒で終わりませんでした。直前の説明: ${step}`);
else if (peak > MAX_MEMORY_MB) console.error(`ツアーは流れましたが、メモリを食いすぎています（${seconds} 秒）。iPhone の Safari では、ページが落ちて読み込み直されるおそれがあります`);
else {
  ok = true;
  console.log(`ツアーが最後まで流れました（${seconds} 秒）`);
}
(ok ? console.log : console.error)(memory);
// 同じエラーは、まとめて 1 行にする（WebKit では、作り物の環境で許されない操作のエラーが何十回も出るため）
const counts = new Map();
for (const message of errors) counts.set(message, (counts.get(message) ?? 0) + 1);
for (const [message, n] of counts) console.error(`コンソールのエラー${n > 1 ? `（${n} 回）` : ''}: ${message}`);
process.exit(ok ? 0 : 1);
