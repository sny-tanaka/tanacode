import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { vi, type Mock } from 'vitest';

// アプリの入り口（src/main/index.ts）を、Electron を起動せずに読み込んで動かす部品（test/main-*.test.ts 用）。
// - electron を作り物（下の FakeWindow など）に差し替える。app.whenReady はすぐに済むので、読み込むと起動の流れが最後まで進み、
//   IPC の受け口（ipcMain.handle・ipcMain.on）・メニュー・ウインドウが作られる。テストはそれを呼び、押し、知らせを送る
// - Claude Code・pty ホスト・ソケット・監視など、重いもの・外に出るものの部品は、呼ばれ方を控える作り物に差し替える。
//   作り物のメソッドは、既定では「どのメソッドが、どの引数で呼ばれたか」をそのまま返す（受け口が、正しい相手に、
//   引数を取り違えずに渡し、返事をそのまま返すかを、戻り値で確かめられる）
// - アプリの設定（AppSettings）・ウインドウの位置の保存（window-state）・通知の文（notice-text）・shared は本物。
//   userData・ダウンロードのフォルダは、使い捨てのフォルダにする
// index.ts は読み込むたびに状態（開いたフォルダ・終了の確認など）を持つので、boot() は毎回読み込み直す

// 作り物の部品（メソッドはどれも vi.fn）
export type Fake = Record<string, Mock>;

// 呼ばれたメソッドと引数を、そのまま返す（返事を取り違えていないかも、これで分かる）
const echo = (call: string) => (_self: Created, ...args: unknown[]) => ({ call, args });
// 作業フォルダごとに作るもの（Workspace・SourceControl）。どのフォルダで作ったかも返す。読み取りは非同期。
// state.failingCwds のフォルダでは失敗する（決めたもので。決めていなければ EACCES のエラー）
const echoIn = (call: string) => (self: Created, ...args: unknown[]) => {
  const cwd = String(self.args[0]);
  if (!state.failingCwds.has(cwd)) return Promise.resolve({ call, cwd, args });
  return Promise.reject(state.failingCwds.get(cwd) ?? new Error(`EACCES: ${call}`));
};

type Created = { name: string; args: unknown[]; instance: Fake };
type Impl = (self: Created, ...args: never[]) => unknown;

// --- Electron の作り物 ---

type Listener = (...args: never[]) => unknown;
export class Emitter {
  readonly events = new Map<string, Listener[]>();
  on(event: string, listener: Listener): this {
    this.events.set(event, [...(this.events.get(event) ?? []), listener]);
    return this;
  }
  // 受け手を呼ぶ（引数は Electron と同じ形で、テストが渡す）
  emit(event: string, ...args: unknown[]): unknown[] {
    return (this.events.get(event) ?? []).map((listener) => (listener as (...a: unknown[]) => unknown)(...args));
  }
  has(event: string): boolean {
    return (this.events.get(event)?.length ?? 0) > 0;
  }
}

// preventDefault を呼んだかを控える、Electron のイベント
export const fakeEvent = <T extends object>(extra?: T) => ({ preventDefault: vi.fn(), ...extra }) as { preventDefault: Mock } & T;

export class FakeWebContents extends Emitter {
  readonly sent: [string, unknown][] = [];
  destroyed = false;
  url = 'file:///app/out/renderer/index.html';
  type = 'window';
  windowOpenHandler: ((details: { url: string; disposition?: string }) => { action: string }) | null = null;
  send = vi.fn((channel: string, payload: unknown) => {
    this.sent.push([channel, payload]);
  });
  isDestroyed = () => this.destroyed;
  getURL = () => this.url;
  getType = () => this.type;
  setWindowOpenHandler = vi.fn((handler: FakeWebContents['windowOpenHandler']) => {
    this.windowOpenHandler = handler;
  });
  focus = vi.fn(() => undefined);
  close = vi.fn(() => {
    this.destroyed = true;
  });
  loadURL = vi.fn((_url: string) => undefined);
  loadFile = vi.fn((_path: string) => undefined);
  reload = vi.fn(() => undefined);
}

