import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, type Session, type WebContents } from 'electron';
import { IpcChannel, type IpcEvent } from '@shared/ipc';
import { normalizeHostPattern } from '@shared/browser-tools';
import { t } from '@shared/i18n';
import type { AppSettings } from './app-settings';
import type { BrowserMcpLaunch } from './browser-bridge';
import { BrowserControl } from './browser-control';
import { McpBridge, textResult, type McpLaunch } from './mcp-bridge';
import { SessionsControl } from './sessions-control';
import { ChecklistControl } from './checklist-control';
import { ChecklistStore } from './checklist-store';
import { WalkthroughControl } from './walkthrough-control';
import { menuNotice, scheduledNotice, snippet } from './notice-text';
import { hostExecutable, PtyHost } from './pty-host-client';
import { ScheduledMessages } from './scheduled-messages';
import { SessionManager } from './session-manager';
import { SettingsFiles } from './settings-files';
import { SessionStore } from './session-store';
import { socketPathIn } from './socket-path';
import { StatusLineWatcher } from './statusline';
import { ShellTerminals } from './shell-terminals';
import { UsageMonitor } from './usage-monitor';
import { WorkspaceWatchers } from './workspace-watcher';

export type Send = <C extends keyof IpcEvent>(channel: C, payload: IpcEvent[C]) => void;
// 通知（タイトルはアプリの名前、サブタイトルはセッション名）。clickChannel: クリックで画面に送る知らせ（既定はそのセッションを選ぶ）
export type Notify = (
  profile: Profile,
  sessionId: string,
  sessionTitle: string | null,
  message: string,
  clickChannel?: typeof IpcChannel.SessionsSelect | typeof IpcChannel.BrowserShow,
) => void;

export type ProfileOptions = {
  id: string;
  // セッションの一覧・チェックリスト・ソケット・pty ホストなどを置くフォルダ
  dataDir: string;
  // Claude Code の設定のフォルダ（起動する Claude Code とシェルに CLAUDE_CONFIG_DIR として渡す）。null は既定のプロファイルで、アプリの環境変数のまま
  claudeDir: string | null;
  // このプロファイルの設定（登録した設定ファイル・Claude に許す機能・アプリ内ブラウザの許す先）
  settings: AppSettings;
  // このプロファイルの画面への知らせと、画面（アプリ内ブラウザの webview を持つもの）
  send: Send;
  host: () => WebContents | null;
  notify: Notify;
  // アプリ内ブラウザの webview が使うセッション（失敗した通信を Claude に見せる）
  preview: Session;
  remoteControl: boolean;
  // セッションの一覧が変わったとき（ほかのプロファイルの画面に「通知あり」を出し直す）
  onSessionsChanged?: () => void;
};

// プロファイル（Claude Code のアカウントごとの環境）が持つもの。セッションの一覧と Claude Code（pty ホスト）・
// statusLine・登録した設定ファイル・Claude が使う MCP の中継（ソケット）・チェックリスト・予約・ウォークスルー・利用枠・
// 開いているフォルダとシェル。画面からの呼び出しは、送り元の画面のプロファイルに渡す（index.ts）
export class Profile {
  readonly id: string;
  readonly claudeDir: string | null;
  readonly settings: AppSettings;
  readonly watchers: WorkspaceWatchers;
  readonly shells: ShellTerminals;
  readonly statusLines: StatusLineWatcher;
  readonly settingsFiles: SettingsFiles;
  readonly browser: BrowserControl;
  readonly checklists: ChecklistStore;
  readonly usage: UsageMonitor;
  manager!: SessionManager;
  ptyHost: PtyHost | null = null;
  scheduled!: ScheduledMessages;
  sessionsControl: SessionsControl | null = null;
  checklistControl: ChecklistControl | null = null;
  walkthroughControl: WalkthroughControl | null = null;
  // Claude によるアプリ内ブラウザの操作・ほかのセッションの扱い・チェックリスト・ウォークスルー。中継（Claude Code が起動する MCP サーバー）からの呼び出しを、ソケットで受ける
  private browserBridge: McpBridge | null = null;
  private sessionsBridge: McpBridge | null = null;
  private checklistBridge: McpBridge | null = null;
  private walkthroughBridge: McpBridge | null = null;
  // 新規セッションの画面で開いているフォルダ（id → フォルダ）。セッションと同じように右パネルとエディタで使う
  readonly folderViews = new Map<string, string>();
  // フォルダ選択ダイアログで選ばれたフォルダ。folders.open で開けるのは、これとセッションのフォルダだけ
  readonly pickedFolders = new Set<string>();

