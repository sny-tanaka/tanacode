import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, powerMonitor, screen, session, shell, type MenuItem, type WebContents } from 'electron';
import {
  IpcChannel,
  type ArchiveOptions,
  type DiscoveredSession,
  type GitAction,
  type NewSessionOptions,
  type ScreenChoice,
  type SearchOptions,
  type SessionOptions,
} from '@shared/ipc';
import { AppSettings } from './app-settings';
import { normalizeHostPattern } from '@shared/browser-tools';
import { checkCopyRequest, checkOp, unreadCount } from '@shared/checklist';
import type { BrowserMcpLaunch } from './browser-bridge';
import { BrowserControl } from './browser-control';
import { McpBridge, textResult, type McpLaunch } from './mcp-bridge';
import { SessionsControl } from './sessions-control';
import { ChecklistControl } from './checklist-control';
import { ChecklistStore } from './checklist-store';
import { WalkthroughControl } from './walkthrough-control';
import { draftWalkthroughComment, postWalkthroughComment, type CommentDeps } from './walkthrough-github';
import { commentOnPullRequest, pullRequestsOf } from './github';
import { AppUpdateMonitor } from './app-update';
import { discoverSessions } from './session-discovery';
import { SourceControl } from './source-control';
import type { PermissionMode } from '@shared/screen';
import type { AgentLogRef, TaskRef } from '@shared/task';
import { listCommands } from './commands';
import { imageOf } from './image-cache';
import { menuNotice, scheduledNotice, snippet } from './notice-text';
import { hostExecutable, PtyHost } from './pty-host-client';
import { ScheduledMessages } from './scheduled-messages';
import { DEFAULT_PTY_SIZE, SessionManager } from './session-manager';
import { SettingsFiles } from './settings-files';
import { SessionStore } from './session-store';
import { socketPathIn } from './socket-path';
import { readModelCatalog } from './model-catalog';
import { StatusLineWatcher } from './statusline';
import { ShellTerminals } from './shell-terminals';
import { SystemMonitor } from './system-monitor';
import { ClaudeVersionMonitor } from './claude-version';
import { LANGUAGE_SETTINGS_URL, translateAvailable, translateHelperPath, translateTexts, Translator } from './translate';
import { UsageMonitor } from './usage-monitor';
import { loadWindowState, placeWindow, saveWindowState } from './window-state';
import { Workspace } from './workspace';
import { WorkspaceWatchers } from './workspace-watcher';

let mainWindow: BrowserWindow | null = null;
let manager: SessionManager;
let ptyHost: PtyHost | null = null;
let usage: UsageMonitor;
let settings: AppSettings;
let statusLines: StatusLineWatcher;
let settingsFiles: SettingsFiles;
let system: SystemMonitor;
let claudeVersions: ClaudeVersionMonitor;
let appUpdates: AppUpdateMonitor;
let watchers: WorkspaceWatchers;
// Claude によるアプリ内ブラウザの操作。中継（Claude Code が起動する MCP サーバー）からの呼び出しを、ソケットで受ける
let browserBridge: McpBridge | null = null;
let browser: BrowserControl;
// Claude によるほかのセッションの扱い（子セッションの起動・指示と、ほかのセッションを覗く）。中継からの呼び出しを、ソケットで受ける
let sessionsBridge: McpBridge | null = null;
let sessionsControl: SessionsControl | null = null;
// 時刻を指定して送信（予約）したメッセージ
let scheduled: ScheduledMessages;
// チェックリスト（人と Claude が一緒に見て、編集するリスト）。Claude からの呼び出しは、中継からソケットで受ける
let checklists: ChecklistStore;
let checklistBridge: McpBridge | null = null;
let checklistControl: ChecklistControl | null = null;
let walkthroughBridge: McpBridge | null = null;
let walkthroughControl: WalkthroughControl | null = null;
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
  onOpened: (owner, id, name) => send(IpcChannel.ShellOpened, { owner, id, name }),
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
  // ダウンロードも断る（Claude が操作したページが、勝手にファイルを保存させないように）
  preview.on('will-download', (event) => event.preventDefault());
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

// 前に閉じたときのウインドウの位置と大きさ。次の起動で同じところに開く
function windowStateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function rememberWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    saveWindowState(windowStateFile(), {
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    });
  } catch {
    // 覚えられなくても、次の起動が既定の大きさになるだけ
  }
}