// 足したプロファイルの画面（WebContentsView）。ウインドウに重ねて、見ているものだけを出す
export class FakeView {
  readonly webContents = new FakeWebContents();
  visible = true;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  constructor(readonly options: Record<string, unknown>) {
    this.webContents.type = 'browserView';
    state.views.push(this);
  }
  setVisible = vi.fn((visible: boolean) => {
    this.visible = visible;
  });
  setBounds = vi.fn((bounds: FakeView['bounds']) => {
    this.bounds = bounds;
  });
  setBackgroundColor = vi.fn((_color: string) => undefined);
}

export class FakeWindow extends Emitter {
  readonly webContents = new FakeWebContents();
  destroyed = false;
  minimized = false;
  maximized = false;
  fullScreen = false;
  focused = false;
  bounds = { x: 40, y: 30, width: 1400, height: 900 };
  // ウインドウに重ねた画面（足したプロファイルのもの）
  readonly contentView = {
    children: [] as FakeView[],
    addChildView: vi.fn((view: FakeView) => {
      this.contentView.children.push(view);
    }),
    removeChildView: vi.fn((view: FakeView) => {
      this.contentView.children = this.contentView.children.filter((v) => v !== view);
    }),
  };
  constructor(readonly options: Record<string, unknown>) {
    super();
    state.windows.push(this);
  }
  getContentBounds = () => ({ x: 0, y: 0, width: this.bounds.width, height: this.bounds.height - 28 });
  isDestroyed = () => this.destroyed;
  isMaximized = () => this.maximized;
  isFullScreen = () => this.fullScreen;
  isMinimized = () => this.minimized;
  isFocused = () => this.focused;
  getNormalBounds = () => this.bounds;
  maximize = vi.fn(() => {
    this.maximized = true;
  });
  restore = vi.fn(() => {
    this.minimized = false;
  });
  show = vi.fn(() => undefined);
  focus = vi.fn(() => undefined);
  loadURL = vi.fn((_url: string) => undefined);
  loadFile = vi.fn((_path: string) => undefined);
}

export class FakeSession extends Emitter {
  requestHandler: ((contents: unknown, permission: string, callback: (ok: boolean) => void, details: { isMainFrame: boolean }) => void) | null = null;
  checkHandler: ((contents: unknown, permission: string, origin: string, details: { isMainFrame: boolean }) => boolean) | null = null;
  setPermissionRequestHandler = (handler: FakeSession['requestHandler']) => {
    this.requestHandler = handler;
  };
  setPermissionCheckHandler = (handler: FakeSession['checkHandler']) => {
    this.checkHandler = handler;
  };
}

export class FakeNotification extends Emitter {
  constructor(readonly options: Record<string, unknown>) {
    super();
  }
  static isSupported = () => state.notificationSupported;
  show = vi.fn(() => {
    state.notifications.push(this);
  });
}

// メニューの項目（Menu.buildFromTemplate に渡したもの）
export type MenuItem = {
  label?: string;
  role?: string;
  type?: string;
  checked?: boolean;
  accelerator?: string;
  submenu?: MenuItem[];
  click?: (item: MenuItem) => void;
};

// --- テストから見る状態（boot() のたびに作り直す） ---

