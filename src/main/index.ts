import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, powerMonitor, screen, session, shell, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItem, type WebContents } from 'electron';
import { IpcChannel, LANGUAGE_ARG, type IpcEvent, type IpcInvoke, type IpcSend, type ArchiveOptions, type DiscoveredSession, type GitAction, type NewSessionOptions, type SearchOptions, type SessionOptions, type SubmitOptions } from '@shared/ipc';
import { PARENT_INSTRUCTIONS_FILE } from '@shared/project-instructions';
import { instructionDirs, instructionFiles } from './project-instructions';
import { repositoryRoot } from './worktree';
import { AppSettings } from './app-settings';
import { PreviewWindows, restrictPreviewSession } from './browser-windows';
import { SharedPrefStore } from './shared-prefs';
import { Profile, type Send } from './profile';
import { SESSIONS_NO_ASK_FILE, writeSessionsNoAskFile } from './sessions-bridge';
import { profileDataDir, ProfileRegistry } from './profile-registry';
import { DEFAULT_PROFILE_ID, type NewProfile, type ProfileInfo, type ProfilesState } from '@shared/profile';
import type { SharedPrefChange, SharedPrefKey, SharedPrefs } from '@shared/prefs';
import { applyPromptChanges, promptChangesOf, type PromptChanges } from '@shared/prompts';
import { checkCopyRequest, checkOp, unreadCount } from '@shared/checklist';
import { AUTO_COMPACT_PERCENTS, DEFAULT_AUTO_COMPACT_PERCENT, IDLE_COMPACT_STATUS } from '@shared/optimized-compact';
import { AWAY_WAIT_MINUTES, DEFAULT_AWAY_WAIT_MINUTES } from '@shared/away-mode';
import { draftWalkthroughComment, postWalkthroughComment, type CommentDeps } from './walkthrough-github';
import { commentOnPullRequest, pullRequestsOf } from './github';
import { AppUpdateMonitor } from './app-update';
import type { AppUpdate } from '@shared/app-update';
import { CASK, HomebrewUpdater } from './homebrew-update';
import { discoverSessions } from './session-discovery';
import { SourceControl } from './source-control';
import type { PermissionMode } from '@shared/screen';
import { permissionReplyOf, questionReplyOf } from '@shared/questions';
import { elicitationReplyOf } from '@shared/elicitation';
import type { AgentLogRef, TaskRef } from '@shared/task';
import { listCommands } from './commands';
import { imageOf } from './image-cache';
import { DEFAULT_PTY_SIZE } from './session-manager';
import { readModelCatalog } from './model-catalog';
import { SystemMonitor } from './system-monitor';
import { ClaudeCompatMonitor } from './claude-compat';
import { ClaudeVersionMonitor } from './claude-version';
import { LANGUAGE_SETTINGS_URL, translateAvailable, translateHelperPath, translateTexts, Translator } from './translate';
import { readClaudeAccount } from './claude-account';
import { loadWindowState, placeWindow, saveWindowState } from './window-state';
import { Workspace } from './workspace';
import { resolveAddedFolders } from './added-folders';
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
// 裏で起動する（TANACODE_BACKGROUND=1）。ウインドウを画面に出さず、Dock にも出さない。画面は描かれ続けるので、Playwright などからは操作できる。
// 手元で E2E を流す間、作業中のアプリから前面を奪わないためのもの（Electron は、ウインドウを出すときにアプリを最前面にする）
const background = process.env.TANACODE_BACKGROUND === '1';
// Dock のアイコンは、起動が済む前に消す。それでも、起動の直後の 0.3 秒ほどは Dock に出る種類のアプリとして見えることがある（実測。20 回のうち 2 回）
if (background) app.dock?.hide();
// アプリ全体の設定（通知・新しいバージョンの確認）。既定のプロファイルの設定も同じファイルに入っている
let settings: AppSettings;
let sharedPrefs: SharedPrefStore;
let system: SystemMonitor;
let claudeVersions: ClaudeVersionMonitor;
let claudeCompat: ClaudeCompatMonitor;
let appUpdates: AppUpdateMonitor;
// Homebrew で入れたときだけ作る（新しいバージョンを裏でダウンロードしておき、終了したあとに入れ替える）
let homebrew: HomebrewUpdater | null = null;
// タイトルバーの「再起動して更新」で終了する（入れ替えたあと起動し直す）
let relaunchAfterUpdate = false;
// 言語を変えて「今すぐ再起動」を選んだ。終了したら起動し直す
let relaunchForLanguage = false;
// Mac の再起動・シャットダウンで終わる（brew を動かしても途中で止められるので、入れ替えない）
let shuttingDown = false;
// 起動の途中に 2 つめが起動した（ウインドウを作ったら前に出す）
let showWhenCreated = false;
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

