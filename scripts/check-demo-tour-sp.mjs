// デモのサイトのツアーが、スマホ（iPhone）でも最後まで流れ、メモリを食いすぎないかを確かめる（npm run demo:check:sp）。
// PC で流すほう（check-demo-tour.mjs。Electron）とは別に、iPhone の Safari と同じ WebKit（Playwright）を iPhone と同じ画面の大きさ・倍率で使う。
// iPhone の Safari は、ページの処理（WebContent のプロセス）がメモリの上限を超えると、そのプロセスを落として白くし、ページを読み込み直す。
// アプリの画面の縮め方によっては、WebKit が端末の解像度（3 倍）のまま描いてメモリが数 GB に膨らむ（Chromium では起きないので、PC で流すほうでは気づけない）。
// そこで、ページの処理のプロセスのメモリの最大（VmHWM）を測り、上限を超えたら失敗にする。プロセスが落ちても失敗にする。
// メモリは、ページの様子を読む（page.evaluate）のとは別の時計で測る。ページの処理が JavaScript を回し続けて止まると evaluate が返らず、
// その間にメモリが膨らんで落ちても、evaluate のあとで測っていると膨らむ前の値しか残らないため。
// ページの処理が応答しないときは、その間のメモリと一緒に知らせる。説明が長く変わらないときは、10 分待たずに失敗にする
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
// 説明がこの時間変わらなければ、止まったとみなす（待ち時間 0 のビルドでは、ひとつの説明は長くても数秒）
const STALL_MS = Number(option('stall', 120_000));
// ページの処理がこの時間応答しなければ、応答しないと知らせる
const UNRESPONSIVE_MS = 3000;
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

// このスクリプトから起こしたプロセスの番号（手元で並べて流しても、ほかのブラウザのメモリを数えない）
function ownProcesses() {
  const parents = new Map();
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      // stat の 4 つめが親の番号（2 つめのコマンド名は括弧で囲まれ、空白を含むことがある）
      parents.set(pid, readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
    } catch {
      // 調べる間に終わったプロセスは飛ばす
    }
  }
  const own = new Set([String(process.pid)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, parent] of parents) {
      if (own.has(pid) || !own.has(parent)) continue;
      own.add(pid);
      grew = true;
    }
  }
  return own;
}

// ページの処理のプロセス（Linux の WebKit では WPEWebProcess）ごとの、これまでのメモリの最大（hwm）と、いまのメモリ（rss）（MB）。
// VmHWM は、プロセスが使ったメモリ（RSS）の最大なので、測る間隔の間の一瞬の山も取りこぼさない
function webProcesses() {
  const out = [];
  for (const pid of ownProcesses()) {
    try {
      if (!/WPEWebProcess|WebKitWebProcess/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) continue;
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const mb = (key) => Math.round(Number(status.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'))?.[1] ?? 0) / 1024);
      out.push({ pid, hwm: mb('VmHWM'), rss: mb('VmRSS') });
    } catch {
      // 測る間に終わったプロセスは飛ばす
    }
  }
  return out;
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
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);
let last = '';
let step = '';
let lastChange = Date.now();
let result = 'timeout';
// ページの処理のメモリの最大（MB）と、そのときの章・説明。いまのメモリ（MB）
let peak = 0;
let peakAt = '';
let rss = 0;
const measure = () => {
  rss = 0;
  // iframe（アプリの画面）の中も、同じページの処理のプロセスで描く
  for (const p of webProcesses()) {
    rss = Math.max(rss, p.rss);
    if (p.hwm <= peak) continue;
    peak = p.hwm;
    peakAt = step || last;
  }
};
const meter = setInterval(measure, 250);
// 読んでいる途中の様子（page.evaluate）と、読み始めた時刻。ページの処理が応答しない間は、前の読みが返るのを待ち続ける
let reading = null;
// 応答しなくなった時刻と、最後に応答したときのメモリ（MB）
let unresponsive = null;
let responsiveRss = 0;
let unresponsiveNoted = 0;
const PENDING = Symbol('pending');
for (;;) {
  await sleep(250);
  if (crashed) {
    result = 'crashed';
    break;
  }
  reading ??= {
    since: Date.now(),
    promise: page
      .evaluate(() => ({
        chapter: document.querySelector('.demo-tour-title')?.textContent ?? '',
        status: document.querySelector('.demo-caption-text')?.textContent ?? '',
        callout: document.querySelector('.demo-callout-text')?.textContent ?? '',
      }))
      .catch(() => null),
  };
  const state = await Promise.race([reading.promise, sleep(1000).then(() => PENDING)]);
  if (state === PENDING) {
    // 応答しない間は、5 秒ごとにメモリを出す（JavaScript が回り続けてメモリを食っていくのが分かる）
    const waited = Date.now() - reading.since;
    if (waited >= UNRESPONSIVE_MS) {
      unresponsive ??= { since: reading.since, rss: responsiveRss };
      if (Date.now() - unresponsiveNoted >= 5000) {
        unresponsiveNoted = Date.now();
        console.log(`${elapsed()}s ${peak}MB（いま ${rss}MB） ページの処理が ${(waited / 1000).toFixed(0)} 秒応答しません。直前の説明: ${step}`);
      }
    }
  } else {
    reading = null;
    unresponsive = null;
    responsiveRss = rss;
  }
  if (state && state !== PENDING) {
    const line = `${state.chapter} ${state.callout || state.status}`.trim();
    if (state.callout) step = `${state.chapter} ${state.callout}`.trim();
    if (line && line !== last) {
      last = line;
      lastChange = Date.now();
      console.log(`${elapsed()}s ${peak}MB ${line}`);
    }
    if (state.status.includes('ツアーが終わりました')) result = 'done';
    else if (state.status.includes('ツアーが途中で止まりました')) result = 'failed';
    if (result !== 'timeout') break;
  }
  if (Date.now() - lastChange > STALL_MS) {
    result = 'stalled';
    break;
  }
  if (Date.now() - started > LIMIT_MS) break;
}
clearInterval(meter);
measure();
const seconds = elapsed();
const hungSeconds = unresponsive ? ((Date.now() - unresponsive.since) / 1000).toFixed(0) : '';
await Promise.race([browser.close().catch(() => {}), sleep(15_000)]);
server.close();

const memory = `ページの処理のメモリの最大: ${peak}MB（上限 ${MAX_MEMORY_MB}MB）。そのときの説明: ${peakAt}`;
// 応答しないまま終わったときは、その間の長さとメモリを添える
const hung = unresponsive
  ? `その前の ${hungSeconds} 秒、ページの処理は応答していませんでした（メモリ ${unresponsive.rss}MB → 最大 ${peak}MB）。`
  : '';
let ok = false;
if (result === 'crashed') console.error(`ページの処理が落ちました（${seconds} 秒）。iPhone の Safari では、白くなってページが読み込み直されます。${hung}直前の説明: ${step}`);
else if (result === 'failed') console.error(`ツアーが途中で止まりました（${seconds} 秒）。直前の説明: ${step}`);
else if (result === 'stalled') console.error(`ツアーが ${STALL_MS / 1000} 秒進みません（${seconds} 秒）。${hung}直前の説明: ${step}`);
else if (result === 'timeout') console.error(`ツアーが ${LIMIT_MS / 1000} 秒で終わりませんでした。${hung}直前の説明: ${step}`);
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