function createWindow(): void {
  const saved = loadWindowState(windowStateFile());
  const placement = placeWindow(
    saved?.bounds ?? null,
    screen.getAllDisplays().map((display) => display.workArea),
    { width: 1600, height: 960 },
  );
  const win = new BrowserWindow({
    ...placement,
    fullscreen: saved?.fullScreen ?? false,
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
  if (saved?.maximized && !saved.fullScreen) win.maximize();
  // macOS の resized・moved は、動かし終えたときに一度だけ届く
  const remember = () => rememberWindowState(win);
  win.on('resized', remember);
  win.on('moved', remember);
  win.on('maximize', remember);
  win.on('unmaximize', remember);
  win.on('enter-full-screen', remember);
  win.on('leave-full-screen', remember);

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
    // コンソールと失敗した通信は、ページの最初のスクリプトから集める（Claude が読む）
    browser?.track(guest);
    // 新しいウィンドウで開くもの（target=_blank・window.open）は、アプリ内ブラウザの新しいタブで開く（ウィンドウは作らない）。
    // Claude の操作で、許していない先を開こうとしたものは開かない（browser-control の openFromPage）
    guest.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:\/\//.test(url) && !browser?.openFromPage(guest, url, disposition) && !browser?.isOperating(guest)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
  // バツボタンでウインドウを閉じたら、アプリも終了する（Claude Code を止めるかは quit の確認で決める）
  win.on('close', (event) => {
    rememberWindowState(win);
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

// 設定ファイルの選択。Claude Code の設定は隠しフォルダ（~/.claude）にあるので、そこから始めて、隠しファイルも見せる
async function pickSettingsFile(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '設定ファイルを選択',
    defaultPath: join(homedir(), '.claude'),
    properties: ['openFile', 'showHiddenFiles'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

// 作業の書き出しで保存したファイル（Finder で見せてよいもの）
const savedExports = new Set<string>();

// 書き出した HTML を、保存のダイアログで選んだ場所に保存する（どこにも送らない）。ファイル名は画面が付けたもので、パスの区切りなどは除く。
// 会話の中身（社内の情報や API キーが入ることがある）なので、ほかのユーザーからは読めないようにする
async function saveExport(html: unknown, fileName: unknown): Promise<string | null> {
  if (typeof html !== 'string' || typeof fileName !== 'string') throw new Error('書き出す中身がありません');
  const name = fileName.replace(/[/\\:\x00-\x1f]/g, ' ').replace(/^\.+/, '').trim().slice(0, 120) || '作業';
  const options: Electron.SaveDialogOptions = {
    title: '作業を書き出す',
    defaultPath: join(app.getPath('downloads'), name.endsWith('.html') ? name : `${name}.html`),
    filters: [{ name: 'HTML', extensions: ['html'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  await writeFile(result.filePath, html, { encoding: 'utf8', mode: 0o600 });
  // mode は新しく作るときにしか効かないので、上書きしたときのために付け直す
  await chmod(result.filePath, 0o600);
  savedExports.add(result.filePath);
  return result.filePath;
}

// 出した通知を、クリックされるまで持っておく。Electron の Notification は、JS から参照されなくなると回収され、
// そのあとクリックしても click が届かない（アプリは前に出るが、セッションは移らない。electron/electron#16922）。
// 閉じたときの close は、必ず届くとは限らない。溜まりすぎないよう、古いものから手放す
const liveNotifications = new Set<Notification>();
const MAX_LIVE_NOTIFICATIONS = 50;

// 通知のタイトルはアプリの名前、サブタイトルはセッション名。clickChannel: クリックで画面に送る知らせ（既定はそのセッションを選ぶ）
function notify(sessionId: string, sessionTitle: string | null, message: string, clickChannel: string = IpcChannel.SessionsSelect): void {
  if (!settings.notificationsEnabled()) return;
  // 子セッションは人に通知しない。作業の終わり・質問・人の対応待ちは親に知らせ、人を呼ぶときは親から伝える（sessions-control.ts）
  if (manager?.parentOf(sessionId)) return;
  const windowActive = mainWindow?.isFocused() ?? false;
  if (windowActive && manager.isFocused(sessionId)) return;
  if (!Notification.isSupported()) return;
  // 音は macOS のシステム音の Glass（指定しないと、既定の通知音が鳴る）
  const notification = new Notification({ title: 'tanacode', subtitle: sessionTitle ?? '新しいセッション', body: message, sound: 'Glass' });
  const release = () => liveNotifications.delete(notification);
  notification.on('click', () => {
    release();
    showWindow();
    send(clickChannel, sessionId);
  });
  notification.on('close', release);
  notification.on('failed', release);
  liveNotifications.add(notification);
  if (liveNotifications.size > MAX_LIVE_NOTIFICATIONS) {
    const oldest = liveNotifications.values().next().value;
    if (oldest) liveNotifications.delete(oldest);
  }
  notification.show();
}

function registerIpc(): void {
  ipcMain.handle(IpcChannel.SessionsList, () => manager.list());
  const isDirectory = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);
  ipcMain.handle(IpcChannel.SessionsCreate, async (_e, cwd: string, options: NewSessionOptions) => {
    if (!(await isDirectory(cwd))) throw new Error(`フォルダが見つかりません: ${cwd}`);
    return options.worktree ? manager.createInWorktree(cwd, options) : manager.create(cwd, options);
  });
  ipcMain.handle(IpcChannel.FolderPick, () => pickFolder());
  ipcMain.handle(IpcChannel.FolderInfo, async (_e, cwd: string) => ((await isDirectory(cwd)) ? new Workspace(cwd).info() : null));
  ipcMain.handle(IpcChannel.FolderFiles, (_e, cwd: string) => new Workspace(cwd).listFiles().catch(() => []));
  ipcMain.handle(IpcChannel.FolderCommands, (_e, cwd: string) => listCommands(cwd, null));
  ipcMain.handle(IpcChannel.FolderOpen, async (_e, cwd: string) => {
    const known = pickedFolders.has(cwd) || manager.list().some((s) => s.cwd === cwd || s.worktree?.root === cwd);
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
    // 新規セッションの画面で開いたターミナルとブラウザは、画面を閉じる（フォルダを変える・セッションを始める）と一緒に閉じる
    shells.killOwner(id);
    browser.forget(id);
  });
  ipcMain.handle(IpcChannel.SessionsOpen, (_e, id: string) => manager.open(id));
  ipcMain.handle(IpcChannel.SessionsArchive, (_e, id: string, options?: ArchiveOptions) => {
    // 子セッションも一緒にアーカイブされる
    for (const target of [id, ...manager.childrenOf(id)]) browser.forget(target);
    // worktree を消すときは、そのフォルダで開いたシェルも閉じる（消したフォルダに残らないように）
    if (options?.removeWorktree) shells.killOwner(id);
    return manager.archive(id, options);
  });
  ipcMain.handle(IpcChannel.SessionsWorktreeLeftovers, (_e, id: string) => manager.worktreeLeftovers(id));
  ipcMain.handle(IpcChannel.SessionsUnarchive, (_e, id: string) => manager.unarchive(id));
  ipcMain.handle(IpcChannel.SessionsSnapshot, (_e, id: string) => manager.snapshot(id));
  ipcMain.handle(IpcChannel.SessionsSubmit, (_e, id: string, text: string, attachments: string[]) =>
    manager.submit(id, String(text ?? ''), Array.isArray(attachments) ? attachments.filter((a): a is string => typeof a === 'string') : []),
  );
  ipcMain.on(IpcChannel.SessionsInterrupt, (_e, id: string) => manager.interrupt(id));
  ipcMain.handle(IpcChannel.ScheduledList, () => scheduled.list());
  ipcMain.handle(IpcChannel.ScheduledAdd, (_e, sessionId: string, text: string, attachments: string[], at: number) => {
    const paths = Array.isArray(attachments) ? attachments.filter((a): a is string => typeof a === 'string') : [];
    scheduled.add(String(sessionId), String(text ?? ''), paths, Number(at));
  });
  ipcMain.handle(IpcChannel.ScheduledReschedule, (_e, id: string, at: number) => scheduled.reschedule(String(id), Number(at)));
  ipcMain.handle(IpcChannel.ScheduledSendNow, (_e, id: string) => scheduled.sendNow(String(id)));
  ipcMain.handle(IpcChannel.ScheduledCancel, (_e, id: string) => scheduled.cancel(String(id)));
  ipcMain.handle(IpcChannel.SessionsRename, (_e, id: string, title: string) => manager.rename(id, title));
  ipcMain.handle(IpcChannel.SessionsRemove, async (_e, id: string, options?: ArchiveOptions) => {
    shells.killOwner(id);
    const targets = [id, ...manager.childrenOf(id)];
    for (const target of targets) browser.forget(target);
    const removal = await manager.remove(id, options);
    // 一覧から消したセッションのチェックリストも消す（アーカイブでは残す）
    for (const target of targets) if (!manager.summary(target)) checklists.remove(target);
    for (const target of targets) if (!manager.summary(target)) walkthroughControl?.forget(target);
    return removal;
  });
  ipcMain.handle(IpcChannel.SessionsHistory, (_e, id: string) => manager.history(id));
  ipcMain.handle(IpcChannel.ChatImage, (_e, key: string) => imageOf(key));
  ipcMain.handle(IpcChannel.SessionsExportSource, (_e, id: string) => manager.exportSource(id));
  ipcMain.handle(IpcChannel.SessionsExportSave, (_e, html: unknown, fileName: unknown) => saveExport(html, fileName));
  ipcMain.on(IpcChannel.SessionsExportReveal, (_e, path: string) => {
    if (savedExports.has(path)) shell.showItemInFolder(path);
  });
  ipcMain.handle(IpcChannel.SessionsDiscover, () => discoverSessions(manager.claudeSessionIds()));
  ipcMain.handle(IpcChannel.SessionsImport, (_e, s: DiscoveredSession) => manager.importSession(s.claudeSessionId, s.cwd, s.title));
  ipcMain.handle(IpcChannel.SessionsConfigure, (_e, id: string, options: SessionOptions) => manager.configure(id, options));
  ipcMain.handle(IpcChannel.SessionsRestart, (_e, id: string) => manager.restart(id));
  // チェックリスト。読む・書き換える（画面から届いた形を確かめる）・別のセッションへコピーする・セッションごとの未読の数
  ipcMain.handle(IpcChannel.ChecklistGet, (_e, id: string) => (manager.summary(id) ? checklists.lists(id) : []));
  ipcMain.handle(IpcChannel.ChecklistApply, (_e, id: string, op: unknown) => {
    if (!manager.summary(id)) throw new Error('セッションが見つかりません');
    checklistControl?.apply(id, checkOp(op));
  });
  ipcMain.handle(IpcChannel.ChecklistCopy, (_e, request: unknown) => checklistControl?.copy(checkCopyRequest(request)));
  ipcMain.handle(IpcChannel.ChecklistUnread, () => {
    const counts: Record<string, number> = {};
    for (const s of manager.list()) {
      const n = unreadCount(checklists.lists(s.id));
      if (n > 0) counts[s.id] = n;
    }
    return counts;
  });
  // ウォークスルー。今のもの・人が見るステップを変えた・終えた
  ipcMain.handle(IpcChannel.WalkthroughGet, () => walkthroughControl?.list() ?? []);
  ipcMain.handle(IpcChannel.WalkthroughGo, (_e, id: string, index: unknown) => walkthroughControl?.go(String(id), Number(index)));
  ipcMain.handle(IpcChannel.WalkthroughClose, (_e, id: string) => walkthroughControl?.close(String(id)));
  // GitHub の PR にコメントとして載せる（人が下見で本文を確かめてから投稿する）
  const commentDeps: CommentDeps = { pullRequests: pullRequestsOf, comment: commentOnPullRequest };
  ipcMain.handle(IpcChannel.WalkthroughDraftComment, async (_e, id: string) => {
    const w = manager.summary(String(id)) ? walkthroughControl?.get(String(id)) : null;
    if (!w || !walkthroughControl) return { ok: false, reason: 'ウォークスルーがありません。' };
    return draftWalkthroughComment(cwdOf(String(id)), w, walkthroughControl.postedUrl(w.id), commentDeps);
  });
  ipcMain.handle(IpcChannel.WalkthroughPostComment, async (_e, id: string, body: unknown, attribution: unknown) => {
    const w = manager.summary(String(id)) ? walkthroughControl?.get(String(id)) : null;
    if (!w || !walkthroughControl) throw new Error('ウォークスルーがありません。');
    if (typeof body !== 'string') throw new Error('本文がありません。');
    const url = await postWalkthroughComment(cwdOf(String(id)), w, body, attribution !== false, commentDeps);
    walkthroughControl.markPosted(w.id, url);
    return url;
  });
  ipcMain.handle(IpcChannel.SessionsSetRemoteControl, (_e, id: string, on: boolean) => manager.setRemoteControl(id, on));
  ipcMain.handle(IpcChannel.RemoteControlAvailable, () => manager.remoteAvailable());
  ipcMain.handle(IpcChannel.ScreenGet, (_e, id: string) => manager.screenForView(id));
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
  ipcMain.handle(IpcChannel.ContextGet, (_e, id: string) => manager.context(id));
  ipcMain.handle(IpcChannel.SettingsFilesList, () => settingsFiles.list());
  ipcMain.handle(IpcChannel.SettingsFilesPick, () => pickSettingsFile());
  ipcMain.handle(IpcChannel.SettingsFilesAdd, (_e, path: string, name?: string) => settingsFiles.add(path, name));
  ipcMain.handle(IpcChannel.SettingsFilesRename, (_e, id: string, name: string) => settingsFiles.rename(id, name));
  ipcMain.handle(IpcChannel.SettingsFilesRemove, (_e, id: string) => settingsFiles.remove(id));
  ipcMain.handle(IpcChannel.ModelsGet, () => readModelCatalog().catch(() => null));
  ipcMain.handle(IpcChannel.StatusLineGet, (_e, id: string) => manager.statusLine(id));
  ipcMain.handle(IpcChannel.UsageGet, () => usage.get());
  ipcMain.handle(IpcChannel.ClaudeVersionGet, () => claudeVersions.get());
  ipcMain.handle(IpcChannel.AppUpdateGet, () => appUpdates.get());
  ipcMain.handle(IpcChannel.UsageRefresh, () => usage.refresh());
  ipcMain.handle(IpcChannel.NotificationsGet, () => settings.notificationsEnabled());
  ipcMain.handle(IpcChannel.NotificationsSet, (_e, on: boolean) => settings.setNotificationsEnabled(on === true));
  ipcMain.handle(IpcChannel.ModelsRefresh, () =>
    readModelCatalog().then(
      (catalog) => (catalog ? { catalog } : { error: 'Claude Code のモデル一覧の控え（~/.claude/cache/model-catalog）がありません' }),
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    ),
  );
  // チャットの思考・応答の翻訳（同梱の補助プログラムで、macOS 標準の翻訳を呼ぶ）
  const translateHelper = translateHelperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  const translator = new Translator(translateHelper);
  ipcMain.handle(IpcChannel.TranslateAvailable, () => translateAvailable(process.getSystemVersion(), existsSync(translateHelper)));
  ipcMain.handle(IpcChannel.TranslateRun, (_e, texts: unknown) => translator.translate(translateTexts(texts)));
  ipcMain.handle(IpcChannel.TranslateOpenSettings, () => shell.openExternal(LANGUAGE_SETTINGS_URL));
  ipcMain.handle(IpcChannel.TasksAgentLog, (_e, id: string, ref: AgentLogRef) => manager.agentLog(id, ref));
  ipcMain.handle(IpcChannel.TasksStop, (_e, id: string, ref: TaskRef) => manager.stopTask(id, ref));
  ipcMain.handle(IpcChannel.ScreenChoose, (_e, id: string, choice: ScreenChoice) => manager.choose(id, choice));
  ipcMain.on(IpcChannel.SessionsFocus, (_e, id: string | null) => manager.focus(id));
  ipcMain.on(IpcChannel.PtyWrite, (_e, id: string, data: string) => manager.write(id, data));
  ipcMain.on(IpcChannel.PtyResize, (_e, id: string, cols: number, rows: number) => manager.resize(id, cols, rows));
  ipcMain.on(IpcChannel.PtyResetSize, (_e, id: string) => manager.resize(id, DEFAULT_PTY_SIZE.cols, DEFAULT_PTY_SIZE.rows));
  ipcMain.handle(IpcChannel.ShellCreate, (_e, id: string, cols: number, rows: number) =>
    shells.create(id, cwdOf(id), cols, rows),
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
  ipcMain.on(IpcChannel.BrowserAttach, (_e, id: string, tabId: string, webContentsId: number) => browser.attach(id, tabId, webContentsId));
  ipcMain.on(IpcChannel.BrowserActivate, (_e, id: string, tabId: string | null) => browser.activate(id, tabId));
  ipcMain.handle(IpcChannel.BrowserOpenExternal, (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle(IpcChannel.BrowserAsksGet, () => browser.pendingAsks());
  ipcMain.on(IpcChannel.BrowserAnswer, (_e, id: string, askId: string, answer: unknown) => browser.answerAsk(id, askId, answer));
  ipcMain.handle(IpcChannel.BrowserHostsGet, () => settings.browserHosts());
  ipcMain.handle(IpcChannel.BrowserHostsSet, (_e, hosts: string[]) => setBrowserHosts(hosts));
}

// アプリ内ブラウザで Claude に許す先を保存する。書き方をそろえ、重なりを除く。書き方が違うものがあれば、保存せずに断る
function setBrowserHosts(hosts: unknown): string[] {
  const list = Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string' && h.trim() !== '') : [];
  const bad = list.filter((h) => !normalizeHostPattern(h));
  if (bad.length > 0) throw new Error(`書き方が違います: ${bad.join('、')}（例: example.test・*.example.test・192.168.0.10）`);
  const normalized = [...new Set(list.map((h) => normalizeHostPattern(h)!))];
  settings.setBrowserHosts(normalized);
  return normalized;
}

// 起動する Claude Code に足す、アプリ内ブラウザの MCP サーバー。メニューでオフにしているときや、待ち受けを始められなかったときは足さない
function browserLaunch(): BrowserMcpLaunch | null {
  if (!browserBridge || !settings.browserControlEnabled()) return null;
  return { command: hostExecutable(), script: join(__dirname, 'browser-mcp.js'), socketPath: browserBridge.socketPath, version: app.getVersion() };
}

// 起動する Claude Code に足す、セッションの MCP サーバー。メニューでオフにしているときや、待ち受けを始められなかったときは足さない
function sessionsLaunch(): McpLaunch | null {
  if (!sessionsBridge || !settings.sessionsControlEnabled()) return null;
  return { command: hostExecutable(), script: join(__dirname, 'sessions-mcp.js'), socketPath: sessionsBridge.socketPath, version: app.getVersion() };
}

// 起動する Claude Code に足す、チェックリストの MCP サーバー。メニューでオフにしているときや、待ち受けを始められなかったときは足さない
function checklistLaunch(): McpLaunch | null {
  if (!checklistBridge || !settings.checklistControlEnabled()) return null;
  return { command: hostExecutable(), script: join(__dirname, 'checklist-mcp.js'), socketPath: checklistBridge.socketPath, version: app.getVersion() };
}

// 起動する Claude Code に足す、ウォークスルーの MCP サーバー。メニューでオフにしているときや、待ち受けを始められなかったときは足さない
function walkthroughLaunch(): McpLaunch | null {
  if (!walkthroughBridge || !settings.walkthroughControlEnabled()) return null;
  return { command: hostExecutable(), script: join(__dirname, 'walkthrough-mcp.js'), socketPath: walkthroughBridge.socketPath, version: app.getVersion() };
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
      {
        // 既定の appMenu の並びに、「新しいバージョンが出たら通知する」の切り替えを足す
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: '新しいバージョンが出たら通知する', type: 'checkbox', checked: settings.updateCheckEnabled(), click: (item) => setUpdateCheck(item) },
          { label: 'Claude にアプリ内ブラウザを操作させる', type: 'checkbox', checked: settings.browserControlEnabled(), click: (item) => setBrowserControl(item) },
          { label: 'Claude にほかのセッションを扱わせる', type: 'checkbox', checked: settings.sessionsControlEnabled(), click: (item) => setSessionsControl(item) },
          { label: 'Claude にチェックリストを扱わせる', type: 'checkbox', checked: settings.checklistControlEnabled(), click: (item) => setChecklistControl(item) },
          { label: 'Claude にウォークスルーさせる', type: 'checkbox', checked: settings.walkthroughControlEnabled(), click: (item) => setWalkthroughControl(item) },
          {
            label: 'アプリ内ブラウザで Claude に許す先…',
            click: () => {
              showWindow();
              send(IpcChannel.BrowserHostsOpen, undefined);
            },
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
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

// メニューの「新しいバージョンが出たら通知する」。オフにしたら、GitHub への問い合わせをやめて、タイトルバーの印も消す。
// 保存できなかったら、チェックを元に戻す
function setUpdateCheck(item: MenuItem): void {
  try {
    settings.setUpdateCheckEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
    return;
  }
  if (item.checked) appUpdates.start();
  else appUpdates.stop();
}

// メニューの「Claude にアプリ内ブラウザを操作させる」。オンなら、次に起動する Claude Code から MCP サーバーを足す。
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（browser-control の handle）。保存できなかったら、チェックを元に戻す
function setBrowserControl(item: MenuItem): void {
  try {
    settings.setBrowserControlEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
    return;
  }
  if (!item.checked) browser.cancelAsks();
}

// メニューの「Claude にほかのセッションを扱わせる」。オンなら、次に起動する Claude Code から MCP サーバーを足す。
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（sessions-control の handle）。子への知らせも止める。
// 保存できなかったら、チェックを元に戻す
function setSessionsControl(item: MenuItem): void {
  try {
    settings.setSessionsControlEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
  }
}

// メニューの「Claude にチェックリストを扱わせる」。オンなら、次に起動する Claude Code から MCP サーバーを足す。
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（checklist-control の handle）。画面のチェックリストは使える。
// 保存できなかったら、チェックを元に戻す
function setChecklistControl(item: MenuItem): void {
  try {
    settings.setChecklistControlEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
  }
}

// メニューの「Claude にウォークスルーさせる」。オンなら、次に起動する Claude Code から MCP サーバーを足す。
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（walkthrough-control の handle）。
// 保存できなかったら、チェックを元に戻す
function setWalkthroughControl(item: MenuItem): void {
  try {
    settings.setWalkthroughControlEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
  }
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
  // Claude の操作でトップのフレームが移るときは、Claude に許した先だけ（リンクやリダイレクトで、外のサイトを開かせない）
  const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (!isPreviewDestination(event.url, event.isMainFrame)) event.preventDefault();
    else if (event.isMainFrame && browser?.blocksNavigation(contents, event.url)) event.preventDefault();
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
  // 登録した設定ファイル。設定ファイルを選んだセッションの起動で、アプリの設定と合わせたファイルは session-settings に置く
  settingsFiles = new SettingsFiles(settings, join(app.getPath('userData'), 'session-settings'), (files) =>
    send(IpcChannel.SettingsFilesChanged, files),
  );
  // Claude によるアプリ内ブラウザの操作。中継（MCP サーバー）からの呼び出しを、userData のソケットで受ける。
  // 待ち受けを始められなくても、アプリはそのまま使う（Claude Code に MCP サーバーを足さない）
  browser = new BrowserControl({
    send,
    enabled: () => settings.browserControlEnabled(),
    extraHosts: () => settings.browserHosts(),
    host: () => mainWindow?.webContents ?? null,
    hasSession: (id) => !!manager?.summary(id),
    // 一覧は「ブラウザでの操作待ち」。見ていないセッションなら通知し、クリックでそのセッションのブラウザを開く
    onAsk: (id, ask) => {
      manager?.browserAskChanged(id, !!ask);
      if (ask) notify(id, manager?.summary(id)?.title ?? null, `ブラウザでの操作の依頼: ${snippet(ask.message)}`, IpcChannel.BrowserShow);
    },
    channels: {
      open: IpcChannel.BrowserOpen,
      activity: IpcChannel.BrowserActivity,
      viewport: IpcChannel.BrowserViewport,
      newTab: IpcChannel.BrowserNewTab,
      selectTab: IpcChannel.BrowserSelectTab,
      closeTab: IpcChannel.BrowserCloseTab,
      ask: IpcChannel.BrowserAsk,
    },
  });
  browser.watchNetwork(session.fromPartition(PREVIEW_PARTITION));
  const bridge = new McpBridge(socketPathIn(app.getPath('userData'), 'browser', 'browser'), (id, tool, args, signal) => browser.handle(id, tool, args, signal));
  try {
    await bridge.start();
    browserBridge = bridge;
  } catch (error) {
    console.error('アプリ内ブラウザの待ち受けを始められませんでした', error);
  }
  // ほかのセッションの扱い。待ち受けを始められなくても、アプリはそのまま使う（Claude Code に MCP サーバーを足さない）
  const sessions = new McpBridge(socketPathIn(app.getPath('userData'), 'sessions', 'sessions'), (id, tool, args, signal) =>
    sessionsControl ? sessionsControl.handle(id, tool, args, signal) : Promise.resolve(textResult('tanacode の起動が終わっていません。少し待ってから試してください', true)),
  );
  try {
    await sessions.start();
    sessionsBridge = sessions;
  } catch (error) {
    console.error('セッションの待ち受けを始められませんでした', error);
  }
  // チェックリスト。待ち受けを始められなくても、画面からは使える（Claude Code に MCP サーバーを足さない）
  checklists = new ChecklistStore(join(app.getPath('userData'), 'checklists'), (id, lists) => send(IpcChannel.ChecklistChanged, { sessionId: id, lists }));
  const checklistSocket = new McpBridge(socketPathIn(app.getPath('userData'), 'checklist', 'checklist'), (id, tool, args) =>
    checklistControl ? checklistControl.handle(id, tool, args) : Promise.resolve(textResult('tanacode の起動が終わっていません。少し待ってから試してください', true)),
  );
  try {
    await checklistSocket.start();
    checklistBridge = checklistSocket;
  } catch (error) {
    console.error('チェックリストの待ち受けを始められませんでした', error);
  }
  // ウォークスルー。保存はせず、アプリのメモリの上だけで持つ
  const walkthroughSocket = new McpBridge(socketPathIn(app.getPath('userData'), 'walkthrough', 'walkthrough'), (id, tool, args) =>
    walkthroughControl ? walkthroughControl.handle(id, tool, args) : Promise.resolve(textResult('tanacode の起動が終わっていません。少し待ってから試してください', true)),
  );
  try {
    await walkthroughSocket.start();
    walkthroughBridge = walkthroughSocket;
  } catch (error) {
    console.error('ウォークスルーの待ち受けを始められませんでした', error);
  }
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
  }, remoteControl, settingsFiles, (owner, cwd, command, name) => shells.run(owner, cwd, command, name), browserLaunch, sessionsLaunch, checklistLaunch, walkthroughLaunch);
  sessionsControl = new SessionsControl({ host: manager, enabled: () => settings.sessionsControlEnabled(), home: homedir() });
  // 時刻を指定して送信（予約）。送れなかった・時刻を過ぎていたものは通知する
  scheduled = new ScheduledMessages(
    join(app.getPath('userData'), 'scheduled-messages.json'),
    manager,
    (messages) => send(IpcChannel.ScheduledChanged, messages),
    (message) => notify(message.sessionId, manager.summary(message.sessionId)?.title ?? null, scheduledNotice(message)),
  );
  // アーカイブした・一覧から消したセッションの予約は取り消す
  manager.watchState((id) => {
    const state = manager.stateOf(id);
    if (state === null || state === 'archived') scheduled.dropSession(id);
    // アーカイブした・一覧から消したセッションのウォークスルーは捨てる
    if (state === null || state === 'archived') walkthroughControl?.discard(id);
  });
  walkthroughControl = new WalkthroughControl({
    cwdOf: (id) => (manager.summary(id) ? manager.cwdOf(id) : null),
    enabled: () => settings.walkthroughControlEnabled(),
    onChange: (sessionId, walkthrough) => send(IpcChannel.WalkthroughChanged, { sessionId, walkthrough }),
  });
  checklistControl = new ChecklistControl({ store: checklists, host: manager, enabled: () => settings.checklistControlEnabled() });
  usage = new UsageMonitor(join(app.getPath('userData'), 'usage.json'), (value) => send(IpcChannel.UsageChanged, value));
  claudeVersions = new ClaudeVersionMonitor((version) => send(IpcChannel.ClaudeVersionChanged, version));
  // 問い合わせは Chromium の通信（net.fetch）で行う。macOS のプロキシの設定がそのまま効く
  appUpdates = new AppUpdateMonitor(app.getVersion(), (update) => send(IpcChannel.AppUpdateChanged, update), (url, init) => net.fetch(url, init));
  // 前に起動したアプリから動き続けている Claude Code を引き継ぐ
  await manager.adopt();
  // 動き続けている Claude Code を引き継いでから、時刻を過ぎた予約を片付けて待ち始める
  scheduled.start();
  registerIpc();
  buildMenu();
  createWindow();
  void usage.start();
  system = new SystemMonitor((stats) => send(IpcChannel.SystemStats, stats));
  system.start();
  claudeVersions.start();
  if (settings.updateCheckEnabled()) appUpdates.start();
  // ターミナルで Claude Code を更新して戻ってきたときに、すぐ表示を変える
  app.on('browser-window-focus', () => void claudeVersions.refresh());
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
  claudeVersions?.stop();
  appUpdates?.stop();
  // Claude Code は止めずに、見るのをやめるだけ（止めるときは、先に quit(true) で止めてある）
  manager?.closeAll(false);
  ptyHost?.close();
  browserBridge?.close();
  sessionsControl?.dispose();
  scheduled?.dispose();
  sessionsBridge?.close();
  checklistControl?.dispose();
  checklistBridge?.close();
  checklists?.flush();
  walkthroughBridge?.close();
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