  // 作るだけ。待ち受けと pty ホストは start() で始める（途中で終われと言われても、作ったものは close() で片付けられるように）
  constructor(private readonly options: ProfileOptions) {
    const { dataDir, send, claudeDir } = options;
    this.id = options.id;
    this.claudeDir = claudeDir;
    this.settings = options.settings;
    this.shells = new ShellTerminals(
      {
        onData: (id, data) => send(IpcChannel.ShellData, { id, data }),
        onExit: (id, exitCode) => send(IpcChannel.ShellExit, { id, exitCode }),
        onOpened: (owner, id, name) => send(IpcChannel.ShellOpened, { owner, id, name }),
      },
      claudeDir,
    );
    this.watchers = new WorkspaceWatchers((root, paths) => {
      send(IpcChannel.FilesChanged, { root, paths });
    });
    this.statusLines = new StatusLineWatcher(
      join(dataDir, 'statusline'),
      (id, info) => {
        this.manager.statusLineChanged(id, info);
        this.usage.fromStatusLine(info);
      },
      (id, input) => this.manager.askQuestionsChanged(id, input),
    );
    // 登録した設定ファイル。設定ファイルを選んだセッションの起動で、アプリの設定と合わせたファイルは session-settings に置く
    this.settingsFiles = new SettingsFiles(this.settings, join(dataDir, 'session-settings'), (files) => send(IpcChannel.SettingsFilesChanged, files), claudeDir);
    this.browser = new BrowserControl({
      send,
      enabled: () => this.settings.browserControlEnabled(),
      extraHosts: () => this.settings.browserHosts(),
      host: options.host,
      hasSession: (id) => !!this.manager?.summary(id),
      // 一覧は「ブラウザでの操作待ち」。見ていないセッションなら通知し、クリックでそのセッションのブラウザを開く
      onAsk: (id, ask) => {
        this.manager?.browserAskChanged(id, !!ask);
        if (ask) options.notify(this, id, this.manager?.summary(id)?.title ?? null, t('main.notification.browserAsk', { message: snippet(ask.message) }), IpcChannel.BrowserShow);
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
    this.browser.watchNetwork(options.preview);
    this.checklists = new ChecklistStore(join(dataDir, 'checklists'), (id, lists) => send(IpcChannel.ChecklistChanged, { sessionId: id, lists }));
    this.usage = new UsageMonitor(join(dataDir, 'usage.json'), (value) => send(IpcChannel.UsageChanged, value), claudeDir);
  }

  // 待ち受けと pty ホストを始め、前に起動したアプリから動き続けている Claude Code を引き継ぐ。
  // pty ホストを起動できなければ投げる（Claude Code を動かせないので、アプリは続けられない）
  async start(): Promise<void> {
    const { dataDir, send } = this.options;
    // 以前のレビュー機能が作業フォルダを控えていた場所。もう使わないので消す
    void rm(join(dataDir, 'snapshots'), { recursive: true, force: true });
    await this.statusLines.start();
    // 待ち受けを始められなくても、アプリはそのまま使う（Claude Code に MCP サーバーを足さない）
    this.browserBridge = await listen('アプリ内ブラウザ', socketPathIn(dataDir, 'browser', 'browser'), (id, tool, args, signal) =>
      this.browser.handle(id, tool, args, signal),
    );
    this.sessionsBridge = await listen('セッション', socketPathIn(dataDir, 'sessions', 'sessions'), (id, tool, args, signal) =>
      this.sessionsControl ? this.sessionsControl.handle(id, tool, args, signal) : Promise.resolve(notReady()),
    );
    // チェックリストは、待ち受けを始められなくても画面からは使える
    this.checklistBridge = await listen('チェックリスト', socketPathIn(dataDir, 'checklist', 'checklist'), (id, tool, args) =>
      this.checklistControl ? this.checklistControl.handle(id, tool, args) : Promise.resolve(notReady()),
    );
    // ウォークスルーは保存せず、アプリのメモリの上だけで持つ
    this.walkthroughBridge = await listen('ウォークスルー', socketPathIn(dataDir, 'walkthrough', 'walkthrough'), (id, tool, args) =>
      this.walkthroughControl ? this.walkthroughControl.handle(id, tool, args) : Promise.resolve(notReady()),
    );
    // Claude Code は、アプリとは別の常駐プロセス（pty ホスト）が起動して持つ。アプリを再起動しても止まらない
    this.ptyHost = await PtyHost.start(dataDir, join(__dirname, 'pty-host.js'));
    const store = new SessionStore(join(dataDir, 'sessions.json'));
    const notify = (sessionId: string, title: string | null, message: string) => this.options.notify(this, sessionId, title, message);
    this.manager = new SessionManager(
      this.ptyHost,
      store,
      this.watchers,
      this.statusLines,
      {
        onSessionsChanged: (sessions) => {
          send(IpcChannel.SessionsChanged, sessions);
          this.options.onSessionsChanged?.();
        },
        onChat: (batch) => send(IpcChannel.ChatEvents, batch),
        onPtyData: (sessionId, data) => send(IpcChannel.PtyData, { sessionId, data }),
        onTurnCompleted: (session) => notify(session.id, session.title, t('main.notification.turnCompleted')),
        onAttention: (session, attention) =>
          notify(session.id, session.title, attention.kind === 'menu' ? menuNotice(attention.menu) : t('main.notification.needsTerminal')),
        onScreen: (sessionId, info) => send(IpcChannel.ScreenChanged, { sessionId, info }),
        onActivity: (sessionId, activity) => send(IpcChannel.ScreenActivity, { sessionId, activity }),
        onWorkflows: (sessionId, runs) => send(IpcChannel.WorkflowsChanged, { sessionId, runs }),
        onSubagents: (sessionId, runs) => send(IpcChannel.SubagentsChanged, { sessionId, runs }),
        onBashTasks: (sessionId, tasks) => send(IpcChannel.TasksBashChanged, { sessionId, tasks }),
        onKnowledge: (sessionId, knowledge) => send(IpcChannel.KnowledgeChanged, { sessionId, knowledge }),
        onStatusLine: (sessionId, info) => send(IpcChannel.StatusLineChanged, { sessionId, info }),
      },
      this.options.remoteControl,
      this.settingsFiles,
      (owner, cwd, command, name) => this.shells.run(owner, cwd, command, name),
      () => this.browserLaunch(),
      () => this.sessionsLaunch(),
      () => this.checklistLaunch(),
      () => this.walkthroughLaunch(),
      this.claudeDir,
    );
    const manager = this.manager;
    this.sessionsControl = new SessionsControl({ host: manager, enabled: () => this.settings.sessionsControlEnabled(), home: homedir() });
    // 時刻を指定して送信（予約）。送れなかった・時刻を過ぎていたものは通知する
    this.scheduled = new ScheduledMessages(
      join(dataDir, 'scheduled-messages.json'),
      manager,
      (messages) => send(IpcChannel.ScheduledChanged, messages),
      (message) => notify(message.sessionId, manager.summary(message.sessionId)?.title ?? null, scheduledNotice(message)),
    );
    // アーカイブした・一覧から消したセッションの予約は取り消し、ウォークスルーは捨てる
    manager.watchState((id) => {
      const state = manager.stateOf(id);
      if (state === null || state === 'archived') this.scheduled.dropSession(id);
      if (state === null || state === 'archived') this.walkthroughControl?.discard(id);
    });
    this.walkthroughControl = new WalkthroughControl({
      cwdOf: (id) => (manager.summary(id) ? manager.cwdOf(id) : null),
      enabled: () => this.settings.walkthroughControlEnabled(),
      onChange: (sessionId, walkthrough) => send(IpcChannel.WalkthroughChanged, { sessionId, walkthrough }),
    });
    this.checklistControl = new ChecklistControl({ store: this.checklists, host: manager, enabled: () => this.settings.checklistControlEnabled() });
    // 前に起動したアプリから動き続けている Claude Code を引き継ぐ
    await manager.adopt();
    // 動き続けている Claude Code を引き継いでから、時刻を過ぎた予約を片付けて待ち始める
    this.scheduled.start();
  }

  // workspace・git に渡された id（セッションか、folders.open で開いたフォルダ）のフォルダ
  cwdOf(id: string): string {
    return this.folderViews.get(id) ?? this.manager.cwdOf(id);
  }

  // アプリ内ブラウザで Claude に許す先を保存する。書き方をそろえ、重なりを除く。書き方が違うものがあれば、保存せずに断る
  setBrowserHosts(hosts: unknown): string[] {
    const list = Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string' && h.trim() !== '') : [];
    const bad = list.filter((h) => !normalizeHostPattern(h));
    if (bad.length > 0) throw new Error(t('main.browserHosts.invalid', { hosts: bad.join(t('main.format.listSeparator')) }));
    const normalized = [...new Set(list.map((h) => normalizeHostPattern(h)!))];
    this.settings.setBrowserHosts(normalized);
    return normalized;
  }

  // 起動する Claude Code に足す、アプリ内ブラウザの MCP サーバー。メニューでオフにしているときや、待ち受けを始められなかったときは足さない
  private browserLaunch(): BrowserMcpLaunch | null {
    if (!this.browserBridge || !this.settings.browserControlEnabled()) return null;
    return { command: hostExecutable(), script: join(__dirname, 'browser-mcp.js'), socketPath: this.browserBridge.socketPath, version: app.getVersion() };
  }

  // 起動する Claude Code に足す、セッションの MCP サーバー。メニューでオフにしているときや、待ち受けを始められなかったときは足さない
  private sessionsLaunch(): McpLaunch | null {
    if (!this.sessionsBridge || !this.settings.sessionsControlEnabled()) return null;
    return { command: hostExecutable(), script: join(__dirname, 'sessions-mcp.js'), socketPath: this.sessionsBridge.socketPath, version: app.getVersion() };
  }

  // 起動する Claude Code に足す、チェックリストの MCP サーバー。メニューでオフにしているときや、待ち受けを始められなかったときは足さない
  private checklistLaunch(): McpLaunch | null {
    if (!this.checklistBridge || !this.settings.checklistControlEnabled()) return null;
    return { command: hostExecutable(), script: join(__dirname, 'checklist-mcp.js'), socketPath: this.checklistBridge.socketPath, version: app.getVersion() };
  }

  // 起動する Claude Code に足す、ウォークスルーの MCP サーバー。メニューでオフにしているときや、待ち受けを始められなかったときは足さない
  private walkthroughLaunch(): McpLaunch | null {
    if (!this.walkthroughBridge || !this.settings.walkthroughControlEnabled()) return null;
    return { command: hostExecutable(), script: join(__dirname, 'walkthrough-mcp.js'), socketPath: this.walkthroughBridge.socketPath, version: app.getVersion() };
  }

  // Claude Code と pty ホストを止める（「Claude Code も止めて終了」など）
  async stop(): Promise<void> {
    this.manager?.closeAll(true);
    await this.ptyHost?.shutdown();
  }

  // アプリを終えるとき。Claude Code は止めずに、見るのをやめるだけ（止めるときは、先に stop() で止めてある）
  close(): void {
    this.statusLines.close();
    this.manager?.closeAll(false);
    this.ptyHost?.close();
    this.browserBridge?.close();
    this.sessionsControl?.dispose();
    this.scheduled?.dispose();
    this.sessionsBridge?.close();
    this.checklistControl?.dispose();
    this.checklistBridge?.close();
    this.checklists.flush();
    this.walkthroughBridge?.close();
    this.shells.killAll();
  }
}

// 起動が終わる前に届いた呼び出しに、Claude に返すもの（英語）
function notReady() {
  return textResult('tanacode has not finished starting up. Wait a moment and try again.', true);
}

// MCP の中継からの呼び出しを、ソケットで待ち受ける。始められなければ null（Claude Code に MCP サーバーを足さない）
async function listen(name: string, socketPath: string, handler: ConstructorParameters<typeof McpBridge>[1]): Promise<McpBridge | null> {
  const bridge = new McpBridge(socketPath, handler);
  try {
    await bridge.start();
    return bridge;
  } catch (error) {
    console.error(`${name}の待ち受けを始められませんでした`, error);
    return null;
  }
}
