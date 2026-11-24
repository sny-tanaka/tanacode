// Electron で確かめること（Issue #464 の先に確かめること 1・10）。tanacode 本体には入れない。
//   utility:    utilityProcess の中で HTTP・WebSocket を待ち受け、WebAuthn のライブラリが動くか
//   screencast: webview の中身を CDP の Page.startScreencast で受け、画面ロック・ディスプレイのスリープ・
//               最小化の間も絵が届くか（5 秒ごとの枚数と大きさを記録する）
// 記録は tools/remote-probe/data/electron-<mode>.jsonl
const { app, BrowserWindow, powerMonitor, utilityProcess } = require('electron');
const { appendFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const mode = process.argv.includes('screencast') ? 'screencast' : 'utility';
const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 240);
const hideAfter = Number(process.argv.find((a) => a.startsWith('--hide-after='))?.slice(13) ?? 0);
const minimizeAfter = Number(process.argv.find((a) => a.startsWith('--minimize-after='))?.slice(17) ?? 0);
// --no-throttle: 隠れた窓で描くのを止める仕組みを外す（どれが効くかを試す）
const noThrottle = process.argv.includes('--no-throttle');
if (noThrottle) {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}
const dataDir = path.join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

function log(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(line);
  appendFileSync(path.join(dataDir, `electron-${mode}.jsonl`), `${line}\n`);
}

async function runUtility() {
  const child = utilityProcess.fork(path.join(__dirname, 'utility.cjs'), [], { serviceName: 'tanacode-remote-probe', stdio: 'inherit' });
  const timer = setTimeout(() => {
    log({ ok: false, reason: '20 秒たっても utilityProcess から返事が無い' });
    child.kill();
    app.quit();
  }, 20000);
  child.on('message', async (message) => {
    if (message.echo) return;
    if (message.error) {
      log({ ok: false, step: 'utility', error: message.error });
      clearTimeout(timer);
      child.kill();
      return app.quit();
    }
    const result = { webauthn: message.webauthn, port: message.port };
    try {
      const res = await fetch(`http://127.0.0.1:${message.port}/`);
      result.http = { status: res.status, body: await res.text() };
      result.websocket = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${message.port}/ws`);
        ws.onopen = () => ws.send('ping');
        ws.onmessage = (event) => {
          ws.close();
          resolve({ echo: String(event.data) });
        };
        ws.onerror = () => reject(new Error('WebSocket のエラー'));
      });
      // main と utilityProcess の間の伝文（設計では、形を検査した伝文だけを main に渡す）
      result.parentPort = await new Promise((resolve) => {
        child.once('message', (reply) => resolve(reply));
        child.postMessage({ echo: { hello: 'main' } });
      });
      log({ ok: true, ...result });
    } catch (error) {
      log({ ok: false, ...result, error: String(error?.message ?? error) });
    }
    clearTimeout(timer);
    child.kill();
    app.quit();
  });
}

// 絵が変わり続けるページ（時刻と色が 100ms ごとに変わる）。絵が届くには、変化が要る
const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:48px -apple-system">
<div id="c" style="height:100vh;display:grid;place-items:center"></div>
<script>setInterval(()=>{const d=new Date();c.textContent=d.toLocaleTimeString()+'.'+String(d.getMilliseconds()).padStart(3,'0');c.style.background='hsl('+(d.getTime()/20%360)+' 60% 85%)'},100)</script>`;

async function runScreencast() {
  const win = new BrowserWindow({ width: 900, height: 700, webPreferences: { webviewTag: true, backgroundThrottling: !noThrottle } });
  let frames = 0;
  let bytes = 0;
  let total = 0;
  win.webContents.on('did-attach-webview', async (_event, contents) => {
    if (noThrottle) contents.setBackgroundThrottling(false);
    contents.debugger.attach('1.3');
    contents.debugger.on('message', (_e, method, params) => {
      if (method !== 'Page.screencastFrame') return;
      frames += 1;
      total += 1;
      bytes += Math.floor((params.data.length * 3) / 4);
      contents.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    });
    await contents.debugger.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 390, maxHeight: 844 });
    log({ event: 'screencast-started', noThrottle });
  });
  const html = `<!doctype html><body style="margin:0"><webview src="data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}" style="width:100vw;height:100vh"></webview>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  for (const name of ['lock-screen', 'unlock-screen', 'suspend', 'resume', 'user-did-become-active', 'user-did-resign-active']) {
    powerMonitor.on(name, () => log({ event: name }));
  }
  if (hideAfter > 0) {
    setTimeout(() => {
      win.hide();
      log({ event: 'hidden' });
    }, hideAfter * 1000);
  }
  if (minimizeAfter > 0) {
    setTimeout(() => {
      win.minimize();
      log({ event: 'minimized' });
    }, minimizeAfter * 1000);
  }
  const started = Date.now();
  const tick = setInterval(() => {
    log({ t: Math.round((Date.now() - started) / 1000), framesIn5s: frames, kbIn5s: Math.round(bytes / 1024), totalFrames: total, visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() });
    frames = 0;
    bytes = 0;
    if (Date.now() - started >= seconds * 1000) {
      clearInterval(tick);
      app.quit();
    }
  }, 5000);
}

app.whenReady().then(mode === 'screencast' ? runScreencast : runUtility);