function freshState() {
  return {
    root: '',
    userData: '',
    downloads: '',
    appPath: '',
    resources: '',
    packaged: false,
    // Mac の優先する言語（app.getPreferredSystemLanguages）。言語の設定が「システムに合わせる」のときに使う
    preferredLanguages: ['ja-JP'],
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    listeners: new Map<string, (...args: unknown[]) => unknown>(),
    app: new Emitter(),
    // Electron の準備ができる（app.whenReady。既定はすぐに済む）
    whenReady: vi.fn(async (): Promise<void> => undefined),
    quit: vi.fn((..._args: unknown[]) => undefined),
    // macOS 以外では無い
    dock: { setIcon: vi.fn((_path: string) => undefined) } as { setIcon: Mock } | undefined,
    windows: [] as FakeWindow[],
    views: [] as FakeView[],
    displays: [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    menu: null as MenuItem[] | null,
    defaultSession: new FakeSession(),
    partitions: new Map<string, FakeSession>(),
    powerMonitor: new Emitter(),
    notifications: [] as FakeNotification[],
    notificationSupported: true,
    dialog: {
      showOpenDialog: vi.fn(async (..._args: unknown[]) => ({ canceled: true, filePaths: [] as string[] })),
      showSaveDialog: vi.fn(async (..._args: unknown[]) => ({ canceled: true, filePath: undefined as string | undefined })),
      showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 2 })),
      showErrorBox: vi.fn((..._args: unknown[]) => undefined),
    },
    shell: { openExternal: vi.fn(async (_url: string) => undefined), showItemInFolder: vi.fn((_path: string) => undefined), openPath: vi.fn(async (_path: string) => '') },
    netFetch: vi.fn((..._args: unknown[]): unknown => undefined),
    execFileSync: vi.fn((..._args: unknown[]): string => {
      throw new Error('ログインシェルは使えません');
    }),
    // 作った作り物の部品（作った順）
    created: [] as Created[],
    // 待ち受けを始められないソケット（ファイル名。browser.sock など）
    failingSockets: new Set<string>(),
    // ソケットの待ち受けを始める（McpBridge.start。引数はソケットのファイル名。既定は、failingSockets のもの以外はすぐに済む）
    bridgeStart: vi.fn(async (name: string): Promise<void> => {
      if (state.failingSockets.has(name)) throw new Error('EADDRINUSE');
    }),
    // 読み取れないフォルダ（Workspace・SourceControl の作り物が失敗する）と、失敗の中身（undefined なら EACCES のエラー）
    failingCwds: new Map<string, unknown>(),
    // pty ホスト（の作り物）と、その起動（既定はすぐに済む）
    ptyHost: { shutdown: vi.fn(async () => undefined), close: vi.fn() } as Fake,
    ptyHostStart: vi.fn(async (..._args: unknown[]): Promise<Fake> => state.ptyHost),
    // Homebrew で入れたアプリの更新（HomebrewUpdater.detect が返すもの。既定は、Homebrew で入れていない）
    homebrew: null as Fake | null,
    homebrewDetect: vi.fn(async (..._args: unknown[]): Promise<Fake | null> => state.homebrew),
    // 前に起動したアプリから動き続けている Claude Code の引き継ぎ（SessionManager.adopt。既定はすぐに済む）
    adopt: vi.fn(async () => undefined),
    // 作り物の関数（モジュールの関数）
    fn: {
      discoverSessions: vi.fn((...args: unknown[]) => ({ call: 'discoverSessions', args })),
      listCommands: vi.fn((...args: unknown[]) => ({ call: 'listCommands', args })),
      imageOf: vi.fn((...args: unknown[]) => ({ call: 'imageOf', args })),
      readModelCatalog: vi.fn(async (): Promise<unknown> => ({ models: ['opus'] })),
      draftWalkthroughComment: vi.fn(async (...args: unknown[]) => ({ ok: true, call: 'draftWalkthroughComment', args })),
      postWalkthroughComment: vi.fn(async (..._args: unknown[]) => 'https://github.com/me/cafe/pull/12#issuecomment-1'),
      pullRequestsOf: vi.fn((..._args: unknown[]): unknown => undefined),
      commentOnPullRequest: vi.fn((..._args: unknown[]): unknown => undefined),
    },
    // セッションごとのチェックリスト（ChecklistStore.lists が返すもの）
    checklists: new Map<string, unknown[]>(),
  };
}

export let state = freshState();

// 作った作り物の部品。同じ名前のものが複数あれば最後のもの
export function the(name: string): Fake {
  const found = state.created.filter((c) => c.name === name).at(-1);
  if (!found) throw new Error(`${name} はまだ作られていません`);
  return found.instance;
}
// 作り物の部品を作ったときの引数
export function argsOf(name: string, index = -1): unknown[] {
  const found = state.created.filter((c) => c.name === name).at(index);
  if (!found) throw new Error(`${name} はまだ作られていません`);
  return found.args;
}
export const allOf = (name: string) => state.created.filter((c) => c.name === name);

