import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, powerMonitor, screen, session, shell, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItem, type WebContents } from 'electron';
import { IpcChannel, LANGUAGE_ARG, type IpcEvent, type IpcInvoke, type IpcSend, type ArchiveOptions, type DiscoveredSession, type GitAction, type NewSessionOptions, type ScreenChoice, type SearchOptions, type SessionOptions } from '@shared/ipc';
import { AppSettings } from './app-settings';
import { SharedPrefStore } from './shared-prefs';
import { Profile, type Send } from './profile';
import { profileDataDir, ProfileRegistry } from './profile-registry';
import { DEFAULT_PROFILE_ID, type NewProfile, type ProfileInfo, type ProfilesState } from '@shared/profile';
import type { SharedPrefChange, SharedPrefKey, SharedPrefs } from '@shared/prefs';
import { checkCopyRequest, checkOp, unreadCount } from '@shared/checklist';
import { draftWalkthroughComment, postWalkthroughComment, type CommentDeps } from './walkthrough-github';
import { commentOnPullRequest, pullRequestsOf } from './github';
import { AppUpdateMonitor } from './app-update';
import type { AppUpdate } from '@shared/app-update';
import { CASK, HomebrewUpdater } from './homebrew-update';
import { discoverSessions } from './session-discovery';
import { SourceControl } from './source-control';
import type { PermissionMode } from '@shared/screen';
import type { AgentLogRef, TaskRef } from '@shared/task';
import { listCommands } from './commands';
import { imageOf } from './image-cache';
import { DEFAULT_PTY_SIZE } from './session-manager';
import { readModelCatalog } from './model-catalog';
import { SystemMonitor } from './system-monitor';
import { ClaudeVersionMonitor } from './claude-version';
import { LANGUAGE_SETTINGS_URL, translateAvailable, translateHelperPath, translateTexts, Translator } from './translate';
import { readClaudeAccount } from './claude-account';
import { loadWindowState, placeWindow, saveWindowState } from './window-state';
import { Workspace } from './workspace';
import { claudeConfigDir, claudeJsonPath } from './claude-config';
import { language, LANGUAGE_SETTINGS, resolveLanguage, setLanguage, t, tFor, type LanguageSetting } from '@shared/i18n';

let mainWindow: BrowserWindow | null = null;
// 登録したプロファイル（Claude Code のアカウントごとの環境）
let registry: ProfileRegistry;
// 開いているプロファイル（id → プロファイル）。既定のプロファイルがいつも先頭
const opened = new Map<string, Profile>();
// 足したプロファイルの画面。ウインドウいっぱいに重ね、見ているものだけを出す（既定のプロファイルは、ウインドウ自身の画面）
const views = new Map<string, WebContentsView>();
// 見ているプロファイル
let activeId: string = DEFAULT_PROFILE_ID;
// アプリの画面（主ウインドウと足したプロファイルの画面）が、どのプロファイルのものか。画面からの呼び出しを振り分ける
const contentsProfile = new WeakMap<WebContents, string>();
// 画面に最後に知らせた「ほかのプロファイルに通知あり」（変わったときだけ知らせ直す）
const lastOthersAttention = new Map<string, boolean>();
// 開発版（パッケージしていないもの）は Remote Control を使わない（起動するたびにスマホに通知が届くため）。
// 以前つないでいた会話を再開して Claude Code が勝手につなぎ直したときも、切る。使いたいときは TANACODE_REMOTE_CONTROL=1 で起動する
let remoteControl = false;
// アプリ全体の設定（通知・新しいバージョンの確認）。既定のプロファイルの設定も同じファイルに入っている
let settings: AppSettings;
let sharedPrefs: SharedPrefStore;
let system: SystemMonitor;
let claudeVersions: ClaudeVersionMonitor;
let appUpdates: AppUpdateMonitor;
// Homebrew で入れたときだけ作る（新しいバージョンを裏でダウンロードしておき、終了したあとに入れ替える）
let homebrew: HomebrewUpdater | null = null;
// タイトルバーの「再起動して更新」で終了する（入れ替えたあと起動し直す）
let relaunchAfterUpdate = false;
// 言語を変えて「今すぐ再起動」を選んだ。終了したら起動し直す
let relaunchForLanguage = false;
// Mac の再起動・シャットダウンで終わる（brew を動かしても途中で止められるので、入れ替えない）
let shuttingDown = false;
// 終了のしかたが決まった（確認を済ませた・確認の要らない終了）。まだなら before-quit で止めて確認する
let quitDecided = false;
let confirmingQuit = false;
// アプリ内プレビューの webview が使うセッション（renderer の PreviewPane の PARTITION と同じ名前）。
// 足したプロファイルは、ログイン（Cookie）が混ざらないよう別のものにする（webview を付けるときに main が差し替える）
const PREVIEW_PARTITION = 'persist:tanacode-preview';
const previewPartition = (id: string) => (id === DEFAULT_PROFILE_ID ? PREVIEW_PARTITION : `${PREVIEW_PARTITION}-${id}`);
// 足したプロファイルの画面（アプリ自身）のセッション。localStorage などを分ける（既定のプロファイルは defaultSession）
const appPartition = (id: string) => `persist:tanacode-profile-${id}`;
// 主ウインドウ（アプリ自身の画面）にだけ許す権限。Monaco の右クリックメニューの「貼り付け」は、
// execCommand('paste') が効かないとき navigator.clipboard.readText を使う（コピーも navigator.clipboard を使うことがある）。
// 通知は main の Notification で出すので、画面側の notifications は要らない
const APP_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-read', 'clipboard-sanitized-write']);

// 権限の要求と確認を、既定では断る。Electron はハンドラーが無いと、ほとんどの権限（カメラ・マイク・位置情報・
// クリップボードの読み取り・外部プロトコルの起動など）を確認なしに許してしまう。
// プレビューの webview（開発中の任意のページ）には何も許さない。主ウインドウには APP_PERMISSIONS だけを許す
function restrictPermissions(): void {
  restrictAppSession(session.defaultSession);
  restrictPreviewSession(session.fromPartition(PREVIEW_PARTITION));
}

// アプリの画面のセッション。アプリの画面（主ウインドウと、足したプロファイルの画面）にだけ APP_PERMISSIONS を許す
function restrictAppSession(target: Electron.Session): void {
  const isApp = (contents: WebContents | null, isMainFrame: boolean) => !!contents && isMainFrame && isAppContents(contents);
  target.setPermissionRequestHandler((contents, permission, callback, details) => callback(APP_PERMISSIONS.has(permission) && isApp(contents, details.isMainFrame)));
  target.setPermissionCheckHandler((contents, permission, _origin, details) => APP_PERMISSIONS.has(permission) && isApp(contents, details.isMainFrame));
}

function restrictPreviewSession(preview: Electron.Session): void {
  preview.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  preview.setPermissionCheckHandler(() => false);
  // ダウンロードも断る（Claude が操作したページが、勝手にファイルを保存させないように）
  preview.on('will-download', (event) => event.preventDefault());
}