// アプリ自身の画面か（主ウインドウか、足したプロファイルの画面）
function isAppContents(contents: WebContents): boolean {
  if (contents.getType() !== 'window' && contents.getType() !== 'browserView') return false;
  return contents === mainWindow?.webContents || [...views.values()].some((view) => view.webContents === contents);
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

// 画面からの呼び出しと知らせは、どれもここで受け口を登録する。アプリの画面のメインフレームから来たものだけを受ける
function handle<C extends keyof IpcInvoke>(
  channel: C,
  listener: (event: IpcMainInvokeEvent, ...args: Parameters<IpcInvoke[C]>) => ReturnType<IpcInvoke[C]> | Awaited<ReturnType<IpcInvoke[C]>>,
): void {
  const run = listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error(t('main.error.notFromApp'));
    return run(event, ...args);
  });
}

function listen<C extends keyof IpcSend>(channel: C, listener: (event: IpcMainEvent, ...args: Parameters<IpcSend[C]>) => void): void {
  const run = listener as (event: IpcMainEvent, ...args: unknown[]) => void;
  ipcMain.on(channel, (event, ...args) => {
    if (fromApp(event)) run(event, ...args);
  });
}

// アプリの画面（主ウインドウと、足したプロファイルの画面）のメインフレームで、アプリの画面を開いているものから来たか。
// 中のフレーム・アプリ内ブラウザのページ・アプリの画面でなくなったもの（フレームが分からないものも）からは受けない
function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return !!frame && !frame.parent && isAppContents(event.sender) && isAppUrl(frame.url);
}

// アプリの画面の URL か。ビルドした画面のファイルか、開発中は開発サーバー（同じオリジン）
function isAppUrl(url: string): boolean {
  try {
    const dev = process.env.ELECTRON_RENDERER_URL;
    if (dev) return new URL(url).origin === new URL(dev).origin;
    return url.startsWith('file:') && fileURLToPath(url) === APP_HTML;
  } catch {
    return false;
  }
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
    show: !background,
    // 裏で起動したときは、フルスクリーン・最大化にしない（どちらも、ウインドウを画面に出す）
    fullscreen: !background && (saved?.fullScreen ?? false),
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
  if (saved?.maximized && !saved.fullScreen && !background) win.maximize();
  // macOS の resized・moved は、動かし終えたときに一度だけ届く。最大化のアニメーションの途中（resize）は、
  // まだ通常の状態に見えるので、そこでは控えない
  const remember = () => {
    // 裏で起動したときは覚えない（最大化・フルスクリーンにしていないので、覚えていたものを書き換えてしまう）
    if (background || win.isDestroyed()) return;
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

// ビルドした画面のファイル
const APP_HTML = join(__dirname, '../renderer/index.html');

// アプリの画面を読み込む（主ウインドウか、足したプロファイルの画面）
function loadApp(target: Pick<WebContents, 'loadURL' | 'loadFile'>): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void target.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void target.loadFile(APP_HTML);
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
  // 画面を読み込み直す（⌘R）。前の画面が開いた新規セッションの画面のフォルダ（見張り・そこで開いたシェルとブラウザ）は、
  // 新しい画面からは見えず使えないので閉じる。セッションのシェルは止めずに、新しい画面が引き継ぐ（shell.attach）まで、知らせを止める。
  // 移り始めた知らせは、止められる知らせ（上の will-navigate）より先に届くので、will-navigate が止める移動（URL の違うもの。
  // Finder のファイルを落とした・リンク）では何もしない（読み込み直しにならず、引き継ぐ画面が来ないため）
  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument || details.url !== contents.getURL()) return;
    const p = opened.get(id);
    if (!p) return;
    for (const folder of [...p.folderViews.keys()]) p.closeFolderView(folder);
    p.shells.detach();
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
  // ページが新しいウインドウで開くもの（新しいタブ・ポップアップの別ウインドウ）の扱いは、browser-windows.ts
  contents.on('did-attach-webview', (_e, guest) => previewWindows.attach(guest, opened.get(id)?.browser));
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
  layoutViews();
  loadApp(view.webContents);
}

function detachView(id: string): void {
  const view = views.get(id);
  if (!view) return;
  views.delete(id);
  drawn.delete(id);
  mainWindow?.contentView.removeChildView(view);
  view.webContents.close();
}

// 足したプロファイルの画面の出し方を決め直す。見ているプロファイルのものだけを、ウインドウいっぱいに出す。
// 見ていないもののうち、Claude がアプリ内ブラウザを操作する間だけ描かせるもの（drawn）は、表示にして、ウインドウの右下の隅に 1px だけ残して置く
// （大きさはそのまま。ウインドウの外へ出しきると、描かれない。全体を重ねると、見ている画面を覆ってしまう）
function layoutViews(): void {
  if (!mainWindow) return;
  const { width, height } = mainWindow.getContentBounds();
  for (const [id, view] of views) {
    const drawnAside = id !== activeId && drawn.has(id);
    view.setBounds(drawnAside ? { x: width - 1, y: height - 1, width, height } : { x: 0, y: 0, width, height });
    view.setVisible(id === activeId || drawnAside);
  }
}