function fakeClass(name: string, methods: Record<string, Impl>, init?: (self: Fake, args: unknown[]) => void) {
  return class {
    constructor(...args: unknown[]) {
      const instance = this as unknown as Fake;
      const created: Created = { name, args, instance };
      for (const [method, impl] of Object.entries(methods)) instance[method] = vi.fn((...a: never[]) => impl(created, ...a));
      init?.(instance, args);
      state.created.push(created);
    }
  };
}

// --- 差し替えるモジュール ---

export const electronModule = {
  app: {
    on: (event: string, listener: Listener) => state.app.on(event, listener),
    whenReady: () => state.whenReady(),
    getPath: (name: string) => (name === 'userData' ? state.userData : name === 'downloads' ? state.downloads : join(state.root, name)),
    get isPackaged() {
      return state.packaged;
    },
    getAppPath: () => state.appPath,
    getVersion: () => '9.8.7',
    getPreferredSystemLanguages: () => state.preferredLanguages,
    name: 'tanacode',
    quit: (...args: unknown[]) => state.quit(...args),
    get dock() {
      return state.dock;
    },
  },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      // Electron と同じく、同じチャンネルを 2 回登録すると例外
      if (state.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      state.handlers.set(channel, listener);
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      if (state.listeners.has(channel)) throw new Error(`${channel} を 2 回 listen しました`);
      state.listeners.set(channel, listener);
    },
  },
  BrowserWindow: FakeWindow,
  WebContentsView: FakeView,
  dialog: {
    showOpenDialog: (...args: unknown[]) => state.dialog.showOpenDialog(...args),
    showSaveDialog: (...args: unknown[]) => state.dialog.showSaveDialog(...args),
    showMessageBox: (...args: unknown[]) => state.dialog.showMessageBox(...args),
    showErrorBox: (...args: unknown[]) => state.dialog.showErrorBox(...args),
  },
  Menu: {
    setApplicationMenu: (menu: MenuItem[]) => {
      state.menu = menu;
    },
    buildFromTemplate: (template: MenuItem[]) => template,
  },
  net: { fetch: (...args: unknown[]) => state.netFetch(...args) },
  Notification: FakeNotification,
  powerMonitor: { on: (event: string, listener: Listener) => state.powerMonitor.on(event, listener) },
  screen: { getAllDisplays: () => state.displays },
  session: {
    get defaultSession() {
      return state.defaultSession;
    },
    fromPartition: (name: string) => {
      if (!state.partitions.has(name)) state.partitions.set(name, new FakeSession());
      return state.partitions.get(name);
    },
  },
  shell: {
    openExternal: (url: string) => state.shell.openExternal(url),
    showItemInFolder: (path: string) => state.shell.showItemInFolder(path),
    openPath: (path: string) => state.shell.openPath(path),
  },
};

// 作り物の関数は、モジュールを読み込み直しても同じもの（コメントの投稿先の関数を、そのまま渡しているかを比べられる）
export const githubModule = {
  pullRequestsOf: (...args: unknown[]) => state.fn.pullRequestsOf(...args),
  commentOnPullRequest: (...args: unknown[]) => state.fn.commentOnPullRequest(...args),
};

