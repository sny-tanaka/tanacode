import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import { textResult } from '../src/main/mcp-bridge';
import { menuNotice, scheduledNotice } from '../src/main/notice-text';
import {
  allOf,
  argsOf,
  boot,
  cleanup,
  fakeEvent,
  type Fake,
  FakeWebContents,
  invoke,
  mainWindow,
  manager,
  menuItem,
  sentToRenderer,
  started,
  state,
  the,
  type MenuItem,
} from './helpers/main-app';

// アプリの入り口（src/main/index.ts）の、IPC の受け口のほか。起動の流れ（部品の組み立てと、部品から画面への知らせ）・
// ウインドウ・権限・プレビューの webview の移動先・メニュー・終了の確認・通知を、Electron と重い部品を作り物にして確かめる
// （test/helpers/main-app.ts）。IPC の受け口は test/main-ipc.test.ts

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

// index.ts のあるフォルダ（ビルドすると out/main。MCP の中継・pty ホスト・preload はその隣に置く）
const MAIN_DIR = resolve('src/main');
// SessionManager に渡すもの（index.ts の new SessionManager(...) の引数の順）
const managerArg = {
  ptyHost: 0,
  store: 1,
  watchers: 2,
  statusLines: 3,
  callbacks: 4,
  remoteControl: 5,
  settingsFiles: 6,
  runShell: 7,
  browserLaunch: 8,
  sessionsLaunch: 9,
  checklistLaunch: 10,
  walkthroughLaunch: 11,
} as const;
const managerArgs = () => argsOf('SessionManager');
type Callbacks = Record<string, (...args: unknown[]) => unknown>;
const callbacks = () => managerArgs()[managerArg.callbacks] as Callbacks;
// 作り物を作ったときに渡した関数
const fnArg = (name: string, index: number) => argsOf(name)[index] as (...args: unknown[]) => unknown;
const optionsOf = (name: string) => argsOf(name)[0] as Record<string, (...args: unknown[]) => unknown>;
const savedSettings = () => JSON.parse(readFileSync(join(state.userData, 'settings.json'), 'utf8')) as Record<string, unknown>;
const pending = <T = void>() => {
  let resolveIt!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolveIt = r));
  return { promise, resolve: resolveIt };
};