// Claude がアプリ内ブラウザを操作する間だけ描かせている、見ていないプロファイルの画面と、頼んでいる数
const drawn = new Map<string, number>();

// プロファイルの画面を、描かれる状態にする（戻す関数を返す）。Claude がアプリ内ブラウザのツールを動かす間だけ頼む（browser-control.ts の drawHost）。
// 非表示の画面の中のタブ（webview）は、置き場所が決まらず、撮っても返ってこない（Chromium が、その画面を描かないため）。
// 既定のプロファイルの画面はウインドウ自身で、いつも描かれているので、何もしない
function drawView(id: string): () => void {
  if (!views.has(id)) return () => {};
  drawn.set(id, (drawn.get(id) ?? 0) + 1);
  layoutViews();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (drawn.get(id) ?? 1) - 1;
    if (left > 0) drawn.set(id, left);
    else drawn.delete(id);
    layoutViews();
  };
}

// 見るプロファイルを変える。足したプロファイルの画面を出し入れし、メニュー（プロファイルごとの設定）も作り直す
function showProfile(id: string): void {
  if (!opened.has(id)) return;
  activeId = id;
  layoutViews();
  // 既定のプロファイルの画面はウインドウ自身なので、ウインドウが前に出れば入力を受ける
  if (id !== DEFAULT_PROFILE_ID) views.get(id)?.webContents.focus();
  buildMenu();
}

