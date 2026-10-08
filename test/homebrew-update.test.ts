import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_BUNDLE, BREW_ENV, CASK, findBrew, HomebrewUpdater, parseCaskInfo, UPGRADE_SCRIPT, type BrewRunner } from '../src/main/homebrew-update';

// Homebrew で入れた tanacode の更新（裏でのダウンロードと、終了したあとの入れ替え）
const info = (version: string, installed: string | null, tap = 'sny-tanaka/tanacode') => JSON.stringify({ formulae: [], casks: [{ token: 'tanacode', tap, version, installed }] });

describe('parseCaskInfo', () => {
  it('tap の cask のバージョンと、入っているバージョンを取り出す', () => {
    expect(parseCaskInfo(info('1.3.0', '1.2.1'))).toEqual({ version: '1.3.0', installed: '1.2.1' });
    expect(parseCaskInfo(info('1.3.0', null))).toEqual({ version: '1.3.0', installed: null });
  });

  it('ほかの tap の cask・形の違う返事は null', () => {
    expect(parseCaskInfo(info('1.3.0', '1.2.1', 'homebrew/cask'))).toBeNull();
    expect(parseCaskInfo(JSON.stringify({ casks: [] }))).toBeNull();
    expect(parseCaskInfo('Error: No available cask')).toBeNull();
  });
});

describe('findBrew', () => {
  it('Apple Silicon・Intel の置き場所の、あるほうを返す', () => {
    expect(findBrew((p) => p === '/opt/homebrew/bin/brew')).toBe('/opt/homebrew/bin/brew');
    expect(findBrew((p) => p === '/usr/local/bin/brew')).toBe('/usr/local/bin/brew');
    expect(findBrew(() => false)).toBeNull();
  });
});

