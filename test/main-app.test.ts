import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import { sessionToolId } from '@shared/session-tools';
import { IpcChannel } from '@shared/ipc';
import { textResult } from '../src/main/mcp-bridge';
import { menuNotice, scheduledNotice } from '../src/main/notice-text';
import { formatScheduleTime } from '@shared/scheduled';
import {
  allOf,
  argsOf,
  boot,
  cleanup,
  fakeEvent,
  type Fake,
  FakeWebContents,
  FakeWindow,
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
  claudeDir: 12,
  terminalLaunch: 13,
} as const;
const managerArgs = () => argsOf('SessionManager');
// アプリが待ち受けるソケット（userData の中の名前）
const SOCKETS = ['browser.sock', 'sessions.sock', 'checklist.sock', 'walkthrough.sock', 'terminal.sock'];
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
    expect(argsOf('ClaudeCompatMonitor')[1]).toBe(u('claude-compat.json'));
    expect(allOf('McpBridge').map((c) => c.args[0])).toEqual([
      u('browser.sock'),
      u('sessions.sock'),
      u('checklist.sock'),
      u('walkthrough.sock'),
      u('terminal.sock'),
    ]);
    expect(state.ptyHostStart.mock.calls).toEqual([[state.userData, join(MAIN_DIR, 'pty-host.js')]]);
    // SessionManager には、pty ホスト・会話の一覧・監視を渡す
    const args = managerArgs();
    expect(args[managerArg.ptyHost]).toBe(state.ptyHost);
    expect(args[managerArg.store]).toBe(the('SessionStore'));
    expect(args[managerArg.watchers]).toBe(the('WorkspaceWatchers'));
    expect(args[managerArg.statusLines]).toBe(the('StatusLineWatcher'));
    expect(args[managerArg.settingsFiles]).toBe(the('SettingsFiles'));
  });

  it('同じ userData のアプリがもう動いていたら（2 つめの起動）、何も作らずに、確かめずに終える', async () => {
    await boot({ before: (s) => (s.singleInstanceLock = false) });
    expect(state.quit).toHaveBeenCalledTimes(1);
    // 終わるときに、Claude Code を止めるかの確認を出さない
    state.app.emit('before-quit', fakeEvent());
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.ptyHostStart).not.toHaveBeenCalled();
    expect(state.handlers.size).toBe(0);
    expect(state.windows).toHaveLength(0);
    expect(state.app.has('second-instance')).toBe(false);
  });

  it('2 つめを起動しようとしたら、動いているアプリのウインドウを前に出す（しまっていれば戻す）', async () => {
    await boot();
    const win = mainWindow();
    win.minimized = true;
    state.app.emit('second-instance', fakeEvent(), ['/Applications/tanacode.app/Contents/MacOS/tanacode'], '/');
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(state.quit).not.toHaveBeenCalled();
  });

  it('裏で起動した 2 つめ（TANACODE_BACKGROUND=1）からの知らせでは、前に出さない。ふつうに起動した 2 つめは、何も添えない', async () => {
    await boot();
    expect(state.requestSingleInstanceLock).toHaveBeenCalledWith(undefined);
    const win = mainWindow();
    win.minimized = true;
    state.app.emit('second-instance', fakeEvent(), [], '/', { background: true });
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    // 添えたものが違えば、ふだんどおり前に出す
    state.app.emit('second-instance', fakeEvent(), [], '/', { background: 'yes' });
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('裏で起動したアプリは、2 つめになったときに、裏で起動したことを 1 つめに添える', async () => {
    await boot({
      before: (s) => {
        process.env.TANACODE_BACKGROUND = '1';
        s.singleInstanceLock = false;
      },
    });
    expect(state.requestSingleInstanceLock).toHaveBeenCalledWith({ background: true });
    expect(state.quit).toHaveBeenCalledTimes(1);
  });

  it('起動の途中に 2 つめが起動しても、ウインドウを先に作らない（作るのは起動の終わりの 1 枚だけ）。前に出す頼みは、ウインドウを作ったあとで行う', async () => {
    const adopting = pending<undefined>();
    await boot({ noWait: true, before: (s) => s.adopt.mockReturnValue(adopting.promise) });
    await vi.waitFor(() => expect(state.adopt).toHaveBeenCalled());
    state.app.emit('second-instance', fakeEvent(), [], '/');
    expect(state.windows).toHaveLength(0);
    adopting.resolve(undefined);
    await started();
    expect(state.windows).toHaveLength(1);
    // 起動を待つあいだにほかのアプリへ移っていても、ウインドウができたら前に出す
    expect(mainWindow().show).toHaveBeenCalledTimes(1);
    expect(mainWindow().focus).toHaveBeenCalledTimes(1);
    state.app.emit('second-instance', fakeEvent(), [], '/');
    expect(mainWindow().show).toHaveBeenCalledTimes(2);
    expect(state.windows).toHaveLength(1);
  });

  it('起動の途中に 2 つめが起動しなければ、ウインドウを作っても前に出す頼みはしない', async () => {
    await boot();
    expect(mainWindow().show).not.toHaveBeenCalled();
  });

  it('以前のレビュー機能が使っていたフォルダ（snapshots）を消す', async () => {
    await boot({ before: (s) => mkdirSync(join(s.userData, 'snapshots', 'old'), { recursive: true }) });
    await vi.waitFor(() => expect(existsSync(join(state.userData, 'snapshots'))).toBe(false));
  });

  it('開発中の起動では、Dock のアイコンをアプリのものにし、Remote Control を使わない。ログインシェルの PATH は使わない', async () => {
    await boot();
    expect(state.dock!.setIcon.mock.calls).toEqual([[join(state.appPath, 'build/icon.png')]]);
    expect(state.dock!.hide).not.toHaveBeenCalled();
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
    expect(sockets.map((path) => path.startsWith(`${tmpdir()}/`))).toEqual([true, true, true, true, true]);
    expect(sockets.map((path) => path.slice(tmpdir().length + 1).replace(/-[0-9a-f]{12}\.sock$/, ''))).toEqual([
      'tanacode-browser',
      'tanacode-sessions',
      'tanacode-checklist',
      'tanacode-walkthrough',
      'tanacode-terminal',
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
    // Claude Code の対応表も読まない（組み込んだバージョンで印を出す）
    expect(the('ClaudeCompatMonitor').start).not.toHaveBeenCalled();
    await boot();
    expect(the('AppUpdateMonitor').start).toHaveBeenCalledTimes(1);
    expect(the('ClaudeCompatMonitor').start).toHaveBeenCalledTimes(1);
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
  // メニューでオン・オフを切り替えるもの
  const launches = ['browserLaunch', 'sessionsLaunch', 'checklistLaunch', 'walkthroughLaunch', 'terminalLaunch'] as const;
  const launch = (name: (typeof launches)[number]) => (managerArgs()[managerArg[name]] as () => unknown)();

  it('どれも、同梱の Node で中継のスクリプトを動かし、userData のソケットにつなぐ', async () => {
    await boot();
    const scripts = ['browser-mcp.js', 'sessions-mcp.js', 'checklist-mcp.js', 'walkthrough-mcp.js', 'terminal-mcp.js'];
    const sockets = ['browser.sock', 'sessions.sock', 'checklist.sock', 'walkthrough.sock', 'terminal.sock'];
    launches.forEach((name, i) => {
      // ツールごとの許可の印のフォルダ（userData。アプリ全体で 1 つ）も渡す
      const permissionsDir = join(state.userData, 'tool-permissions');
      expect(launch(name)).toEqual({ command: '/fake/bin/node', script: join(MAIN_DIR, scripts[i]), socketPath: join(state.userData, sockets[i]), version: '9.8.7', permissionsDir });
    });
  });

  it('MCP の設定で切っているものは足さない（次に起動する Claude Code から）', async () => {
    await boot({ settings: { browserControl: false, sessionsControl: false, checklistControl: false, walkthroughControl: false, terminalControl: false } });
    for (const name of launches) expect(launch(name)).toBeNull();
    await invoke(IpcChannel.McpEnabledSet, 'checklist', true);
    expect(launch('checklistLaunch')).not.toBeNull();
  });

  it('待ち受けを始められなかったものは足さず、理由を出す。アプリはそのまま使える', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await boot({ before: (s) => SOCKETS.forEach((f) => s.failingSockets.add(f)) });
    for (const name of launches) expect(launch(name)).toBeNull();
    expect(error.mock.calls.map((c) => c[0])).toEqual([
      'アプリ内ブラウザの待ち受けを始められませんでした',
      'セッションの待ち受けを始められませんでした',
      'チェックリストの待ち受けを始められませんでした',
      'ウォークスルーの待ち受けを始められませんでした',
      'ターミナルの待ち受けを始められませんでした',
    ]);
    expect(state.windows).toHaveLength(1);
  });

  it('中継からの呼び出しは、それぞれの制御に渡す（中断の合図も）', async () => {
    await boot();
    const [browser, sessions, checklist, walkthrough, terminal] = allOf('McpBridge').map((c) => c.args[1] as (...args: unknown[]) => unknown);
    const signal = new AbortController().signal;
    // アプリ内ブラウザには、Claude Code が付けた呼び出しの ID も渡す（JavaScript の実行の確認と結びつける）
    expect(browser('s1', 'evaluate', { expression: '1' }, signal, 'toolu_1')).toEqual({ call: 'browser.handle', args: ['s1', 'evaluate', { expression: '1' }, signal, 'toolu_1'] });
    expect(sessions('s1', 'start_session', { prompt: 'x' }, signal)).toEqual({ call: 'sessionsControl.handle', args: ['s1', 'start_session', { prompt: 'x' }, signal] });
    expect(checklist('s1', 'card_add', { title: 'x' })).toEqual({ call: 'checklistControl.handle', args: ['s1', 'card_add', { title: 'x' }] });
    expect(walkthrough('s1', 'walkthrough_start', { steps: [] })).toEqual({ call: 'walkthrough.handle', args: ['s1', 'walkthrough_start', { steps: [] }] });
    expect(terminal('s1', 'read_terminal', { id: 'shell-1' }, signal)).toEqual({ call: 'terminalControl.handle', args: ['s1', 'read_terminal', { id: 'shell-1' }, signal] });
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
    const [, sessions, checklist, walkthrough, terminal] = allOf('McpBridge').map((c) => c.args[1] as (...args: unknown[]) => Promise<unknown>);
    const notYet = textResult('tanacode has not finished starting up. Wait a moment and try again.', true);
    await expect(sessions('s1', 'list_sessions', {}, new AbortController().signal)).resolves.toEqual(notYet);
    await expect(checklist('s1', 'list_get', {})).resolves.toEqual(notYet);
    await expect(walkthrough('s1', 'walkthrough_start', {})).resolves.toEqual(notYet);
    await expect(terminal('s1', 'list_terminals', {}, new AbortController().signal)).resolves.toEqual(notYet);
    host.resolve(state.ptyHost);
    await started();
  });
});

describe('部品から画面への知らせ', () => {
  it.each([
    ['onSessionsChanged', [[{ id: 's1' }]], IpcChannel.SessionsChanged, [{ id: 's1' }]],
    ['onChat', [{ sessionId: 's1', events: [] }], IpcChannel.ChatEvents, { sessionId: 's1', events: [] }],
    ['onPtyData', ['s1', 'ターミナルの出力'], IpcChannel.PtyData, { sessionId: 's1', data: 'ターミナルの出力' }],
    ['onProgress', ['s1', { phase: 'thinking' }], IpcChannel.SessionsProgress, { sessionId: 's1', activity: { phase: 'thinking' } }],
    ['onWorkflows', ['s1', [{ id: 'w' }]], IpcChannel.WorkflowsChanged, { sessionId: 's1', runs: [{ id: 'w' }] }],
    ['onSubagents', ['s1', [{ id: 'a' }]], IpcChannel.SubagentsChanged, { sessionId: 's1', runs: [{ id: 'a' }] }],
    ['onBashTasks', ['s1', [{ id: 'b' }]], IpcChannel.TasksBashChanged, { sessionId: 's1', tasks: [{ id: 'b' }] }],
    ['onKnowledge', ['s1', { files: {} }], IpcChannel.KnowledgeChanged, { sessionId: 's1', knowledge: { files: {} } }],
    ['onStatusLine', ['s1', { model: 'opus' }], IpcChannel.StatusLineChanged, { sessionId: 's1', info: { model: 'opus' } }],
    ['onQuestion', ['s1', { id: 'q1' }], IpcChannel.QuestionChanged, { sessionId: 's1', question: { id: 'q1' } }],
  ])('セッションの %s は、%s で送る', async (name, args, channel, payload) => {
    await boot();
    callbacks()[name](...(args as unknown[]));
    expect(sentToRenderer()).toEqual([[channel, payload]]);
  });

  it('ほかの部品の知らせ（ファイル・設定ファイル・チェックリスト・予約・ウォークスルー・使用量・バージョン・更新・負荷・シェル）', async () => {
    await boot();
    fnArg('WorkspaceWatchers', 0)('/work', ['a.ts']);
    // エディタで開いている、フォルダの外のファイル（ファイルごとの見張り）も、同じ形で送る
    fnArg('OpenFileWatchers', 1)('/outside', ['memo.md']);
    // フォルダの監視が増えた・減ったら、ファイルごとに見張るタブを決め直させる。決め直すときは、今見張っているフォルダを聞く
    fnArg('WorkspaceWatchers', 1)();
    expect(the('OpenFileWatchers').rootsChanged).toHaveBeenCalledTimes(1);
    fnArg('OpenFileWatchers', 0)();
    expect(the('WorkspaceWatchers').roots).toHaveBeenCalledTimes(1);
    fnArg('SettingsFiles', 2)([{ id: 'f1' }]);
    fnArg('ChecklistStore', 1)('s1', [{ id: 'l1' }]);
    fnArg('ScheduledMessages', 2)([{ id: 'm1' }]);
    // 予約が変わったら、親の再開の予約を待って預かっている子の知らせを見直させる
    expect(the('SessionsControl').scheduledChanged).toHaveBeenCalledTimes(1);
    optionsOf('WalkthroughControl').onChange('s1', { id: 'w1' });
    fnArg('UsageMonitor', 1)({ fiveHour: 10 });
    fnArg('ClaudeVersionMonitor', 0)('2.1.300');
    fnArg('ClaudeCompatMonitor', 2)('2.1.301');
    fnArg('AppUpdateMonitor', 1)({ latest: '9.9.0' });
    fnArg('SystemMonitor', 0)({ cpu: 1 });
    const shells = optionsOf('ShellTerminals');
    shells.onData('sh1', 'ls');
    shells.onExit('sh1', 0);
    shells.onOpened('s1', 'task-2', 'npm install', true);
    shells.onOpened('s1', 'shell-3', 'zsh', false);
    expect(sentToRenderer()).toEqual([
      [IpcChannel.FilesChanged, { root: '/work', paths: ['a.ts'] }],
      [IpcChannel.FilesChanged, { root: '/outside', paths: ['memo.md'] }],
      [IpcChannel.SettingsFilesChanged, [{ id: 'f1' }]],
      [IpcChannel.ChecklistChanged, { sessionId: 's1', lists: [{ id: 'l1' }] }],
      [IpcChannel.ScheduledChanged, [{ id: 'm1' }]],
      [IpcChannel.WalkthroughChanged, { sessionId: 's1', walkthrough: { id: 'w1' } }],
      [IpcChannel.UsageChanged, { fiveHour: 10 }],
      [IpcChannel.ClaudeVersionChanged, '2.1.300'],
      [IpcChannel.ClaudeVerifiedChanged, '2.1.301'],
      [IpcChannel.AppUpdateChanged, { latest: '9.9.0' }],
      [IpcChannel.SystemStats, { cpu: 1 }],
      [IpcChannel.ShellData, { id: 'sh1', data: 'ls' }],
      [IpcChannel.ShellExit, { id: 'sh1', exitCode: 0 }],
      [IpcChannel.ShellOpened, { owner: 's1', id: 'task-2', name: 'npm install', task: true }],
      [IpcChannel.ShellOpened, { owner: 's1', id: 'shell-3', name: 'zsh', task: false }],
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

  it('statusLine のファイルは、セッションに渡す。セッションが知らせた statusLine（ファイルからも stream-json からも）は、使用量に渡す。書くだけのフックのファイルも、セッションに渡す', async () => {
    await boot();
    const info = { model: 'opus', rateLimits: {} };
    fnArg('StatusLineWatcher', 1)('s1', info);
    expect(manager().statusLineChanged.mock.calls).toEqual([['s1', info]]);
    expect(the('UsageMonitor').fromStatusLine.mock.calls).toEqual([]);
    callbacks().onStatusLine('s1', info);
    expect(the('UsageMonitor').fromStatusLine.mock.calls).toEqual([[info]]);
    fnArg('StatusLineWatcher', 2)('s1', { tool_name: 'Bash' }, 5);
    expect(manager().permissionRequested.mock.calls).toEqual([['s1', { tool_name: 'Bash' }, 5]]);
    fnArg('StatusLineWatcher', 3)('s1', { permission_mode: 'plan' });
    expect(manager().tuiStopHook.mock.calls).toEqual([['s1', { permission_mode: 'plan' }]]);
  });

  it('セッションのフォルダで、Claude が頼んだコマンドをターミナルで動かす', async () => {
    await boot();
    const run = managerArgs()[managerArg.runShell] as (...args: unknown[]) => unknown;
    // 入力を待っているように見えたときの知らせ（onWaiting）も渡す
    const onWaiting = () => {};
    expect(run('s1', '/work', 'npm test', 'テスト', onWaiting)).toEqual({ call: 'shells.run', args: ['s1', '/work', 'npm test', 'テスト', onWaiting] });
  });

  it('アーカイブした・一覧から消したセッションの予約とウォークスルーは捨てる。ほかの状態の変化では捨てない', async () => {
    await boot();
    const watch = manager().watchState.mock.calls[0][0] as (id: string) => void;
    const states: Record<string, string | null> = { s1: 'archived', s2: null, s3: 'idle' };
    manager().stateOf.mockImplementation((id: string) => states[id]);
    for (const id of ['s1', 's2', 's3']) watch(id);
    expect(the('ScheduledMessages').dropSession.mock.calls).toEqual([['s1'], ['s2']]);
    expect(the('WalkthroughControl').discard.mock.calls).toEqual([['s1'], ['s2']]);
    expect(the('UsageLimitResume').forget.mock.calls).toEqual([['s1'], ['s2']]);
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
    // 制御の部品には、最適化圧縮の流れの間は「作業中」に見える manager を渡す（outward-state.ts）。ほかは、manager をそのまま呼ぶ
    const host = checklist.host as unknown as { cwdOf(id: string): string; stateOf(id: string): string };
    expect(host.cwdOf('s1')).toBe('/sessions/s1');
    expect(host.stateOf('s1')).toBe('idle');
    expect(checklist.enabled()).toBe(false);
    const sessions = optionsOf('SessionsControl');
    expect(sessions.host).toBe(checklist.host);
    expect(sessions.compacting('s1')).toBe(false);
    // 流れが /clear を打っているときだけ、reset に印を付ける
    expect(manager().compactClearing('s1')).toBe(false);
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
      throttle: IpcChannel.BrowserThrottle,
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

  it('最適化圧縮の流れの最後のターン（引き継いで、報告して待つ）が終わったら、コンテキストの最適化の完了として知らせる', async () => {
    await boot();
    callbacks().onTurnCompleted(session, 'compact');
    callbacks().onTurnCompleted(session, 'work');
    expect(state.notifications.map((n) => n.options.body)).toEqual(['コンテキストの最適化が完了しました', '作業が完了しました']);
  });

  it('最適化圧縮の流れの途中でターンが終わっても、完了を知らせない。そのあと切り替えられなかったら、取りやめたことを知らせる', async () => {
    await boot();
    // 流れの外では、ふつうの完了
    expect(manager().turnNotice('s1', 'other')).toBe('work');
    expect(manager().turnNotice('s1', 'resume')).toBe('compact');
    manager().summary.mockImplementation((id: string) => (id === 's1' ? { id, title: 'メニューを直す' } : undefined));
    let fail = (): void => undefined;
    Object.assign(manager(), {
      hasChecklistMcp: vi.fn(() => true),
      conversation: vi.fn(async () => []),
      // 仕上げの頼みを打っている途中で止めておく
      submitWhenReady: vi.fn(() => new Promise<void>((_resolve, reject) => (fail = () => reject(new Error('busy'))))),
    });
    await invoke(IpcChannel.CompactStart, 's1');
    await vi.waitFor(() => expect(manager().submitWhenReady).toHaveBeenCalledTimes(1));
    // 流れの途中の、仕上げのターンの終わり（このあと /clear）
    expect(manager().turnNotice('s1', 'handoff')).toBeNull();
    expect(manager().turnNotice('s2', 'other')).toBe('work');
    expect(state.notifications).toHaveLength(0);
    fail();
    await vi.waitFor(() => expect(state.notifications).toHaveLength(1));
    expect(state.notifications[0].options).toEqual({ title: 'tanacode', subtitle: 'メニューを直す', body: 'コンテキストの最適化を取りやめました', sound: 'Glass' });
    // 流れが終わったあとのターンは、作業の完了
    expect(manager().turnNotice('s1', 'other')).toBe('work');
  });

  it('流れの途中で出さなかった通知が無ければ、取りやめても知らせない（ボタンの左の札だけ）', async () => {
    await boot();
    Object.assign(manager(), { hasChecklistMcp: vi.fn(() => true), conversation: vi.fn(async () => []), submitWhenReady: vi.fn(async () => Promise.reject(new Error('busy'))) });
    await invoke(IpcChannel.CompactStart, 's1');
    await vi.waitFor(() => expect(sentToRenderer(IpcChannel.CompactChanged).some((p) => (p as { status: { failure: string | null } }).status.failure === 'busy')).toBe(true));
    expect(state.notifications).toHaveLength(0);
  });

  it('操作を待っているときは、確認の中身を知らせる', async () => {
    await boot();
    const menu = { kind: 'question', title: 'どちらにしますか？', options: [] };
    callbacks().onAttention(session, { kind: 'menu', menu });
    expect(state.notifications.map((n) => n.options.body)).toEqual([menuNotice(menu as never)]);
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

  describe('Claude の報告（report_result）と、自分への予約', () => {
    // SessionsControl に渡した、報告を預ける関数
    const report = (id: string, text: string) => optionsOf('SessionsControl').report(id, text);
    const bodies = () => state.notifications.map((n) => n.options.body);
    // セッションの状態が変わったことを、見張っている先に知らせる（profile.ts の manager.watchState）
    const stateChanges = (id: string, ...states: string[]) => {
      for (const s of states) {
        manager().stateOf.mockReturnValue(s);
        for (const [listener] of manager().watchState.mock.calls as [(id: string) => void][]) listener(id);
      }
    };

    it('報告があれば、ふつうの完了の通知の代わりに、報告を本文にして知らせる。使ったら捨てる', async () => {
      await boot();
      report('s1', 'ログイン画面を直しました。テストも通っています。');
      callbacks().onTurnCompleted(session, 'work');
      callbacks().onTurnCompleted(session, 'work');
      expect(state.notifications.map((n) => n.options)).toEqual([
        { title: 'tanacode', subtitle: 'メニューを直す', body: 'ログイン画面を直しました。テストも通っています。', sound: 'Glass' },
        { title: 'tanacode', subtitle: 'メニューを直す', body: '作業が完了しました', sound: 'Glass' },
      ]);
    });

    it('長い報告は、通知の長さで切る。最適化圧縮の流れの最後のターンでも、報告があれば報告にする。ほかのセッションの報告は使わない', async () => {
      await boot();
      report('s1', `${'あ'.repeat(150)}`);
      report('s2', 'ほかのセッションの報告');
      callbacks().onTurnCompleted(session, 'compact');
      callbacks().onTurnCompleted(session, 'compact');
      expect(bodies()).toEqual([`${'あ'.repeat(100)}…`, 'コンテキストの最適化が完了しました']);
    });

    it('出さないとき（通知をオフ・子セッション・見ているセッション）も、報告は使って捨てる', async () => {
      await boot({ settings: { notifications: false } });
      report('s1', '報告');
      callbacks().onTurnCompleted(session, 'work');
      expect(state.notifications).toHaveLength(0);

      await boot();
      manager().parentOf.mockImplementation((id: string) => (id === 'child' ? 'parent' : null));
      report('child', '子の報告');
      callbacks().onTurnCompleted({ id: 'child', title: '子' }, 'work');
      expect(state.notifications).toHaveLength(0);

      manager().isFocused.mockImplementation((id: string) => id === 's1');
      mainWindow().focused = true;
      report('s1', '見ている間の報告');
      callbacks().onTurnCompleted(session, 'work');
      expect(state.notifications).toHaveLength(0);
      mainWindow().focused = false;
      callbacks().onTurnCompleted(session, 'work');
      expect(bodies()).toEqual(['作業が完了しました']);
    });

    it('新しいターンが始まったら、前のターンの報告は捨てる。質問・許可の確認から作業に戻ったのは同じターンなので捨てない', async () => {
      await boot();
      stateChanges('s1', 'working');
      report('s1', '同じターンの報告');
      stateChanges('s1', 'permission', 'working', 'browser', 'working');
      callbacks().onTurnCompleted(session, 'work');
      // 使われずに残った報告（通知を出さないターンの終わりなど）は、次のターンが始まったら捨てる
      report('s1', '古い報告');
      stateChanges('s1', 'idle', 'working');
      callbacks().onTurnCompleted(session, 'work');
      // Claude Code が終わった・アーカイブしたときも捨てる
      report('s1', '終わる前の報告');
      stateChanges('s1', 'exited');
      callbacks().onTurnCompleted(session, 'work');
      expect(bodies()).toEqual(['同じターンの報告', '作業が完了しました', '作業が完了しました']);
    });

    it('報告を預けたかを SessionManager に伝える（バックグラウンドのタスクが動いていても、報告があれば通知させる）', async () => {
      await boot();
      expect(manager().turnReported('s1')).toBe(false);
      report('s1', '報告');
      expect(manager().turnReported('s1')).toBe(true);
      expect(manager().turnReported('s2')).toBe(false);
      callbacks().onTurnCompleted(session, 'work');
      expect(manager().turnReported('s1')).toBe(false);
    });

    it('自分への予約が待っている間は、報告が無ければ、作業の完了を知らせない（最適化の完了は知らせる）', async () => {
      await boot();
      the('ScheduledMessages').hasClaudeWakeup.mockImplementation((id: string) => id === 's1');
      callbacks().onTurnCompleted(session, 'work');
      callbacks().onTurnCompleted({ id: 's2', title: 'ほか' }, 'work');
      callbacks().onTurnCompleted(session, 'compact');
      report('s1', '子を待っています。5 分後に見に行きます。');
      callbacks().onTurnCompleted(session, 'work');
      expect(bodies()).toEqual(['作業が完了しました', 'コンテキストの最適化が完了しました', '子を待っています。5 分後に見に行きます。']);
      expect(state.notifications[0]!.options.subtitle).toBe('ほか');
    });

    it('SessionsControl に、予約（あとから作る）を取り出す関数を渡す', async () => {
      await boot();
      expect(optionsOf('SessionsControl').scheduled()).toBe(the('ScheduledMessages'));
    });

    it('利用枠で止まったターンは、作業の完了ではなく、いつ再開するか（再開しないなら、枠がいつ戻るか）を知らせる。報告より先', async () => {
      await boot();
      const resumeAt = Date.now() + 61 * 60_000;
      const resetsAt = Date.now() + 60 * 60_000;
      const notices = new Map([
        ['s1', { resumeAt, resetsAt }],
        ['s2', { resumeAt: null, resetsAt }],
        ['s3', { resumeAt: null, resetsAt: null }],
      ]);
      the('UsageLimitResume').noticeOf.mockImplementation((id: string) => notices.get(id) ?? null);
      report('s1', '止まる前の報告');
      callbacks().onTurnCompleted(session, 'work');
      callbacks().onTurnCompleted({ id: 's2', title: 'ほか' }, 'compact');
      callbacks().onTurnCompleted({ id: 's3', title: 'ほか' }, 'work');
      callbacks().onTurnCompleted({ id: 's4', title: 'ほか' }, 'work');
      expect(bodies()).toEqual([
        `利用枠で止まりました。${formatScheduleTime(resumeAt)} に再開します`,
        `利用枠で止まりました。${formatScheduleTime(resetsAt)} に戻ります`,
        '利用枠で止まりました',
        '作業が完了しました',
      ]);
      // 止まったときの報告は、使って捨てる
      callbacks().onTurnCompleted({ id: 's1', title: 'メニューを直す' }, 'work');
      expect(bodies()).toHaveLength(5);
    });
  });

  it('利用枠の再開: ターンの終わり（onTurnLimit）を渡し、設定・ターミナルモード・親・予約を読ませる', async () => {
    await boot({ settings: { usageLimitResume: false } });
    const stop = { resetsAt: 1_800_000_000_000, window: 'five_hour' };
    callbacks().onTurnLimit?.('s1', stop);
    callbacks().onTurnLimit?.('s2', null);
    expect(the('UsageLimitResume').turnEnded.mock.calls).toEqual([
      ['s1', stop],
      ['s2', null],
    ]);
    const options = optionsOf('UsageLimitResume');
    expect(options.scheduled()).toBe(the('ScheduledMessages'));
    expect(options.enabled()).toBe(false);
    manager().summary.mockImplementation((id: string) => (id === 'tui' ? { id, terminal: true } : { id }));
    expect([options.terminal('tui'), options.terminal('chat')]).toEqual([true, false]);
    manager().parentOf.mockImplementation((id: string) => (id === 'child' ? 'parent' : null));
    expect([options.parentOf('child'), options.parentOf('parent')]).toEqual(['parent', null]);
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
    // 子セッションの予約は、SessionsControl が親に回したら、人には通知しない
    expect(the('SessionsControl').scheduledTrouble).toHaveBeenCalledWith(message);
    the('SessionsControl').scheduledTrouble.mockReturnValueOnce(true);
    fnArg('ScheduledMessages', 3)({ ...message, sessionId: 'child' });
    expect(state.notifications).toHaveLength(2);
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
      show: true,
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

  const inBackground = () => (process.env.TANACODE_BACKGROUND = '1');

  it('TANACODE_BACKGROUND=1 なら裏で起動する。Dock に出さず、ウインドウを画面に出さない。Dock や通知から前に出そうとしても、出さない', async () => {
    await boot({ before: inBackground });
    expect(state.dock!.hide).toHaveBeenCalledTimes(1);
    const win = mainWindow();
    expect(win.options.show).toBe(false);
    win.minimized = true;
    state.app.emit('activate');
    callbacks().onTurnCompleted({ id: 's1', title: '税率の計算' });
    state.notifications[0].emit('click');
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    // 前に出さないだけで、通知のクリックの続き（セッションを選ばせる）は動く
    expect(sentToRenderer(IpcChannel.SessionsSelect)).toEqual(['s1']);
    // ウインドウを閉じていれば作るが、それも出さない
    win.emit('closed');
    state.app.emit('activate');
    expect(state.windows).toHaveLength(2);
    expect(mainWindow().options.show).toBe(false);
    expect(mainWindow().show).not.toHaveBeenCalled();
  });

  it('TANACODE_BACKGROUND が 1 でなければ、ふだんどおり前に出す', async () => {
    await boot({ before: () => (process.env.TANACODE_BACKGROUND = '0') });
    expect(state.dock!.hide).not.toHaveBeenCalled();
    expect(mainWindow().options.show).toBe(true);
    state.app.emit('activate');
    expect(mainWindow().show).toHaveBeenCalledTimes(1);
  });

  it('Dock の無い環境でも、裏での起動は止まらない', async () => {
    await boot({
      before: (s) => {
        inBackground();
        s.dock = undefined;
      },
    });
    expect(mainWindow().options.show).toBe(false);
  });

  it('裏で起動したときは、最大化・フルスクリーンにしない（どちらも、ウインドウを画面に出す）。ウインドウの位置と大きさも覚え直さない', async () => {
    const maximized = { version: 1, bounds: { x: 100, y: 50, width: 1300, height: 800 }, maximized: true, fullScreen: false };
    await boot({ windowState: maximized, before: inBackground });
    expect(mainWindow().options).toMatchObject({ x: 100, y: 50, width: 1300, height: 800, fullscreen: false });
    expect(mainWindow().maximize).not.toHaveBeenCalled();
    // 最大化していないまま覚えると、次にふだんどおり起動したとき、最大化が解けてしまう
    for (const event of ['resized', 'moved', 'close']) mainWindow().emit(event, fakeEvent());
    expect(savedWindowState()).toEqual(maximized);
    await boot({ windowState: { ...maximized, fullScreen: true }, before: inBackground });
    expect(mainWindow().options.fullscreen).toBe(false);
    expect(mainWindow().maximize).not.toHaveBeenCalled();
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

  it('webview のページが新しいタブで開こうとしたら、アプリ内ブラウザのタブで開く。開けず、Claude の操作中でもなければ、ふだんのブラウザで開く', async () => {
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
    open({ url: 'https://example.test/operating', disposition: 'background-tab' });
    open({ url: 'mailto:me@example.test', disposition: 'foreground-tab' });
    expect(state.shell.openExternal).not.toHaveBeenCalled();
    open({ url: 'file:///tmp/a.html#https://example.test/', disposition: 'foreground-tab' });
    expect(state.shell.openExternal).not.toHaveBeenCalled();
    open({ url: 'https://example.test/outside', disposition: 'foreground-tab' });
    open({ url: 'http://localhost:8080/', disposition: 'background-tab' });
    expect(state.shell.openExternal.mock.calls).toEqual([['https://example.test/outside'], ['http://localhost:8080/']]);
  });

  it('webview のページにフォーカスがあっても、「移動」のショートカットを効かせる（ページに渡さず、画面に知らせる）。ほかのキーはページに渡す', async () => {
    await boot();
    const guest = new FakeWebContents();
    mainWindow().webContents.emit('did-attach-webview', fakeEvent(), guest);
    const press = (input: Partial<Electron.Input>) => {
      const event = fakeEvent();
      guest.emit('before-input-event', event, { type: 'keyDown', key: '', code: '', meta: false, control: false, shift: false, alt: false, ...input });
      return event.preventDefault.mock.calls.length > 0;
    };
    expect(press({ key: 'w', code: 'KeyW', meta: true })).toBe(true);
    expect(press({ key: 'Tab', code: 'Tab', control: true, shift: true })).toBe(true);
    expect(press({ key: '1', code: 'Digit1', meta: true })).toBe(true);
    // 離したキー・ショートカットでないキー（⌘C・⌥ を足したもの・修飾キーの無い Tab）は、ページのもの
    expect(press({ type: 'keyUp', key: 'w', code: 'KeyW', meta: true })).toBe(false);
    expect(press({ key: 'c', code: 'KeyC', meta: true })).toBe(false);
    expect(press({ key: 'w', code: 'KeyW', meta: true, alt: true })).toBe(false);
    expect(press({ key: 'Tab', code: 'Tab' })).toBe(false);
    // 押し続けたとき: タブの送りはくり返し、タブを閉じる・フォーカスの移動はくり返さない（ページにも渡さない）
    expect(press({ key: 'Tab', code: 'Tab', control: true, isAutoRepeat: true })).toBe(true);
    expect(press({ key: 'w', code: 'KeyW', meta: true, isAutoRepeat: true })).toBe(true);
    expect(press({ key: 'j', code: 'KeyJ', meta: true, isAutoRepeat: true })).toBe(true);
    expect(mainWindow().webContents.sent).toEqual([
      [IpcChannel.ShortcutRun, 'closeTab'],
      [IpcChannel.ShortcutRun, 'previousTab'],
      [IpcChannel.ShortcutRun, 'focusSessions'],
      [IpcChannel.ShortcutRun, 'nextTab'],
    ]);
  });

  it('webview のページが開くポップアップ（new-window）は、アプリ内ブラウザの外の別ウインドウで開く（window.opener をつなぐ）。http(s) でないものは開かない', async () => {
    await boot();
    const guest = new FakeWebContents();
    mainWindow().webContents.emit('did-attach-webview', fakeEvent(), guest);
    const browser = the('BrowserControl');
    const open = guest.windowOpenHandler!;
    const popup = open({ url: 'https://login.example.test/authorize', disposition: 'new-window', features: 'width=480,height=640,left=-500,closable=no' } as never) as {
      action: string;
      outlivesOpener: boolean;
      overrideBrowserWindowOptions: Record<string, unknown>;
      createWindow: (options: Record<string, unknown>) => unknown;
    };
    const secure = { nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webviewTag: false, disableDialogs: true };
    expect(popup.action).toBe('allow');
    expect(popup.outlivesOpener).toBe(true);
    expect(popup.overrideBrowserWindowOptions).toEqual({ webPreferences: secure });
    // 別ウインドウは、アプリが BrowserWindow で作る。ページの features（closable=no など）は渡さない。
    // tanacode のウインドウ（x=40 y=30 1400×900）がある画面（1920×1080）の中に詰める。上下の位置の指定が無ければ、ウインドウの真ん中
    const contents = new FakeWebContents();
    popup.createWindow({ webContents: contents, closable: false, x: -500, width: 480, height: 640 });
    // tanacode のウインドウにフォーカスが無い間は出さず、フォーカスが来たら、フォーカスを移さずに出す
    const popupWindow = state.windows.at(-1)!;
    expect(popupWindow.showInactive).not.toHaveBeenCalled();
    state.app.emit('browser-window-focus');
    expect(popupWindow.showInactive).toHaveBeenCalledTimes(1);
    expect(state.windows.at(-1)!.options).toEqual({ webContents: contents, show: false, x: 0, y: 160, width: 480, height: 640, backgroundColor: '#ffffff', webPreferences: secure });
    expect(browser.allowsPopup.mock.calls).toEqual([[guest, 'https://login.example.test/authorize']]);
    // Claude の操作で許していない先なら開かない
    browser.allowsPopup.mockReturnValueOnce(false);
    expect(open({ url: 'https://outside.test/', disposition: 'new-window', features: 'width=480,height=640' } as never)).toEqual({ action: 'deny' });
    expect(open({ url: 'file:///etc/hosts', disposition: 'new-window' })).toEqual({ action: 'deny' });
    expect(state.shell.openExternal).not.toHaveBeenCalled();
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
    expect(contents.windowOpenHandler).toBeNull();
  });

  it('プレビューのセッションのウインドウ（ページが開いたポップアップの別ウインドウ）にも、同じ見張りと新しいウインドウの扱いを付ける', async () => {
    await boot();
    const contents = new FakeWebContents();
    contents.session = state.partitions.get('persist:tanacode-preview');
    state.app.emit('web-contents-created', fakeEvent(), contents);
    expect(go(contents, 'will-navigate', 'file:///etc/hosts')).toBe('止める');
    expect(go(contents, 'will-redirect', 'blob:http://localhost/1')).toBe('止める');
    expect(go(contents, 'will-frame-navigate', 'https://example.test/')).toBe('通す');
    expect(contents.windowOpenHandler!({ url: 'mailto:me@example.test', disposition: 'new-window' })).toEqual({ action: 'deny' });
    expect(contents.windowOpenHandler!({ url: 'https://login.example.test/', disposition: 'new-window', features: 'width=480,height=640' } as never)).toMatchObject({ action: 'allow' });
  });
});

describe('メニュー', () => {
  const toggle = (id: string) => {
    const item = menuItem(id);
    item.checked = !item.checked;
    item.click?.(item);
    return item;
  };

  // 並びは id（役割・区切り）で見る。文言は en.json・ja.json のもの
  const shape = (items: MenuItem[]) => items.map((i) => i.id ?? i.role ?? i.type);

  it('アプリのメニュー: 更新 ／ MCP ／ Claude の自動の動きと送る文 ／ 言語 の順に、区切って並べる', async () => {
    await boot({ settings: { updateCheck: false, usageLimitResume: false } });
    const [appMenu, fileMenu, ...rest] = state.menu!;
    expect(appMenu.label).toBe('tanacode');
    expect(shape(appMenu.submenu!)).toEqual([
      'about',
      'separator',
      'notifyUpdates',
      'updateOnQuit',
      'separator',
      'mcpSettings',
      'separator',
      'usageLimitResume',
      'autoCompactPercent',
      'awayWait',
      'prompts',
      'separator',
      'language',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ]);
    // MCP の入り・切り・許す先・ツールの許可は、「MCP の設定…」のダイアログで変える（メニューにチェックを置かない）
    expect(menuItem('mcpSettings').submenu).toBeUndefined();
    const checks = appMenu.submenu!.filter((i) => i.type === 'checkbox');
    expect(Object.fromEntries(checks.map((i) => [i.id, i.checked]))).toEqual({ notifyUpdates: false, updateOnQuit: true, usageLimitResume: false });
    expect(fileMenu.id).toBe('file');
    // ウインドウを閉じる「閉じる」（⌘W）は置かない。⌘W は「移動」の「タブを閉じる」にして、アプリを終えない
    expect(shape(fileMenu.submenu!)).toEqual(['newSession', 'separator', 'stopAndQuit']);
    expect(menuItem('newSession').accelerator).toBe('CmdOrCtrl+N');
    expect(rest.map((i) => i.role ?? i.id)).toEqual(['editMenu', 'viewMenu', 'go', 'windowMenu']);
  });

  it('「移動」: ショートカットを区切りごとに並べ、キーを右に出す。押したら、見ているプロファイルの画面に知らせる', async () => {
    await boot();
    const go = state.menu!.find((i) => i.id === 'go')!;
    expect(go.label).toBe('移動');
    expect(go.submenu!.map((i) => (i.type === 'separator' ? '---' : `${i.label} ${i.accelerator}`))).toEqual([
      'セッション一覧 Cmd+1',
      'チャット Cmd+2',
      'サイドパネル Cmd+3',
      'エディタ・ブラウザ Cmd+4',
      '---',
      '前のセッション Ctrl+Cmd+Up',
      '次のセッション Ctrl+Cmd+Down',
      '---',
      '次のタブ Ctrl+Tab',
      '前のタブ Ctrl+Shift+Tab',
      'タブを閉じる Cmd+W',
      '---',
      'ターミナルを開く・閉じる Cmd+J',
      '---',
      '待っている質問・許可 Cmd+Shift+A',
    ]);
    // どのメニューにも、ウインドウを閉じる役割（⌘W でアプリが終わる）を置かない
    const roles = (items: MenuItem[]): string[] => items.flatMap((i) => [i.role ?? '', ...roles(i.submenu ?? [])]);
    expect(roles(state.menu!)).not.toContain('close');
    const click = (id: string, triggeredByAccelerator: boolean) =>
      (menuItem(id).click as unknown as (item: unknown, window: unknown, event: { triggeredByAccelerator: boolean }) => void)({}, undefined, { triggeredByAccelerator });
    // マウスで押したら、ほかのメニューの項目と同じく、メインのウインドウを前に出してから知らせる
    click('shortcut-closeTab', false);
    click('shortcut-focusQuestion', false);
    expect(mainWindow().show).toHaveBeenCalledTimes(2);
    // メインのウインドウでキーで押したものは、画面（か before-input-event）が受けているので、二重に知らせない。⌘W でもウインドウを閉じない
    mainWindow().focused = true;
    click('shortcut-toggleTerminal', true);
    click('shortcut-closeTab', true);
    expect(state.firstResponderActions).toEqual([]);
    expect(mainWindow().webContents.sent).toEqual([
      [IpcChannel.ShortcutRun, 'closeTab'],
      [IpcChannel.ShortcutRun, 'focusQuestion'],
    ]);
  });

  // 直す前（ファイルのメニューの「閉じる」を外しただけ）: ポップアップ・About のパネル・切り離した DevTools が、⌘W で閉じなくなっていた
  it('「移動」: メインでないウインドウ（ポップアップ・About のパネル・切り離した DevTools）で押した ⌘W は、そのウインドウを閉じる。ほかのキーは、メインのウインドウを前に出して知らせる', async () => {
    await boot();
    const main = mainWindow();
    const click = (id: string) =>
      (menuItem(id).click as unknown as (item: unknown, window: unknown, event: { triggeredByAccelerator: boolean }) => void)({}, undefined, { triggeredByAccelerator: true });
    // About のパネル・DevTools（BrowserWindow ではない）にフォーカスがある
    click('shortcut-closeTab');
    expect(state.firstResponderActions).toEqual(['performClose:']);
    // アプリ内ブラウザのポップアップ（メインでない BrowserWindow）
    const popup = new FakeWindow({});
    popup.focused = true;
    click('shortcut-closeTab');
    expect(state.firstResponderActions).toEqual(['performClose:', 'performClose:']);
    expect(state.quit).not.toHaveBeenCalled();
    click('shortcut-focusSessions');
    expect(main.show).toHaveBeenCalledTimes(1);
    expect(main.webContents.sent).toEqual([[IpcChannel.ShortcutRun, 'focusSessions']]);
    expect(popup.webContents.sent).toEqual([]);
  });

  it('「自動で最適化圧縮する大きさ」「離席モードで答えを待つ時間」: 選んだものを設定に保存し、チェックを移す', async () => {
    await boot();
    const checked = (id: string) => menuItem(id).submenu!.filter((i) => i.checked).map((i) => i.id);
    expect(checked('autoCompactPercent')).toEqual(['autoCompactPercent-80']);
    expect(checked('awayWait')).toEqual(['awayWait-5']);
    menuItem('autoCompactPercent-60').click?.({});
    menuItem('awayWait-15').click?.({});
    expect(savedSettings()).toMatchObject({ autoCompactPercent: 60, awayWaitMinutes: 15 });
    expect(checked('autoCompactPercent')).toEqual(['autoCompactPercent-60']);
    expect(checked('awayWait')).toEqual(['awayWait-15']);
  });

  it('メニューの項目の名前（日本語と英語）', async () => {
    const labels = () => {
      const appMenu = state.menu![0].submenu!;
      return appMenu.filter((i) => i.id).map((i) => i.label);
    };
    await boot();
    expect(labels()).toEqual([
      '新しいバージョンが出たら通知する',
      '終了するときに新しいバージョンを入れる（Homebrew）',
      'MCP の設定…',
      '利用枠で止まったら、戻ったときに自動で再開する',
      '自動で最適化圧縮する大きさ',
      '離席モードで答えを待つ時間',
      'Claude に送る文…',
      '言語（Language）',
    ]);
    await boot({ settings: { language: 'en' } });
    expect(labels()).toEqual([
      'Notify When Updates Are Available',
      'Install Updates on Quit (Homebrew)',
      'MCP Settings…',
      'Resume Automatically When the Usage Limit Resets',
      'Auto Optimized Compact At',
      'Away Mode Wait Time',
      'Messages Sent to Claude…',
      'Language',
    ]);
  });

  it('「言語」: 既定は「システムに合わせる」で、Mac の優先する言語に日本語があれば日本語。画面には起動の引数で渡す', async () => {
    await boot({ before: (s) => (s.preferredLanguages = ['en-US', 'ja-JP']) });
    const languages = menuItem('language').submenu!;
    expect(languages.map((i) => [i.label, i.type, i.checked])).toEqual([
      ['システムに合わせる', 'radio', true],
      ['日本語', 'radio', false],
      ['English', 'radio', false],
    ]);
    expect(mainWindow().options.webPreferences).toMatchObject({ additionalArguments: ['--tanacode-language=ja'] });
  });

  it('「言語」: Mac の優先する言語に日本語が無ければ、英語で出す（メニューも画面も）', async () => {
    await boot({ before: (s) => (s.preferredLanguages = ['en-US', 'fr-FR']) });
    expect(menuItem('language').submenu!.map((i) => i.label)).toEqual(['System Default', '日本語', 'English']);
    expect(menuItem('file').submenu![0].label).toBe('New Session');
    expect(mainWindow().options.webPreferences).toMatchObject({ additionalArguments: ['--tanacode-language=en'] });
  });

  it('「言語」: 保存した言語で起動する（Mac の言語より優先）', async () => {
    await boot({ settings: { language: 'en' } });
    expect(menuItem('language').submenu!.find((i) => i.checked)?.label).toBe('English');
    expect(mainWindow().options.webPreferences).toMatchObject({ additionalArguments: ['--tanacode-language=en'] });
  });

  // 言語の項目を押す（Electron のラジオボタンと同じく、押すとチェックが移る）。聞いたダイアログが閉じるまで待つ
  const chooseLanguage = async (id: string) => {
    const languages = menuItem(id);
    for (const item of menuItem('language').submenu!) item.checked = item === languages;
    languages.click?.(languages);
    await new Promise((r) => setTimeout(r, 0));
  };

  it('「言語」: 選んだ言語を保存し、今の言語のまま動き続ける。言語が変わるなら、変えた先の言語で再起動するかを聞く（「あとで」なら何もしない）', async () => {
    await boot();
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await chooseLanguage('language-en');
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
    expect(menuItem('language').submenu!.find((i) => i.checked)?.label).toBe('English');
    // 今の言語（日本語）に戻すなら、保存するだけで聞かない
    await chooseLanguage('language-ja');
    expect(savedSettings().language).toBe('ja');
    expect(state.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('「言語」: 「今すぐ再起動」なら、ふつうの終了の確認を通して終了し、終わったら起動し直す', async () => {
    await boot();
    state.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await chooseLanguage('language-en');
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
    await chooseLanguage('language-en');
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
    await chooseLanguage('language-en');
    expect(menuItem('language').submenu!.map((i) => [i.label, i.checked])).toEqual([
      ['システムに合わせる', true],
      ['日本語', false],
      ['English', false],
    ]);
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('「新しいバージョンが出たら通知する」: オンで問い合わせ（と Claude Code の対応表を読むの）を始め、オフでやめる。設定に保存する', async () => {
    await boot();
    const monitor = the('AppUpdateMonitor');
    const compat = the('ClaudeCompatMonitor');
    monitor.start.mockClear();
    compat.start.mockClear();
    toggle('notifyUpdates');
    expect(monitor.stop).toHaveBeenCalledTimes(1);
    expect(compat.stop).toHaveBeenCalledTimes(1);
    expect(savedSettings().updateCheck).toBe(false);
    toggle('notifyUpdates');
    expect(monitor.start).toHaveBeenCalledTimes(1);
    expect(compat.start).toHaveBeenCalledTimes(1);
    expect(savedSettings().updateCheck).toBe(true);
  });

  describe('MCP の設定の入り・切り', () => {
    it('読むと、入り・切りとツールの許可を返す', async () => {
      await boot({ settings: { sessionsControl: false, toolPermissions: { [sessionToolId('start_session')]: 'allow' } } });
      await expect(invoke(IpcChannel.McpSettingsGet)).resolves.toEqual({
        enabled: { browser: true, sessions: false, checklist: true, walkthrough: true, terminal: true },
        permissions: { [sessionToolId('start_session')]: 'allow' },
        parentAskRules: false,
        problem: null,
      });
    });

    it('ask の規則で出た子の確認を親に許させるかを保存する（スイッチの値でなければ断る）', async () => {
      await boot();
      await expect(invoke(IpcChannel.ParentAskRulesSet, true)).resolves.toBe(true);
      expect(savedSettings().parentAskRules).toBe(true);
      await expect(invoke(IpcChannel.McpSettingsGet)).resolves.toMatchObject({ parentAskRules: true });
      await expect(invoke(IpcChannel.ParentAskRulesSet, 'yes')).rejects.toThrow();
      expect(savedSettings().parentAskRules).toBe(true);
      await invoke(IpcChannel.ParentAskRulesSet, false);
      expect(savedSettings().parentAskRules).toBe(false);
    });

    it('アプリ内ブラウザを切ったら、頼んでいる操作を取り下げ、許した外の先も捨てる（入れたときは何もしない）', async () => {
      await boot();
      await expect(invoke(IpcChannel.McpEnabledSet, 'browser', false)).resolves.toMatchObject({ browser: false });
      expect(the('BrowserControl').turnOff).toHaveBeenCalledTimes(1);
      expect(savedSettings().browserControl).toBe(false);
      await invoke(IpcChannel.McpEnabledSet, 'browser', true);
      expect(the('BrowserControl').turnOff).toHaveBeenCalledTimes(1);
      expect(savedSettings().browserControl).toBe(true);
    });

    // 入り・切りは、それぞれ同じ名前の設定に保存する
    it.each([
      ['sessions', 'sessionsControl'],
      ['checklist', 'checklistControl'],
      ['walkthrough', 'walkthroughControl'],
      ['terminal', 'terminalControl'],
    ])('「%s」: %s に保存する', async (server, key) => {
      await boot();
      await expect(invoke(IpcChannel.McpEnabledSet, server, false)).resolves.toMatchObject({ [server]: false });
      expect(savedSettings()[key]).toBe(false);
      await invoke(IpcChannel.McpEnabledSet, server, true);
      expect(savedSettings()[key]).toBe(true);
    });

    it('知らない MCP・値は断る', async () => {
      await boot();
      await expect(invoke(IpcChannel.McpEnabledSet, 'other', false)).rejects.toThrow();
      await expect(invoke(IpcChannel.McpEnabledSet, 'browser', 'no')).rejects.toThrow();
    });

    it.each(['browser', 'sessions', 'checklist', 'walkthrough', 'terminal'])('「%s」: 保存できなかったら断り、値もほかも変えない', async (server) => {
      await boot();
      // 設定は、一時ファイルに書いてから置き換える。一時ファイルの場所にフォルダがあると、書けない
      mkdirSync(join(state.userData, 'settings.json.tmp'));
      await expect(invoke(IpcChannel.McpEnabledSet, server, false)).rejects.toThrow();
      expect(((await invoke(IpcChannel.McpSettingsGet)) as { enabled: Record<string, boolean> }).enabled[server]).toBe(true);
      expect(the('BrowserControl').turnOff).not.toHaveBeenCalled();
    });
  });

  // 項目の id は、保存する設定の名前と同じ
  it.each([
    'updateOnQuit',
    'usageLimitResume',
  ])('「%s」: 同じ名前の設定に保存する', async (key) => {
    await boot();
    toggle(key);
    expect(savedSettings()[key]).toBe(false);
    toggle(key);
    expect(savedSettings()[key]).toBe(true);
  });

  describe('Claude のツールの許可', () => {
    const dir = () => join(state.userData, 'tool-permissions');
    const start = sessionToolId('start_session');
    const marks = () => (existsSync(dir()) ? readdirSync(dir()).sort() : []);

    it('1 つ変えると、印のファイルを置き・消してから設定に保存する（フックが、動いているセッションでも次の呼び出しから読む）', async () => {
      await boot();
      await expect(invoke(IpcChannel.McpSettingsGet)).resolves.toMatchObject({ permissions: {} });
      await expect(invoke(IpcChannel.ToolPermissionsSet, start, 'allow')).resolves.toEqual({ [start]: 'allow' });
      expect(marks()).toEqual([`${start}.allow`]);
      expect(savedSettings().toolPermissions).toEqual({ [start]: 'allow' });
      // 既定に戻すと印は消え、選んだ値は残る
      await invoke(IpcChannel.ToolPermissionsSet, start, 'ask');
      expect(marks()).toEqual([]);
      await expect(invoke(IpcChannel.McpSettingsGet)).resolves.toMatchObject({ permissions: { [start]: 'ask' } });
      // 知らないツール・値は断る
      await expect(invoke(IpcChannel.ToolPermissionsSet, 'mcp__other__x', 'allow')).rejects.toThrow();
      await expect(invoke(IpcChannel.ToolPermissionsSet, start, 'yes')).rejects.toThrow();
    });

    it('前のバージョンの「セッションを始める前に許可を求める」がオフなら、起動したときに start_session を常に許可に引き継ぎ、前の印のファイルは消す', async () => {
      await boot({ settings: { sessionsStartConfirm: false }, before: (st) => writeFileSync(join(st.userData, 'sessions-start-no-ask'), '') });
      expect(savedSettings().toolPermissions).toEqual({ [start]: 'allow' });
      expect(marks()).toEqual([`${start}.allow`]);
      await vi.waitFor(() => expect(existsSync(join(state.userData, 'sessions-start-no-ask'))).toBe(false));
    });

    it('選び直したあとは、引き継ぎ直さない。起動したら、印のファイルを保存した設定に合わせ直す', async () => {
      await boot({
        settings: { sessionsStartConfirm: false, toolPermissions: { [start]: 'ask', [browserToolId('click')]: 'ask' } },
        before: (st) => {
          mkdirSync(join(st.userData, 'tool-permissions'), { recursive: true });
          writeFileSync(join(st.userData, 'tool-permissions', `${start}.allow`), '');
        },
      });
      expect(marks()).toEqual([`${browserToolId('click')}.ask`]);
      expect(savedSettings().toolPermissions).toEqual({ [start]: 'ask', [browserToolId('click')]: 'ask' });
    });

    it('起動したときに印のファイルを合わせられなかったら、警告を出し、MCP の設定のダイアログにも理由を出させる', async () => {
      await boot({
        settings: { toolPermissions: { [browserToolId('get_text')]: 'ask' } },
        // 印のフォルダの場所にファイルがあると、フォルダを作れない
        before: (st) => writeFileSync(join(st.userData, 'tool-permissions'), ''),
      });
      const warning = state.dialog.showMessageBox.mock.calls.map((c) => c.at(-1) as { type?: string; message?: string; detail?: string }).find((o) => o.type === 'warning');
      expect(warning?.message).toBe('MCP の設定の確認の選択を、Claude Code に効かせられませんでした');
      expect(warning?.detail).toContain('毎回確認にしたツールが確認なしで動くことがあります');
      const { problem } = (await invoke(IpcChannel.McpSettingsGet)) as { problem: string | null };
      expect(problem).toBe(warning?.detail);
    });

    it('起動したときに印のファイルを合わせられたら、警告を出さない', async () => {
      await boot({ settings: { toolPermissions: { [browserToolId('get_text')]: 'ask' } } });
      expect(state.dialog.showMessageBox.mock.calls.some((c) => (c.at(-1) as { type?: string }).type === 'warning')).toBe(false);
      await expect(invoke(IpcChannel.McpSettingsGet)).resolves.toMatchObject({ problem: null });
    });

    it('保存できなかったら、印のファイルを保存した設定に戻して断る（確認を省いたままにしない）', async () => {
      await boot();
      mkdirSync(join(state.userData, 'settings.json.tmp'));
      await expect(invoke(IpcChannel.ToolPermissionsSet, start, 'allow')).rejects.toThrow();
      expect(marks()).toEqual([]);
    });
  });

  it('「利用枠で止まったら、戻ったときに自動で再開する」をオフにしたら、待っている再開の予約を取り消す（オンにしたときは何もしない）', async () => {
    await boot();
    toggle('usageLimitResume');
    expect(the('UsageLimitResume').cancelAll).toHaveBeenCalledTimes(1);
    toggle('usageLimitResume');
    expect(the('UsageLimitResume').cancelAll).toHaveBeenCalledTimes(1);
  });

  it.each([
    'notifyUpdates',
    'updateOnQuit',
    'usageLimitResume',
  ])('「%s」: 保存できなかったら、チェックを元に戻し、ほかは何もしない', async (id) => {
    await boot();
    // 設定は、一時ファイルに書いてから置き換える。一時ファイルの場所にフォルダがあると、書けない
    mkdirSync(join(state.userData, 'settings.json.tmp'));
    const monitor = the('AppUpdateMonitor');
    monitor.start.mockClear();
    const item = toggle(id);
    expect(item.checked).toBe(true);
    expect(monitor.start).not.toHaveBeenCalled();
    expect(monitor.stop).not.toHaveBeenCalled();
    expect(the('BrowserControl').turnOff).not.toHaveBeenCalled();
  });

  it('「MCP の設定…」「Claude に送る文…」「新規セッション」は、ウインドウを出して、画面にダイアログ・新規セッションの画面を開かせる', async () => {
    await boot();
    mainWindow().emit('closed');
    menuItem('mcpSettings').click?.({});
    expect(state.windows).toHaveLength(2);
    menuItem('prompts').click?.({});
    menuItem('newSession').click?.({});
    expect(mainWindow().show).toHaveBeenCalledTimes(3);
    expect(mainWindow().webContents.sent).toEqual([
      [IpcChannel.McpSettingsOpen, undefined],
      [IpcChannel.PromptsOpen, undefined],
      [IpcChannel.SessionsNew, undefined],
    ]);
  });

  it('「Claude Code も止めて終了」: 確認を出さずに、Claude Code と pty ホストを止めてから終了する', async () => {
    await boot();
    menuItem('stopAndQuit').click?.({});
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
    // エディタのタブのファイルごとの見張りもやめる
    expect(the('OpenFileWatchers').closeAll).toHaveBeenCalledTimes(1);
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
    expect(the('ClaudeCompatMonitor').stop).toHaveBeenCalledTimes(1);
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
    await boot({ before: (s) => SOCKETS.forEach((f) => s.failingSockets.add(f)) });
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

  it('確かめられたら（結果が前と同じでも）、画面に知らせる', async () => {
    await bootWith(updater());
    fnArg('AppUpdateMonitor', 3)();
    expect(sentToRenderer(IpcChannel.AppUpdateChecked)).toEqual([undefined]);
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
      onSpawnError: expect.any(Function),
    });
    // 起動し直すのは、入れ替えたあとのシェル
    expect(state.relaunch).not.toHaveBeenCalled();
  });

  it('「再起動して更新」: 入れ替えのシェルを起動できなければ、入れ替えずに起動し直す（起動の失敗があとから分かったときも）', async () => {
    const homebrew = updater();
    homebrew.upgradeAfterExit.mockReturnValueOnce(false);
    await bootWith(homebrew);
    await invoke(IpcChannel.AppUpdateInstall);
    quitOnce();
    expect(state.relaunch).toHaveBeenCalledTimes(1);
  });

  it('「再起動して更新」: シェルの起動の失敗があとから届いたら、起動し直す', async () => {
    await bootWith(updater());
    await invoke(IpcChannel.AppUpdateInstall);
    quitOnce();
    expect(state.relaunch).not.toHaveBeenCalled();
    const [{ onSpawnError }] = upgrade().mock.calls[0] as unknown as [{ onSpawnError: () => void }];
    onSpawnError();
    expect(state.relaunch).toHaveBeenCalledTimes(1);
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
    const english = menuItem('language-en');
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

  // Claude の restart_app（tanacode-sessions）。Profile が SessionsControl に渡すものを、index.ts がつなぐ
  type AppControl = { restart: (id: string, onlyIfUpdate: boolean) => { restarting: boolean; to?: string | null } };
  const appControl = () => (argsOf('SessionsControl')[0] as { app: AppControl }).app;

  it('restart_app: ダウンロード済みなら、確認のダイアログを出さず、結果を返してから動かしたまま終え、入れ替えてから起動し直す', async () => {
    await bootWith(updater());
    manager().liveSessions.mockReturnValue(live);
    expect(appControl().restart('s1', true)).toMatchObject({ restarting: true, to: '9.9.0' });
    // 結果を返した時点では、まだ終えない
    expect(state.quit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(quitOnce().preventDefault).not.toHaveBeenCalled();
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(manager().closeAll).not.toHaveBeenCalledWith(true);
    expect(upgrade()).toHaveBeenCalledWith(expect.objectContaining({ relaunch: true }));
    expect(state.relaunch).not.toHaveBeenCalled();
  });

  it('restart_app: 入れ替えるものが無ければ、only_if_update では終えない。省けば、動かしたまま終えて起動し直す', async () => {
    await bootWith(updater(null));
    manager().liveSessions.mockReturnValue(live);
    expect(appControl().restart('s1', true)).toMatchObject({ restarting: false });
    expect(appControl().restart('s1', false)).toMatchObject({ restarting: true, to: null });
    await vi.waitFor(() => expect(state.quit).toHaveBeenCalledTimes(1), { timeout: 3000 });
    quitOnce();
    expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(manager().closeAll).not.toHaveBeenCalledWith(true);
    expect(upgrade()).not.toHaveBeenCalled();
    expect(state.relaunch).toHaveBeenCalledTimes(1);
  });
});
