import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, powerMonitor, session, shell, type WebContents } from 'electron';
import {
  IpcChannel,
  type DiscoveredSession,
  type GitAction,
  type NewSessionOptions,
  type ScreenChoice,
  type SearchOptions,
  type SessionOptions,
} from '@shared/ipc';
import { AppSettings } from './app-settings';
import { discoverSessions } from './session-discovery';
import { SourceControl } from './source-control';
import type { PermissionMode } from '@shared/screen';
import type { AgentLogRef } from '@shared/task';
import { listCommands } from './commands';
import { imageOf } from './image-cache';
import { menuNotice } from './notice-text';
import { PtyHost } from './pty-host-client';
import { DEFAULT_PTY_SIZE, SessionManager } from './session-manager';
import { SessionStore } from './session-store';
import { readModelCatalog } from './model-catalog';
import { StatusLineWatcher } from './statusline';
import { ShellTerminals } from './shell-terminals';
import { SystemMonitor } from './system-monitor';
import { UsageMonitor } from './usage-monitor';
import { Workspace } from './workspace';
import { WorkspaceWatchers } from './workspace-watcher';

let mainWindow: BrowserWindow | null = null;
let manager: SessionManager;
let ptyHost: PtyHost | null = null;
let usage: UsageMonitor;
let settings: AppSettings;
let statusLines: StatusLineWatcher;
let system: SystemMonitor;
let watchers: WorkspaceWatchers;
// 新規セッションの画面で開いているフォルダ（id → フォルダ）。セッションと同じように右パネルとエディタで使う
const folderViews = new Map<string, string>();
// フォルダ選択ダイアログで選ばれたフォルダ。folders.open で開けるのは、これとセッションのフォルダだけ
const pickedFolders = new Set<string>();
// 終了のしかたが決まった（確認を済ませた・確認の要らない終了）。まだなら before-quit で止めて確認する
let quitDecided = false;
let confirmingQuit = false;
const shells = new ShellTerminals({
  onData: (id, data) => send(IpcChannel.ShellData, { id, data }),
  onExit: (id, exitCode) => send(IpcChannel.ShellExit, { id, exitCode }),
});

// アプリ内プレビューの webview が使うセッション（renderer の PreviewPane の PARTITION と同じ名前）
const PREVIEW_PARTITION = 'persist:tanacode-preview';
// 主ウインドウ（アプリ自身の画面）にだけ許す権限。Monaco の右クリックメニューの「貼り付け」は、
// execCommand('paste') が効かないとき navigator.clipboard.readText を使う（コピーも navigator.clipboard を使うことがある）。
// 通知は main の Notification で出すので、画面側の notifications は要らない
const APP_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-read', 'clipboard-sanitized-write']);

// 権限の要求と確認を、既定では断る。Electron はハンドラーが無いと、ほとんどの権限（カメラ・マイク・位置情報・
// クリップボードの読み取り・外部プロトコルの起動など）を確認なしに許してしまう。
// プレビューの webview（開発中の任意のページ）には何も許さない。主ウインドウには APP_PERMISSIONS だけを許す
function restrictPermissions(): void {
  const isApp = (contents: WebContents | null, isMainFrame: boolean) =>
    !!contents && isMainFrame && contents === mainWindow?.webContents && contents.getType() === 'window';
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(APP_PERMISSIONS.has(permission) && isApp(contents, details.isMainFrame)),
  );
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) => APP_PERMISSIONS.has(permission) && isApp(contents, details.isMainFrame),
  );
  const preview = session.fromPartition(PREVIEW_PARTITION);
  preview.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  preview.setPermissionCheckHandler(() => false);
}