// brew の作り物。引数ごとの返事を決め、呼ばれた順を控える
function fakeBrew(replies: Record<string, () => string>) {
  const calls: string[] = [];
  const run: BrewRunner = (args) => {
    const key = args.join(' ');
    calls.push(key);
    const reply = replies[key];
    if (!reply) return Promise.reject(new Error(`知らない呼び出し: ${key}`));
    try {
      return Promise.resolve(reply());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return { run, calls };
}
const INFO = `info --cask --json=v2 ${CASK}`;
const FETCH = `fetch --cask ${CASK}`;

describe('HomebrewUpdater.detect', () => {
  const detect = (bundle: string, installed: string | null, brew: string | null = '/opt/homebrew/bin/brew') =>
    HomebrewUpdater.detect({ bundle, current: '1.2.1', onChange: () => {}, brew, run: fakeBrew({ [INFO]: () => info('1.2.1', installed) }).run });

  it('/Applications の tanacode.app で、brew の記録が同じバージョンなら、Homebrew で入れたとみなす', async () => {
    expect(await detect(APP_BUNDLE, '1.2.1')).toBeInstanceOf(HomebrewUpdater);
  });

  it('ほかの場所のアプリ・brew が無い・brew で入れていない・記録のバージョンが違う（pkg などで上書きした）なら null', async () => {
    expect(await detect('/Users/me/Applications/tanacode.app', '1.2.1')).toBeNull();
    expect(await detect(APP_BUNDLE, '1.2.1', null)).toBeNull();
    expect(await detect(APP_BUNDLE, null)).toBeNull();
    expect(await detect(APP_BUNDLE, '1.1.0')).toBeNull();
  });

  it('brew info が失敗したら null', async () => {
    const run: BrewRunner = () => Promise.reject(new Error('brew が壊れている'));
    expect(await HomebrewUpdater.detect({ bundle: APP_BUNDLE, current: '1.2.1', onChange: () => {}, brew: '/opt/homebrew/bin/brew', run })).toBeNull();
  });
});

describe('HomebrewUpdater の用意（ダウンロード）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const updater = (replies: Record<string, () => string>) => {
    const brew = fakeBrew(replies);
    const changes: unknown[] = [];
    const u = new HomebrewUpdater({ brew: '/opt/homebrew/bin/brew', run: brew.run, current: '1.2.1', onChange: () => changes.push(u.get()) });
    return { u, calls: brew.calls, changes };
  };

  it('新しいバージョンがあれば、brew update・tap の cask の確認・brew fetch をして、ready にする', async () => {
    const { u, calls, changes } = updater({ update: () => '', [INFO]: () => info('1.3.0', '1.2.1'), [FETCH]: () => '' });
    u.want('1.3.0');
    await u.prepare();
    expect(calls).toEqual(['update', INFO, FETCH]);
    expect(changes).toEqual([{ status: 'downloading' }, { status: 'ready', version: '1.3.0' }]);
    // 用意できたら、もう brew を動かさない
    u.want('1.3.0');
    await u.prepare();
    expect(calls).toHaveLength(3);
  });

  it('今より新しくなければ、何もしない', async () => {
    const { u, calls } = updater({});
    u.want('1.2.1');
    u.want(null);
    await vi.runAllTimersAsync();
    expect(calls).toEqual([]);
    expect(u.get()).toBeNull();
  });

  it('tap の cask がまだ新しくなっていなければ、ダウンロードせずに少しあとで確かめ直す', async () => {
    let tap = '1.2.1';
    const { u, calls } = updater({ update: () => '', [INFO]: () => info(tap, '1.2.1'), [FETCH]: () => '' });
    u.want('1.3.0');
    await u.prepare();
    expect(calls).toEqual(['update', INFO]);
    expect(u.get()).toEqual({ status: 'downloading' });
    tap = '1.3.0';
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toEqual(['update', INFO, 'update', INFO, FETCH]);
    expect(u.get()).toEqual({ status: 'ready', version: '1.3.0' });
  });

  it('失敗したら failed にして、1 時間あとにやり直す。止めたらやり直さない', async () => {
    let online = false;
    const { u, calls } = updater({
      update: () => {
        if (!online) throw new Error('offline');
        return '';
      },
      [INFO]: () => info('1.3.0', '1.2.1'),
      [FETCH]: () => '',
    });
    u.want('1.3.0');
    await u.prepare();
    expect(u.get()).toEqual({ status: 'failed' });
    online = true;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(u.get()).toEqual({ status: 'ready', version: '1.3.0' });

    const stopped = updater({ update: () => { throw new Error('offline'); } });
    stopped.u.want('1.3.0');
    await stopped.u.prepare();
    stopped.u.stop();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(stopped.calls).toEqual(['update']);
  });

  it('用意できたあとに、さらに新しいバージョンが出たら、用意できているものを残したまま、新しいものを用意する', async () => {
    let tap = '1.3.0';
    let online = true;
    const { u, calls } = updater({
      update: () => {
        if (!online) throw new Error('offline');
        return '';
      },
      [INFO]: () => info(tap, '1.2.1'),
      [FETCH]: () => '',
    });
    u.want('1.3.0');
    await u.prepare();
    // 新しいものを用意するあいだ（tap の cask が古いあいだ）も、失敗したときも、1.3.0 は入れられる
    u.want('1.4.0');
    await u.prepare();
    expect(u.get()).toEqual({ status: 'ready', version: '1.3.0' });
    online = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(u.get()).toEqual({ status: 'ready', version: '1.3.0' });
    online = true;
    tap = '1.4.0';
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(u.get()).toEqual({ status: 'ready', version: '1.4.0' });
    expect(calls.filter((c) => c === FETCH)).toHaveLength(2);
  });

  it('同時に何度も用意しない', async () => {
    const { u, calls } = updater({ update: () => '', [INFO]: () => info('1.3.0', '1.2.1'), [FETCH]: () => '' });
    u.want('1.3.0');
    u.want('1.3.0');
    await u.prepare();
    expect(calls).toEqual(['update', INFO, FETCH]);
  });
});

