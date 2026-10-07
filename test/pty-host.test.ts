import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PtyHost, type PtyHandle } from '../src/main/pty-host-client';
import { PROTOCOL } from '../src/main/pty-host-protocol';
import { socketPathIn } from '../src/main/socket-path';

// 本物の pty ホスト（src/main/pty-host.ts）と、アプリ側の接続（pty-host-client.ts の PtyHost）。
// ホストをアプリのビルドと同じく 1 つの JS にまとめて、Node として起動する（アプリは Electron を Node として起動する）。
// claude の代わりに /bin/sh を起動する。test:cli はホストを偽物に差し替えるので、ソケット・やりとりの形・引き継ぎはここで確かめる

let script: string;
let buildDir: string;
beforeAll(async () => {
  // ホストが読む node-pty・@xterm を node_modules から探せるよう、リポジトリの node_modules の下に書き出す
  mkdirSync(resolve('node_modules/.cache'), { recursive: true });
  buildDir = mkdtempSync(resolve('node_modules/.cache/tanacode-pty-host-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: resolve('src/main/pty-host.ts'),
      outDir: buildDir,
      emptyOutDir: false,
      minify: false,
      // アプリのビルド（electron-vite）と同じく、dependencies は 1 つにまとめず node_modules から読む
      rollupOptions: { external: ['node-pty', '@xterm/headless', '@xterm/addon-serialize'], output: { format: 'cjs', entryFileNames: 'pty-host.js' } },
    },
  });
  script = join(buildDir, 'pty-host.js');
}, 60_000);
afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

let dir: string;
const hosts: PtyHost[] = [];
const start = async () => {
  const host = await PtyHost.start(dir, script);
  hosts.push(host);
  return host;
};
afterEach(async () => {
  // ホストごと止める（claude にあたる sh も止まる）
  await hosts.at(-1)?.shutdown();
  hosts.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(label: string, check: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`${label}: 時間切れ`);
    await sleep(25);
  }
}

// ホストのプロセス ID（hello の返事にある）
function hostPid(socketPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => socket.write(`${JSON.stringify({ t: 'hello', protocol: -1 })}\n`));
    socket.setEncoding('utf8');
    socket.once('data', (line: string) => {
      socket.destroy();
      resolve((JSON.parse(line.split('\n')[0]) as { pid: number }).pid);
    });
    socket.once('error', reject);
  });
}

// 出力をためながら受ける
function collect(pty: PtyHandle): { text: () => string; exit: () => number | null } {
  let text = '';
  let exit: number | null = null;
  pty.onData((data) => (text += data));
  pty.onExit((code) => (exit = code));
  return { text: () => text, exit: () => exit };
}

const sh = (tag: string, command?: string) => ({
  tag,
  file: '/bin/sh',
  args: command ? ['-c', command] : [],
  cwd: dir,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, PS1: '$ ', TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
});

describe('pty ホスト', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-pty-'));
  });

  it('起動した pty の出力が届き、打った文字が届く', async () => {
    const host = await start();
    const pty = host.spawn(sh('s1'));
    const out = collect(pty);
    await waitFor('プロンプト', () => out.text().includes('$ '));
    pty.write('echo $((40+2))\r');
    await waitFor('計算の結果', () => out.text().includes('42'));
  });

  it('大きさを変えると、pty にも伝わる', async () => {
    const host = await start();
    const pty = host.spawn(sh('s1'));
    const out = collect(pty);
    await waitFor('プロンプト', () => out.text().includes('$ '));
    pty.resize(100, 30);
    await sleep(100);
    pty.write('stty size\r');
    await waitFor('大きさ', () => out.text().includes('30 100'));
  });

  it('終了コードが届く', async () => {
    const host = await start();
    const out = collect(host.spawn(sh('s1', 'exit 3')));
    expect(await waitFor('終了', () => out.exit() !== null && out.exit())).toBe(3);
  });

  it('アプリを起動し直しても、動いている pty を止めず、それまでの画面ごと引き継ぐ', async () => {
    const first = await start();
    const pty = first.spawn(sh('session-1'));
    const out = collect(pty);
    await waitFor('プロンプト', () => out.text().includes('$ '));
    pty.write('echo before-restart\r');
    await waitFor('出力', () => out.text().includes('before-restart'));
    // アプリを終了する（claude は止めずに接続だけ切る）
    first.close();
    const second = await start();
    const listed = await second.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tag: 'session-1', exitCode: null, cols: 80, rows: 24 });
    expect(listed[0].screen).toContain('before-restart');
    // 引き継いだ pty に打てて、出力も届く
    const adopted = second.attach(listed[0]);
    const again = collect(adopted);
    adopted.write('echo after-restart\r');
    await waitFor('引き継いだあとの出力', () => again.text().includes('after-restart'));
  });

  it('アプリが見ていない間に終わった pty は、終了コードを持ったまま一覧に残り、forget で消える', async () => {
    const first = await start();
    first.spawn(sh('session-1', 'sleep 0.3; exit 5'));
    // アプリを終了する（接続だけ切る）。sh は、アプリが見ていない間に終わる
    first.close();
    await sleep(1000);
    const second = await start();
    const listed = await second.list();
    expect(listed).toMatchObject([{ tag: 'session-1', exitCode: 5 }]);
    second.forget(listed[0].id);
    expect(await second.list()).toEqual([]);
  });

  it('ソケットは、自分だけが読み書きできる（つながれば任意のコマンドを起動できるため）', async () => {
    await start();
    const mode = statSync(socketPathIn(dir, 'pty-host', 'pty')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('形（PROTOCOL）の違う古いホストは止めてもらい、今のホストを起動し直す', async () => {
    const socketPath = socketPathIn(dir, 'pty-host', 'pty');
    let shutdownAsked = false;
    // 古いホストの代わり。hello に古い形で答え、shutdown を受けたら終わる
    const old = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as { t: string };
          if (message.t === 'hello') socket.write(`${JSON.stringify({ t: 'hello', protocol: PROTOCOL - 1, pid: 1 })}\n`);
          if (message.t === 'shutdown') {
            shutdownAsked = true;
            socket.end();
            old.close();
          }
        }
      });
    });
    await new Promise<void>((r) => old.listen(socketPath, r));
    const host = await start();
    expect(shutdownAsked).toBe(true);
    const out = collect(host.spawn(sh('s1', 'echo new-host')));
    await waitFor('新しいホストの出力', () => out.text().includes('new-host'));
  });

  it('ホストが落ちたら、動いていた pty は終わったことにする（-1）', async () => {
    const host = await start();
    const pty = host.spawn(sh('s1'));
    const out = collect(pty);
    await waitFor('プロンプト', () => out.text().includes('$ '));
    // ホストのプロセスを強制終了する（プロセス ID は、hello の返事で分かる。形を違えて送れば、アプリとしては数えられない）
    const pid = await hostPid(socketPathIn(dir, 'pty-host', 'pty'));
    process.kill(pid, 'SIGKILL');
    expect(await waitFor('終了', () => out.exit() !== null && String(out.exit()))).toBe('-1');
    hosts.length = 0;
  });
});