describe('起動', () => {
  it('部品を組み立て、前の Claude Code を引き継いでから、予約を始め・受け口を登録し・メニューとウインドウを作る', async () => {
    const adopting = pending<undefined>();
    await boot({ noWait: true, before: (s) => s.adopt.mockReturnValue(adopting.promise) });
    await vi.waitFor(() => expect(state.adopt).toHaveBeenCalled());
    // 引き継ぎが終わるまでは、予約を始めず、画面からの呼び出しも受けない
    expect(the('ScheduledMessages').start).not.toHaveBeenCalled();
    expect(state.handlers.size).toBe(0);
    expect(state.windows).toHaveLength(0);
    // 権限の扱いは、ウインドウを作る前に決める
    expect(state.defaultSession.requestHandler).not.toBeNull();
    adopting.resolve(undefined);
    await started();
    expect(the('ScheduledMessages').start).toHaveBeenCalledTimes(1);
    expect(state.handlers.size).toBeGreaterThan(50);
    expect(state.menu).not.toBeNull();
    expect(state.windows).toHaveLength(1);
    expect(the('UsageMonitor').start).toHaveBeenCalledTimes(1);
    expect(the('SystemMonitor').start).toHaveBeenCalledTimes(1);
    expect(the('ClaudeVersionMonitor').start).toHaveBeenCalledTimes(1);
    expect(the('StatusLineWatcher').start).toHaveBeenCalledTimes(1);
  });

  it('userData に置くもの（会話の一覧・設定・statusLine・設定ファイル・チェックリスト・予約・使用量・ソケット）', async () => {
    await boot();
    const u = (name: string) => join(state.userData, name);
    expect(argsOf('SessionStore')).toEqual([u('sessions.json')]);
    expect(argsOf('StatusLineWatcher')[0]).toBe(u('statusline'));
    expect(argsOf('SettingsFiles')[1]).toBe(u('session-settings'));
    expect(argsOf('ChecklistStore')[0]).toBe(u('checklists'));
    expect(argsOf('ScheduledMessages')[0]).toBe(u('scheduled-messages.json'));
    expect(argsOf('ScheduledMessages')[1]).toBe(manager());
    expect(argsOf('UsageMonitor')[0]).toBe(u('usage.json'));
    expect(allOf('McpBridge').map((c) => c.args[0])).toEqual([u('browser.sock'), u('sessions.sock'), u('checklist.sock'), u('walkthrough.sock')]);
    expect(state.ptyHostStart.mock.calls).toEqual([[state.userData, join(MAIN_DIR, 'pty-host.js')]]);
    // SessionManager には、pty ホスト・会話の一覧・監視を渡す
    const args = managerArgs();
    expect(args[managerArg.ptyHost]).toBe(state.ptyHost);
    expect(args[managerArg.store]).toBe(the('SessionStore'));
    expect(args[managerArg.watchers]).toBe(the('WorkspaceWatchers'));
    expect(args[managerArg.statusLines]).toBe(the('StatusLineWatcher'));
    expect(args[managerArg.settingsFiles]).toBe(the('SettingsFiles'));
  });

  it('以前のレビュー機能が使っていたフォルダ（snapshots）を消す', async () => {
    await boot({ before: (s) => mkdirSync(join(s.userData, 'snapshots', 'old'), { recursive: true }) });
    await vi.waitFor(() => expect(existsSync(join(state.userData, 'snapshots'))).toBe(false));
  });

  it('開発中の起動では、Dock のアイコンをアプリのものにし、Remote Control を使わない。ログインシェルの PATH は使わない', async () => {
    await boot();
    expect(state.dock!.setIcon.mock.calls).toEqual([[join(state.appPath, 'build/icon.png')]]);
    expect(managerArgs()[managerArg.remoteControl]).toBe(false);
    expect(state.execFileSync).not.toHaveBeenCalled();
  });

  it('Dock の無い環境でも、開発中の起動は止まらない', async () => {
    await boot({ before: (s) => (s.dock = undefined) });
    expect(state.windows).toHaveLength(1);
  });

  it('userData のパスが長すぎてソケットを置けないときは、一時フォルダに、用途ごとの名前で置く', async () => {
    await boot({
      before: (s) => {
        s.userData = join(s.root, 'u'.repeat(120));
        mkdirSync(s.userData);
      },
    });
    const sockets = allOf('McpBridge').map((c) => String(c.args[0]));
    expect(sockets.map((path) => path.startsWith(`${tmpdir()}/`))).toEqual([true, true, true, true]);
    expect(sockets.map((path) => path.slice(tmpdir().length + 1).replace(/-[0-9a-f]{12}\.sock$/, ''))).toEqual([
      'tanacode-browser',
      'tanacode-sessions',
      'tanacode-checklist',
      'tanacode-walkthrough',
    ]);
  });

  it('開発中でも TANACODE_REMOTE_CONTROL=1 なら Remote Control を使う', async () => {
    await boot({ before: () => (process.env.TANACODE_REMOTE_CONTROL = '1') });
    expect(managerArgs()[managerArg.remoteControl]).toBe(true);
  });

  it('パッケージしたアプリは、Remote Control を使い、ログインシェルの PATH で claude を探す', async () => {
    await boot({
      packaged: true,
      before: (s) => {
        process.env.SHELL = '/opt/homebrew/bin/fish';
        s.execFileSync.mockReturnValue('/opt/homebrew/bin:/usr/bin\n');
      },
    });
    expect(managerArgs()[managerArg.remoteControl]).toBe(true);
    expect(state.dock!.setIcon).not.toHaveBeenCalled();
    expect(state.execFileSync.mock.calls).toEqual([['/opt/homebrew/bin/fish', ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 }]]);
    expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('ログインシェルが分からなければ zsh。PATH が空なら、そのまま', async () => {
    const before = process.env.PATH;
    await boot({
      packaged: true,
      before: (s) => {
        delete process.env.SHELL;
        s.execFileSync.mockReturnValue('  \n');
      },
    });
    expect(state.execFileSync.mock.calls[0][0]).toBe('/bin/zsh');
    expect(process.env.PATH).toBe(before);
  });

  it('ログインシェルの PATH が取れなければ、よくある場所を前に足す', async () => {
    const before = process.env.PATH;
    await boot({ packaged: true, before: () => (process.env.HOME = '/Users/me') });
    expect(process.env.PATH).toBe(`/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin:${before}`);
  });

  it('pty ホストを起動できなければ、理由とログの場所を出して終了する（確認は出さない）', async () => {
    await boot({ before: (s) => s.ptyHostStart.mockRejectedValue(new Error('spawn EACCES')) });
    expect(state.dialog.showErrorBox.mock.calls).toEqual([
      ['Claude Code を動かす常駐プロセスを起動できませんでした', `Error: spawn EACCES\n\nログ: ${join(state.userData, 'pty-host.log')}`],
    ]);
    expect(state.quit).toHaveBeenCalledTimes(1);
    expect(state.windows).toHaveLength(0);
    expect(state.handlers.size).toBe(0);
    expect(allOf('SessionManager')).toHaveLength(0);
    // 終了の確認を出さずに、そのまま終わる（Claude Code が無いので、止めるものも無い）
    const event = fakeEvent();
    state.app.emit('before-quit', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(the('StatusLineWatcher').close).toHaveBeenCalledTimes(1);
    expect(the('ShellTerminals').killAll).toHaveBeenCalledTimes(1);
  });

  it('新しいバージョンの通知をオフにしていれば、GitHub に問い合わせない', async () => {
    await boot({ settings: { updateCheck: false } });
    expect(the('AppUpdateMonitor').start).not.toHaveBeenCalled();
    await boot();
    expect(the('AppUpdateMonitor').start).toHaveBeenCalledTimes(1);
  });

  it('ウインドウが前に出たら Claude Code のバージョンを読み直す。Dock のアイコンを押したら、ウインドウを出す（閉じていれば作る）', async () => {
    await boot();
    state.app.emit('browser-window-focus');
    expect(the('ClaudeVersionMonitor').refresh).toHaveBeenCalledTimes(1);
    const first = mainWindow();
    first.minimized = true;
    state.app.emit('activate');
    expect(first.restore).toHaveBeenCalledTimes(1);
    expect(first.show).toHaveBeenCalledTimes(1);
    expect(first.focus).toHaveBeenCalledTimes(1);
    first.emit('closed');
    state.app.emit('activate');
    expect(state.windows).toHaveLength(2);
    expect(mainWindow().show).toHaveBeenCalledTimes(1);
    expect(mainWindow().restore).not.toHaveBeenCalled();
  });
});

describe('Claude Code に足す MCP サーバー', () => {
  const launches = ['browserLaunch', 'sessionsLaunch', 'checklistLaunch', 'walkthroughLaunch'] as const;
  const launch = (name: (typeof launches)[number]) => (managerArgs()[managerArg[name]] as () => unknown)();

  it('どれも、同梱の Node で中継のスクリプトを動かし、userData のソケットにつなぐ', async () => {
    await boot();
    const scripts = ['browser-mcp.js', 'sessions-mcp.js', 'checklist-mcp.js', 'walkthrough-mcp.js'];
    const sockets = ['browser.sock', 'sessions.sock', 'checklist.sock', 'walkthrough.sock'];
    launches.forEach((name, i) => {
      expect(launch(name)).toEqual({ command: '/fake/bin/node', script: join(MAIN_DIR, scripts[i]), socketPath: join(state.userData, sockets[i]), version: '9.8.7' });
    });
  });

  it('メニューでオフにしているものは足さない（次に起動する Claude Code から）', async () => {
    await boot({ settings: { browserControl: false, sessionsControl: false, checklistControl: false, walkthroughControl: false } });
    for (const name of launches) expect(launch(name)).toBeNull();
    menuItem('Claude にチェックリストを扱わせる').checked = true;
    menuItem('Claude にチェックリストを扱わせる').click?.(menuItem('Claude にチェックリストを扱わせる'));
    expect(launch('checklistLaunch')).not.toBeNull();
  });

  it('待ち受けを始められなかったものは足さず、理由を出す。アプリはそのまま使える', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await boot({ before: (s) => ['browser.sock', 'sessions.sock', 'checklist.sock', 'walkthrough.sock'].forEach((f) => s.failingSockets.add(f)) });
    for (const name of launches) expect(launch(name)).toBeNull();
    expect(error.mock.calls.map((c) => c[0])).toEqual([
      'アプリ内ブラウザの待ち受けを始められませんでした',
      'セッションの待ち受けを始められませんでした',
      'チェックリストの待ち受けを始められませんでした',
      'ウォークスルーの待ち受けを始められませんでした',
    ]);
    expect(state.windows).toHaveLength(1);
  });

  it('中継からの呼び出しは、それぞれの制御に渡す（中断の合図も）', async () => {
    await boot();
    const [browser, sessions, checklist, walkthrough] = allOf('McpBridge').map((c) => c.args[1] as (...args: unknown[]) => unknown);
    const signal = new AbortController().signal;
    expect(browser('s1', 'navigate', { url: 'http://localhost' }, signal)).toEqual({ call: 'browser.handle', args: ['s1', 'navigate', { url: 'http://localhost' }, signal] });
    expect(sessions('s1', 'start_session', { prompt: 'x' }, signal)).toEqual({ call: 'sessionsControl.handle', args: ['s1', 'start_session', { prompt: 'x' }, signal] });
    expect(checklist('s1', 'card_add', { title: 'x' })).toEqual({ call: 'checklistControl.handle', args: ['s1', 'card_add', { title: 'x' }] });
    expect(walkthrough('s1', 'walkthrough_start', { steps: [] })).toEqual({ call: 'walkthrough.handle', args: ['s1', 'walkthrough_start', { steps: [] }] });
  });

  it('起動が終わる前（セッションの一覧を読む前）に、アプリ内ブラウザから届いた問い合わせ・依頼も扱える', async () => {
    const host = pending<Record<string, unknown>>();
    await boot({ noWait: true, before: (s) => s.ptyHostStart.mockReturnValue(host.promise as never) });
    await vi.waitFor(() => expect(state.ptyHostStart).toHaveBeenCalled());
    const browser = optionsOf('BrowserControl');
    expect(browser.hasSession('s1')).toBe(false);
    expect(browser.host()).toBeNull();
    browser.onAsk('s1', { id: 'ask-1', message: 'ログインしてください' });
    expect(state.notifications.map((n) => [n.options.subtitle, n.options.body])).toEqual([['新しいセッション', 'ブラウザでの操作の依頼: ログインしてください']]);
    host.resolve(state.ptyHost);
    await started();
  });

  it('起動が終わる前に届いた呼び出しには、少し待ってから試すよう返す', async () => {
    const host = pending<Record<string, unknown>>();
    await boot({ noWait: true, before: (s) => s.ptyHostStart.mockReturnValue(host.promise as never) });
    await vi.waitFor(() => expect(state.ptyHostStart).toHaveBeenCalled());
    const [, sessions, checklist, walkthrough] = allOf('McpBridge').map((c) => c.args[1] as (...args: unknown[]) => Promise<unknown>);
    const notYet = textResult('tanacode has not finished starting up. Wait a moment and try again.', true);
    await expect(sessions('s1', 'list_sessions', {}, new AbortController().signal)).resolves.toEqual(notYet);
    await expect(checklist('s1', 'list_get', {})).resolves.toEqual(notYet);
    await expect(walkthrough('s1', 'walkthrough_start', {})).resolves.toEqual(notYet);
    host.resolve(state.ptyHost);
    await started();
  });
});

describe('部品から画面への知らせ', () => {
  it.each([
    ['onSessionsChanged', [[{ id: 's1' }]], IpcChannel.SessionsChanged, [{ id: 's1' }]],
    ['onChat', [{ sessionId: 's1', events: [] }], IpcChannel.ChatEvents, { sessionId: 's1', events: [] }],
    ['onPtyData', ['s1', 'ターミナルの出力'], IpcChannel.PtyData, { sessionId: 's1', data: 'ターミナルの出力' }],
    ['onScreen', ['s1', { mode: 'plan' }], IpcChannel.ScreenChanged, { sessionId: 's1', info: { mode: 'plan' } }],
    ['onActivity', ['s1', { kind: 'thinking' }], IpcChannel.ScreenActivity, { sessionId: 's1', activity: { kind: 'thinking' } }],
    ['onWorkflows', ['s1', [{ id: 'w' }]], IpcChannel.WorkflowsChanged, { sessionId: 's1', runs: [{ id: 'w' }] }],
    ['onSubagents', ['s1', [{ id: 'a' }]], IpcChannel.SubagentsChanged, { sessionId: 's1', runs: [{ id: 'a' }] }],
    ['onBashTasks', ['s1', [{ id: 'b' }]], IpcChannel.TasksBashChanged, { sessionId: 's1', tasks: [{ id: 'b' }] }],
    ['onKnowledge', ['s1', { files: {} }], IpcChannel.KnowledgeChanged, { sessionId: 's1', knowledge: { files: {} } }],
    ['onStatusLine', ['s1', { model: 'opus' }], IpcChannel.StatusLineChanged, { sessionId: 's1', info: { model: 'opus' } }],
  ])('セッションの %s は、%s で送る', async (name, args, channel, payload) => {
    await boot();
    callbacks()[name](...(args as unknown[]));
    expect(sentToRenderer()).toEqual([[channel, payload]]);
  });

  it('ほかの部品の知らせ（ファイル・設定ファイル・チェックリスト・予約・ウォークスルー・使用量・バージョン・更新・負荷・シェル）', async () => {
    await boot();
    fnArg('WorkspaceWatchers', 0)('/work', ['a.ts']);
    fnArg('SettingsFiles', 2)([{ id: 'f1' }]);
    fnArg('ChecklistStore', 1)('s1', [{ id: 'l1' }]);
    fnArg('ScheduledMessages', 2)([{ id: 'm1' }]);
    optionsOf('WalkthroughControl').onChange('s1', { id: 'w1' });
    fnArg('UsageMonitor', 1)({ fiveHour: 10 });
    fnArg('ClaudeVersionMonitor', 0)('2.1.300');
    fnArg('AppUpdateMonitor', 1)({ latest: '9.9.0' });
    fnArg('SystemMonitor', 0)({ cpu: 1 });
    const shells = optionsOf('ShellTerminals');
    shells.onData('sh1', 'ls');
    shells.onExit('sh1', 0);
    shells.onOpened('s1', 'sh2', 'zsh');
    expect(sentToRenderer()).toEqual([
      [IpcChannel.FilesChanged, { root: '/work', paths: ['a.ts'] }],
      [IpcChannel.SettingsFilesChanged, [{ id: 'f1' }]],
      [IpcChannel.ChecklistChanged, { sessionId: 's1', lists: [{ id: 'l1' }] }],
      [IpcChannel.ScheduledChanged, [{ id: 'm1' }]],
      [IpcChannel.WalkthroughChanged, { sessionId: 's1', walkthrough: { id: 'w1' } }],
      [IpcChannel.UsageChanged, { fiveHour: 10 }],
      [IpcChannel.ClaudeVersionChanged, '2.1.300'],
      [IpcChannel.AppUpdateChanged, { latest: '9.9.0' }],
      [IpcChannel.SystemStats, { cpu: 1 }],
      [IpcChannel.ShellData, { id: 'sh1', data: 'ls' }],
      [IpcChannel.ShellExit, { id: 'sh1', exitCode: 0 }],
      [IpcChannel.ShellOpened, { owner: 's1', id: 'sh2', name: 'zsh' }],
    ]);
  });

  it('ウインドウを閉じたあと・画面が壊れたあとは、送らない', async () => {
    await boot();
    mainWindow().webContents.destroyed = true;
    callbacks().onSessionsChanged([]);
    mainWindow().webContents.destroyed = false;
    mainWindow().emit('closed');
    callbacks().onSessionsChanged([]);
    expect(sentToRenderer()).toEqual([]);
  });

  it('statusLine は、セッションと使用量に渡す。質問の入力は、セッションに渡す', async () => {
    await boot();
    const info = { model: 'opus', rateLimits: {} };
    fnArg('StatusLineWatcher', 1)('s1', info);
    expect(manager().statusLineChanged.mock.calls).toEqual([['s1', info]]);
    expect(the('UsageMonitor').fromStatusLine.mock.calls).toEqual([[info]]);
    fnArg('StatusLineWatcher', 2)('s1', { questions: [] });
    expect(manager().askQuestionsChanged.mock.calls).toEqual([['s1', { questions: [] }]]);
  });

  it('セッションのフォルダで、Claude が頼んだコマンドをターミナルで動かす', async () => {
    await boot();
    const run = managerArgs()[managerArg.runShell] as (...args: unknown[]) => unknown;
    expect(run('s1', '/work', 'npm test', 'テスト')).toEqual({ call: 'shells.run', args: ['s1', '/work', 'npm test', 'テスト'] });
  });

  it('アーカイブした・一覧から消したセッションの予約とウォークスルーは捨てる。ほかの状態の変化では捨てない', async () => {
    await boot();
    const watch = manager().watchState.mock.calls[0][0] as (id: string) => void;
    const states: Record<string, string | null> = { s1: 'archived', s2: null, s3: 'idle' };
    manager().stateOf.mockImplementation((id: string) => states[id]);
    for (const id of ['s1', 's2', 's3']) watch(id);
    expect(the('ScheduledMessages').dropSession.mock.calls).toEqual([['s1'], ['s2']]);
    expect(the('WalkthroughControl').discard.mock.calls).toEqual([['s1'], ['s2']]);
  });

  it('制御の部品に渡すもの（一覧にあるか・設定・フォルダ・ホーム）', async () => {
    await boot({ settings: { walkthroughControl: false, checklistControl: false, sessionsControl: true, browserControl: false, browserHosts: ['dev.test'] } });
    manager().summary.mockImplementation((id: string) => (id === 's1' ? { id } : undefined));
    const walkthrough = optionsOf('WalkthroughControl');
    expect(walkthrough.cwdOf('s1')).toBe('/sessions/s1');
    expect(walkthrough.cwdOf('gone')).toBeNull();
    expect(walkthrough.enabled()).toBe(false);
    const checklist = optionsOf('ChecklistControl');
    expect(checklist.store).toBe(the('ChecklistStore'));
    expect(checklist.host).toBe(manager());
    expect(checklist.enabled()).toBe(false);
    const sessions = optionsOf('SessionsControl');
    expect(sessions.host).toBe(manager());
    expect(sessions.home).toBe(homedir());
    expect(sessions.enabled()).toBe(true);
    const browser = optionsOf('BrowserControl');
    expect(browser.enabled()).toBe(false);
    expect(browser.extraHosts()).toEqual(['dev.test']);
    expect(browser.hasSession('s1')).toBe(true);
    expect(browser.hasSession('gone')).toBe(false);
    expect(browser.host()).toBe(mainWindow().webContents);
    expect(browser.channels).toEqual({
      open: IpcChannel.BrowserOpen,
      activity: IpcChannel.BrowserActivity,
      viewport: IpcChannel.BrowserViewport,
      newTab: IpcChannel.BrowserNewTab,
      selectTab: IpcChannel.BrowserSelectTab,
      closeTab: IpcChannel.BrowserCloseTab,
      ask: IpcChannel.BrowserAsk,
    });
    browser.send(IpcChannel.BrowserOpen, { sessionId: 's1', url: 'http://localhost' });
    expect(sentToRenderer()).toEqual([[IpcChannel.BrowserOpen, { sessionId: 's1', url: 'http://localhost' }]]);
    mainWindow().emit('closed');
    expect(browser.host()).toBeNull();
    // プレビューの webview の通信を見る（Claude が読む、失敗した通信）
    expect(the('BrowserControl').watchNetwork.mock.calls).toEqual([[state.partitions.get('persist:tanacode-preview')]]);
  });

  it('新しいバージョンの問い合わせは、Chromium の通信（net.fetch）で行う', async () => {
    await boot();
    state.netFetch.mockReturnValue('返事');
    const fetch = fnArg('AppUpdateMonitor', 2);
    expect(fetch('https://api.github.com/x', { headers: {} })).toBe('返事');
    expect(state.netFetch.mock.calls).toEqual([['https://api.github.com/x', { headers: {} }]]);
    expect(argsOf('AppUpdateMonitor')[0]).toBe('9.8.7');
  });
});

describe('通知', () => {
  const session = { id: 's1', title: 'メニューを直す' };

  it('作業が終わったら、セッション名をサブタイトルにして、音付きで知らせる', async () => {
    await boot();
    callbacks().onTurnCompleted(session);
    callbacks().onTurnCompleted({ id: 's2', title: null });
    expect(state.notifications.map((n) => n.options)).toEqual([
      { title: 'tanacode', subtitle: 'メニューを直す', body: '作業が完了しました', sound: 'Glass' },
      { title: 'tanacode', subtitle: '新しいセッション', body: '作業が完了しました', sound: 'Glass' },
    ]);
  });

  it('操作を待っているときは、確認の中身を知らせる', async () => {
    await boot();
    const menu = { kind: 'question', title: 'どちらにしますか？', options: [] };
    callbacks().onAttention(session, { kind: 'menu', menu });
    callbacks().onAttention(session, { kind: 'other' });
    expect(state.notifications.map((n) => n.options.body)).toEqual([menuNotice(menu as never), 'ターミナルでの操作が必要です']);
  });

  it('クリックすると、ウインドウを前に出して、そのセッションを選ばせる（ウインドウを閉じていれば作る）', async () => {
    await boot();
    callbacks().onTurnCompleted(session);
    mainWindow().minimized = true;
    state.notifications[0].emit('click');
    expect(mainWindow().restore).toHaveBeenCalledTimes(1);
    expect(mainWindow().focus).toHaveBeenCalledTimes(1);
    expect(sentToRenderer(IpcChannel.SessionsSelect)).toEqual(['s1']);
    mainWindow().emit('closed');
    callbacks().onTurnCompleted({ id: 's2', title: 'x' });
    state.notifications[1].emit('click');
    expect(state.windows).toHaveLength(2);
    expect(mainWindow().webContents.sent).toEqual([[IpcChannel.SessionsSelect, 's2']]);
  });

  it('出さないとき: 通知をオフにしている・子セッション・見ているセッション（ウインドウが前にあるとき）・通知の使えない環境', async () => {
    await boot({ settings: { notifications: false } });
    callbacks().onTurnCompleted(session);
    expect(state.notifications).toHaveLength(0);

    await boot();
    manager().parentOf.mockImplementation((id: string) => (id === 'child' ? 'parent' : null));
    callbacks().onTurnCompleted({ id: 'child', title: '子' });
    expect(state.notifications).toHaveLength(0);

    manager().isFocused.mockImplementation((id: string) => id === 's1');
    mainWindow().focused = true;
    callbacks().onTurnCompleted(session);
    expect(state.notifications).toHaveLength(0);
    // ウインドウが前にあっても、ほかのセッションなら出す
    callbacks().onTurnCompleted({ id: 's2', title: 'ほか' });
    expect(state.notifications).toHaveLength(1);
    // 見ているセッションでも、ウインドウが後ろにあれば出す
    mainWindow().focused = false;
    callbacks().onTurnCompleted(session);
    expect(state.notifications).toHaveLength(2);

    state.notificationSupported = false;
    callbacks().onTurnCompleted({ id: 's3', title: 'x' });
    expect(state.notifications).toHaveLength(2);
  });

  it('ウインドウが無いときは、見ているセッションでも出す', async () => {
    await boot();
    manager().isFocused.mockReturnValue(true);
    mainWindow().emit('closed');
    callbacks().onTurnCompleted(session);
    expect(state.notifications).toHaveLength(1);
  });

  it('予約を送れなかったら、予約の中身を知らせる', async () => {
    await boot();
    manager().summary.mockImplementation((id: string) => (id === 's1' ? { id, title: '予約したセッション' } : undefined));
    const message = { id: 'm1', sessionId: 's1', text: '明日の朝に送る', attachments: [], at: Date.now(), state: 'failed', error: '止まっていました' };
    fnArg('ScheduledMessages', 3)(message);
    fnArg('ScheduledMessages', 3)({ ...message, sessionId: 'gone' });
    expect(state.notifications.map((n) => [n.options.subtitle, n.options.body])).toEqual([
      ['予約したセッション', scheduledNotice(message as never)],
      ['新しいセッション', scheduledNotice(message as never)],
    ]);
  });

  it('Claude がブラウザでの操作を頼んだら、一覧に印を付けて知らせ、クリックでそのセッションのブラウザを開かせる。頼みが終わったら印を消す', async () => {
    await boot();
    manager().summary.mockReturnValue({ id: 's1', title: 'ログインの確認' });
    const onAsk = optionsOf('BrowserControl').onAsk;
    onAsk('s1', { id: 'ask-1', message: '**ログイン**してください' });
    expect(manager().browserAskChanged.mock.calls).toEqual([['s1', true]]);
    expect(state.notifications.map((n) => [n.options.subtitle, n.options.body])).toEqual([['ログインの確認', 'ブラウザでの操作の依頼: ログインしてください']]);
    state.notifications[0].emit('click');
    expect(sentToRenderer(IpcChannel.BrowserShow)).toEqual(['s1']);
    expect(sentToRenderer(IpcChannel.SessionsSelect)).toEqual([]);
    onAsk('s1', null);
    expect(manager().browserAskChanged.mock.calls[1]).toEqual(['s1', false]);
    expect(state.notifications).toHaveLength(1);
    manager().summary.mockReturnValue(undefined);
    onAsk('s2', { id: 'ask-2', message: '確認' });
    expect(state.notifications[1].options.subtitle).toBe('新しいセッション');
  });

  it('閉じた・出せなかった通知も、クリックされた通知と同じく手放す。たくさん出しても動き続ける', async () => {
    await boot();
    for (let i = 0; i < 60; i++) callbacks().onTurnCompleted({ id: `s${i}`, title: `${i}` });
    expect(state.notifications).toHaveLength(60);
    state.notifications[58].emit('close');
    state.notifications[59].emit('failed');
    state.notifications[57].emit('click');
    expect(sentToRenderer(IpcChannel.SessionsSelect)).toEqual(['s57']);
  });
});

describe('ウインドウ', () => {
  it('前に閉じたときの位置と大きさで開く。最大化していれば最大化する', async () => {
    await boot({ windowState: { bounds: { x: 100, y: 50, width: 1300, height: 800 }, maximized: true, fullScreen: false } });
    const win = mainWindow();
    expect(win.options).toMatchObject({
      x: 100,
      y: 50,
      width: 1300,
      height: 800,
      fullscreen: false,
      minWidth: 1180,
      minHeight: 600,
      // CSS を読み込む前に出る色（global.css の --bg-chrome と同じ）
      backgroundColor: '#121211',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 15 },
    });
    expect(win.options.webPreferences).toEqual({ preload: join(MAIN_DIR, '../preload/index.js'), webviewTag: true, additionalArguments: ['--tanacode-language=ja'] });
    expect(win.maximize).toHaveBeenCalledTimes(1);
  });

  it('フルスクリーンだったら、フルスクリーンで開く（最大化はしない）。覚えていなければ既定の大きさ', async () => {
    await boot({ windowState: { bounds: { x: 0, y: 0, width: 1300, height: 800 }, maximized: true, fullScreen: true } });
    expect(mainWindow().options.fullscreen).toBe(true);
    expect(mainWindow().maximize).not.toHaveBeenCalled();
    await boot();
    expect(mainWindow().options).toMatchObject({ width: 1600, height: 960, fullscreen: false });
    expect(mainWindow().options.x).toBeUndefined();
  });

  const savedWindowState = () => JSON.parse(readFileSync(join(state.userData, 'window-state.json'), 'utf8'));

  it.each(['resized', 'moved', 'unmaximize', 'leave-full-screen', 'close'])('%s で、位置と大きさを覚える', async (event) => {
    await boot();
    const win = mainWindow();
    win.bounds = { x: 5, y: 6, width: 1500, height: 900 };
    win.emit(event, fakeEvent());
    expect(savedWindowState()).toEqual({
      version: 1,
      bounds: { x: 5, y: 6, width: 1500, height: 900 },
      frame: { x: 5, y: 6, width: 1500, height: 900 },
      maximized: false,
      fullScreen: false,
    });
  });

  it.each([
    ['maximize', 'maximized'],
    ['enter-full-screen', 'fullScreen'],
  ] as const)('%s で、画面いっぱいにしたことと、その前の位置と大きさを覚える（ドラッグで動かしたあとの位置）', async (event, flag) => {
    await boot();
    const win = mainWindow();
    // ドラッグでもう一つの画面へ動かしてから、そこで画面いっぱいにする
    win.bounds = { x: 2000, y: 100, width: 1500, height: 900 };
    win.emit('moved');
    win.bounds = { x: 1920, y: 0, width: 2560, height: 1440 };
    win[flag] = true;
    win.emit(event);
    const expected = {
      version: 1,
      bounds: { x: 2000, y: 100, width: 1500, height: 900 },
      frame: { x: 1920, y: 0, width: 2560, height: 1440 },
      maximized: flag === 'maximized',
      fullScreen: flag === 'fullScreen',
    };
    expect(savedWindowState()).toEqual(expected);
    // そのまま閉じても、画面いっぱいの大きさや、起動したときの位置（Electron の getNormalBounds）で上書きしない
    win.emit('close', fakeEvent());
    expect(savedWindowState()).toEqual(expected);
  });

  it('最大化して開いたあと、何も動かさずに閉じたら、前に覚えた位置と大きさのまま', async () => {
    await boot({ windowState: { bounds: { x: 100, y: 50, width: 1300, height: 800 }, maximized: true, fullScreen: false } });
    const win = mainWindow();
    // 作り物のウインドウは、指定した位置（options）ではなく既定の位置に出る
    const opened = win.bounds;
    win.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    win.emit('close', fakeEvent());
    expect(savedWindowState()).toMatchObject({ bounds: opened, frame: { x: 0, y: 0, width: 1920, height: 1080 }, maximized: true });
  });

  it('最大化したまま別の画面へ移して閉じたら、次はその画面に開く', async () => {
    const displays = [{ workArea: { x: 0, y: 25, width: 1920, height: 1055 } }, { workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }];
    await boot({
      windowState: { bounds: { x: 100, y: 50, width: 1300, height: 800 }, frame: { x: 1920, y: 0, width: 2560, height: 1440 }, maximized: true, fullScreen: false },
      before: (s) => (s.displays = displays),
    });
    expect(mainWindow().options).toMatchObject({ x: 1920, y: 50, width: 1300, height: 800 });
    expect(mainWindow().maximize).toHaveBeenCalledTimes(1);
  });

  it('壊れたウインドウの位置は覚えない。覚えられなくても止まらない', async () => {
    await boot();
    mainWindow().destroyed = true;
    mainWindow().emit('resized');
    expect(existsSync(join(state.userData, 'window-state.json'))).toBe(false);
    mainWindow().destroyed = false;
    mkdirSync(join(state.userData, 'window-state.json.tmp'));
    expect(() => mainWindow().emit('resized')).not.toThrow();
  });

  it('開発サーバーがあれば、その URL を開く。無ければ、ビルドした画面のファイル', async () => {
    await boot();
    expect(mainWindow().loadFile.mock.calls).toEqual([[join(MAIN_DIR, '../renderer/index.html')]]);
    expect(mainWindow().loadURL).not.toHaveBeenCalled();
    await boot({ before: () => (process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173') });
    expect(mainWindow().loadURL.mock.calls).toEqual([['http://localhost:5173']]);
    expect(mainWindow().loadFile).not.toHaveBeenCalled();
  });

  it('画面の中のリンクで新しいウインドウは開かない。http(s) なら、ふだんのブラウザで開く', async () => {
    await boot();
    const open = mainWindow().webContents.windowOpenHandler!;
    expect(open({ url: 'https://example.test/' })).toEqual({ action: 'deny' });
    expect(open({ url: 'http://localhost:3000/' })).toEqual({ action: 'deny' });
    expect(open({ url: 'file:///etc/hosts' })).toEqual({ action: 'deny' });
    // http(s) で始まるものだけ（途中に https:// があるものは開かない）
    expect(open({ url: 'file:///tmp/a.html#https://example.test/' })).toEqual({ action: 'deny' });
    expect(state.shell.openExternal.mock.calls).toEqual([['https://example.test/'], ['http://localhost:3000/']]);
  });

  it('画面は、ほかのページへ移らない（読み込み直しは移る）', async () => {
    await boot();
    const contents = mainWindow().webContents;
    const away = fakeEvent();
    contents.emit('will-navigate', away, 'https://example.test/');
    expect(away.preventDefault).toHaveBeenCalled();
    const reload = fakeEvent();
    contents.emit('will-navigate', reload, contents.url);
    expect(reload.preventDefault).not.toHaveBeenCalled();
  });

  it('プレビューの webview には、アプリの API（preload）と Node を渡さない。開けるのは http(s) と about:blank だけ', async () => {
    await boot();
    const contents = mainWindow().webContents;
    const attach = (src: string) => {
      const event = fakeEvent();
      const prefs: Record<string, unknown> = { preload: '/app/preload.js', nodeIntegration: true, contextIsolation: false, sandbox: false };
      contents.emit('will-attach-webview', event, prefs, { src });
      return { prevented: event.preventDefault.mock.calls.length > 0, prefs };
    };
    expect(attach('http://localhost:3000')).toEqual({ prevented: false, prefs: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    expect(attach('about:blank').prevented).toBe(false);
    expect(attach('https://example.test').prevented).toBe(false);
    expect(attach('file:///etc/hosts').prevented).toBe(true);
    expect(attach('file:///tmp/a.html#https://example.test/').prevented).toBe(true);
    expect(attach('data:text/html,x').prevented).toBe(true);
  });

  it('webview のページが新しいウインドウで開こうとしたら、アプリ内ブラウザのタブで開く。開けず、Claude の操作中でもなければ、ふだんのブラウザで開く', async () => {
    await boot();
    const guest = new FakeWebContents();
    mainWindow().webContents.emit('did-attach-webview', fakeEvent(), guest);
    const browser = the('BrowserControl');
    expect(browser.track.mock.calls).toEqual([[guest]]);
    const open = guest.windowOpenHandler!;

    browser.openFromPage.mockReturnValueOnce(true);
    expect(open({ url: 'https://example.test/tab', disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
    expect(browser.openFromPage.mock.calls).toEqual([[guest, 'https://example.test/tab', 'foreground-tab']]);
    browser.isOperating.mockReturnValueOnce(true);
    open({ url: 'https://example.test/operating', disposition: 'new-window' });
    open({ url: 'mailto:me@example.test', disposition: 'new-window' });
    expect(state.shell.openExternal).not.toHaveBeenCalled();
    open({ url: 'file:///tmp/a.html#https://example.test/', disposition: 'new-window' });
    expect(state.shell.openExternal).not.toHaveBeenCalled();
    open({ url: 'https://example.test/outside', disposition: 'new-window' });
    open({ url: 'http://localhost:8080/', disposition: 'new-window' });
    expect(state.shell.openExternal.mock.calls).toEqual([['https://example.test/outside'], ['http://localhost:8080/']]);
  });
});

describe('権限', () => {
  it('主ウインドウの画面（トップのフレーム）にだけ、クリップボードを許す', async () => {
    await boot();
    const contents = mainWindow().webContents;
    const request = (who: unknown, permission: string, isMainFrame = true) => {
      let answer: boolean | null = null;
      state.defaultSession.requestHandler!(who, permission, (ok) => (answer = ok), { isMainFrame });
      return answer;
    };
    const check = (who: unknown, permission: string, isMainFrame = true) => state.defaultSession.checkHandler!(who, permission, 'file://', { isMainFrame });
    expect(request(contents, 'clipboard-read')).toBe(true);
    expect(request(contents, 'clipboard-sanitized-write')).toBe(true);
    expect(check(contents, 'clipboard-read')).toBe(true);
    for (const answer of [request(contents, 'media'), request(contents, 'notifications'), check(contents, 'geolocation')]) expect(answer).toBe(false);
    // 中のフレーム・ほかの画面・画面の無い問い合わせには許さない
    expect(request(contents, 'clipboard-read', false)).toBe(false);
    expect(check(contents, 'clipboard-read', false)).toBe(false);
    expect(request(new FakeWebContents(), 'clipboard-read')).toBe(false);
    expect(request(null, 'clipboard-read')).toBe(false);
    contents.type = 'webview';
    expect(check(contents, 'clipboard-read')).toBe(false);
    // ウインドウを閉じたあとは、誰にも許さない
    contents.type = 'window';
    mainWindow().emit('closed');
    expect(check(contents, 'clipboard-read')).toBe(false);
  });

  it('プレビュー（開発中の任意のページ）には何も許さず、ダウンロードもさせない', async () => {
    await boot();
    const preview = state.partitions.get('persist:tanacode-preview')!;
    let answer: boolean | null = null;
    preview.requestHandler!(null, 'clipboard-read', (ok) => (answer = ok), { isMainFrame: true });
    expect(answer).toBe(false);
    expect(preview.checkHandler!(null, 'clipboard-read', '', { isMainFrame: true })).toBe(false);
    const download = fakeEvent();
    preview.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalled();
  });
});

describe('プレビューの webview の移動先', () => {
  const guard = async (type = 'webview') => {
    await boot();
    const contents = new FakeWebContents();
    contents.type = type;
    state.app.emit('web-contents-created', fakeEvent(), contents);
    return contents;
  };
  const go = (contents: FakeWebContents, event: string, url: string, isMainFrame = true) => {
    const e = fakeEvent({ url, isMainFrame });
    contents.emit(event, e);
    return e.preventDefault.mock.calls.length > 0 ? '止める' : '通す';
  };

  it.each([
    ['https://example.test/', true, '通す'],
    ['HTTP://LOCALHOST:3000/', true, '通す'],
    ['about:blank', true, '通す'],
    ['file:///etc/hosts', true, '止める'],
    ['file:///tmp/a.html#https://example.test/', true, '止める'],
    ['mailto:me@example.test', true, '止める'],
    ['about:srcdoc', true, '止める'],
    ['data:text/html,x', true, '止める'],
    ['about:srcdoc', false, '通す'],
    ['blob:http://localhost/1', false, '通す'],
    ['DATA:text/html,x', false, '通す'],
    ['file:///etc/hosts', false, '止める'],
    ['file:///tmp/blob:x', false, '止める'],
    ['file:///tmp/data:x', false, '止める'],
    ['javascript:alert(1)', false, '止める'],
  ])('%s（トップのフレーム: %s）は%s', async (url, isMainFrame, expected) => {
    const contents = await guard();
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) expect(go(contents, event, url, isMainFrame)).toBe(expected);
  });

  it('Claude の操作で移るトップのフレームは、Claude に許した先だけ', async () => {
    const contents = await guard();
    const browser = the('BrowserControl');
    browser.blocksNavigation.mockImplementation((_c: unknown, url: string) => url.includes('outside'));
    expect(go(contents, 'will-navigate', 'https://outside.test/')).toBe('止める');
    expect(go(contents, 'will-navigate', 'http://localhost/')).toBe('通す');
    // 中のフレームは見ない
    expect(go(contents, 'will-frame-navigate', 'https://outside.test/', false)).toBe('通す');
    expect(browser.blocksNavigation.mock.calls).toEqual([
      [contents, 'https://outside.test/'],
      [contents, 'http://localhost/'],
    ]);
  });

  it('webview でないもの（アプリのウインドウなど）には付けない', async () => {
    const contents = await guard('window');
    expect(contents.events.size).toBe(0);
  });
});

describe('メニュー', () => {
  const toggle = (label: string) => {
    const item = menuItem(label);
    item.checked = !item.checked;
    item.click?.(item);
    return item;
  };

  it('アプリのメニューに、設定の切り替えと、許す先・新規セッション・止めて終了を並べる', async () => {
    await boot({ settings: { updateCheck: false, browserControl: true, sessionsControl: false, checklistControl: true, walkthroughControl: false } });
    const [appMenu, fileMenu, ...rest] = state.menu!;
    expect(appMenu.label).toBe('tanacode');
    expect(appMenu.submenu!.map((i: MenuItem) => i.role ?? i.label ?? i.type)).toEqual([
      'about',
      'separator',
      '新しいバージョンが出たら通知する',
      '終了するときに新しいバージョンを入れる（Homebrew）',
      'Claude にアプリ内ブラウザを操作させる',
      'Claude にほかのセッションを扱わせる',
      'Claude にチェックリストを扱わせる',
      'Claude にウォークスルーさせる',
      'アプリ内ブラウザで Claude に許す先…',
      'separator',
      '言語（Language）',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ]);
    expect(appMenu.submenu!.filter((i) => i.type === 'checkbox').map((i) => i.checked)).toEqual([false, true, true, false, true, false]);
    expect(fileMenu.label).toBe('ファイル');
    expect(fileMenu.submenu!.map((i: MenuItem) => i.role ?? i.label ?? i.type)).toEqual(['新規セッション', 'separator', 'close', 'separator', 'Claude Code も止めて終了']);
    expect(menuItem('新規セッション').accelerator).toBe('CmdOrCtrl+N');
    expect(rest.map((i) => i.role)).toEqual(['editMenu', 'viewMenu', 'windowMenu']);
  });

  it('「言語」: 既定は「システムに合わせる」で、Mac の優先する言語に日本語があれば日本語。画面には起動の引数で渡す', async () => {
    await boot({ before: (s) => (s.preferredLanguages = ['en-US', 'ja-JP']) });
    const languages = menuItem('言語（Language）').submenu!;
    expect(languages.map((i) => [i.label, i.type, i.checked])).toEqual([
      ['システムに合わせる', 'radio', true],
      ['日本語', 'radio', false],
      ['English', 'radio', false],
    ]);
    expect(mainWindow().options.webPreferences).toMatchObject({ additionalArguments: ['--tanacode-language=ja'] });
  });

  it('「言語」: Mac の優先する言語に日本語が無ければ、英語で出す（メニューも画面も）', async () => {
    await boot({ before: (s) => (s.preferredLanguages = ['en-US', 'fr-FR']) });
    expect(menuItem('Language').submenu!.map((i) => i.label)).toEqual(['System Default', '日本語', 'English']);
    expect(menuItem('File').submenu![0].label).toBe('New Session');
    expect(mainWindow().options.webPreferences).toMatchObject({ additionalArguments: ['--tanacode-language=en'] });
  });

  it('「言語」: 保存した言語で起動する（Mac の言語より優先）', async () => {
    await boot({ settings: { language: 'en' } });
    expect(menuItem('Language').submenu!.find((i) => i.checked)?.label).toBe('English');
    expect(mainWindow().options.webPreferences).toMatchObject({ additionalArguments: ['--tanacode-language=en'] });
  });

  // 言語の項目を押す（Electron のラジオボタンと同じく、押すとチェックが移る）。聞いたダイアログが閉じるまで待つ
  const chooseLanguage = async (label: string) => {
    const languages = menuItem(label);
    for (const item of state.menu![0].submenu!.find((i) => i.submenu?.includes(languages))!.submenu!) item.checked = item === languages;
    languages.click?.(languages);
    await new Promise((r) => setTimeout(r, 0));
  };

  it('「言語」: 選んだ言語を保存し、今の言語のまま動き続ける。言語が変わるなら、変えた先の言語で再起動するかを聞く（「あとで」なら何もしない）', async () => {
    await boot();
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await chooseLanguage('English');
    expect(savedSettings().language).toBe('en');
    const [, options] = state.dialog.showMessageBox.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options).toEqual({
      type: 'question',
      message: 'Restart tanacode to switch to English?',
      detail: 'The language changes when tanacode restarts. If you choose Later, tanacode will use English the next time it starts.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    expect(state.quit).not.toHaveBeenCalled();
    expect(state.relaunch).not.toHaveBeenCalled();
    // 動いている間は日本語のまま（メニューも）。チェックは選んだもの
    expect(menuItem('言語（Language）').submenu!.find((i) => i.checked)?.label).toBe('English');
    // 今の言語（日本語）に戻すなら、保存するだけで聞かない
    await chooseLanguage('日本語');
    expect(savedSettings().language).toBe('ja');
    expect(state.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('「言語」: 「今すぐ再起動」なら、ふつうの終了の確認を通して終了し、終わったら起動し直す', async () => {
    await boot();
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await chooseLanguage('English');
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    expect(state.relaunch).not.toHaveBeenCalled();
    const event = fakeEvent();
    state.app.emit('before-quit', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(state.relaunch).toHaveBeenCalledTimes(1);
  });

  it('「言語」: 終了の確認でキャンセルしたら、起動し直さない（あとでふつうに終了しても）', async () => {
    await boot();
    manager().liveSessions.mockReturnValue([{ id: 's1', title: 'メニューを直す', state: '作業中' }]);
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 2 });
    await chooseLanguage('English');
    await vi.waitFor(() => expect(state.dialog.showMessageBox).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(state.quit).not.toHaveBeenCalled();
    // あとでふつうに終了する
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const event = fakeEvent();
    state.app.emit('before-quit', event);
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    state.app.emit('before-quit', fakeEvent());
    expect(state.relaunch).not.toHaveBeenCalled();
  });

  it('「言語」: 保存できなかったら、メニューを選んでいたものに戻し、再起動も聞かない', async () => {
    await boot();
    // 設定は、一時ファイルに書いてから置き換える。一時ファイルの場所にフォルダがあると、書けない
    mkdirSync(join(state.userData, 'settings.json.tmp'));
    await chooseLanguage('English');
    expect(menuItem('言語（Language）').submenu!.map((i) => [i.label, i.checked])).toEqual([
      ['システムに合わせる', true],
      ['日本語', false],
      ['English', false],
    ]);
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('「新しいバージョンが出たら通知する」: オンで問い合わせを始め、オフでやめる。設定に保存する', async () => {
    await boot();
    const monitor = the('AppUpdateMonitor');
    monitor.start.mockClear();
    toggle('新しいバージョンが出たら通知する');
    expect(monitor.stop).toHaveBeenCalledTimes(1);
    expect(savedSettings().updateCheck).toBe(false);
    toggle('新しいバージョンが出たら通知する');
    expect(monitor.start).toHaveBeenCalledTimes(1);
    expect(savedSettings().updateCheck).toBe(true);
  });

  it('「Claude にアプリ内ブラウザを操作させる」: オフにしたら、頼んでいる操作を取り下げる', async () => {
    await boot();
    toggle('Claude にアプリ内ブラウザを操作させる');
    expect(the('BrowserControl').cancelAsks).toHaveBeenCalledTimes(1);
    expect(savedSettings().browserControl).toBe(false);
    toggle('Claude にアプリ内ブラウザを操作させる');
    expect(the('BrowserControl').cancelAsks).toHaveBeenCalledTimes(1);
    expect(savedSettings().browserControl).toBe(true);
  });

  it.each([
    ['終了するときに新しいバージョンを入れる（Homebrew）', 'updateOnQuit'],
    ['Claude にほかのセッションを扱わせる', 'sessionsControl'],
    ['Claude にチェックリストを扱わせる', 'checklistControl'],
    ['Claude にウォークスルーさせる', 'walkthroughControl'],
  ])('「%s」: 設定（%s）に保存する', async (label, key) => {
    await boot();
    toggle(label);
    expect(savedSettings()[key]).toBe(false);
    toggle(label);
    expect(savedSettings()[key]).toBe(true);
  });

  it.each([
    '新しいバージョンが出たら通知する',
    '終了するときに新しいバージョンを入れる（Homebrew）',
    'Claude にアプリ内ブラウザを操作させる',
    'Claude にほかのセッションを扱わせる',
    'Claude にチェックリストを扱わせる',
    'Claude にウォークスルーさせる',
  ])('「%s」: 保存できなかったら、チェックを元に戻し、ほかは何もしない', async (label) => {
    await boot();
    // 設定は、一時ファイルに書いてから置き換える。一時ファイルの場所にフォルダがあると、書けない
    mkdirSync(join(state.userData, 'settings.json.tmp'));
    const monitor = the('AppUpdateMonitor');
    monitor.start.mockClear();
    const item = toggle(label);
    expect(item.checked).toBe(true);
    expect(monitor.start).not.toHaveBeenCalled();
    expect(monitor.stop).not.toHaveBeenCalled();
    expect(the('BrowserControl').cancelAsks).not.toHaveBeenCalled();
  });

  it('「アプリ内ブラウザで Claude に許す先…」「新規セッション」は、ウインドウを出して、画面にダイアログ・新規セッションの画面を開かせる', async () => {
    await boot();
    mainWindow().emit('closed');
    menuItem('アプリ内ブラウザで Claude に許す先…').click?.({});
    expect(state.windows).toHaveLength(2);
    menuItem('新規セッション').click?.({});
    expect(mainWindow().show).toHaveBeenCalledTimes(2);
    expect(mainWindow().webContents.sent).toEqual([
      [IpcChannel.BrowserHostsOpen, undefined],
      [IpcChannel.SessionsNew, undefined],
    ]);
  });

  it('「Claude Code も止めて終了」: 確認を出さずに、Claude Code と pty ホストを止めてから終了する', async () => {
    await boot();
    menuItem('Claude Code も止めて終了').click?.({});
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    expect(manager().closeAll.mock.calls).toEqual([[true]]);
    expect(state.ptyHost.shutdown).toHaveBeenCalledTimes(1);
    expect(state.ptyHost.shutdown.mock.invocationCallOrder[0]).toBeLessThan(state.quit.mock.invocationCallOrder[0]);
    // 終了の流れ（before-quit）では、もう確認しない
    const event = fakeEvent();
    state.app.emit('before-quit', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
  });
});

describe('終了', () => {
  const live = [
    { id: 's1', title: 'メニューを直す', state: '作業中' },
    { id: 's2', title: '在庫の画面', state: '待機中' },
  ];
  const quitOnce = () => {
    const event = fakeEvent();
    state.app.emit('before-quit', event);
    return event;
  };

  it('Claude Code が動いていなければ、確認せずに、Claude Code と pty ホストも止めて終了する', async () => {
    await boot();
    expect(quitOnce().preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(manager().closeAll.mock.calls).toEqual([[true]]);
    expect(state.ptyHost.shutdown).toHaveBeenCalledTimes(1);
  });

  it('動いているセッションがあれば、止めるか確認する。「動かしたまま終了」なら、止めずに終了する', async () => {
    await boot();
    manager().liveSessions.mockReturnValue(live);
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    quitOnce();
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    const [win, options] = state.dialog.showMessageBox.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(win).toBe(mainWindow());
    expect(options).toEqual({
      type: 'question',
      message: 'Claude Code が動いているセッションがあります',
      detail: [
        '・メニューを直す（作業中）',
        '・在庫の画面（待機中）',
        '',
        '止めると、作業は途中で切れ、Remote Control からも続けられなくなります。動かしたまま終了すると、次に起動したときに引き継ぎます。',
      ].join('\n'),
      buttons: ['動かしたまま終了', 'Claude Code も止めて終了', 'キャンセル'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    expect(manager().closeAll).not.toHaveBeenCalledWith(true);
    expect(state.ptyHost.shutdown).not.toHaveBeenCalled();
    // 決めたあとの終了の流れでは、見るのをやめるだけ（Claude Code は止めない）
    const event = quitOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(manager().closeAll.mock.calls).toEqual([[false]]);
  });

  it('「Claude Code も止めて終了」なら、止めてから終了する', async () => {
    await boot();
    manager().liveSessions.mockReturnValue(live);
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    quitOnce();
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    expect(manager().closeAll.mock.calls).toEqual([[true]]);
    expect(state.ptyHost.shutdown).toHaveBeenCalledTimes(1);
  });

  it('「キャンセル」なら終了しない。確認を出している間の終了は、確認を重ねない。答えたあとは、また確認する', async () => {
    await boot();
    manager().liveSessions.mockReturnValue(live);
    const answer = pending<{ response: number }>();
    state.dialog.showMessageBox.mockReturnValueOnce(answer.promise);
    quitOnce();
    quitOnce();
    await vi.waitFor(() => expect(state.dialog.showMessageBox).toHaveBeenCalledTimes(1));
    answer.resolve({ response: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(state.quit).not.toHaveBeenCalled();
    expect(manager().closeAll).not.toHaveBeenCalled();
    expect(quitOnce().preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(state.dialog.showMessageBox).toHaveBeenCalledTimes(2));
  });

  it('ウインドウが無い・壊れているときは、確認を単独で出す', async () => {
    await boot();
    manager().liveSessions.mockReturnValue(live);
    mainWindow().destroyed = true;
    quitOnce();
    await vi.waitFor(() => expect(state.dialog.showMessageBox).toHaveBeenCalledTimes(1));
    expect(state.dialog.showMessageBox.mock.calls[0]).toHaveLength(1);
  });

  it('終了するときに、見張り・監視・待ち受け・シェルを片付ける（Claude Code は止めない）', async () => {
    await boot();
    state.powerMonitor.emit('shutdown');
    const event = quitOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(the('StatusLineWatcher').close).toHaveBeenCalledTimes(1);
    expect(the('SystemMonitor').stop).toHaveBeenCalledTimes(1);
    expect(the('ClaudeVersionMonitor').stop).toHaveBeenCalledTimes(1);
    expect(the('AppUpdateMonitor').stop).toHaveBeenCalledTimes(1);
    expect(manager().closeAll.mock.calls).toEqual([[false]]);
    expect(state.ptyHost.close).toHaveBeenCalledTimes(1);
    expect(state.ptyHost.shutdown).not.toHaveBeenCalled();
    for (const bridge of allOf('McpBridge')) expect(bridge.instance.close).toHaveBeenCalledTimes(1);
    expect(the('SessionsControl').dispose).toHaveBeenCalledTimes(1);
    expect(the('ScheduledMessages').dispose).toHaveBeenCalledTimes(1);
    expect(the('ChecklistControl').dispose).toHaveBeenCalledTimes(1);
    expect(the('ChecklistStore').flush).toHaveBeenCalledTimes(1);
    expect(the('ShellTerminals').killAll).toHaveBeenCalledTimes(1);
  });

  it('待ち受けを始められなかったものがあっても、終了の片付けは止まらない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await boot({ before: (s) => ['browser.sock', 'sessions.sock', 'checklist.sock', 'walkthrough.sock'].forEach((f) => s.failingSockets.add(f)) });
    state.powerMonitor.emit('shutdown');
    expect(() => quitOnce()).not.toThrow();
    expect(the('ShellTerminals').killAll).toHaveBeenCalledTimes(1);
    for (const bridge of allOf('McpBridge')) expect(bridge.instance.close).not.toHaveBeenCalled();
  });

  it('起動のごく初め（待ち受けを始めている途中）に終われと言われても、片付けは止まらない', async () => {
    const listening = pending<undefined>();
    await boot({ noWait: true, before: (s) => s.bridgeStart.mockReturnValue(listening.promise) });
    await vi.waitFor(() => expect(state.bridgeStart).toHaveBeenCalled());
    state.powerMonitor.emit('shutdown');
    expect(() => quitOnce()).not.toThrow();
    expect(the('StatusLineWatcher').close).toHaveBeenCalledTimes(1);
    expect(the('ChecklistStore').flush).toHaveBeenCalledTimes(1);
    expect(the('ShellTerminals').killAll).toHaveBeenCalledTimes(1);
  });

  it('Electron の準備ができる前に終われと言われたら、確認せずに終了し、片付けも止まらない', async () => {
    const ready = pending<undefined>();
    await boot({ noWait: true, before: (s) => s.whenReady.mockReturnValue(ready.promise) });
    expect(quitOnce().preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(state.ptyHostStart).not.toHaveBeenCalled();
    expect(() => quitOnce()).not.toThrow();
    // プロファイル（シェル・statusLine など）はまだ作っていないので、片付けるものも無い
    expect(allOf('ShellTerminals')).toHaveLength(0);
    expect(allOf('StatusLineWatcher')).toHaveLength(0);
  });

  it('Mac の再起動・シャットダウンでは、確認を出さずに終わる', async () => {
    await boot();
    manager().liveSessions.mockReturnValue(live);
    state.powerMonitor.emit('shutdown');
    expect(quitOnce().preventDefault).not.toHaveBeenCalled();
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('バツボタンで閉じたら、アプリも終了する（終了の確認へ）。終了が決まっていれば、そのまま閉じる', async () => {
    await boot();
    const close = fakeEvent();
    mainWindow().emit('close', close);
    expect(close.preventDefault).toHaveBeenCalled();
    expect(state.quit).toHaveBeenCalledTimes(1);
    state.powerMonitor.emit('shutdown');
    const closeAgain = fakeEvent();
    mainWindow().emit('close', closeAgain);
    expect(closeAgain.preventDefault).not.toHaveBeenCalled();
    expect(state.quit).toHaveBeenCalledTimes(1);
  });

  it('前のウインドウの closed では、今のウインドウを手放さない', async () => {
    await boot();
    const first = mainWindow();
    first.emit('closed');
    state.app.emit('activate');
    const second = mainWindow();
    first.emit('closed');
    callbacks().onSessionsChanged([]);
    expect(second.webContents.sent).toEqual([[IpcChannel.SessionsChanged, []]]);
  });

  it('ウインドウを全部閉じたとき、macOS では終了しない（ほかの OS では終了する）', async () => {
    await boot();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      state.app.emit('window-all-closed');
      expect(state.quit).not.toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: 'linux' });
      state.app.emit('window-all-closed');
      expect(state.quit).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('起動の途中（pty ホストを待っている間）に終了したら、止めるものが無いので、そのまま終了する', async () => {
    const host = pending<Record<string, unknown>>();
    await boot({ noWait: true, before: (s) => s.ptyHostStart.mockReturnValue(host.promise as never) });
    await vi.waitFor(() => expect(state.ptyHostStart).toHaveBeenCalled());
    expect(quitOnce().preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    expect(state.ptyHost.shutdown).not.toHaveBeenCalled();
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
    // 片付けは、作っていないものを飛ばす
    expect(() => quitOnce()).not.toThrow();
    host.resolve(state.ptyHost);
  });
});

describe('Homebrew での更新', () => {
  const live = [{ id: 's1', title: 'メニューを直す', state: '作業中' }];
  const quitOnce = () => {
    const event = fakeEvent();
    state.app.emit('before-quit', event);
    return event;
  };
  // Homebrew で入れたアプリの更新の作り物。既定は、新しいバージョンをダウンロード済み
  const updater = (status: Record<string, unknown> | null = { status: 'ready', version: '9.9.0' }): Fake => ({
    get: vi.fn(() => status),
    want: vi.fn(),
    stop: vi.fn(),
    upgradeAfterExit: vi.fn(() => true),
  });
  const bootWith = async (u: Fake | null, settings?: Record<string, unknown>) => {
    await boot({ packaged: true, settings, before: (s) => (s.homebrew = u) });
    await vi.waitFor(() => expect(state.homebrewDetect).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
  };
  const upgrade = () => state.homebrew!.upgradeAfterExit;

  it('パッケージしたアプリなら、動いている .app と今のバージョンで、Homebrew で入れたかを確かめる', async () => {
    await boot();
    expect(state.homebrewDetect).not.toHaveBeenCalled();
    await bootWith(updater());
    const [options] = state.homebrewDetect.mock.calls[0] as [{ bundle: string; current: string }];
    expect(options.bundle).toBe(resolve(process.execPath, '../../..'));
    expect(options.current).toBe('9.8.7');
  });

  it('新しいバージョンが出たら用意を頼み、画面には用意の様子を足して知らせる（新しくなければ足さない）', async () => {
    await bootWith(updater());
    fnArg('AppUpdateMonitor', 1)({ latest: '9.9.0', available: true, url: 'u' });
    fnArg('AppUpdateMonitor', 1)({ latest: '9.8.7', available: false, url: 'u' });
    expect(state.homebrew!.want.mock.calls.slice(-2)).toEqual([['9.9.0'], ['9.8.7']]);
    expect(sentToRenderer(IpcChannel.AppUpdateChanged)).toEqual([
      { latest: '9.9.0', available: true, url: 'u', homebrew: { status: 'ready', version: '9.9.0' } },
      { latest: '9.8.7', available: false, url: 'u' },
    ]);
  });

  it('「再起動して更新」: Claude Code が動いていなければ、そのまま終了し、入れ替えてから起動し直す', async () => {
    await bootWith(updater());
    await invoke(IpcChannel.AppUpdateInstall);
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(state.quit).toHaveBeenCalledTimes(1);
    expect(manager().closeAll).not.toHaveBeenCalledWith(true);
    quitOnce();
    expect(upgrade()).toHaveBeenCalledWith({
      pid: process.pid,
      log: join(state.userData, 'homebrew-update.log'),
      result: join(state.userData, 'homebrew-update.result'),
      relaunch: true,
    });
  });

  it('「再起動して更新」: Claude Code が動いていれば、止めるかを聞く。キャンセルなら何もしない', async () => {
    await bootWith(updater());
    manager().liveSessions.mockReturnValue(live);
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 2 });
    await invoke(IpcChannel.AppUpdateInstall);
    const [, options] = state.dialog.showMessageBox.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options.buttons).toEqual(['動かしたまま更新', 'Claude Code も止めて更新', 'キャンセル']);
    expect(String(options.detail)).toContain('・メニューを直す（作業中）');
    expect(state.quit).not.toHaveBeenCalled();

    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await invoke(IpcChannel.AppUpdateInstall);
    expect(manager().closeAll.mock.calls).toEqual([[true]]);
    expect(state.ptyHost.shutdown).toHaveBeenCalledTimes(1);
    expect(state.quit).toHaveBeenCalledTimes(1);
  });

  it('言語を変えて「今すぐ再起動」したときも、終了で入れ替えるなら、入れ替えたあとに起動し直す（先に起動しない）', async () => {
    await bootWith(updater());
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const english = menuItem('English');
    english.click?.(english);
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    quitOnce();
    expect(upgrade()).toHaveBeenCalledWith(expect.objectContaining({ relaunch: true }));
    expect(state.relaunch).not.toHaveBeenCalled();
  });

  it('「再起動して更新」: ダウンロードが済んでいない・Homebrew で入れていないなら、何もしない', async () => {
    await bootWith(updater({ status: 'downloading' }));
    await invoke(IpcChannel.AppUpdateInstall);
    await bootWith(null);
    await invoke(IpcChannel.AppUpdateInstall);
    expect(state.quit).not.toHaveBeenCalled();
  });

  it('ダウンロード済みなら、ふつうの終了でも入れ替える（起動し直さない）。終了の確認にも書く', async () => {
    await bootWith(updater());
    manager().liveSessions.mockReturnValue(live);
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    quitOnce();
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    const [, options] = state.dialog.showMessageBox.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(String(options.detail)).toContain('終了すると、Homebrew で新しいバージョンに入れ替えます。');
    quitOnce();
    expect(upgrade()).toHaveBeenCalledWith(expect.objectContaining({ relaunch: false }));
    expect(state.homebrew!.stop).toHaveBeenCalled();
  });

  it.each([
    ['「終了するときに新しいバージョンを入れる」がオフ', { updateOnQuit: false }],
    ['「新しいバージョンが出たら通知する」がオフ', { updateCheck: false }],
  ])('%sなら、ふつうの終了では入れ替えない', async (_label, settings) => {
    await bootWith(updater(), settings);
    quitOnce();
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1));
    quitOnce();
    expect(upgrade()).not.toHaveBeenCalled();
  });

  it('Mac の再起動・シャットダウンでは入れ替えない', async () => {
    await bootWith(updater());
    state.powerMonitor.emit('shutdown');
    quitOnce();
    expect(upgrade()).not.toHaveBeenCalled();
  });

  it('前回の入れ替えが失敗していたら、ログの終わりと手動の手順を知らせ、ログを開ける。結果は一度だけ見る', async () => {
    const write = (result: string) => (s: typeof state) => {
      mkdirSync(s.userData, { recursive: true });
      writeFileSync(join(s.userData, 'homebrew-update.result'), `${result}\n`);
      writeFileSync(join(s.userData, 'homebrew-update.log'), 'v9.9.0 に更新します\nError: Operation not permitted\n');
    };
    await boot({ before: (s) => (write('1')(s), s.dialog.showMessageBox.mockResolvedValue({ response: 1 })) });
    await vi.waitFor(() => expect(state.shell.openPath).toHaveBeenCalledWith(join(state.userData, 'homebrew-update.log')));
    const [, options] = state.dialog.showMessageBox.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options.message).toBe('tanacode を更新できませんでした');
    expect(String(options.detail)).toContain('Error: Operation not permitted');
    expect(String(options.detail)).toContain('brew update && brew upgrade --cask sny-tanaka/tanacode/tanacode');
    expect(existsSync(join(state.userData, 'homebrew-update.result'))).toBe(false);

    await boot({ before: write('0') });
    await vi.waitFor(() => expect(existsSync(join(state.userData, 'homebrew-update.result'))).toBe(false));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
  });
});