describe('HomebrewUpdater.upgradeAfterExit', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'tanacode-brew-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ready = async () => {
    const shells: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const u = new HomebrewUpdater({
      brew: '/opt/homebrew/bin/brew',
      run: fakeBrew({ update: () => '', [INFO]: () => info('1.3.0', '1.2.1'), [FETCH]: () => '' }).run,
      current: '1.2.1',
      onChange: () => {},
      spawnShell: (args, env) => shells.push({ args, env }),
    });
    return { u, shells };
  };

  it('ダウンロード済みなら、終わるのを待って入れ替えるシェルを 1 回だけ起動する。確認（y/n）は出さない', async () => {
    const { u, shells } = await ready();
    const options = { pid: 123, log: join(dir, 'logs/update.log'), result: join(dir, 'result'), relaunch: true };
    expect(u.upgradeAfterExit(options)).toBe(false);
    u.want('1.3.0');
    await u.prepare();
    writeFileSync(options.result, '1');
    expect(u.upgradeAfterExit(options)).toBe(true);
    expect(u.upgradeAfterExit(options)).toBe(false);
    expect(shells).toHaveLength(1);
    expect(shells[0].args).toEqual(['123', '/opt/homebrew/bin/brew', CASK, APP_BUNDLE, options.log, options.result, '1', '/usr/bin/open']);
    expect(shells[0].env).toMatchObject(BREW_ENV);
    // ログはこの更新の分から書き始め、前の結果は消しておく
    expect(readFileSync(options.log, 'utf8')).toContain('v1.3.0 に更新します');
    expect(existsSync(options.result)).toBe(false);
  });
});

describe('HomebrewUpdater.upgradeAfterExit で書けないとき', () => {
  it('ログを書けなければ、投げずに false を返し、シェルを起動しない', async () => {
    const shells: string[][] = [];
    const u = new HomebrewUpdater({
      brew: '/opt/homebrew/bin/brew',
      run: fakeBrew({ update: () => '', [INFO]: () => info('1.3.0', '1.2.1'), [FETCH]: () => '' }).run,
      current: '1.2.1',
      onChange: () => {},
      spawnShell: (args) => shells.push(args),
    });
    u.want('1.3.0');
    await u.prepare();
    const dir = mkdtempSync(join(tmpdir(), 'tanacode-brew-'));
    try {
      // ログの置き場所がファイルなので、フォルダを作れない
      writeFileSync(join(dir, 'file'), '');
      expect(u.upgradeAfterExit({ pid: 1, log: join(dir, 'file/update.log'), result: join(dir, 'result'), relaunch: false })).toBe(false);
      expect(shells).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 本物の sh で、入れ替えのシェルを動かす（brew と open は作り物）
describe('UPGRADE_SCRIPT', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'tanacode-brew-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const tool = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  const run = async (pid: number, brewBody: string, relaunch: '0' | '1') => {
    const brew = tool('brew', brewBody);
    const opener = tool('open', `echo "$1" > "${join(dir, 'opened')}"`);
    const log = join(dir, 'log');
    const result = join(dir, 'result');
    // spawnSync で待つと、終わった「アプリ」をこのプロセスが片付けられず（ゾンビのまま）、kill -0 が通り続けるので、非同期で待つ
    const shell = spawn('/bin/sh', ['-c', UPGRADE_SCRIPT, 'tanacode-update', String(pid), brew, CASK, APP_BUNDLE, log, result, relaunch, opener], { stdio: 'ignore' });
    await new Promise((resolve) => shell.on('close', resolve));
    return { log: readFileSync(log, 'utf8'), result: readFileSync(result, 'utf8').trim(), opened: existsSync(join(dir, 'opened')) ? readFileSync(join(dir, 'opened'), 'utf8').trim() : null };
  };

  it('アプリが終わるのを待ってから brew upgrade し、起動し直す。入力はつながない', async () => {
    const app = spawn('sleep', ['0.5']);
    const started = Date.now();
    const out = await run(app.pid!, `[ -t 0 ] && echo "入力がつながっています"; read answer || echo "入力なし"; echo "brew $*"`, '1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(out.log).toBe(`入力なし\nbrew upgrade --cask ${CASK}\n`);
    expect(out.result).toBe('0');
    expect(out.opened).toBe(APP_BUNDLE);
  });

  it('brew upgrade が失敗したら、終了コードを残す。起動し直さない設定なら起動しない', async () => {
    const out = await run(2 ** 22 + 12345, 'echo "Error: 失敗"; exit 3', '0');
    expect(out.log).toBe('Error: 失敗\n');
    expect(out.result).toBe('3');
    expect(out.opened).toBeNull();
  });
});