// アプリ自身の画面か（主ウインドウか、足したプロファイルの画面）
function isAppContents(contents: WebContents): boolean {
  if (contents.getType() !== 'window' && contents.getType() !== 'browserView') return false;
  return contents === mainWindow?.webContents || [...views.values()].some((view) => view.webContents === contents);
}

// プレビューの webview の中で移ってよい先。トップのフレームは http(s) のページと about:blank だけ（file: や
// mailto: などの外部プロトコルへは移らない。外部プロトコルのアプリも起こさない）。
// 中のフレーム（iframe）は、ページが自分で作る about:srcdoc・blob:・data: も通す（ページの開発で使うため。どれもページの外には出られない）
function isPreviewDestination(url: string, isMainFrame: boolean): boolean {
  if (/^https?:\/\//i.test(url) || url === 'about:blank') return true;
  return !isMainFrame && (url === 'about:srcdoc' || /^(blob|data):/i.test(url));
}

// 画面への知らせ・画面からの呼び出しと知らせの受け口。チャンネルごとの中身・引数・戻り値は、shared/ipc.ts の表（IpcEvent・IpcInvoke・IpcSend）で決まる。
// preload も同じ表で型を付けるので、食い違うと型チェックで止まる
// アプリ全体の知らせ（新しいバージョン・CPU とメモリなど）は、どのプロファイルの画面にも送る
function send<C extends keyof IpcEvent>(channel: C, payload: IpcEvent[C]): void {
  for (const id of [DEFAULT_PROFILE_ID, ...views.keys()]) sendTo(id)(channel, payload);
}

// プロファイル id の画面への知らせ
function sendTo(id: string): Send {
  return (channel, payload) => {
    const contents = contentsOf(id);
    if (contents && !contents.isDestroyed()) contents.send(channel, payload);
  };
}

// プロファイル id の画面
function contentsOf(id: string): WebContents | null {
  return (id === DEFAULT_PROFILE_ID ? mainWindow?.webContents : views.get(id)?.webContents) ?? null;
}

// 開いているプロファイル
function profiles(): Profile[] {
  return [...opened.values()];
}

// 見ているプロファイル
function activeProfile(): Profile | null {
  return opened.get(activeId) ?? opened.get(DEFAULT_PROFILE_ID) ?? null;
}

// Claude Code が動いているセッション（全プロファイル）。終了・更新のときに止めるかを聞く
function liveSessions() {
  // 起動の途中（pty ホストを待っている間）のプロファイルには、まだ動いているものが無い
  return profiles().flatMap((p) => p.manager?.liveSessions() ?? []);
}

// 画面（呼び出し・知らせの送り元）のプロファイル。ほかのプロファイルのものは扱わせない
function profileOf(contents: WebContents): Profile {
  const id = contentsProfile.get(contents);
  const p = id === undefined ? undefined : opened.get(id);
  if (!p) throw new Error(t('main.error.profileOfViewNotFound'));
  return p;
}

// 画面に渡すプロファイルの様子（id のプロファイルの画面から見たもの）
function profilesState(id: string): ProfilesState {
  return { profiles: registry.list().filter((p) => opened.has(p.id)), current: id, othersAttention: othersAttention(id) };
}

// id 以外のプロファイルに、見てほしいもの（確認待ち・新しい応答）があるか
function othersAttention(id: string): boolean {
  for (const [other, p] of opened) {
    if (other === id || !p.manager) continue;
    if (p.manager.list().some((s) => !s.archived && (s.attention !== null || s.unread))) return true;
  }
  return false;
}

// プロファイルの様子を画面に知らせる。force でなければ、「ほかのプロファイルに通知あり」が変わった画面にだけ
function broadcastProfiles(force = false): void {
  for (const id of opened.keys()) {
    const state = profilesState(id);
    if (!force && lastOthersAttention.get(id) === state.othersAttention) continue;
    lastOthersAttention.set(id, state.othersAttention);
    sendTo(id)(IpcChannel.ProfilesChanged, state);
  }
}

function handle<C extends keyof IpcInvoke>(
  channel: C,
  listener: (event: IpcMainInvokeEvent, ...args: Parameters<IpcInvoke[C]>) => ReturnType<IpcInvoke[C]> | Awaited<ReturnType<IpcInvoke[C]>>,
): void {
  ipcMain.handle(channel, listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
}

function listen<C extends keyof IpcSend>(channel: C, listener: (event: IpcMainEvent, ...args: Parameters<IpcSend[C]>) => void): void {
  ipcMain.on(channel, listener as (event: IpcMainEvent, ...args: unknown[]) => void);
}

// 前に閉じたときのウインドウの位置と大きさ。次の起動で同じところに開く
function windowStateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function createWindow(): void {
  const saved = loadWindowState(windowStateFile());
  const placement = placeWindow(
    saved,
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
    webPreferences: { preload: join(__dirname, '../preload/index.js'), webviewTag: true, additionalArguments: [`${LANGUAGE_ARG}${language()}`] },
  });
  mainWindow = win;
  // 最大化・フルスクリーンを解いたときの位置と大きさは、通常の状態のたびに自分で控える。macOS の getNormalBounds() は、
  // ドラッグで動かしたあとを追わず、最後に API で決めた位置（起動したときの位置）を返す。それを覚えると、
  // 別のディスプレイへ動かして最大化したウインドウが、次の起動で元のディスプレイに開いてしまう
  let normalBounds = win.getNormalBounds();
  if (saved?.maximized && !saved.fullScreen) win.maximize();
  // macOS の resized・moved は、動かし終えたときに一度だけ届く。最大化のアニメーションの途中（resize）は、
  // まだ通常の状態に見えるので、そこでは控えない
  const remember = () => {
    if (win.isDestroyed()) return;
    if (win.isNormal()) normalBounds = win.getBounds();
    try {
      saveWindowState(windowStateFile(), { bounds: normalBounds, frame: win.getBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() });
    } catch {
      // 覚えられなくても、次の起動が既定の大きさになるだけ
    }
  };
  win.on('resized', remember);
  win.on('moved', remember);
  win.on('maximize', remember);
  win.on('unmaximize', remember);
  win.on('enter-full-screen', remember);
  win.on('leave-full-screen', remember);

  setupAppContents(win.webContents, DEFAULT_PROFILE_ID);
  // 足したプロファイルの画面は、ウインドウの大きさに合わせる
  win.on('resize', layoutViews);
  // バツボタンでウインドウを閉じたら、アプリも終了する（Claude Code を止めるかは quit の確認で決める）
  win.on('close', (event) => {
    remember();
    if (quitDecided) return;
    event.preventDefault();
    app.quit();
  });
  win.on('closed', () => {
    if (mainWindow !== win) return;
    mainWindow = null;
    views.clear();
  });

  loadApp(win);
  for (const id of opened.keys()) if (id !== DEFAULT_PROFILE_ID) attachView(id);
}

// アプリの画面を読み込む（主ウインドウか、足したプロファイルの画面）
function loadApp(target: Pick<WebContents, 'loadURL' | 'loadFile'>): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void target.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void target.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// アプリの画面（プロファイル id のもの）。外へのリンクは既定のブラウザで開き、画面は移らない。アプリ内ブラウザの webview には、
// アプリの API（preload）や Node を渡さず、プロファイルのセッション（Cookie）を使わせる
function setupAppContents(contents: WebContents, id: string): void {
  contentsProfile.set(contents, id);
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
    if (id !== DEFAULT_PROFILE_ID) webPreferences.partition = previewPartition(id);
    if (!/^https?:\/\//.test(params.src) && params.src !== 'about:blank') event.preventDefault();
  });
  contents.on('did-attach-webview', (_e, guest) => {
    const browser = opened.get(id)?.browser;
    // コンソールと失敗した通信は、ページの最初のスクリプトから集める（Claude が読む）
    browser?.track(guest);
    // 新しいウィンドウで開くもの（target=_blank・window.open）は、アプリ内ブラウザの新しいタブで開く（ウィンドウは作らない）。
    // Claude の操作で、許していない先を開こうとしたものは開かない（browser-control の openFromPage）
    guest.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:\/\//.test(url) && !browser?.openFromPage(guest, url, disposition) && !browser?.isOperating(guest)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

// 足したプロファイルの画面を作って、ウインドウに重ねる（見ているプロファイルのものだけを出す）
function attachView(id: string): void {
  if (!mainWindow || views.has(id)) return;
  const view = new WebContentsView({
    webPreferences: { preload: join(__dirname, '../preload/index.js'), webviewTag: true, partition: appPartition(id), additionalArguments: [`${LANGUAGE_ARG}${language()}`] },
  });
  view.setBackgroundColor('#121211');
  setupAppContents(view.webContents, id);
  views.set(id, view);
  mainWindow.contentView.addChildView(view);
  view.setVisible(id === activeId);
  layoutViews();
  loadApp(view.webContents);
}

function detachView(id: string): void {
  const view = views.get(id);
  if (!view) return;
  views.delete(id);
  mainWindow?.contentView.removeChildView(view);
  view.webContents.close();
}

function layoutViews(): void {
  if (!mainWindow) return;
  const { width, height } = mainWindow.getContentBounds();
  for (const view of views.values()) view.setBounds({ x: 0, y: 0, width, height });
}

// 見るプロファイルを変える。足したプロファイルの画面を出し入れし、メニュー（プロファイルごとの設定）も作り直す
function showProfile(id: string): void {
  if (!opened.has(id)) return;
  activeId = id;
  for (const [viewId, view] of views) view.setVisible(viewId === id);
  // 既定のプロファイルの画面はウインドウ自身なので、ウインドウが前に出れば入力を受ける
  if (id !== DEFAULT_PROFILE_ID) views.get(id)?.webContents.focus();
  buildMenu();
}

function showWindow(): BrowserWindow {
  if (!mainWindow) createWindow();
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

async function pickFolder(p: Profile): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: t('main.dialog.pickFolder'),
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  const dir = result.canceled ? null : (result.filePaths[0] ?? null);
  if (dir) p.pickedFolders.add(dir);
  return dir;
}

// 設定ファイルの選択。Claude Code の設定は隠しフォルダ（~/.claude）にあるので、そこから始めて、隠しファイルも見せる
async function pickSettingsFile(p: Profile): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: t('main.dialog.pickSettingsFile'),
    defaultPath: claudeConfigDir(p.claudeDir),
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
  if (typeof html !== 'string' || typeof fileName !== 'string') throw new Error(t('main.error.nothingToExport'));
  // 先頭の . は除いて、隠しファイルにしない。先頭の空白（制御文字を置き換えたものも）と . はまとめて除く（空白のあとの . も残さない）
  const name = fileName.replace(/[/\\:\x00-\x1f]/g, ' ').replace(/^[\s.]+/, '').trim().slice(0, 120) || t('main.dialog.exportDefaultName');
  const options: Electron.SaveDialogOptions = {
    title: t('main.dialog.exportTitle'),
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
function notify(
  p: Profile,
  sessionId: string,
  sessionTitle: string | null,
  message: string,
  clickChannel: typeof IpcChannel.SessionsSelect | typeof IpcChannel.BrowserShow = IpcChannel.SessionsSelect,
): void {
  if (!settings.notificationsEnabled()) return;
  // 子セッションは人に通知しない。作業の終わり・質問・人の対応待ちは親に知らせ、人を呼ぶときは親から伝える（sessions-control.ts）
  if (p.manager?.parentOf(sessionId)) return;
  const windowActive = mainWindow?.isFocused() ?? false;
  if (windowActive && p.id === activeId && p.manager.isFocused(sessionId)) return;
  if (!Notification.isSupported()) return;
  // プロファイルが 2 つ以上あれば、どのプロファイルのセッションかをサブタイトルの頭に付ける
  const title = sessionTitle ?? t('main.session.untitled');
  const subtitle = opened.size > 1 ? `${registry.get(p.id)?.name ?? ''} · ${title}` : title;
  // 音は macOS のシステム音の Glass（指定しないと、既定の通知音が鳴る）
  const notification = new Notification({ title: 'tanacode', subtitle, body: message, sound: 'Glass' });
  const release = () => liveNotifications.delete(notification);
  notification.on('click', () => {
    release();
    showWindow();
    showProfile(p.id);
    sendTo(p.id)(clickChannel, sessionId);
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

// プロファイルを開く（待ち受けと pty ホストを始め、動き続けている Claude Code を引き継ぐ）。開けなければ片付けてから投げる
async function openProfile(info: ProfileInfo): Promise<Profile> {
  const isDefault = info.id === DEFAULT_PROFILE_ID;
  const dataDir = profileDataDir(app.getPath('userData'), info.id);
  if (!isDefault) {
    restrictAppSession(session.fromPartition(appPartition(info.id)));
    restrictPreviewSession(session.fromPartition(previewPartition(info.id)));
  }
  const p = new Profile({
    id: info.id,
    dataDir,
    claudeDir: info.claudeDir,
    // 既定のプロファイルの設定は、アプリ全体の設定と同じファイル
    settings: isDefault ? settings : new AppSettings(join(dataDir, 'settings.json')),
    send: sendTo(info.id),
    host: () => contentsOf(info.id),
    notify,
    preview: session.fromPartition(previewPartition(info.id)),
    remoteControl,
    onSessionsChanged: () => broadcastProfiles(),
  });
  // 起動の途中で終われと言われても、作ったものは片付けられるように、先に覚えておく
  opened.set(info.id, p);
  lastOthersAttention.set(info.id, false);
  try {
    await p.start();
  } catch (error) {
    if (!isDefault) {
      opened.delete(info.id);
      p.close();
    }
    throw error;
  }
  return p;
}

// 足したプロファイルを足して開き、画面を作る。開けなければ登録も戻す
async function addProfile(input: NewProfile): Promise<ProfileInfo> {
  const info = registry.add(input);
  try {
    const p = await openProfile(info);
    void p.usage.start();
  } catch (error) {
    registry.remove(info.id);
    throw error;
  }
  attachView(info.id);
  broadcastProfiles(true);
  return info;
}

// 足したプロファイルを登録から外し、閉じる。Claude Code が動いているセッションがあれば断る（止めるかは人が決める）
async function removeProfile(id: string): Promise<void> {
  const p = opened.get(id);
  if (id === DEFAULT_PROFILE_ID) throw new Error(t('main.profile.cannotRemoveDefault'));
  if (p?.manager?.liveSessions().length) throw new Error(t('main.profile.hasLiveSessions'));
  registry.remove(id);
  if (activeId === id) showProfile(DEFAULT_PROFILE_ID);
  detachView(id);
  opened.delete(id);
  lastOthersAttention.delete(id);
  if (p) {
    await p.stop();
    p.close();
  }
  broadcastProfiles(true);
}

// 既にある Claude Code の設定のフォルダを選ぶ。隠しフォルダ（~/.claude-…）なので、ホームから始めて隠しファイルも見せる
async function pickProfileDir(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: t('main.dialog.pickProfileDir'),
    defaultPath: homedir(),
    properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function registerIpc(): void {
  // 送り元の画面のプロファイル
  const P = (e: IpcMainEvent | IpcMainInvokeEvent) => profileOf(e.sender);
  handle(IpcChannel.SessionsList, (e) => P(e).manager.list());
  const isDirectory = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);
  handle(IpcChannel.SessionsCreate, async (e, cwd: string, options: NewSessionOptions) => {
    const p = P(e);
    if (!(await isDirectory(cwd))) throw new Error(t('main.error.folderNotFound', { path: cwd }));
    return options.worktree ? p.manager.createInWorktree(cwd, options) : p.manager.create(cwd, options);
  });
  handle(IpcChannel.FolderPick, (e) => pickFolder(P(e)));
  handle(IpcChannel.FolderInfo, async (_e, cwd: string) => ((await isDirectory(cwd)) ? new Workspace(cwd).info() : null));
  handle(IpcChannel.FolderFiles, (_e, cwd: string) => new Workspace(cwd).listFiles().catch(() => []));
  handle(IpcChannel.FolderCommands, (e, cwd: string) => listCommands(cwd, null, P(e).claudeDir));
  handle(IpcChannel.FolderOpen, async (e, cwd: string) => {
    const p = P(e);
    const known = p.pickedFolders.has(cwd) || p.manager.list().some((s) => s.cwd === cwd || s.worktree?.root === cwd);
    if (!known || !(await isDirectory(cwd))) throw new Error(t('main.error.folderCannotOpen', { path: cwd }));
    const id = `folder:${randomUUID()}`;
    p.folderViews.set(id, cwd);
    p.watchers.retain(cwd);
    return id;
  });
  listen(IpcChannel.FolderClose, (e, id: string) => {
    const p = P(e);
    const cwd = p.folderViews.get(id);
    if (cwd === undefined) return;
    p.folderViews.delete(id);
    p.watchers.release(cwd);
    // 新規セッションの画面で開いたターミナルとブラウザは、画面を閉じる（フォルダを変える・セッションを始める）と一緒に閉じる
    p.shells.killOwner(id);
    p.browser.forget(id);
  });
  handle(IpcChannel.SessionsOpen, (e, id: string) => P(e).manager.open(id));
  handle(IpcChannel.SessionsArchive, (e, id: string, options?: ArchiveOptions) => {
    const p = P(e);
    // 子セッションも一緒にアーカイブされる
    for (const target of [id, ...p.manager.childrenOf(id)]) p.browser.forget(target);
    // worktree を消すときは、そのフォルダで開いたシェルも閉じる（消したフォルダに残らないように）
    if (options?.removeWorktree) p.shells.killOwner(id);
    return p.manager.archive(id, options);
  });
  handle(IpcChannel.SessionsWorktreeLeftovers, (e, id: string) => P(e).manager.worktreeLeftovers(id));
  handle(IpcChannel.SessionsUnarchive, (e, id: string) => P(e).manager.unarchive(id));
  handle(IpcChannel.SessionsSnapshot, (e, id: string) => P(e).manager.snapshot(id));
  handle(IpcChannel.SessionsSubmit, (e, id: string, text: string, attachments: string[]) =>
    P(e).manager.submit(id, String(text ?? ''), Array.isArray(attachments) ? attachments.filter((a): a is string => typeof a === 'string') : []),
  );
  listen(IpcChannel.SessionsInterrupt, (e, id: string) => P(e).manager.interrupt(id));
  handle(IpcChannel.ScheduledList, (e) => P(e).scheduled.list());
  handle(IpcChannel.ScheduledAdd, (e, sessionId: string, text: string, attachments: string[], at: number) => {
    const paths = Array.isArray(attachments) ? attachments.filter((a): a is string => typeof a === 'string') : [];
    P(e).scheduled.add(String(sessionId), String(text ?? ''), paths, Number(at));
  });
  handle(IpcChannel.ScheduledReschedule, (e, id: string, at: number) => P(e).scheduled.reschedule(String(id), Number(at)));
  handle(IpcChannel.ScheduledSendNow, (e, id: string) => P(e).scheduled.sendNow(String(id)));
  handle(IpcChannel.ScheduledCancel, (e, id: string) => P(e).scheduled.cancel(String(id)));
  handle(IpcChannel.SessionsRename, (e, id: string, title: string) => P(e).manager.rename(id, title));
  handle(IpcChannel.SessionsRemove, async (e, id: string, options?: ArchiveOptions) => {
    const p = P(e);
    p.shells.killOwner(id);
    const targets = [id, ...p.manager.childrenOf(id)];
    for (const target of targets) p.browser.forget(target);
    const removal = await p.manager.remove(id, options);
    // 一覧から消したセッションのチェックリストも消す（アーカイブでは残す）
    for (const target of targets) if (!p.manager.summary(target)) p.checklists.remove(target);
    for (const target of targets) if (!p.manager.summary(target)) p.walkthroughControl?.forget(target);
    return removal;
  });
  handle(IpcChannel.SessionsHistory, (e, id: string) => P(e).manager.history(id));
  handle(IpcChannel.ChatImage, (_e, key: string) => imageOf(key));
  handle(IpcChannel.SessionsExportSource, (e, id: string) => P(e).manager.exportSource(id));
  handle(IpcChannel.SessionsExportSave, (_e, html: unknown, fileName: unknown) => saveExport(html, fileName));
  listen(IpcChannel.SessionsExportReveal, (_e, path: string) => {
    if (savedExports.has(path)) shell.showItemInFolder(path);
  });
  handle(IpcChannel.SessionsDiscover, (e) => discoverSessions(P(e).manager.claudeSessionIds(), P(e).claudeDir));
  handle(IpcChannel.SessionsImport, (e, s: DiscoveredSession) => P(e).manager.importSession(s.claudeSessionId, s.cwd, s.title));
  handle(IpcChannel.SessionsConfigure, (e, id: string, options: SessionOptions) => P(e).manager.configure(id, options));
  handle(IpcChannel.SessionsRestart, (e, id: string) => P(e).manager.restart(id));
  // チェックリスト。読む・書き換える（画面から届いた形を確かめる）・別のセッションへコピーする・セッションごとの未読の数
  handle(IpcChannel.ChecklistGet, (e, id: string) => (P(e).manager.summary(id) ? P(e).checklists.lists(id) : []));
  handle(IpcChannel.ChecklistApply, (e, id: string, op: unknown) => {
    const p = P(e);
    if (!p.manager.summary(id)) throw new Error(t('main.session.notFound'));
    p.checklistControl?.apply(id, checkOp(op));
  });
  handle(IpcChannel.ChecklistCopy, (e, request: unknown) => P(e).checklistControl?.copy(checkCopyRequest(request)));
  handle(IpcChannel.ChecklistUnread, (e) => {
    const p = P(e);
    const counts: Record<string, number> = {};
    for (const s of p.manager.list()) {
      const n = unreadCount(p.checklists.lists(s.id));
      if (n > 0) counts[s.id] = n;
    }
    return counts;
  });
  // ウォークスルー。今のもの・人が見るステップを変えた・終えた
  handle(IpcChannel.WalkthroughGet, (e) => P(e).walkthroughControl?.list() ?? []);
  handle(IpcChannel.WalkthroughGo, (e, id: string, index: unknown) => P(e).walkthroughControl?.go(String(id), Number(index)));
  handle(IpcChannel.WalkthroughClose, (e, id: string) => P(e).walkthroughControl?.close(String(id)));
  // GitHub の PR にコメントとして載せる（人が下見で本文を確かめてから投稿する）
  const commentDeps: CommentDeps = { pullRequests: pullRequestsOf, comment: commentOnPullRequest };
  handle(IpcChannel.WalkthroughDraftComment, async (e, id: string) => {
    const p = P(e);
    const w = p.manager.summary(String(id)) ? p.walkthroughControl?.get(String(id)) : null;
    if (!w || !p.walkthroughControl) return { ok: false, reason: t('main.walkthrough.missing') };
    return draftWalkthroughComment(p.cwdOf(String(id)), w, p.walkthroughControl.postedUrl(w.id), commentDeps);
  });
  handle(IpcChannel.WalkthroughPostComment, async (e, id: string, body: unknown, attribution: unknown) => {
    const p = P(e);
    const w = p.manager.summary(String(id)) ? p.walkthroughControl?.get(String(id)) : null;
    if (!w || !p.walkthroughControl) throw new Error(t('main.walkthrough.missing'));
    if (typeof body !== 'string') throw new Error(t('main.walkthrough.noBody'));
    const url = await postWalkthroughComment(p.cwdOf(String(id)), w, body, attribution !== false, commentDeps);
    p.walkthroughControl.markPosted(w.id, url);
    return url;
  });
  handle(IpcChannel.SessionsSetRemoteControl, (e, id: string, on: boolean) => P(e).manager.setRemoteControl(id, on));
  handle(IpcChannel.RemoteControlAvailable, (e) => P(e).manager.remoteAvailable());
  handle(IpcChannel.ScreenGet, (e, id: string) => P(e).manager.screenForView(id));
  handle(IpcChannel.ScreenActivityGet, (e, id: string) => P(e).manager.activity(id));
  handle(IpcChannel.WorkflowsGet, (e, id: string) => P(e).manager.workflows(id));
  handle(IpcChannel.ScreenSetMode, (e, id: string, mode: PermissionMode) => P(e).manager.setMode(id, mode));
  handle(IpcChannel.ScreenRewind, (e, id: string, text: string) => P(e).manager.rewind(id, text));
  handle(IpcChannel.WriteFile, (e, id: string, relPath: string, text: string) =>
    new Workspace(P(e).cwdOf(id)).writeFile(relPath, text),
  );
  const scm = (e: IpcMainInvokeEvent, id: string) => new SourceControl(P(e).cwdOf(id));
  handle(IpcChannel.GitState, (e, id: string) => scm(e, id).state());
  handle(IpcChannel.GitBranches, (e, id: string) => scm(e, id).branches());
  handle(IpcChannel.GitDiffSides, (e, id: string, relPath: string, staged: boolean) => scm(e, id).diffSides(relPath, staged));
  handle(IpcChannel.GitBranchDiffSides, (e, id: string, mergeBase: string, relPath: string) =>
    scm(e, id).branchDiffSides(mergeBase, relPath),
  );
  handle(IpcChannel.GitBaseline, (e, id: string, mergeBase: string, relPath: string) => scm(e, id).baseline(mergeBase, relPath));
  handle(IpcChannel.GitLastMessage, (e, id: string) => scm(e, id).lastCommitMessage());
  handle(IpcChannel.GitRun, (e, id: string, action: GitAction) => runGit(scm(e, id), action));
  handle(IpcChannel.Search, (e, id: string, query: string, options: SearchOptions) =>
    new Workspace(P(e).cwdOf(id)).search(query, options),
  );
  handle(IpcChannel.ListFiles, (e, id: string) => new Workspace(P(e).cwdOf(id)).listFiles());
  handle(IpcChannel.CommandsList, (e, id: string) => listCommands(P(e).manager.cwdOf(id), P(e).manager.transcriptOf(id), P(e).claudeDir));
  handle(IpcChannel.AttachmentSave, (_e, name: string, data: Uint8Array) => saveAttachment(name, data));
  handle(IpcChannel.SubagentsGet, (e, id: string) => P(e).manager.subagents(id));
  handle(IpcChannel.TasksBash, (e, id: string) => P(e).manager.bashTasks(id));
  handle(IpcChannel.KnowledgeGet, (e, id: string) => P(e).manager.knowledge(id));
  handle(IpcChannel.ContextGet, (e, id: string) => P(e).manager.context(id));
  handle(IpcChannel.SettingsFilesList, (e) => P(e).settingsFiles.list());
  handle(IpcChannel.SettingsFilesPick, (e) => pickSettingsFile(P(e)));
  handle(IpcChannel.SettingsFilesAdd, (e, path: string, name?: string) => P(e).settingsFiles.add(path, name));
  handle(IpcChannel.SettingsFilesRename, (e, id: string, name: string) => P(e).settingsFiles.rename(id, name));
  handle(IpcChannel.SettingsFilesRemove, (e, id: string) => P(e).settingsFiles.remove(id));
  handle(IpcChannel.ModelsGet, (e) => readModelCatalog(P(e).claudeDir).catch(() => null));
  handle(IpcChannel.StatusLineGet, (e, id: string) => P(e).manager.statusLine(id));
  handle(IpcChannel.UsageGet, (e) => P(e).usage.get());
  handle(IpcChannel.ClaudeVersionGet, () => claudeVersions.get());
  handle(IpcChannel.AppUpdateGet, () => withHomebrew(appUpdates.get()));
  handle(IpcChannel.AppUpdateInstall, () => installUpdate());
  handle(IpcChannel.UsageRefresh, (e) => P(e).usage.refresh());
  handle(IpcChannel.AccountGet, (e) => readClaudeAccount(claudeJsonPath(P(e).claudeDir)));
  handle(IpcChannel.ProfilesGet, (e) => profilesState(P(e).id));
  handle(IpcChannel.ProfilesSwitch, (_e, id: string) => showProfile(String(id)));
  handle(IpcChannel.ProfilesAdd, (_e, input: NewProfile) => addProfile(input));
  handle(IpcChannel.ProfilesUpdate, (_e, id: string, patch: { name?: string; color?: string }) => {
    const info = registry.update(String(id), { name: patch?.name, color: patch?.color });
    broadcastProfiles(true);
    return info;
  });
  handle(IpcChannel.ProfilesRemove, (_e, id: string) => removeProfile(String(id)));
  handle(IpcChannel.ProfilesPickDir, () => pickProfileDir());
  // プロファイルをまたいで同じにする表示設定。変わったら、ほかのプロファイルの画面に配る（送り元は、もうその値になっている）
  const sharePrefs = (sender: WebContents, changes: SharedPrefChange[]) => {
    for (const id of [DEFAULT_PROFILE_ID, ...views.keys()]) {
      if (contentsOf(id) === sender) continue;
      for (const change of changes) sendTo(id)(IpcChannel.PrefsChanged, change);
    }
  };
  handle(IpcChannel.PrefsSync, (e, local: SharedPrefs) => {
    P(e);
    sharePrefs(e.sender, sharedPrefs.adopt(local));
    return sharedPrefs.all();
  });
  listen(IpcChannel.PrefsSet, (e, key: SharedPrefKey, value: string) => {
    P(e);
    if (sharedPrefs.set(key, value)) sharePrefs(e.sender, [{ key, value }]);
  });
  handle(IpcChannel.NotificationsGet, () => settings.notificationsEnabled());
  handle(IpcChannel.NotificationsSet, (_e, on: boolean) => settings.setNotificationsEnabled(on === true));
  handle(IpcChannel.ModelsRefresh, (e) =>
    readModelCatalog(P(e).claudeDir).then(
      (catalog) => (catalog ? { catalog } : { error: t('main.model.noCatalog') }),
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    ),
  );
  // チャットの思考・応答の翻訳（同梱の補助プログラムで、macOS 標準の翻訳を呼ぶ）
  const translateHelper = translateHelperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  const translator = new Translator(translateHelper);
  handle(IpcChannel.TranslateAvailable, () => translateAvailable(process.getSystemVersion(), existsSync(translateHelper)));
  handle(IpcChannel.TranslateRun, (_e, texts: unknown) => translator.translate(translateTexts(texts)));
  handle(IpcChannel.TranslateOpenSettings, () => shell.openExternal(LANGUAGE_SETTINGS_URL));
  handle(IpcChannel.TasksAgentLog, (e, id: string, ref: AgentLogRef) => P(e).manager.agentLog(id, ref));
  handle(IpcChannel.TasksStop, (e, id: string, ref: TaskRef) => P(e).manager.stopTask(id, ref));
  handle(IpcChannel.ScreenChoose, (e, id: string, choice: ScreenChoice) => P(e).manager.choose(id, choice));
  listen(IpcChannel.SessionsFocus, (e, id: string | null) => P(e).manager.focus(id));
  listen(IpcChannel.PtyWrite, (e, id: string, data: string) => P(e).manager.write(id, data));
  listen(IpcChannel.PtyResize, (e, id: string, cols: number, rows: number) => P(e).manager.resize(id, cols, rows));
  listen(IpcChannel.PtyResetSize, (e, id: string) => P(e).manager.resize(id, DEFAULT_PTY_SIZE.cols, DEFAULT_PTY_SIZE.rows));
  handle(IpcChannel.ShellCreate, (e, id: string, cols: number, rows: number) =>
    P(e).shells.create(id, P(e).cwdOf(id), cols, rows),
  );
  listen(IpcChannel.ShellWrite, (e, id: string, data: string) => P(e).shells.write(id, data));
  listen(IpcChannel.ShellResize, (e, id: string, cols: number, rows: number) => P(e).shells.resize(id, cols, rows));
  listen(IpcChannel.ShellKill, (e, id: string) => P(e).shells.kill(id));
  handle(IpcChannel.WorkspaceInfo, (e, id: string) => new Workspace(P(e).cwdOf(id)).info());
  handle(IpcChannel.ListDir, (e, id: string, relPath: string) => new Workspace(P(e).cwdOf(id)).listDir(relPath));
  handle(IpcChannel.ReadFile, (e, id: string, relPath: string) => new Workspace(P(e).cwdOf(id)).readFile(relPath));
  handle(IpcChannel.ReadImage, (e, id: string, relPath: string) =>
    new Workspace(P(e).cwdOf(id)).readImage(relPath).catch(() => null),
  );
  listen(IpcChannel.BrowserAttach, (e, id: string, tabId: string, webContentsId: number) => P(e).browser.attach(id, tabId, webContentsId));
  listen(IpcChannel.BrowserActivate, (e, id: string, tabId: string | null) => P(e).browser.activate(id, tabId));
  handle(IpcChannel.BrowserOpenExternal, (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
  });
  handle(IpcChannel.BrowserAsksGet, (e) => P(e).browser.pendingAsks());
  listen(IpcChannel.BrowserAnswer, (e, id: string, askId: string, answer: unknown) => P(e).browser.answerAsk(id, askId, answer));
  handle(IpcChannel.BrowserHostsGet, (e) => P(e).settings.browserHosts());
  handle(IpcChannel.BrowserHostsSet, (e, hosts: string[]) => P(e).setBrowserHosts(hosts));
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
          { label: t('main.menu.notifyUpdates'), type: 'checkbox', checked: settings.updateCheckEnabled(), click: (item) => setUpdateCheck(item) },
          { label: t('main.menu.updateOnQuit'), type: 'checkbox', checked: settings.updateOnQuitEnabled(), click: (item) => setUpdateOnQuit(item) },
          { label: t('main.menu.browserControl'), type: 'checkbox', checked: !!activeProfile()?.settings.browserControlEnabled(), click: (item) => setBrowserControl(item) },
          { label: t('main.menu.sessionsControl'), type: 'checkbox', checked: !!activeProfile()?.settings.sessionsControlEnabled(), click: (item) => setSessionsControl(item) },
          { label: t('main.menu.checklistControl'), type: 'checkbox', checked: !!activeProfile()?.settings.checklistControlEnabled(), click: (item) => setChecklistControl(item) },
          { label: t('main.menu.walkthroughControl'), type: 'checkbox', checked: !!activeProfile()?.settings.walkthroughControlEnabled(), click: (item) => setWalkthroughControl(item) },
          {
            label: t('main.menu.browserHosts'),
            click: () => {
              showWindow();
              sendTo(activeId)(IpcChannel.BrowserHostsOpen, undefined);
            },
          },
          { type: 'separator' },
          {
            label: t('main.menu.language'),
            submenu: LANGUAGE_SETTINGS.map((setting) => ({
              label: languageSettingLabel(setting),
              type: 'radio' as const,
              checked: settings.languageSetting() === setting,
              click: () => void changeLanguage(setting),
            })),
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
        label: t('main.menu.file'),
        submenu: [
          {
            label: t('main.menu.newSession'),
            accelerator: 'CmdOrCtrl+N',
            click: () => {
              showWindow();
              sendTo(activeId)(IpcChannel.SessionsNew, undefined);
            },
          },
          { type: 'separator' },
          { role: 'close' },
          { type: 'separator' },
          {
            // 確認を出さずに止める（ふだんの終了は、動いている Claude Code があれば止めるか確認する）
            label: t('main.menu.stopAndQuit'),
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

// メニューの「終了するときに新しいバージョンを入れる（Homebrew）」。保存できなかったら、チェックを元に戻す
function setUpdateOnQuit(item: MenuItem): void {
  try {
    settings.setUpdateOnQuitEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
  }
}

// 画面へ渡す新しいバージョン。Homebrew で入れていて、新しいバージョンがあれば、その用意（ダウンロード）の様子を足す
function withHomebrew(update: AppUpdate | null): AppUpdate | null {
  const prepared = update?.available ? homebrew?.get() : null;
  return update && prepared ? { ...update, homebrew: prepared } : update;
}

function sendAppUpdate(update: AppUpdate | null = appUpdates.get()): void {
  send(IpcChannel.AppUpdateChanged, withHomebrew(update));
}

// 終了したあとの Homebrew での入れ替えの、ログと結果（brew upgrade の終了コード）
const updateLogPath = () => join(app.getPath('userData'), 'homebrew-update.log');
const updateResultPath = () => join(app.getPath('userData'), 'homebrew-update.result');

// 終了するときに入れ替えるか。ダウンロード済みで、「再起動して更新」を押したか、
// メニューの「終了するときに新しいバージョンを入れる」と「新しいバージョンが出たら通知する」がどちらもオンのとき
function updatesOnQuit(): boolean {
  if (homebrew?.get()?.status !== 'ready' || shuttingDown) return false;
  return relaunchAfterUpdate || (settings.updateOnQuitEnabled() && settings.updateCheckEnabled());
}

// タイトルバーの「再起動して更新」。Claude Code が動いているセッションがあれば、止めるかを聞いてから終了する。
// 終了すると（before-quit）、brew upgrade のシェルを切り離して起動し、入れ替えたら起動し直す
async function installUpdate(): Promise<void> {
  if (homebrew?.get()?.status !== 'ready' || confirmingQuit) return;
  confirmingQuit = true;
  try {
    const live = liveSessions();
    let stop = false;
    if (live.length > 0) {
      const { response } = await showDialog({
        type: 'question',
        message: t('main.dialog.liveSessions'),
        detail: [
          ...live.map((s) => t('main.dialog.liveSessionLine', { title: s.title, state: s.state })),
          '',
          t('main.dialog.updateKeepRunningDetail'),
          t('main.dialog.updateStopDetail'),
        ].join('\n'),
        buttons: [t('main.dialog.updateKeepRunning'), t('main.dialog.updateStop'), t('common.cancel')],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (response === 2) return;
      stop = response === 1;
    }
    relaunchAfterUpdate = true;
    await quit(stop);
  } finally {
    confirmingQuit = false;
  }
}

// 前回の終了のときの Homebrew での入れ替えが失敗していたら、理由と手動の手順を知らせる（結果は一度だけ見る）
async function reportUpdateResult(): Promise<void> {
  let code: string;
  try {
    code = (await readFile(updateResultPath(), 'utf8')).trim();
  } catch {
    return;
  }
  await rm(updateResultPath(), { force: true });
  if (code === '0') return;
  const log = await readFile(updateLogPath(), 'utf8').catch(() => '');
  const { response } = await showDialog({
    type: 'warning',
    message: t('main.dialog.updateFailed'),
    detail: [
      log.trimEnd().split('\n').slice(-12).join('\n'),
      '',
      t('main.dialog.updateManual', { cask: CASK }),
      t('main.dialog.updateBlocked'),
    ].join('\n'),
    buttons: [t('main.dialog.ok'), t('main.dialog.openLog')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response === 1) void shell.openPath(updateLogPath());
}

// ウインドウがあれば、その上に出す
function showDialog(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

// メニューの「Claude にアプリ内ブラウザを操作させる」。オンなら、次に起動する Claude Code から MCP サーバーを足す。
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（browser-control の handle）。保存できなかったら、チェックを元に戻す
function setBrowserControl(item: MenuItem): void {
  try {
    activeProfile()?.settings.setBrowserControlEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
    return;
  }
  if (!item.checked) activeProfile()?.browser.cancelAsks();
}

// メニューの「Claude にほかのセッションを扱わせる」。オンなら、次に起動する Claude Code から MCP サーバーを足す。
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（sessions-control の handle）。子への知らせも止める。
// 保存できなかったら、チェックを元に戻す
function setSessionsControl(item: MenuItem): void {
  try {
    activeProfile()?.settings.setSessionsControlEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
  }
}

// メニューの「Claude にチェックリストを扱わせる」。オンなら、次に起動する Claude Code から MCP サーバーを足す。
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（checklist-control の handle）。画面のチェックリストは使える。
// 保存できなかったら、チェックを元に戻す
function setChecklistControl(item: MenuItem): void {
  try {
    activeProfile()?.settings.setChecklistControlEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
  }
}

// メニューの「Claude にウォークスルーさせる」。オンなら、次に起動する Claude Code から MCP サーバーを足す。
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（walkthrough-control の handle）。
// 保存できなかったら、チェックを元に戻す
function setWalkthroughControl(item: MenuItem): void {
  try {
    activeProfile()?.settings.setWalkthroughControlEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
  }
}

// メニューの「言語」の項目の名前。日本語と English は、どの言語の画面でもその言語の書き方で出す（読めない言語の画面からでも選べるように）
function languageSettingLabel(setting: LanguageSetting): string {
  if (setting === 'ja') return '日本語';
  if (setting === 'en') return 'English';
  return t('main.menu.languageSystem');
}

// 使う言語を、設定と Mac の言語の設定から決める（起動するときだけ。終わるまで変えない）
function applyLanguage(): void {
  setLanguage(resolveLanguage(settings.languageSetting(), app.getPreferredSystemLanguages()));
}

// メニューの「言語」。保存して、次に起動したときから使う（動いている間の言語は変えない）。
// 使う言語が変わるなら、変えた先の言語で、今すぐ再起動するかを聞く。再起動はふつうの終了と同じ確認（動いている Claude Code を止めるか）を通す。
// 保存できなかったら、メニューを作り直して選んでいたものに戻す
async function changeLanguage(setting: LanguageSetting): Promise<void> {
  try {
    settings.setLanguageSetting(setting);
  } catch {
    buildMenu();
    return;
  }
  const next = resolveLanguage(setting, app.getPreferredSystemLanguages());
  if (next === language() || confirmingQuit) return;
  const { response } = await showDialog({
    type: 'question',
    message: tFor(next, 'main.dialog.languageRestart'),
    detail: tFor(next, 'main.dialog.languageRestartDetail'),
    buttons: [tFor(next, 'main.dialog.restartNow'), tFor(next, 'main.dialog.restartLater')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return;
  // 起動し直すのは、終了が決まったときだけ（終了の確認で取りやめたら、あとでふつうに終了したときに起動し直さない）
  relaunchForLanguage = true;
  await confirmQuit();
  if (!quitDecided) relaunchForLanguage = false;
}

// 終了する。stop: Claude Code と pty ホストも止める。false なら動かしたままにして、次に起動したアプリが引き継ぐ
async function quit(stop: boolean): Promise<void> {
  if (stop) for (const p of profiles()) await p.stop();
  quitDecided = true;
  app.quit();
}

// 終了するとき（バツボタン・⌘Q・Dock の「終了」）。Claude Code が動いているセッション（待機中も含む）があれば、止めるか確認する。
// 止めると Remote Control からも続けられなくなるため。無ければ、Claude Code と pty ホストも止める
async function confirmQuit(): Promise<void> {
  if (confirmingQuit) return;
  confirmingQuit = true;
  try {
    const live = liveSessions();
    if (live.length === 0) return await quit(profiles().length > 0);
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      message: t('main.dialog.liveSessions'),
      detail: [
        ...live.map((s) => t('main.dialog.liveSessionLine', { title: s.title, state: s.state })),
        '',
        t('main.dialog.quitDetail'),
        ...(updatesOnQuit() ? ['', t('main.dialog.quitWillUpdate')] : []),
      ].join('\n'),
      buttons: [t('main.dialog.quitKeepRunning'), t('main.dialog.quitStop'), t('common.cancel')],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const { response } = await showDialog(options);
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
    // どのプロファイルの Claude が操作しているページかは、それぞれのアプリ内ブラウザの操作が見分ける
    else if (event.isMainFrame && profiles().some((p) => p.browser.blocksNavigation(contents, event.url))) event.preventDefault();
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
  settings = new AppSettings(join(app.getPath('userData'), 'settings.json'));
  sharedPrefs = new SharedPrefStore(join(app.getPath('userData'), 'shared-prefs.json'));
  // ダイアログ・メニュー・プロファイルの既定の名前などが使うので、ほかのものを作る前に決める
  applyLanguage();
  registry = new ProfileRegistry(join(app.getPath('userData'), 'profiles.json'));
  remoteControl = app.isPackaged || process.env.TANACODE_REMOTE_CONTROL === '1';
  // 既定のプロファイル。データは userData に、設定はアプリ全体の設定と同じファイルに置く。開けなければ、アプリは続けられない
  try {
    await openProfile(registry.list()[0]!);
  } catch (error) {
    const log = join(app.getPath('userData'), 'pty-host.log');
    dialog.showErrorBox(t('main.dialog.ptyHostFailed'), t('main.dialog.errorWithLog', { error: String(error), log }));
    quitDecided = true;
    app.quit();
    return;
  }
  // 足したプロファイル。開けなかったものは理由を出して飛ばす（ほかのプロファイルは使える）
  for (const info of registry.list().slice(1)) {
    try {
      await openProfile(info);
    } catch (error) {
      dialog.showErrorBox(
        t('main.dialog.profileOpenFailed', { name: info.name }),
        t('main.dialog.errorWithLog', { error: String(error), log: join(profileDataDir(app.getPath('userData'), info.id), 'pty-host.log') }),
      );
    }
  }
  claudeVersions = new ClaudeVersionMonitor((version) => send(IpcChannel.ClaudeVersionChanged, version));
  // 問い合わせは Chromium の通信（net.fetch）で行う。macOS のプロキシの設定がそのまま効く
  appUpdates = new AppUpdateMonitor(
    app.getVersion(),
    (update) => {
      homebrew?.want(update?.latest ?? null);
      sendAppUpdate(update);
    },
    (url, init) => net.fetch(url, init),
  );
  registerIpc();
  buildMenu();
  createWindow();
  for (const p of profiles()) void p.usage.start();
  system = new SystemMonitor((stats) => send(IpcChannel.SystemStats, stats));
  system.start();
  claudeVersions.start();
  if (settings.updateCheckEnabled()) appUpdates.start();
  // Homebrew で入れたアプリなら、新しいバージョンを裏でダウンロードしておく（入れ替えは終了したあと）
  if (app.isPackaged) {
    void HomebrewUpdater.detect({ bundle: resolve(process.execPath, '../../..'), current: app.getVersion(), onChange: () => sendAppUpdate() }).then((updater) => {
      homebrew = updater;
      homebrew?.want(appUpdates.get()?.latest ?? null);
    });
  }
  void reportUpdateResult();
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
  system?.stop();
  claudeVersions?.stop();
  appUpdates?.stop();
  // ダウンロード済みの新しいバージョンを、このプロセスが終わってから入れ替える。
  // 言語を変えて起動し直すときも、入れ替えるなら入れ替えたあとに起動し直す（先に起動すると、入れ替える前のアプリが開くため）
  if (updatesOnQuit()) homebrew?.upgradeAfterExit({ pid: process.pid, log: updateLogPath(), result: updateResultPath(), relaunch: relaunchAfterUpdate || relaunchForLanguage });
  else if (relaunchForLanguage) app.relaunch();
  homebrew?.stop();
  // Claude Code は止めずに、見るのをやめるだけ（止めるときは、先に quit(true) で止めてある）
  for (const p of profiles()) p.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Mac の再起動・シャットダウンでは確認を出さない（止めずに終わる）。
// なお kill（SIGTERM）は Chromium が受け取って、ふつうの終了と同じ流れになる（確認が出る。もう一度送ると強制的に終わる）
app.whenReady().then(() => {
  powerMonitor.on('shutdown', () => {
    quitDecided = true;
    shuttingDown = true;
  });
});