const SessionManager = fakeClass('SessionManager', {
  list: () => [],
  create: echo('manager.create'),
  createInWorktree: echo('manager.createInWorktree'),
  cwdOf: (_self, id: string) => `/sessions/${id}`,
  open: echo('manager.open'),
  childrenOf: () => [],
  archive: echo('manager.archive'),
  worktreeLeftovers: echo('manager.worktreeLeftovers'),
  unarchive: echo('manager.unarchive'),
  snapshot: echo('manager.snapshot'),
  submit: echo('manager.submit'),
  interrupt: echo('manager.interrupt'),
  rename: echo('manager.rename'),
  remove: echo('manager.remove'),
  summary: () => undefined,
  history: echo('manager.history'),
  exportSource: echo('manager.exportSource'),
  claudeSessionIds: () => new Set(['known-1']),
  importSession: echo('manager.importSession'),
  configure: echo('manager.configure'),
  restart: echo('manager.restart'),
  setRemoteControl: echo('manager.setRemoteControl'),
  remoteAvailable: echo('manager.remoteAvailable'),
  screenForView: echo('manager.screenForView'),
  activity: echo('manager.activity'),
  workflows: echo('manager.workflows'),
  setMode: echo('manager.setMode'),
  rewind: echo('manager.rewind'),
  transcriptOf: (_self, id: string) => `/transcripts/${id}.jsonl`,
  subagents: echo('manager.subagents'),
  bashTasks: echo('manager.bashTasks'),
  knowledge: echo('manager.knowledge'),
  context: echo('manager.context'),
  statusLine: echo('manager.statusLine'),
  agentLog: echo('manager.agentLog'),
  stopTask: echo('manager.stopTask'),
  choose: echo('manager.choose'),
  focus: echo('manager.focus'),
  write: echo('manager.write'),
  resize: echo('manager.resize'),
  parentOf: () => null,
  isFocused: () => false,
  liveSessions: () => [],
  closeAll: () => undefined,
  statusLineChanged: () => undefined,
  askQuestionsChanged: () => undefined,
  browserAskChanged: () => undefined,
  watchState: () => undefined,
  stateOf: () => 'idle',
  adopt: () => state.adopt(),
});

