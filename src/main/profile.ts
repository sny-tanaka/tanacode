import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, shell, type Session, type WebContents } from 'electron';
import { IpcChannel, type ArchiveOptions, type IpcEvent, type NewSessionOptions, type WorktreeRemoval } from '@shared/ipc';
import { normalizeHostPattern } from '@shared/browser-tools';
import { t } from '@shared/i18n';
import type { CustomPrompts } from '@shared/prompts';
import type { AppSettings } from './app-settings';
import type { BrowserMcpLaunch } from './browser-bridge';
import { BrowserControl } from './browser-control';
import { McpBridge, textResult, type McpLaunch } from './mcp-bridge';
import { SessionsControl } from './sessions-control';
import type { SessionsMcpLaunch } from './sessions-bridge';
import { ChecklistControl } from './checklist-control';
import { AutoCompact } from './auto-compact';
import { CompactNotice, type TurnNotice } from './compact-notice';
import { PRECOMPACT_HOOK_REQUEST } from './checklist-bridge';
import { OptimizedCompact } from './optimized-compact';
import { outwardHost } from './outward-state';
import { ChecklistStore } from './checklist-store';
import { WalkthroughControl } from './walkthrough-control';
import { TerminalControl } from './terminal-control';
import { commentOnPullRequest, pullRequestsOf } from './github';
import { menuNotice, scheduledNotice, snippet, usageLimitNotice } from './notice-text';
import { hostExecutable, PtyHost } from './pty-host-client';
import { ScheduledMessages } from './scheduled-messages';
import { SessionManager } from './session-manager';
import { resolveAddedFolder } from './added-folders';
import { SettingsFiles } from './settings-files';
import { SessionStore } from './session-store';
import { socketPathIn } from './socket-path';
import { StatusLineWatcher } from './statusline';
import { ShellTerminals } from './shell-terminals';
import { TurnReports } from './turn-reports';
import { UsageLimitResume } from './usage-limit-resume';
import { UsageMonitor } from './usage-monitor';
import { OpenFileWatchers } from './open-file-watcher';
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
  // 子セッションの起動の確認を省く印のファイル（アプリ全体で 1 つ。sessions-bridge.ts の SESSIONS_NO_ASK_FILE）
  sessionsNoAskFile: string;
  // 利用者が変えた、Claude に送る文（アプリ全体で 1 つ。メニューの「Claude に送る文…」。無い欄は既定の文）
  prompts: () => CustomPrompts;
  // このプロファイルの画面への知らせと、画面（アプリ内ブラウザの webview を持つもの）
  send: Send;
  host: () => WebContents | null;
  // このプロファイルの画面を、描かれる状態にする（戻す関数を返す）。見ていないプロファイルの画面は非表示なので、Claude がアプリ内ブラウザのツールを動かす間だけ頼む
  drawHost: () => () => void;
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
  // エディタで開いているタブのうち、フォルダの監視の知らせでは読み直せないもの（フォルダの外など）を、ファイルごとに見張る
  readonly openFiles: OpenFileWatchers;
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
  compact: OptimizedCompact | null = null;
  autoCompact: AutoCompact | null = null;
  // 利用枠で止まったセッションに、枠が戻ったら続きを頼む予約を入れる
  usageLimit: UsageLimitResume | null = null;
  walkthroughControl: WalkthroughControl | null = null;
  terminalControl: TerminalControl | null = null;
  // Claude がターンの終わりの通知に載せる報告（tanacode-sessions の report_result）
  private readonly reports = new TurnReports();
  // Claude によるアプリ内ブラウザの操作・ほかのセッションの扱い・チェックリスト・ウォークスルー・人のターミナルの読み書き。中継（Claude Code が起動する MCP サーバー）からの呼び出しを、ソケットで受ける
  private browserBridge: McpBridge | null = null;
  private sessionsBridge: McpBridge | null = null;
  private checklistBridge: McpBridge | null = null;
  private walkthroughBridge: McpBridge | null = null;
  private terminalBridge: McpBridge | null = null;
  // 新規セッションの画面で開いているフォルダ（id → フォルダ）。セッションと同じように右パネルとエディタで使う
  readonly folderViews = new Map<string, string>();
  // フォルダ選択ダイアログで選ばれたフォルダ。folders.open で開けるのは、これとセッションのフォルダだけ
  readonly pickedFolders = new Set<string>();
  // 新規セッションの画面で、ワークスペースに追加したフォルダ（folders.open の id → フォルダ）。始めるときに画面から渡ってくる
  private readonly draftFolders = new Map<string, string[]>();

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
        onOpened: (owner, id, name, task, replay) => send(IpcChannel.ShellOpened, { owner, id, name, task, ...(replay ? { replay } : {}) }),
      },
      claudeDir,
    );
    this.watchers = new WorkspaceWatchers(
      (root, paths) => send(IpcChannel.FilesChanged, { root, paths }),
      () => this.openFiles.rootsChanged(),
    );
    this.openFiles = new OpenFileWatchers(
      () => this.watchers.roots(),
      (root, paths) => send(IpcChannel.FilesChanged, { root, paths }),
    );
    this.statusLines = new StatusLineWatcher(
      join(dataDir, 'statusline'),
      (id, info) => this.manager.statusLineChanged(id, info),
      (id, request, at) => this.manager.permissionRequested(id, request, at),
      (id, input) => this.manager.tuiStopHook(id, input),
    );
    // 登録した設定ファイル。設定ファイルを選んだセッションの起動で、アプリの設定と合わせたファイルは session-settings に置く
    this.settingsFiles = new SettingsFiles(this.settings, join(dataDir, 'session-settings'), (files) => send(IpcChannel.SettingsFilesChanged, files), claudeDir);
    this.browser = new BrowserControl({
      send,
      enabled: () => this.settings.browserControlEnabled(),
      extraHosts: () => this.settings.browserHosts(),
      host: options.host,
      drawHost: options.drawHost,
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
    this.browserBridge = await listen('アプリ内ブラウザ', socketPathIn(dataDir, 'browser', 'browser'), (id, tool, args, signal, toolUseId) =>
      this.browser.handle(id, tool, args, signal, toolUseId),
    );
    this.sessionsBridge = await listen('セッション', socketPathIn(dataDir, 'sessions', 'sessions'), (id, tool, args, signal) =>
      this.sessionsControl ? this.sessionsControl.handle(id, tool, args, signal) : Promise.resolve(notReady()),
    );
    // チェックリストは、待ち受けを始められなくても画面からは使える
    this.checklistBridge = await listen('チェックリスト', socketPathIn(dataDir, 'checklist', 'checklist'), (id, tool, args) => {
      // 圧縮の前のフック（Claude Code の自動の圧縮を止めるか）は、自動の最適化圧縮が答える
      if (tool === PRECOMPACT_HOOK_REQUEST) return Promise.resolve(textResult(this.autoCompact?.preCompact(id) ?? ''));
      return this.checklistControl ? this.checklistControl.handle(id, tool, args) : Promise.resolve(notReady());
    });
    // ウォークスルーは保存せず、アプリのメモリの上だけで持つ
    this.walkthroughBridge = await listen('ウォークスルー', socketPathIn(dataDir, 'walkthrough', 'walkthrough'), (id, tool, args) =>
      this.walkthroughControl ? this.walkthroughControl.handle(id, tool, args) : Promise.resolve(notReady()),
    );
    // 人のターミナルは、打つ前の確認のフック（gate）も、このソケットに聞く
    this.terminalBridge = await listen('ターミナル', socketPathIn(dataDir, 'terminal', 'terminal'), (id, tool, args, signal) =>
      this.terminalControl ? this.terminalControl.handle(id, tool, args, signal) : Promise.resolve(notReady()),
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
        onTurnCompleted: (session, notice) => {
          const message = this.turnMessage(session.id, notice);
          if (message) notify(session.id, session.title, message);
        },
        // 利用枠で止まったら、枠が戻ったときに続きを頼む予約を入れる（止まらずに終わったら、待っている予約は要らない）
        onTurnLimit: (sessionId, limit) => this.usageLimit?.turnEnded(sessionId, limit),
        onAttention: (session, attention) => notify(session.id, session.title, menuNotice(attention.menu)),
        onProgress: (sessionId, activity) => send(IpcChannel.SessionsProgress, { sessionId, activity }),
        onWorkflows: (sessionId, runs) => send(IpcChannel.WorkflowsChanged, { sessionId, runs }),
        onSubagents: (sessionId, runs) => send(IpcChannel.SubagentsChanged, { sessionId, runs }),
        onBashTasks: (sessionId, tasks) => send(IpcChannel.TasksBashChanged, { sessionId, tasks }),
        onKnowledge: (sessionId, knowledge) => {
          send(IpcChannel.KnowledgeChanged, { sessionId, knowledge });
          this.autoCompact?.check(sessionId);
        },
        // ターミナルモードの statusLine のファイルからも、stream-json の行から作ったものからも来る
        onStatusLine: (sessionId, info) => {
          send(IpcChannel.StatusLineChanged, { sessionId, info });
          this.usage.fromStatusLine(info);
          this.autoCompact?.check(sessionId);
        },
        onUsage: (report, at) => this.usage.fromUsage(report, at),
        onQuestion: (sessionId, question) => send(IpcChannel.QuestionChanged, { sessionId, question }),
        onPermission: (sessionId, permission) => send(IpcChannel.PermissionChanged, { sessionId, permission }),
        onElicitation: (sessionId, elicitation) => send(IpcChannel.ElicitationChanged, { sessionId, elicitation }),
        // URL の形の MCP サーバーの質問のページは、チャットのリンクと同じく、ふだんのブラウザで開く（ログインなど、人のブラウザのログインが要るもの）
        onOpenExternal: (url) => {
          if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
        },
      },
      this.options.remoteControl,
      this.settingsFiles,
      (owner, cwd, command, name, onWaiting) => this.shells.run(owner, cwd, command, name, onWaiting),
      () => this.browserLaunch(),
      () => this.sessionsLaunch(),
      () => this.checklistLaunch(),
      () => this.walkthroughLaunch(),
      this.claudeDir,
      () => this.terminalLaunch(),
      // TANACODE.md を渡すフック。メニューで切り替えず、いつも足す（ファイルが無ければ何も渡さない）
      () => ({ command: hostExecutable(), script: join(__dirname, 'instructions-hook.js') }),
      // worktree やブランチを消す操作の確認のフックが、失うものが無いかを確かめる入り口。いつも足す
      () => ({ command: hostExecutable(), script: join(__dirname, 'worktree-guard-hook.js') }),
    );
    const manager = this.manager;
    // 最適化圧縮の流れが進んでいるセッション（アプリが止めたターンが、流れに入るのを待っている間も）。
    // ほかのセッションと、アプリが打つ知らせからは「作業中」に見せる（outward-state.ts）
    const compacting = (id: string) => (this.compact?.running(id) ?? false) || (this.autoCompact?.stopping(id) ?? false);
    const outward = outwardHost(manager, compacting);
    manager.compactClearing = (id) => this.compact?.status(id).phase === 'clearing';
    // 流れの途中のターンの終わりでは「作業が完了しました」を出さず、流れが最後まで終わったときに 1 回知らせる
    const compactNotice = new CompactNotice((id) => (this.autoCompact?.stopping(id) ?? false) || (this.compact?.stoppedMidTurn(id) ?? false));
    manager.turnNotice = (id, starter) => compactNotice.turnEnded(id, starter);
    // Claude の報告があれば、バックグラウンドのタスクが動いていても、ターンの終わりに通知する（報告は、どう終わったかを伝えるもの）
    manager.turnReported = (id) => this.reports.has(id);
    // チェックリストのファイルを読めず、変更を保存しないセッションは、一覧の印でチェックリストのパネルに知らせる
    manager.checklistUnsaved = (id) => this.checklists.unsavable(id);
    this.checklists.onUnsaved = (id) => manager.checklistUnsavedChanged(id);
    this.sessionsControl = new SessionsControl({
      host: outward,
      compacting,
      enabled: () => this.settings.sessionsControlEnabled(),
      archive: (id, options) => this.archiveSession(id, options),
      humanOnly: (id, request) => this.browser.humanOnly(id, request),
      home: homedir(),
      scheduled: () => this.scheduled ?? null,
      report: (id, text) => this.reports.set(id, text),
    });
    // 時刻を指定して送信（予約）。送れなかった・時刻を過ぎていたものは通知する。子セッションのものは、人に通知しない代わりに親に知らせる
    this.scheduled = new ScheduledMessages(
      join(dataDir, 'scheduled-messages.json'),
      manager,
      (messages) => {
        send(IpcChannel.ScheduledChanged, messages);
        // 親の利用枠の再開の予約が無くなったら、預かっていた子の知らせを送る
        this.sessionsControl?.scheduledChanged();
      },
      (message) => {
        if (this.sessionsControl?.scheduledTrouble(message)) return;
        notify(message.sessionId, manager.summary(message.sessionId)?.title ?? null, scheduledNotice(message));
      },
    );
    this.usageLimit = new UsageLimitResume({
      scheduled: () => this.scheduled ?? null,
      enabled: () => this.settings.usageLimitResumeEnabled(),
      parentOf: (id) => manager.parentOf(id),
      terminal: (id) => !!manager.summary(id)?.terminal,
      prompts: this.options.prompts,
    });
    // アーカイブした・一覧から消したセッションの予約は取り消し、ウォークスルーは捨てる
    manager.watchState((id) => {
      const state = manager.stateOf(id);
      if (state === null || state === 'archived') this.scheduled.dropSession(id);
      if (state === null || state === 'archived') this.usageLimit?.forget(id);
      if (state === null || state === 'archived') this.walkthroughControl?.discard(id);
      if (state === null || state === 'archived' || state === 'exited') compactNotice.forget(id);
      // 新しいターンが始まったら、前のターンの報告は捨てる
      this.reports.stateChanged(id, state);
    });
    this.walkthroughControl = new WalkthroughControl({
      cwdOf: (id) => (manager.summary(id) ? manager.cwdOf(id) : null),
      enabled: () => this.settings.walkthroughControlEnabled(),
      onChange: (sessionId, walkthrough) => send(IpcChannel.WalkthroughChanged, { sessionId, walkthrough }),
      comment: { pullRequests: pullRequestsOf, comment: commentOnPullRequest },
    });
    this.terminalControl = new TerminalControl({
      terminals: this.shells,
      sessions: {
        exists: (id) => !!manager.summary(id),
        cwdOf: (id) => manager.cwdOf(id),
        parentOf: (id) => manager.parentOf(id),
        childrenOf: (id) => manager.childrenOf(id),
      },
      enabled: () => this.settings.terminalControlEnabled(),
    });
    const checklistControl = new ChecklistControl({
      store: this.checklists,
      host: outward,
      enabled: () => this.settings.checklistControlEnabled(),
      turnTools: (id) => manager.turnTools(id),
    });
    this.checklistControl = checklistControl;
    const compact = new OptimizedCompact({
      host: manager,
      lists: (id) => this.checklists.lists(id),
      usedSince: (id, at) => checklistControl.usedSince(id, at),
      enabled: () => this.settings.checklistControlEnabled(),
      prompts: this.options.prompts,
      onChange: (sessionId, status) => {
        send(IpcChannel.CompactChanged, { sessionId, status });
        // 流れが始まった・終わったので、外から見た状態が変わる（待っていた知らせを送る・親に知らせる）
        manager.notifyState(sessionId);
      },
      autoStatus: (id) => autoCompact.status(id),
      onFinish: (id, failure, auto) => {
        autoCompact.finished(id, failure, auto);
        // 仕上げのターン・アプリが止めたターンは終わっているのに、切り替えられなかった（そのターンの終わりでは、通知を出していない）。
        // 仕上げのターンが利用枠で止まったときは、利用枠で止まったことを知らせる
        const limit = failure === 'usage-limit' ? this.usageLimit?.noticeOf(id) : null;
        if (compactNotice.finished(id, failure)) notify(id, manager.summary(id)?.title ?? null, limit ? usageLimitNotice(limit) : t('main.notification.compactFailed'));
      },
    });
    this.compact = compact;
    // 最適化圧縮を、自動で始める（ターンの終わり・ツールの切れ目・Claude Code の自動の圧縮の前）
    const autoCompact = new AutoCompact({
      host: manager,
      compact,
      percent: () => this.autoCompactPercent(),
      stopFile: (id) => this.statusLines.stopFileFor(id),
      stopHitFile: (id) => this.statusLines.stopHitFileFor(id),
      onChange: (id) => compact.refresh([id]),
    });
    this.autoCompact = autoCompact;
    manager.compactBlocked = (id) => autoCompact.blocks(id);
    manager.watchState((id) => autoCompact.check(id));
    // 前に起動したアプリから動き続けている Claude Code を引き継ぐ
    await manager.adopt();
    // 動き続けている Claude Code を引き継いでから、時刻を過ぎた予約を片付けて待ち始める
    this.scheduled.start();
  }

  // ターンが終わったときの通知の本文（null なら出さない）。Claude の報告があれば、その文にする（使ったら捨てる）。
  // 無くて、Claude が自分に入れた予約が待っていれば、作業の完了は知らせない（時刻になると Claude が続きを始めるので、まだ終わっていない）
  private turnMessage(id: string, notice: TurnNotice): string | null {
    // 利用枠で止まったのは、作業の完了ではない。いつ再開するか（戻るか）を知らせる
    const limit = this.usageLimit?.noticeOf(id);
    if (limit) {
      this.reports.take(id);
      return usageLimitNotice(limit);
    }
    const report = this.reports.take(id);
    if (report) return snippet(report);
    if (notice === 'work' && this.scheduled?.hasClaudeWakeup(id)) return null;
    return t(notice === 'compact' ? 'main.notification.compactCompleted' : 'main.notification.turnCompleted');
  }

  // 最適化圧縮を自動で始める大きさ（コンテキストの割合）。確かめやすいよう、環境変数（TANACODE_AUTO_COMPACT_PERCENT）で任意の数にできる
  autoCompactPercent(): number {
    const forced = Number(process.env.TANACODE_AUTO_COMPACT_PERCENT);
    return forced > 0 && forced <= 100 ? forced : this.settings.autoCompactPercent();
  }

  // workspace・git に渡された id（セッションか、folders.open で開いたフォルダ）のフォルダ
  cwdOf(id: string): string {
    return this.folderViews.get(id) ?? this.manager.cwdOf(id);
  }

  // ワークスペースに追加したフォルダ（セッションか、folders.open で開いたフォルダ）
  addedFoldersOf(id: string): string[] {
    return this.folderViews.has(id) ? (this.draftFolders.get(id) ?? []) : this.manager.addedFoldersOf(id);
  }

  // ワークスペースにフォルダを追加する。追加したあとの一覧を返す（もう追加してあれば、そのまま）。追加できなければ理由を添えて投げる
  async addFolder(id: string, folder: string): Promise<string[]> {
    const real = await resolveAddedFolder(this.cwdOf(id), folder);
    const current = this.addedFoldersOf(id);
    return current.includes(real) ? current : this.setAddedFolders(id, [...current, real]);
  }

  // 追加したフォルダをワークスペースから外す（フォルダそのものは消さない）。外したあとの一覧を返す
  removeFolder(id: string, folder: string): string[] {
    const current = this.addedFoldersOf(id);
    // 追加していないフォルダなら、何も変えない（動いている claude を起動し直さない）
    return current.includes(folder) ? this.setAddedFolders(id, current.filter((f) => f !== folder)) : current;
  }

  // Claude がフォルダの外で読んだリポジトリを、手で足した追加フォルダに移す（--add-dir で渡す）。追加したあとの一覧を返す。
  // Claude が読んだものとして出していないフォルダは断る（画面から好きなパスを渡させない）
  async keepReadFolder(id: string, folder: string): Promise<string[]> {
    if (!this.manager.readFoldersOf(id).includes(folder)) throw new Error(`not a folder Claude read: ${folder}`);
    const folders = await this.addFolder(id, folder);
    this.manager.removeOutsideRead(id, folder, false);
    return folders;
  }

  private setAddedFolders(id: string, folders: string[]): string[] {
    if (!this.folderViews.has(id)) {
      this.manager.setAddedFolders(id, folders);
      return folders;
    }
    // 新規セッションの画面のフォルダも、セッションと同じく、エクスプローラーのために見張る
    const before = this.draftFolders.get(id) ?? [];
    for (const folder of folders) if (!before.includes(folder)) this.watchers.retain(folder);
    for (const folder of before) if (!folders.includes(folder)) this.watchers.release(folder);
    this.draftFolders.set(id, folders);
    return folders;
  }

  // 新規セッションの画面のフォルダを閉じる（フォルダを変えた・画面を閉じた・セッションを始めた）
  closeFolderView(id: string): void {
    const cwd = this.folderViews.get(id);
    if (cwd === undefined) return;
    this.setAddedFolders(id, []);
    this.draftFolders.delete(id);
    this.folderViews.delete(id);
    this.watchers.release(cwd);
    // 新規セッションの画面で開いたターミナルとブラウザは、画面を閉じると一緒に閉じる
    this.shells.killOwner(id);
    this.browser.forget(id);
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

  // 起動する Claude Code に足す、セッションの MCP サーバー。メニューでオフにしているときや、待ち受けを始められなかったときは足さない。
  // 子セッションの起動の確認のフックが見る、印のファイルのパスも渡す
  private sessionsLaunch(): SessionsMcpLaunch | null {
    if (!this.sessionsBridge || !this.settings.sessionsControlEnabled()) return null;
    return {
      command: hostExecutable(),
      script: join(__dirname, 'sessions-mcp.js'),
      socketPath: this.sessionsBridge.socketPath,
      version: app.getVersion(),
      noAskFile: this.options.sessionsNoAskFile,
    };
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

  // 起動する Claude Code に足す、人のターミナルの MCP サーバー。メニューでオフにしているときや、待ち受けを始められなかったときは足さない
  private terminalLaunch(): McpLaunch | null {
    if (!this.terminalBridge || !this.settings.terminalControlEnabled()) return null;
    return { command: hostExecutable(), script: join(__dirname, 'terminal-mcp.js'), socketPath: this.terminalBridge.socketPath, version: app.getVersion() };
  }

  // 新規セッションの画面から、worktree で始める。Claude Code が worktree を作るのを待たずに id を返す（画面は、すぐそのセッションに移って待つ）。
  // 作れなかったら（セッションは、もう一覧から消えている）、理由を画面に知らせる
  async startInWorktree(cwd: string, options: NewSessionOptions): Promise<string> {
    const { id, created } = await this.manager.startInWorktree(cwd, options);
    created.catch((error: unknown) => {
      this.options.send(IpcChannel.SessionsCreateFailed, { id, cwd, error: error instanceof Error ? error.message : String(error) });
    });
    return id;
  }

  // セッションをアーカイブする。画面からのアーカイブも、親の Claude の end_session（sessions-control.ts）も、ここを通る
  archiveSession(id: string, options?: ArchiveOptions): Promise<WorktreeRemoval | null> {
    // 子セッションも一緒にアーカイブされる
    for (const target of [id, ...this.manager.childrenOf(id)]) this.browser.forget(target);
    // worktree を消すときは、そのフォルダで開いたシェルも閉じる（消したフォルダに残らないように）。起動中の子を終えるときは、
    // worktree を残しても、準備のために動かしているもの（依存の install。持ち主はそのセッション）を止める
    if (options?.removeWorktree || options?.stopSetup) this.shells.killOwner(id);
    return this.manager.archive(id, options);
  }

  // アーカイブ済みのセッションの、残っている worktree を消す（worktree の片付け）。そのフォルダで開いたシェルも閉じる
  removeLeftWorktree(id: string): Promise<WorktreeRemoval> {
    this.shells.killOwner(id);
    return this.manager.removeLeftWorktree(id);
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
    this.openFiles.closeAll();
    this.ptyHost?.close();
    this.browserBridge?.close();
    this.sessionsControl?.dispose();
    this.scheduled?.dispose();
    this.sessionsBridge?.close();
    this.checklistControl?.dispose();
    this.compact?.dispose();
    this.checklistBridge?.close();
    this.checklists.flush();
    this.walkthroughBridge?.close();
    this.terminalBridge?.close();
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