function showWindow(): BrowserWindow {
  if (!mainWindow) createWindow();
  const win = mainWindow!;
  // 裏で起動したときは、前に出さない
  if (background) return win;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

// title: ダイアログの見出し / defaultPath: はじめに開く場所（無ければ前に開いた場所）
async function pickFolder(p: Profile, title = t('main.dialog.pickFolder'), defaultPath?: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title,
    ...(defaultPath ? { defaultPath } : {}),
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
    sessionsNoAskFile: sessionsNoAskPath(),
    prompts: () => settings.prompts(),
    send: sendTo(info.id),
    host: () => contentsOf(info.id),
    drawHost: () => drawView(info.id),
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
    // 新規セッションの画面で追加したフォルダは、始める時点で確かめ直す（消した・セッションのフォルダの中のものは外す）
    const started = { ...options, addedFolders: await resolveAddedFolders(cwd, options.addedFolders) };
    return options.worktree ? p.startInWorktree(cwd, started) : p.manager.create(cwd, started);
  });
  handle(IpcChannel.FolderPick, (e) => pickFolder(P(e)));
  handle(IpcChannel.FolderInfo, async (_e, cwd: string) => ((await isDirectory(cwd)) ? new Workspace(cwd).info() : null));
  // 始めたあとに main が探す場所と同じところを見る。プロファイルのフォルダ（Claude Code の設定のフォルダ）と、セッションのフォルダ。
  // worktree で始めるなら、worktree はリポジトリのいちばん上から作られるので、そこ（サブフォルダを選んでいても）。そうでなければ、
  // フォルダ（.claude/worktrees/<名前> を選んだなら、元のリポジトリも）。どちらかにあれば、そのパス（プロファイルが先）
  handle(IpcChannel.FolderParentInstructions, async (e, cwd: string, worktree?: boolean) => {
    const dir = String(cwd);
    const dirs = worktree === true ? [(await repositoryRoot(dir)) ?? dir] : instructionDirs(dir, null);
    return instructionFiles(PARENT_INSTRUCTIONS_FILE, claudeConfigDir(P(e).claudeDir), dirs)[0]?.path ?? null;
  });
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
  // 新規セッションの画面で開いたターミナルとブラウザ・追加したフォルダは、画面を閉じる（フォルダを変える・セッションを始める）と一緒に閉じる
  listen(IpcChannel.FolderClose, (e, id: string) => P(e).closeFolderView(id));
  handle(IpcChannel.SessionsOpen, (e, id: string) => P(e).manager.open(id));
  handle(IpcChannel.SessionsArchive, (e, id: string, options?: ArchiveOptions) => P(e).archiveSession(id, options));
  handle(IpcChannel.SessionsWorktreeLeftovers, (e, id: string) => P(e).manager.worktreeLeftovers(id));
  handle(IpcChannel.SessionsWorktreeCleanup, (e) => P(e).manager.worktreeCleanup());
  handle(IpcChannel.SessionsDeleteBackup, (e, root: string, ref: string) => P(e).manager.deleteBackup(root, ref));
  handle(IpcChannel.SessionsRemoveLeftWorktree, (e, id: string) => P(e).removeLeftWorktree(id));
  handle(IpcChannel.SessionsUnarchive, (e, id: string) => P(e).manager.unarchive(id));
  handle(IpcChannel.SessionsSnapshot, (e, id: string) => P(e).manager.snapshot(id));
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  handle(IpcChannel.SessionsSubmit, (e, id: string, text: string, attachments: string[], pastes?: string[], options?: SubmitOptions) => {
    const manager = P(e).manager;
    const body = String(text ?? '');
    return manager.submit(id, options?.asParent === true ? manager.withParentRole(id, body) : body, strings(attachments), strings(pastes));
  });
  listen(IpcChannel.SessionsInterrupt, (e, id: string) => P(e).manager.interrupt(id));
  handle(IpcChannel.ScheduledList, (e) => P(e).scheduled.list());
  handle(IpcChannel.ScheduledAdd, (e, sessionId: string, text: string, attachments: string[], at: number, pastes?: string[]) => {
    P(e).scheduled.add(String(sessionId), String(text ?? ''), strings(attachments), Number(at), strings(pastes));
  });
  handle(IpcChannel.ScheduledReschedule, (e, id: string, at: number) => P(e).scheduled.reschedule(String(id), Number(at)));
  handle(IpcChannel.ScheduledSendNow, (e, id: string) => P(e).scheduled.sendNow(String(id)));
  handle(IpcChannel.ScheduledCancel, (e, id: string) => P(e).scheduled.cancel(String(id)));
  handle(IpcChannel.SessionsRename, (e, id: string, title: string) => P(e).manager.rename(id, title));
  handle(IpcChannel.SessionsRemove, async (e, id: string, options?: ArchiveOptions) => {
    const p = P(e);
    p.shells.killOwner(id);
    const targets = [id, ...p.manager.childrenOf(id)];
    p.browser.forget(id);
    let removal: Awaited<ReturnType<typeof p.manager.remove>>;
    try {
      removal = await p.manager.remove(id, options);
    } finally {
      // 子のブラウザは、消えた子とアーカイブ済みの子のものだけを閉じる（親を消しても、戻しておいた子は動き続ける）
      for (const child of targets.slice(1)) {
        const s = p.manager.summary(child);
        if (!s || s.archived) p.browser.forget(child);
      }
    }
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
  handle(IpcChannel.SessionsModels, (e, id: string) => P(e).manager.modelsOf(id));
  handle(IpcChannel.SessionsRestart, (e, id: string) => P(e).manager.restart(id));
  handle(IpcChannel.SessionsParentInstructions, (e, id: string) => P(e).manager.parentInstructions(id)[0]?.path ?? null);
  handle(IpcChannel.SessionsBecomeParent, (e, id: string) => P(e).manager.becomeParent(id));
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
  listen(IpcChannel.WalkthroughShown, (e, id: string, walkId: string, seq: number, shown: unknown) => P(e).walkthroughControl?.shown(String(id), String(walkId), Number(seq), shown));
  listen(IpcChannel.WalkthroughViewing, (e, id: string | null, onWalk: unknown) => P(e).walkthroughControl?.viewing(typeof id === 'string' ? id : null, onWalk === true));
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
  handle(IpcChannel.SessionsSetTerminalMode, (e, id: string, on: boolean, options?: { stopTasks?: boolean }) =>
    P(e).manager.setTerminalMode(id, on === true, { stopTasks: options?.stopTasks === true }),
  );
  handle(IpcChannel.SessionsSetAutoCompact, (e, id: string, on: boolean) => {
    const p = P(e);
    p.manager.setAutoCompact(String(id), on === true);
    p.autoCompact?.toggled(String(id));
    p.compact?.refresh([String(id)]);
  });
  handle(IpcChannel.SessionsSetAway, (e, id: string, on: boolean) => {
    P(e).manager.setAway(String(id), on === true, 'human');
  });
  handle(IpcChannel.RemoteControlAvailable, (e) => P(e).manager.remoteAvailable());
  handle(IpcChannel.SessionsProgressGet, (e, id: string) => P(e).manager.progress(id));
  handle(IpcChannel.QuestionGet, (e, id: string) => P(e).manager.pendingQuestion(id));
  handle(IpcChannel.PermissionGet, (e, id: string) => P(e).manager.pendingPermission(id));
  handle(IpcChannel.PermissionReply, (e, id: string, requestId: string, reply: unknown) => {
    const read = permissionReplyOf(reply);
    return !!read && P(e).manager.replyPermission(String(id), String(requestId), read);
  });
  handle(IpcChannel.ElicitationGet, (e, id: string) => P(e).manager.pendingElicitation(id));
  handle(IpcChannel.ElicitationReply, (e, id: string, elicitationId: string, reply: unknown) => {
    const read = elicitationReplyOf(reply);
    return !!read && P(e).manager.replyElicitation(String(id), String(elicitationId), read);
  });
  handle(IpcChannel.QuestionReply, (e, id: string, questionId: string, reply: unknown) => {
    const read = questionReplyOf(reply);
    return !!read && P(e).manager.replyQuestion(id, questionId, read);
  });
  handle(IpcChannel.WorkflowsGet, (e, id: string) => P(e).manager.workflows(id));
  handle(IpcChannel.ScreenSetMode, (e, id: string, mode: PermissionMode) => P(e).manager.setMode(id, mode));
  handle(IpcChannel.ScreenRewindPreview, (e, id: string, messageId: string) => P(e).manager.rewindPreview(id, String(messageId)));
  handle(IpcChannel.ScreenRewind, (e, id: string, messageId: string, choice: unknown) => {
    const c = choice as { conversation?: unknown; code?: unknown } | null;
    return P(e).manager.rewind(id, String(messageId), { conversation: c?.conversation === true, code: c?.code === true });
  });
  handle(IpcChannel.WriteFile, (e, id: string, relPath: string, text: string, expected: unknown) =>
    new Workspace(P(e).cwdOf(id)).writeFile(relPath, text, typeof expected === 'string' ? expected : null),
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
  handle(IpcChannel.CommandsList, (e, id: string) => P(e).manager.commandsOf(id) ?? listCommands(P(e).manager.cwdOf(id), P(e).manager.transcriptOf(id), P(e).claudeDir));
  handle(IpcChannel.AttachmentSave, (_e, name: string, data: Uint8Array) => saveAttachment(name, data));
  handle(IpcChannel.SubagentsGet, (e, id: string) => P(e).manager.subagents(id));
  handle(IpcChannel.TasksBash, (e, id: string) => P(e).manager.bashTasks(id));
  handle(IpcChannel.KnowledgeGet, (e, id: string) => P(e).manager.knowledge(id));
  handle(IpcChannel.ContextGet, (e, id: string) => P(e).manager.context(id));
  handle(IpcChannel.CompactStart, (e, id: string) => P(e).compact?.start(String(id)) ?? IDLE_COMPACT_STATUS);
  handle(IpcChannel.CompactGet, (e, id: string) => P(e).compact?.status(String(id)) ?? IDLE_COMPACT_STATUS);
  handle(IpcChannel.SettingsFilesList, (e) => P(e).settingsFiles.list());
  handle(IpcChannel.SettingsFilesPick, (e) => pickSettingsFile(P(e)));
  handle(IpcChannel.SettingsFilesAdd, (e, path: string, name?: string) => P(e).settingsFiles.add(path, name));
  handle(IpcChannel.SettingsFilesRename, (e, id: string, name: string) => P(e).settingsFiles.rename(id, name));
  handle(IpcChannel.SettingsFilesRemove, (e, id: string) => P(e).settingsFiles.remove(id));
  handle(IpcChannel.ModelsGet, (e) => readModelCatalog(P(e).claudeDir).catch(() => null));
  handle(IpcChannel.StatusLineGet, (e, id: string) => P(e).manager.statusLine(id));
  handle(IpcChannel.UsageGet, (e) => P(e).usage.get());
  handle(IpcChannel.ClaudeVersionGet, () => claudeVersions.get());
  handle(IpcChannel.ClaudeVerifiedGet, () => claudeCompat.get());
  handle(IpcChannel.AppUpdateGet, () => withHomebrew(appUpdates.get()));
  handle(IpcChannel.AppUpdateInstall, () => installUpdate());
  handle(IpcChannel.AppUpdateCheck, () => appUpdates.refresh());
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
  // Claude に送る文は、アプリ全体で 1 つ（どのプロファイルの画面から変えても、すべてのセッションに効く）。
  // 画面は変えた欄だけを送るので、今の保存の値に重ねる（既定の文と同じ欄は持たない）
  handle(IpcChannel.PromptsGet, () => settings.prompts());
  handle(IpcChannel.PromptsUpdate, (_e, changes: PromptChanges) => {
    settings.setPrompts(applyPromptChanges(settings.prompts(), promptChangesOf(changes)));
    return settings.prompts();
  });
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
  listen(IpcChannel.SessionsFocus, (e, id: string | null) => P(e).manager.focus(id));
  listen(IpcChannel.PtyWrite, (e, id: string, data: string) => P(e).manager.write(id, data));
  listen(IpcChannel.PtyResize, (e, id: string, cols: number, rows: number) => P(e).manager.resize(id, cols, rows));
  listen(IpcChannel.PtyResetSize, (e, id: string) => P(e).manager.resize(id, DEFAULT_PTY_SIZE.cols, DEFAULT_PTY_SIZE.rows));
  handle(IpcChannel.ShellCreate, (e, id: string, cols: number, rows: number) =>
    P(e).shells.create(id, P(e).cwdOf(id), cols, rows),
  );
  handle(IpcChannel.ShellAttach, (e) => P(e).shells.attach());
  listen(IpcChannel.ShellWrite, (e, id: string, data: string) => P(e).shells.write(id, data));
  listen(IpcChannel.ShellResize, (e, id: string, cols: number, rows: number) => P(e).shells.resize(id, cols, rows));
  listen(IpcChannel.ShellKill, (e, id: string) => P(e).shells.kill(id));
  listen(IpcChannel.ShellReveal, (e, sessionId: string) => P(e).shells.revealOwner(sessionId));
  handle(IpcChannel.WorkspaceInfo, (e, id: string) => new Workspace(P(e).cwdOf(id)).info());
  // 追加するフォルダは、人がダイアログで選んだものだけ（画面から好きなパスを渡させない）
  handle(IpcChannel.WorkspaceAddFolder, async (e, id: string) => {
    const p = P(e);
    const folder = await pickFolder(p, t('main.dialog.addFolder'), p.cwdOf(id));
    return folder ? p.addFolder(id, folder) : null;
  });
  handle(IpcChannel.WorkspaceRemoveFolder, (e, id: string, folder: string) => P(e).removeFolder(id, folder));
  handle(IpcChannel.WorkspaceKeepReadFolder, (e, id: string, folder: string) => P(e).keepReadFolder(id, folder));
  handle(IpcChannel.WorkspaceDismissRead, (e, id: string, path: string) => P(e).manager.removeOutsideRead(id, path));
  handle(IpcChannel.ListDir, (e, id: string, relPath: string) => new Workspace(P(e).cwdOf(id)).listDir(relPath));
  handle(IpcChannel.ReadFile, (e, id: string, relPath: string) => new Workspace(P(e).cwdOf(id)).readFile(relPath));
  listen(IpcChannel.WatchOpenFiles, (e, tabs: Record<string, string[]>) => P(e).openFiles.set(tabs));
  handle(IpcChannel.ReadImage, (e, id: string, relPath: string) =>
    // Claude が読んだリポジトリも、エクスプローラーから開いた Markdown の画像を出せるよう、追加したフォルダと同じく読む
    new Workspace(P(e).cwdOf(id)).readImage(relPath, [...P(e).addedFoldersOf(id), ...P(e).manager.readFoldersOf(id)]).catch(() => null),
  );
  handle(IpcChannel.ResolveFiles, (e, id: string, paths: string[]) =>
    new Workspace(P(e).cwdOf(id)).resolveFiles(Array.isArray(paths) ? paths : [], P(e).addedFoldersOf(id)).catch(() => []),
  );
  // エディタのファイルを Finder で表示する（人がボタンを押したときだけ）。見せるだけで、中身は読まない
  handle(IpcChannel.RevealFile, (e, id: string, relPath: string) => {
    if (typeof relPath === 'string' && relPath) shell.showItemInFolder(new Workspace(P(e).cwdOf(id)).absolutePath(relPath));
  });
  // エクスプローラーのファイル操作（人がメニューから選んだときだけ）。変えるのは作業フォルダと追加したフォルダの中だけで、Workspace が確かめる
  handle(IpcChannel.CreateEntry, (e, id: string, dirPath: string, name: string, kind: 'file' | 'dir') =>
    new Workspace(P(e).cwdOf(id)).createEntry(dirPath, name, kind === 'dir' ? 'dir' : 'file', P(e).addedFoldersOf(id)),
  );
  handle(IpcChannel.RenameEntry, (e, id: string, path: string, newName: string) =>
    new Workspace(P(e).cwdOf(id)).renameEntry(path, newName, P(e).addedFoldersOf(id)),
  );
  handle(IpcChannel.TrashEntry, (e, id: string, path: string) =>
    new Workspace(P(e).cwdOf(id)).trashEntry(path, P(e).addedFoldersOf(id), (abs) => shell.trashItem(abs)),
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
          { label: t('main.menu.sessionsStartConfirm'), type: 'checkbox', checked: settings.sessionsStartConfirmEnabled(), click: (item) => setSessionsStartConfirm(item) },
          { label: t('main.menu.checklistControl'), type: 'checkbox', checked: !!activeProfile()?.settings.checklistControlEnabled(), click: (item) => setChecklistControl(item) },
          { label: t('main.menu.walkthroughControl'), type: 'checkbox', checked: !!activeProfile()?.settings.walkthroughControlEnabled(), click: (item) => setWalkthroughControl(item) },
          { label: t('main.menu.terminalControl'), type: 'checkbox', checked: !!activeProfile()?.settings.terminalControlEnabled(), click: (item) => setTerminalControl(item) },
          { label: t('main.menu.usageLimitResume'), type: 'checkbox', checked: !!activeProfile()?.settings.usageLimitResumeEnabled(), click: (item) => setUsageLimitResume(item) },
          {
            label: t('main.menu.autoCompactPercent'),
            submenu: AUTO_COMPACT_PERCENTS.map((percent) => ({
              label: `${percent}%`,
              type: 'radio' as const,
              checked: (activeProfile()?.settings.autoCompactPercent() ?? DEFAULT_AUTO_COMPACT_PERCENT) === percent,
              click: () => setAutoCompactPercent(percent),
            })),
          },
          {
            label: t('main.menu.awayWait'),
            submenu: AWAY_WAIT_MINUTES.map((minutes) => ({
              label: t('main.away.minutes', { count: minutes }),
              type: 'radio' as const,
              checked: (activeProfile()?.settings.awayWaitMinutes() ?? DEFAULT_AWAY_WAIT_MINUTES) === minutes,
              click: () => setAwayWaitMinutes(minutes),
            })),
          },
          {
            label: t('main.menu.browserHosts'),
            click: () => {
              showWindow();
              sendTo(activeId)(IpcChannel.BrowserHostsOpen, undefined);
            },
          },
          {
            label: t('main.menu.prompts'),
            click: () => {
              showWindow();
              sendTo(activeId)(IpcChannel.PromptsOpen, undefined);
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
  if (item.checked) {
    appUpdates.start();
    claudeCompat.start();
  } else {
    appUpdates.stop();
    claudeCompat.stop();
  }
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
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（browser-control の handle）。
// 人が許した、許す先の外のオリジンも捨てる（browser-control の turnOff）。保存できなかったら、チェックを元に戻す
function setBrowserControl(item: MenuItem): void {
  try {
    activeProfile()?.settings.setBrowserControlEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
    return;
  }
  if (!item.checked) activeProfile()?.browser.turnOff();
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

// 子セッションの起動の確認を省く印のファイル（アプリ全体で 1 つ。sessions-bridge.ts）
const sessionsNoAskPath = () => join(app.getPath('userData'), SESSIONS_NO_ASK_FILE);

// 印のファイルを、保存した設定に合わせる（起動したときと、切り替えられなかったとき）。置けない・消せなければ、ログに残して続ける
function syncSessionsNoAskFile(): void {
  try {
    writeSessionsNoAskFile(sessionsNoAskPath(), settings.sessionsStartConfirmEnabled());
  } catch (error) {
    console.error('子セッションの起動の確認の印を、設定に合わせられませんでした', error);
  }
}

// メニューの「Claude がセッションを始める前に許可を求める」。アプリ全体で 1 つ（どのプロファイルのセッションにも効く）。
// 起動の確認のフックは、呼ばれるたびに印のファイルを見るので、動いているセッションにもすぐ効く（sessions-bridge.ts の sessionsGateCommand）。
// 印のファイルを先に置く・消してから保存する。どちらかができなかったら、チェックと印のファイルを、保存した設定に戻す
function setSessionsStartConfirm(item: MenuItem): void {
  try {
    writeSessionsNoAskFile(sessionsNoAskPath(), item.checked);
    settings.setSessionsStartConfirmEnabled(item.checked);
  } catch {
    item.checked = settings.sessionsStartConfirmEnabled();
    syncSessionsNoAskFile();
  }
}

// メニューの「Claude にチェックリストを扱わせる」。オンなら、次に起動する Claude Code から MCP サーバーを足す。
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（checklist-control の handle）。画面のチェックリストは使える。
// 保存できなかったら、チェックを元に戻す
function setChecklistControl(item: MenuItem): void {
  try {
    const profile = activeProfile();
    profile?.settings.setChecklistControlEnabled(item.checked);
    // 最適化圧縮は、オフのあいだ使えない。ボタンとトグルの状態を知らせ直す（自動で止めるファイルも片付ける）
    const ids = profile?.manager.list().map((s) => s.id) ?? [];
    profile?.compact?.refresh(ids);
    for (const id of ids) profile?.autoCompact?.check(id);
  } catch {
    item.checked = !item.checked;
  }
}

// メニューの「離席モードで答えを待つ時間」。次に人に回った要求から効く（もう数え始めたものは、そのまま）
function setAwayWaitMinutes(minutes: number): void {
  try {
    activeProfile()?.settings.setAwayWaitMinutes(minutes);
  } catch {
    // 保存できなければ、メニューを作り直して元に戻す
  }
  buildMenu();
}

// メニューの「自動で最適化圧縮する大きさ」。アプリ全体で 1 つ。選んだら、すぐ効く（自動のスイッチのツールチップの数字も変わる）
function setAutoCompactPercent(percent: number): void {
  const profile = activeProfile();
  if (!profile) return;
  try {
    profile.settings.setAutoCompactPercent(percent);
  } catch {
    // 保存できなければ、メニューを作り直して元に戻す
  }
  const ids = profile.manager.list().map((s) => s.id);
  profile.compact?.refresh(ids);
  for (const id of ids) profile.autoCompact?.check(id);
  buildMenu();
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

// メニューの「Claude にターミナルを使わせる」。オンなら、次に起動する Claude Code から MCP サーバーを足す。
// オフにしても、動いている Claude Code の MCP サーバーは残るので、呼ばれたら断る（terminal-control の handle。打つ前の確認のフックも断られ、確認を出させる）。
// 保存できなかったら、チェックを元に戻す
function setTerminalControl(item: MenuItem): void {
  try {
    activeProfile()?.settings.setTerminalControlEnabled(item.checked);
  } catch {
    item.checked = !item.checked;
  }
}

// メニューの「利用枠で止まったら、戻ったときに自動で再開する」。オフにしたら、待っている再開の予約を取り消す（入れたままだと、
// オフにしたのに再開する）。オンにしても、もう止まっているセッションには予約しない（次に止まったときから）。保存できなかったら、チェックを元に戻す
function setUsageLimitResume(item: MenuItem): void {
  try {
    const profile = activeProfile();
    profile?.settings.setUsageLimitResumeEnabled(item.checked);
    if (!item.checked) profile?.usageLimit?.cancelAll();
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

// 同じ userData で動くアプリは 1 つだけにする（開発版とパッケージ版を同じ userData で起動したときなど）。2 つ動くと、同じ会話を
// 2 回 claude --resume し、チェックリストなどの保存もぶつかる。2 つめは何も作らずに終え、1 つめはウインドウを前に出す
const primary = app.requestSingleInstanceLock();
if (!primary) {
  quitDecided = true;
  app.quit();
} else {
  // 起動の途中（ウインドウを作る前）は、ここでウインドウを作らず（起動の終わりにもう 1 枚作ってしまう）、印だけ付けておき、
  // ウインドウを作ったあとで前に出す（起動を待つあいだにほかのアプリへ移った人の頼みを、捨てない）
  app.on('second-instance', () => {
    if (mainWindow) showWindow();
    else showWhenCreated = true;
  });
}

// プレビューのページ（webview のタブと、そのページが開いたポップアップの別ウインドウ）が、ページの中のリンク・location の書き換え・
// リダイレクトで、http(s) のページの外（file: や mailto: などの外部プロトコル）へ移らないようにする（browser-windows.ts）
const previewWindows = new PreviewWindows({
  browsers: () => profiles().map((p) => p.browser),
  background,
  openExternal: (url) => void shell.openExternal(url),
  // ポップアップは、tanacode のウインドウ（タブはいつもこの中）がある画面の中に置く
  screen: () => (mainWindow && !mainWindow.isDestroyed() ? { workArea: screen.getDisplayMatching(mainWindow.getBounds()).workArea, around: mainWindow.getBounds() } : null),
  makeWindow: (options) => new BrowserWindow(options),
  focused: () => BrowserWindow.getFocusedWindow() !== null,
  whenFocused: (callback) => app.once('browser-window-focus', callback),
});
app.on('web-contents-created', (_e, contents) => previewWindows.watch(contents));

app.whenReady().then(async () => {
  if (!primary) return;
  useLoginShellPath();
  // 窓を作る前に、権限の扱いを決めておく
  restrictPermissions();
  // .app にしていない開発中の起動では Electron のアイコンになるので、アプリのアイコンに差し替える
  if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'));
  settings = new AppSettings(join(app.getPath('userData'), 'settings.json'));
  // 前に動いていたアプリが置いた・消した印を、設定に合わせ直す（設定ファイルを書き換えられていても、設定のとおりにする）
  syncSessionsNoAskFile();
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
    () => send(IpcChannel.AppUpdateChecked, undefined),
  );
  // 動作確認済の Claude Code のバージョンの対応表。読む通信は、新しいバージョンの通知と同じ設定で止める
  claudeCompat = new ClaudeCompatMonitor(
    app.getVersion(),
    join(app.getPath('userData'), 'claude-compat.json'),
    (verified) => send(IpcChannel.ClaudeVerifiedChanged, verified),
    (url, init) => net.fetch(url, init),
    // 開発用のビルドでは、読む表を差し替えられる（表の読み方を、develop に置かずに確かめる）
    (!app.isPackaged && process.env.TANACODE_COMPAT_URL) || undefined,
  );
  registerIpc();
  buildMenu();
  createWindow();
  if (showWhenCreated) {
    showWhenCreated = false;
    showWindow();
  }
  for (const p of profiles()) void p.usage.start();
  system = new SystemMonitor((stats) => send(IpcChannel.SystemStats, stats));
  system.start();
  claudeVersions.start();
  if (settings.updateCheckEnabled()) {
    appUpdates.start();
    claudeCompat.start();
  }
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
  claudeCompat?.stop();
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
  if (!primary) return;
  powerMonitor.on('shutdown', () => {
    quitDecided = true;
    shuttingDown = true;
  });
});