const modules: Record<string, Record<string, unknown>> = {
  'browser-control': {
    BrowserControl: fakeClass('BrowserControl', {
      watchNetwork: () => undefined,
      handle: echo('browser.handle'),
      track: () => undefined,
      openFromPage: () => false,
      isOperating: () => false,
      blocksNavigation: () => false,
      forget: () => undefined,
      attach: echo('browser.attach'),
      activate: echo('browser.activate'),
      pendingAsks: echo('browser.pendingAsks'),
      answerAsk: echo('browser.answerAsk'),
      cancelAsks: () => undefined,
    }),
  },
  'sessions-control': { SessionsControl: fakeClass('SessionsControl', { handle: echo('sessionsControl.handle'), dispose: () => undefined }) },
  'checklist-control': {
    ChecklistControl: fakeClass('ChecklistControl', { apply: echo('checklistControl.apply'), copy: echo('checklistControl.copy'), handle: echo('checklistControl.handle'), dispose: () => undefined }),
  },
  'checklist-store': {
    ChecklistStore: fakeClass('ChecklistStore', { lists: (_self, id: string) => state.checklists.get(id) ?? [], remove: () => undefined, flush: () => undefined }),
  },
  'walkthrough-control': {
    WalkthroughControl: fakeClass('WalkthroughControl', {
      list: echo('walkthrough.list'),
      go: echo('walkthrough.go'),
      close: echo('walkthrough.close'),
      get: () => null,
      postedUrl: (_self, id: string) => `posted:${id}`,
      markPosted: () => undefined,
      forget: () => undefined,
      discard: () => undefined,
      handle: echo('walkthrough.handle'),
    }),
  },
  'walkthrough-github': {
    draftWalkthroughComment: (...args: unknown[]) => state.fn.draftWalkthroughComment(...args),
    postWalkthroughComment: (...args: unknown[]) => state.fn.postWalkthroughComment(...args),
  },
  github: githubModule,
  'homebrew-update': { CASK: 'sny-tanaka/tanacode/tanacode', HomebrewUpdater: { detect: (...args: unknown[]) => state.homebrewDetect(...args) } },
  'app-update': { AppUpdateMonitor: fakeClass('AppUpdateMonitor', { get: echo('appUpdates.get'), start: () => undefined, stop: () => undefined }) },
  'session-discovery': { discoverSessions: (...args: unknown[]) => state.fn.discoverSessions(...args) },
  'source-control': {
    SourceControl: fakeClass('SourceControl', {
      state: echoIn('scm.state'),
      branches: echoIn('scm.branches'),
      diffSides: echoIn('scm.diffSides'),
      branchDiffSides: echoIn('scm.branchDiffSides'),
      baseline: echoIn('scm.baseline'),
      lastCommitMessage: echoIn('scm.lastCommitMessage'),
      stage: echoIn('scm.stage'),
      unstage: echoIn('scm.unstage'),
      discard: echoIn('scm.discard'),
      commit: echoIn('scm.commit'),
      push: echoIn('scm.push'),
      pull: echoIn('scm.pull'),
      fetch: echoIn('scm.fetch'),
      checkout: echoIn('scm.checkout'),
      switchToLatestDefault: echoIn('scm.switchToLatestDefault'),
    }),
  },
  commands: { listCommands: (...args: unknown[]) => state.fn.listCommands(...args) },
  'image-cache': { imageOf: (...args: unknown[]) => state.fn.imageOf(...args) },
  'pty-host-client': { PtyHost: { start: (...args: unknown[]) => state.ptyHostStart(...args) }, hostExecutable: () => '/fake/bin/node' },
  'scheduled-messages': {
    ScheduledMessages: fakeClass('ScheduledMessages', {
      list: echo('scheduled.list'),
      add: echo('scheduled.add'),
      reschedule: echo('scheduled.reschedule'),
      sendNow: echo('scheduled.sendNow'),
      cancel: echo('scheduled.cancel'),
      start: () => undefined,
      dispose: () => undefined,
      dropSession: () => undefined,
    }),
  },
  'settings-files': {
    SettingsFiles: fakeClass('SettingsFiles', { list: echo('settingsFiles.list'), add: echo('settingsFiles.add'), rename: echo('settingsFiles.rename'), remove: echo('settingsFiles.remove') }),
  },
  'session-store': { SessionStore: fakeClass('SessionStore', {}) },
  'model-catalog': { readModelCatalog: () => state.fn.readModelCatalog() },
  // ~/.claude.json を読む代わりに、呼ばれたことと引数を返す
  'claude-account': { readClaudeAccount: (...args: unknown[]) => ({ call: 'readClaudeAccount', args }) },
  statusline: { StatusLineWatcher: fakeClass('StatusLineWatcher', { start: async () => undefined, close: () => undefined }) },
  'shell-terminals': {
    ShellTerminals: fakeClass('ShellTerminals', {
      create: echo('shells.create'),
      write: echo('shells.write'),
      resize: echo('shells.resize'),
      kill: echo('shells.kill'),
      killOwner: () => undefined,
      killAll: () => undefined,
      run: echo('shells.run'),
    }),
  },
  'system-monitor': { SystemMonitor: fakeClass('SystemMonitor', { start: () => undefined, stop: () => undefined }) },
  'claude-version': { ClaudeVersionMonitor: fakeClass('ClaudeVersionMonitor', { get: echo('claudeVersions.get'), start: () => undefined, stop: () => undefined, refresh: async () => undefined }) },
  'usage-monitor': {
    UsageMonitor: fakeClass('UsageMonitor', { get: echo('usage.get'), refresh: echo('usage.refresh'), start: async () => undefined, fromStatusLine: () => undefined }),
  },
  workspace: {
    Workspace: fakeClass('Workspace', {
      info: echoIn('workspace.info'),
      listFiles: echoIn('workspace.listFiles'),
      listDir: echoIn('workspace.listDir'),
      readFile: echoIn('workspace.readFile'),
      readImage: echoIn('workspace.readImage'),
      writeFile: echoIn('workspace.writeFile'),
      search: echoIn('workspace.search'),
    }),
  },
  'workspace-watcher': { WorkspaceWatchers: fakeClass('WorkspaceWatchers', { retain: () => undefined, release: () => undefined }) },
};