// プレビューの webview の中で移ってよい先。トップのフレームは http(s) のページと about:blank だけ（file: や
// mailto: などの外部プロトコルへは移らない。外部プロトコルのアプリも起こさない）。
// 中のフレーム（iframe）は、ページが自分で作る about:srcdoc・blob:・data: も通す（ページの開発で使うため。どれもページの外には出られない）
function isPreviewDestination(url: string, isMainFrame: boolean): boolean {
  if (/^https?:\/\//i.test(url) || url === 'about:blank') return true;
  return !isMainFrame && (url === 'about:srcdoc' || /^(blob|data):/i.test(url));
}

function send(channel: string, payload: unknown): void {
  const contents = mainWindow?.webContents;
  if (contents && !contents.isDestroyed()) contents.send(channel, payload);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1180,
    minHeight: 600,
    // global.css の --bg-chrome と同じ（CSS が読み込まれる前に出る色）
    backgroundColor: '#121211',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 15 },
    // webviewTag: アプリ内プレビュー（開発サーバーの画面）に使う
    webPreferences: { preload: join(__dirname, '../preload/index.js'), webviewTag: true },
  });
  mainWindow = win;

  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault();
  });
  // プレビューの webview には、アプリの API（preload）や Node を渡さない。開けるのは http(s) のページだけ
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^https?:\/\//.test(params.src) && params.src !== 'about:blank') event.preventDefault();
  });
  contents.on('did-attach-webview', (_e, guest) => {
    // 新しいウィンドウを開くリンクは、ふだんのブラウザで開く
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
  // バツボタンでウインドウを閉じたら、アプリも終了する（Claude Code を止めるかは quit の確認で決める）
  win.on('close', (event) => {
    if (quitDecided) return;
    event.preventDefault();
    app.quit();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function showWindow(): BrowserWindow {
  if (!mainWindow) createWindow();
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

// workspace・git に渡された id（セッションか、folders.open で開いたフォルダ）のフォルダ
function cwdOf(id: string): string {
  return folderViews.get(id) ?? manager.cwdOf(id);
}

async function pickFolder(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '作業するフォルダを選択',
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  const dir = result.canceled ? null : (result.filePaths[0] ?? null);
  if (dir) pickedFolders.add(dir);
  return dir;
}

// 通知のタイトルはアプリの名前、サブタイトルはセッション名
function notify(sessionId: string, sessionTitle: string | null, message: string): void {
  if (!settings.notificationsEnabled()) return;
  const windowActive = mainWindow?.isFocused() ?? false;
  if (windowActive && manager.isFocused(sessionId)) return;
  if (!Notification.isSupported()) return;
  // 音は macOS のシステム音の Glass（指定しないと、既定の通知音が鳴る）
  const notification = new Notification({ title: 'tanacode', subtitle: sessionTitle ?? '新しいセッション', body: message, sound: 'Glass' });
  notification.on('click', () => {
    showWindow();
    send(IpcChannel.SessionsSelect, sessionId);
  });
  notification.show();
}

function registerIpc(): void {
  ipcMain.handle(IpcChannel.SessionsList, () => manager.list());
  const isDirectory = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);
  ipcMain.handle(IpcChannel.SessionsCreate, async (_e, cwd: string, options: NewSessionOptions) => {
    if (!(await isDirectory(cwd))) throw new Error(`フォルダが見つかりません: ${cwd}`);
    return manager.create(cwd, options);
  });
  ipcMain.handle(IpcChannel.FolderPick, () => pickFolder());
  ipcMain.handle(IpcChannel.FolderInfo, async (_e, cwd: string) => ((await isDirectory(cwd)) ? new Workspace(cwd).info() : null));
  ipcMain.handle(IpcChannel.FolderFiles, (_e, cwd: string) => new Workspace(cwd).listFiles().catch(() => []));
  ipcMain.handle(IpcChannel.FolderCommands, (_e, cwd: string) => listCommands(cwd, null));
  ipcMain.handle(IpcChannel.FolderOpen, async (_e, cwd: string) => {
    const known = pickedFolders.has(cwd) || manager.list().some((s) => s.cwd === cwd);
    if (!known || !(await isDirectory(cwd))) throw new Error(`フォルダを開けません: ${cwd}`);
    const id = `folder:${randomUUID()}`;
    folderViews.set(id, cwd);
    watchers.retain(cwd);
    return id;
  });
  ipcMain.on(IpcChannel.FolderClose, (_e, id: string) => {
    const cwd = folderViews.get(id);
    if (cwd === undefined) return;
    folderViews.delete(id);
    watchers.release(cwd);
  });
  ipcMain.handle(IpcChannel.SessionsOpen, (_e, id: string) => manager.open(id));
  ipcMain.handle(IpcChannel.SessionsArchive, (_e, id: string) => manager.archive(id));
  ipcMain.handle(IpcChannel.SessionsUnarchive, (_e, id: string) => manager.unarchive(id));
  ipcMain.handle(IpcChannel.SessionsSnapshot, (_e, id: string) => manager.snapshot(id));
  ipcMain.handle(IpcChannel.SessionsRename, (_e, id: string, title: string) => manager.rename(id, title));
  ipcMain.handle(IpcChannel.SessionsRemove, (_e, id: string) => {
    shells.killOwner(id);
    return manager.remove(id);
  });
  ipcMain.handle(IpcChannel.SessionsHistory, (_e, id: string) => manager.history(id));
  ipcMain.handle(IpcChannel.ChatImage, (_e, key: string) => imageOf(key));
  ipcMain.handle(IpcChannel.SessionsDiscover, () => discoverSessions(manager.claudeSessionIds()));
  ipcMain.handle(IpcChannel.SessionsImport, (_e, s: DiscoveredSession) => manager.importSession(s.claudeSessionId, s.cwd, s.title));
  ipcMain.handle(IpcChannel.SessionsConfigure, (_e, id: string, options: SessionOptions) => manager.configure(id, options));
  ipcMain.handle(IpcChannel.SessionsRestart, (_e, id: string) => manager.restart(id));
  ipcMain.handle(IpcChannel.SessionsSetRemoteControl, (_e, id: string, on: boolean) => manager.setRemoteControl(id, on));
  ipcMain.handle(IpcChannel.RemoteControlAvailable, () => manager.remoteAvailable());
  ipcMain.handle(IpcChannel.ScreenGet, (_e, id: string) => manager.screen(id));
  ipcMain.handle(IpcChannel.ScreenActivityGet, (_e, id: string) => manager.activity(id));
  ipcMain.handle(IpcChannel.WorkflowsGet, (_e, id: string) => manager.workflows(id));
  ipcMain.handle(IpcChannel.ScreenSetMode, (_e, id: string, mode: PermissionMode) => manager.setMode(id, mode));
  ipcMain.handle(IpcChannel.ScreenRewind, (_e, id: string, text: string) => manager.rewind(id, text));
  ipcMain.handle(IpcChannel.WriteFile, (_e, id: string, relPath: string, text: string) =>
    new Workspace(cwdOf(id)).writeFile(relPath, text),
  );
  const scm = (id: string) => new SourceControl(cwdOf(id));
  ipcMain.handle(IpcChannel.GitState, (_e, id: string) => scm(id).state());
  ipcMain.handle(IpcChannel.GitBranches, (_e, id: string) => scm(id).branches());
  ipcMain.handle(IpcChannel.GitDiffSides, (_e, id: string, relPath: string, staged: boolean) => scm(id).diffSides(relPath, staged));
  ipcMain.handle(IpcChannel.GitBranchDiffSides, (_e, id: string, mergeBase: string, relPath: string) =>
    scm(id).branchDiffSides(mergeBase, relPath),
  );
  ipcMain.handle(IpcChannel.GitBaseline, (_e, id: string, mergeBase: string, relPath: string) => scm(id).baseline(mergeBase, relPath));
  ipcMain.handle(IpcChannel.GitLastMessage, (_e, id: string) => scm(id).lastCommitMessage());
  ipcMain.handle(IpcChannel.GitRun, (_e, id: string, action: GitAction) => runGit(scm(id), action));
  ipcMain.handle(IpcChannel.Search, (_e, id: string, query: string, options: SearchOptions) =>
    new Workspace(cwdOf(id)).search(query, options),
  );
  ipcMain.handle(IpcChannel.ListFiles, (_e, id: string) => new Workspace(cwdOf(id)).listFiles());
  ipcMain.handle(IpcChannel.CommandsList, (_e, id: string) => listCommands(manager.cwdOf(id), manager.transcriptOf(id)));
  ipcMain.handle(IpcChannel.AttachmentSave, (_e, name: string, data: Uint8Array) => saveAttachment(name, data));
  ipcMain.handle(IpcChannel.SubagentsGet, (_e, id: string) => manager.subagents(id));
  ipcMain.handle(IpcChannel.TasksBash, (_e, id: string) => manager.bashTasks(id));
  ipcMain.handle(IpcChannel.KnowledgeGet, (_e, id: string) => manager.knowledge(id));
  ipcMain.handle(IpcChannel.ModelsGet, () => readModelCatalog().catch(() => null));
  ipcMain.handle(IpcChannel.StatusLineGet, (_e, id: string) => manager.statusLine(id));
  ipcMain.handle(IpcChannel.UsageGet, () => usage.get());
  ipcMain.handle(IpcChannel.UsageRefresh, () => usage.refresh());
  ipcMain.handle(IpcChannel.NotificationsGet, () => settings.notificationsEnabled());
  ipcMain.handle(IpcChannel.NotificationsSet, (_e, on: boolean) => settings.setNotificationsEnabled(on === true));
  ipcMain.handle(IpcChannel.ModelsRefresh, () =>
    readModelCatalog().then(
      (catalog) => (catalog ? { catalog } : { error: 'Claude Code のモデル一覧の控え（~/.claude/cache/model-catalog）がありません' }),
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    ),
  );
  ipcMain.handle(IpcChannel.TasksAgentLog, (_e, id: string, ref: AgentLogRef) => manager.agentLog(id, ref));
  ipcMain.handle(IpcChannel.ScreenChoose, (_e, id: string, choice: ScreenChoice) => manager.choose(id, choice));
  ipcMain.on(IpcChannel.SessionsFocus, (_e, id: string | null) => manager.focus(id));
  ipcMain.on(IpcChannel.PtyWrite, (_e, id: string, data: string) => manager.write(id, data));
  ipcMain.on(IpcChannel.PtyResize, (_e, id: string, cols: number, rows: number) => manager.resize(id, cols, rows));
  ipcMain.on(IpcChannel.PtyResetSize, (_e, id: string) => manager.resize(id, DEFAULT_PTY_SIZE.cols, DEFAULT_PTY_SIZE.rows));
  ipcMain.handle(IpcChannel.ShellCreate, (_e, id: string, cols: number, rows: number) =>
    shells.create(id, manager.cwdOf(id), cols, rows),
  );
  ipcMain.on(IpcChannel.ShellWrite, (_e, id: string, data: string) => shells.write(id, data));
  ipcMain.on(IpcChannel.ShellResize, (_e, id: string, cols: number, rows: number) => shells.resize(id, cols, rows));
  ipcMain.on(IpcChannel.ShellKill, (_e, id: string) => shells.kill(id));
  ipcMain.handle(IpcChannel.WorkspaceInfo, (_e, id: string) => new Workspace(cwdOf(id)).info());
  ipcMain.handle(IpcChannel.ListDir, (_e, id: string, relPath: string) => new Workspace(cwdOf(id)).listDir(relPath));
  ipcMain.handle(IpcChannel.ReadFile, (_e, id: string, relPath: string) => new Workspace(cwdOf(id)).readFile(relPath));
  ipcMain.handle(IpcChannel.ReadImage, (_e, id: string, relPath: string) =>
    new Workspace(cwdOf(id)).readImage(relPath).catch(() => null),
  );
}

async function runGit(scm: SourceControl, action: GitAction): Promise<string | null> {
  try {
    switch (action.kind) {
      case 'stage':
        await scm.stage(action.paths);
        break;
      case 'unstage':
        await scm.unstage(action.paths);
        break;
      case 'discard':
        await scm.discard(action.paths);
        break;
      case 'commit':
        await scm.commit(action.message, action.amend);
        break;
      case 'push':
        await scm.push();
        break;
      case 'pull':
        await scm.pull();
        break;
      case 'fetch':
        await scm.fetch();
        break;
      case 'checkout':
        await scm.checkout(action.branch, action.mode);
        break;
      case 'switch-default':
        await scm.switchToLatestDefault();
        break;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// 貼り付け・ドロップされた画像。Claude Code にはパスを貼り付けとして渡すと画像として添付される
async function saveAttachment(name: string, data: Uint8Array): Promise<string> {
  const dir = join(app.getPath('userData'), 'attachments');
  await mkdir(dir, { recursive: true });
  const safe = basename(name).replace(/[^\w.-]/g, '_') || 'image.png';
  const file = join(dir, `${randomUUID().slice(0, 8)}-${safe}`);
  await writeFile(file, data);
  return file;
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'ファイル',
        submenu: [
          {
            label: '新規セッション',
            accelerator: 'CmdOrCtrl+N',
            click: () => {
              showWindow();
              send(IpcChannel.SessionsNew, undefined);
            },
          },
          { type: 'separator' },
          { role: 'close' },
          { type: 'separator' },
          {
            // 確認を出さずに止める（ふだんの終了は、動いている Claude Code があれば止めるか確認する）
            label: 'Claude Code も止めて終了',
            click: () => void quit(true),
          },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

// 終了する。stop: Claude Code と pty ホストも止める。false なら動かしたままにして、次に起動したアプリが引き継ぐ
async function quit(stop: boolean): Promise<void> {
  if (stop) {
    manager?.closeAll(true);
    await ptyHost?.shutdown();
  }
  quitDecided = true;
  app.quit();
}

// 終了するとき（バツボタン・⌘Q・Dock の「終了」）。Claude Code が動いているセッション（待機中も含む）があれば、止めるか確認する。
// 止めると Remote Control からも続けられなくなるため。無ければ、Claude Code と pty ホストも止める
async function confirmQuit(): Promise<void> {
  if (confirmingQuit) return;
  confirmingQuit = true;
  try {
    const live = manager?.liveSessions() ?? [];
    if (live.length === 0) return await quit(!!manager);
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      message: 'Claude Code が動いているセッションがあります',
      detail: [
        ...live.map((s) => `・${s.title}（${s.state}）`),
        '',
        '止めると、作業は途中で切れ、Remote Control からも続けられなくなります。動かしたまま終了すると、次に起動したときに引き継ぎます。',
      ].join('\n'),
      buttons: ['動かしたまま終了', 'Claude Code も止めて終了', 'キャンセル'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response === 2) return;
    await quit(response === 1);
  } finally {
    confirmingQuit = false;
  }
}

// Finder などから起動すると PATH が最小限で、claude（Homebrew など）が見つからない。ログインシェルの PATH を使う
function useLoginShellPath(): void {
  if (!app.isPackaged) return;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const path = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (path) process.env.PATH = path;
  } catch {
    // 取れなければよくある場所を足しておく
    process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`, process.env.PATH].join(':');
  }
}

// プレビューの webview（ゲスト）が、ページの中のリンク・location の書き換え・リダイレクトで、http(s) のページの外
// （file: や mailto: などの外部プロトコル）へ移らないようにする。新しいウィンドウは did-attach-webview の setWindowOpenHandler で扱う
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (!isPreviewDestination(event.url, event.isMainFrame)) event.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-frame-navigate', guard);
  contents.on('will-redirect', guard);
});

app.whenReady().then(async () => {
  useLoginShellPath();
  // 窓を作る前に、権限の扱いを決めておく
  restrictPermissions();
  // .app にしていない開発中の起動では Electron のアイコンになるので、アプリのアイコンに差し替える
  if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'));
  watchers = new WorkspaceWatchers((root, paths) => {
    send(IpcChannel.FilesChanged, { root, paths });
  });
  const store = new SessionStore(join(app.getPath('userData'), 'sessions.json'));
  settings = new AppSettings(join(app.getPath('userData'), 'settings.json'));
  // 以前のレビュー機能が作業フォルダを控えていた場所。もう使わないので消す
  void rm(join(app.getPath('userData'), 'snapshots'), { recursive: true, force: true });
  statusLines = new StatusLineWatcher(
    join(app.getPath('userData'), 'statusline'),
    (id, info) => {
      manager.statusLineChanged(id, info);
      usage.fromStatusLine(info);
    },
    (id, input) => manager.askQuestionsChanged(id, input),
  );
  await statusLines.start();
  // Claude Code は、アプリとは別の常駐プロセス（pty ホスト）が起動して持つ。アプリを再起動しても止まらない
  try {
    ptyHost = await PtyHost.start(app.getPath('userData'), join(__dirname, 'pty-host.js'));
  } catch (error) {
    const log = join(app.getPath('userData'), 'pty-host.log');
    dialog.showErrorBox('Claude Code を動かす常駐プロセスを起動できませんでした', `${String(error)}\n\nログ: ${log}`);
    quitDecided = true;
    app.quit();
    return;
  }
  // 開発版（パッケージしていないもの）は Remote Control を使わない（起動するたびにスマホに通知が届くため）。
  // 以前つないでいた会話を再開して Claude Code が勝手につなぎ直したときも、切る。使いたいときは TANACODE_REMOTE_CONTROL=1 で起動する
  const remoteControl = app.isPackaged || process.env.TANACODE_REMOTE_CONTROL === '1';
  manager = new SessionManager(ptyHost, store, watchers, statusLines, {
    onSessionsChanged: (sessions) => send(IpcChannel.SessionsChanged, sessions),
    onChat: (batch) => send(IpcChannel.ChatEvents, batch),
    onPtyData: (sessionId, data) => send(IpcChannel.PtyData, { sessionId, data }),
    onTurnCompleted: (session) => notify(session.id, session.title, '作業が完了しました'),
    onAttention: (session, attention) =>
      notify(session.id, session.title, attention.kind === 'menu' ? menuNotice(attention.menu) : 'ターミナルでの操作が必要です'),
    onScreen: (sessionId, info) => send(IpcChannel.ScreenChanged, { sessionId, info }),
    onActivity: (sessionId, activity) => send(IpcChannel.ScreenActivity, { sessionId, activity }),
    onWorkflows: (sessionId, runs) => send(IpcChannel.WorkflowsChanged, { sessionId, runs }),
    onSubagents: (sessionId, runs) => send(IpcChannel.SubagentsChanged, { sessionId, runs }),
    onBashTasks: (sessionId, tasks) => send(IpcChannel.TasksBashChanged, { sessionId, tasks }),
    onKnowledge: (sessionId, knowledge) => send(IpcChannel.KnowledgeChanged, { sessionId, knowledge }),
    onStatusLine: (sessionId, info) => send(IpcChannel.StatusLineChanged, { sessionId, info }),
  }, remoteControl);
  usage = new UsageMonitor(join(app.getPath('userData'), 'usage.json'), (value) => send(IpcChannel.UsageChanged, value));
  // 前に起動したアプリから動き続けている Claude Code を引き継ぐ
  await manager.adopt();
  registerIpc();
  buildMenu();
  createWindow();
  void usage.start();
  system = new SystemMonitor((stats) => send(IpcChannel.SystemStats, stats));
  system.start();
  app.on('activate', () => showWindow());
});

app.on('before-quit', (event) => {
  if (!quitDecided) {
    event.preventDefault();
    void confirmQuit();
    return;
  }
  statusLines?.close();
  system?.stop();
  // Claude Code は止めずに、見るのをやめるだけ（止めるときは、先に quit(true) で止めてある）
  manager?.closeAll(false);
  ptyHost?.close();
  shells.killAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Mac の再起動・シャットダウンでは確認を出さない（止めずに終わる）。
// なお kill（SIGTERM）は Chromium が受け取って、ふつうの終了と同じ流れになる（確認が出る。もう一度送ると強制的に終わる）
app.whenReady().then(() => {
  powerMonitor.on('shutdown', () => {
    quitDecided = true;
  });
});