vi.mock('electron', () => electronModule);
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: (...args: unknown[]) => state.execFileSync(...args),
}));
vi.mock('../../src/main/browser-control', () => modules['browser-control']);
vi.mock('../../src/main/mcp-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/mcp-bridge')>()),
  McpBridge: fakeClass(
    'McpBridge',
    {
      start: (self) => state.bridgeStart(basename(String(self.args[0]))),
      close: () => undefined,
    },
    (self, args) => {
      (self as Record<string, unknown>).socketPath = args[0];
    },
  ),
}));
vi.mock('../../src/main/sessions-control', () => modules['sessions-control']);
vi.mock('../../src/main/checklist-control', () => modules['checklist-control']);
vi.mock('../../src/main/checklist-store', () => modules['checklist-store']);
vi.mock('../../src/main/walkthrough-control', () => modules['walkthrough-control']);
vi.mock('../../src/main/walkthrough-github', () => modules['walkthrough-github']);
vi.mock('../../src/main/github', () => modules.github);
vi.mock('../../src/main/app-update', () => modules['app-update']);
vi.mock('../../src/main/homebrew-update', () => modules['homebrew-update']);
vi.mock('../../src/main/session-discovery', () => modules['session-discovery']);
vi.mock('../../src/main/source-control', () => modules['source-control']);
vi.mock('../../src/main/commands', () => modules.commands);
vi.mock('../../src/main/image-cache', () => modules['image-cache']);
vi.mock('../../src/main/pty-host-client', () => modules['pty-host-client']);
vi.mock('../../src/main/scheduled-messages', () => modules['scheduled-messages']);
vi.mock('../../src/main/session-manager', async (importOriginal) => ({
  DEFAULT_PTY_SIZE: (await importOriginal<typeof import('../../src/main/session-manager')>()).DEFAULT_PTY_SIZE,
  SessionManager,
}));
vi.mock('../../src/main/settings-files', () => modules['settings-files']);
vi.mock('../../src/main/session-store', () => modules['session-store']);
vi.mock('../../src/main/model-catalog', () => modules['model-catalog']);
vi.mock('../../src/main/claude-account', () => modules['claude-account']);
vi.mock('../../src/main/statusline', () => modules.statusline);
vi.mock('../../src/main/shell-terminals', () => modules['shell-terminals']);
vi.mock('../../src/main/system-monitor', () => modules['system-monitor']);
vi.mock('../../src/main/claude-version', () => modules['claude-version']);
vi.mock('../../src/main/translate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/translate')>()),
  Translator: fakeClass('Translator', { translate: echo('translator.translate') }),
}));
vi.mock('../../src/main/usage-monitor', () => modules['usage-monitor']);
vi.mock('../../src/main/workspace', () => modules.workspace);
vi.mock('../../src/main/workspace-watcher', () => modules['workspace-watcher']);

// --- 読み込みと起動 ---

export type BootOptions = {
  // パッケージしたアプリとして起動する（app.isPackaged）
  packaged?: boolean;
  // 前に保存したアプリの設定（settings.json の中身）
  settings?: Record<string, unknown>;
  // 前に閉じたときのウインドウの位置と大きさ（window-state.json の中身）
  windowState?: Record<string, unknown>;
  // 登録したプロファイル（profiles.json の中身）
  profiles?: Record<string, unknown>;
  // 起動の前に、状態を変える（作り物の返事を決めるなど）
  before?: (s: typeof state) => void;
  // 起動が最後まで進むのを待たない（pty ホストの起動を止めておくときなど）
  noWait?: boolean;
};

const saved = {
  env: { ...process.env },
  resourcesPath: (process as { resourcesPath?: string }).resourcesPath,
  getSystemVersion: (process as { getSystemVersion?: () => string }).getSystemVersion,
};
export let systemVersion = '15.4.1';

export async function boot(o: BootOptions = {}): Promise<typeof state> {
  cleanup();
  state = freshState();
  // macOS の tmpdir()（/var/folders/…/T）は長く、userData のソケットのパスが上限を超えて別の場所に作られてしまうので、短い /tmp に作る
  state.root = realpathSync(mkdtempSync('/tmp/tanacode-main-'));
  state.userData = join(state.root, 'userData');
  state.downloads = join(state.root, 'Downloads');
  state.appPath = join(state.root, 'app');
  state.resources = join(state.root, 'Resources');
  for (const dir of [state.userData, state.downloads, state.appPath, state.resources]) mkdirSync(dir, { recursive: true });
  state.packaged = o.packaged ?? false;
  if (o.settings) writeFileSync(join(state.userData, 'settings.json'), JSON.stringify({ version: 1, ...o.settings }));
  if (o.windowState) writeFileSync(join(state.userData, 'window-state.json'), JSON.stringify(o.windowState));
  if (o.profiles) writeFileSync(join(state.userData, 'profiles.json'), JSON.stringify(o.profiles));
  // Electron にだけあるもの
  Object.assign(process, { resourcesPath: state.resources, getSystemVersion: () => systemVersion });
  o.before?.(state);
  vi.resetModules();
  await import('../../src/main/index');
  if (!o.noWait) await started();
  return state;
}

// 起動の流れが終わるまで待つ（最後に app.on('activate') を登録する。起動できずに終了したときは app.quit）
export async function started(): Promise<void> {
  await vi.waitFor(
    () => {
      if (!state.app.has('activate') && state.quit.mock.calls.length === 0) throw new Error('起動の途中です');
    },
    { timeout: 3000, interval: 1 },
  );
}

export function setSystemVersion(version: string): void {
  systemVersion = version;
}

// 使い捨てのフォルダを消し、環境変数と process を戻す
export function cleanup(): void {
  if (state.root) rmSync(state.root, { recursive: true, force: true });
  state.root = '';
  for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
  Object.assign(process.env, saved.env);
  Object.assign(process, { resourcesPath: saved.resourcesPath, getSystemVersion: saved.getSystemVersion });
  systemVersion = '15.4.1';
}

// --- 呼び出し ---

// 画面からの呼び出し（ipcRenderer.invoke の代わり）。受け口の返事（約束なら、その結果）を返す
export async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return await invokeFrom(appContents(), channel, ...args);
}

// 画面 sender からの呼び出し（足したプロファイルの画面から呼ぶとき）
export async function invokeFrom(sender: unknown, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.handlers.get(channel);
  if (!handler) throw new Error(`${channel} の受け口がありません`);
  return await handler({ sender }, ...args);
}

// 画面からの知らせ（ipcRenderer.send の代わり）
export function sendFromRenderer(channel: string, ...args: unknown[]): unknown {
  const listener = state.listeners.get(channel);
  if (!listener) throw new Error(`${channel} の受け口がありません`);
  return listener({ sender: appContents() }, ...args);
}

// 既定のプロファイルの画面（主ウインドウの画面）。ウインドウを作る前は、名前だけの送り元
const appContents = () => state.windows.at(-1)?.webContents ?? 'renderer';

// 主ウインドウ（最後に作ったもの）
export function mainWindow(): FakeWindow {
  const win = state.windows.at(-1);
  if (!win) throw new Error('ウインドウがありません');
  return win;
}

// 主ウインドウの画面に送った知らせ（チャンネルを指定すれば、その中身だけ）
export function sentToRenderer(channel?: string): unknown[] {
  const sent = state.windows.flatMap((w) => w.webContents.sent);
  return channel ? sent.filter(([c]) => c === channel).map(([, payload]) => payload) : sent;
}

// メニューの項目をラベルか役割で探す
export function menuItem(label: string): MenuItem {
  const walk = (items: MenuItem[]): MenuItem | undefined => {
    for (const item of items) {
      if (item.label === label || item.role === label) return item;
      const found = item.submenu && walk(item.submenu);
      if (found) return found;
    }
    return undefined;
  };
  const found = state.menu && walk(state.menu);
  if (!found) throw new Error(`メニューに「${label}」がありません`);
  return found;
}

export const manager = () => the('SessionManager');
