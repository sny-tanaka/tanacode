import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  bridgeUrlOf,
  isTranscriptEntry,
  toChatEvents,
  transcriptTitle,
  type ChatEvent,
  type TranscriptEntry,
  type UnsentPrompt,
} from '@shared/chat';
import { stripControlChars } from '@shared/prompt-keys';
import { t } from '@shared/i18n';
import type { CarriedTask } from '@shared/optimized-compact';
import { modeWithin, type PermissionRequest, type SessionState } from '@shared/session-tools';
import type {
  ArchiveOptions,
  ChatBatch,
  ExportSource,
  NewSessionOptions,
  ScreenChoice,
  SessionOptions,
  SessionSnapshot,
  SessionAttention,
  SessionSummary,
  WorktreeLeftovers,
  WorktreePreparing,
  WorktreeRemoval,
} from '@shared/ipc';
import type { Activity, AskQuestion, ChooseResult, Menu, PermissionMode, ScreenInfo } from '@shared/screen';
import type { SubagentRun } from '@shared/subagent';
import type { SessionKnowledge } from '@shared/knowledge';
import type { SessionContext } from '@shared/context';
import type { StatusLineInfo } from '@shared/statusline';
import type { AgentLogRef, BashTask, TaskRef } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import type { PendingQuestion, QuestionReply } from '@shared/questions';
import { BashTaskTracker } from './bash-task-tracker';
import { branchCut, readAgentLog, readChatLog, readExportLog, type ChainEntry } from './chat-log';
import { ClaudeSession, transcriptPath } from './claude-session';
import { settingsDefaultMode } from './claude-config';
import { turnStarterOf, type TurnNotice, type TurnStarter } from './compact-notice';
import type { BrowserMcpLaunch } from './browser-bridge';
import { textResult, type McpLaunch, type ToolResult } from './mcp-bridge';
import { PendingQuestions } from './pending-questions';
import type { TerminalMcpLaunch } from './terminal-bridge';
import type { PreparedSettings, SettingsFiles } from './settings-files';
import { KnowledgeTracker } from './knowledge-tracker';
import { ContextTracker, readContext } from './context-tracker';
import type { PtyHostApi } from './pty-host-client';
import type { HostedPipeInfo } from './pty-host-protocol';
import { rememberImage } from './image-cache';
import { askQuestionsOf } from './screen-parser';
import { TaskRouter } from './task-router';
import type { StatusLineWatcher } from './statusline';
import { SubagentTracker } from './subagent-tracker';
import { WorkflowTracker } from './workflow-tracker';
import type { SessionRecord, SessionStore } from './session-store';
import type { WorkspaceWatchers } from './workspace-watcher';
import type { StreamClient } from './stream/client';
import { generateTitle } from './stream/internal';
import { LineLog } from './stream/log';
import type {
  AssistantMessage,
  CanUseToolRequest,
  CommandLifecycleMessage,
  ContentBlock,
  ContextUsageResponse,
  InitializeResponse,
  ResultMessage,
  SettingsResponse,
  StreamMessage,
  UserMessage,
} from './stream/protocol';
import { appMode, modelName, Progress, rateLimitsOf, streamMode } from './stream/state';
import {
  hideWorktrees,
  planWorktree,
  prepareNodeModules,
  removeWorktree,
  restoreWorktree,
  waitForWorktree,
  worktreeLeftovers,
  type NodeModulesResult,
} from './worktree';

// rename で付けた名前。会話ログのタイトル（最大 3）より常に優先する
const USER_TITLE_PRIORITY = 4;
// 会話ログのタイトルのうち、最初の発言のもの（これより高いものは ai-title・custom-title）
const FIRST_PROMPT_TITLE_PRIORITY = 1;

// ターンの終わり（result）のあと、そのターンの最後の応答が会話ログに出るのを待つ上限（出たら、チャットにターンの終わりを出す。設計書 7 節）。
// result は会話ログより先に届くので、先に出すと実行中のツールをいったんエラーにしてしまう
const TURN_END_WAIT_MS = 3000;
// 送った発言が Claude Code に受け付けられた知らせ（command_lifecycle）も会話ログの行も来ないまま、送信中として扱う上限
const SENDING_TIMEOUT_MS = 30_000;
// 作業中の経過時間を知らせ直す間隔
const PROGRESS_TICK_MS = 1000;

// ターミナルモードで Claude Code の画面を見ていないときの pty サイズ（ターミナルモードで見ているあいだだけ、ペインの大きさに合わせる）
export const DEFAULT_PTY_SIZE = { cols: 120, rows: 40 };

type Runtime = {
  process: ClaudeSession | null;
  // これまでに配信したイベントの総数。再起動をまたいで増え続ける
  seq: number;
  // 直近の起動（process-start）以降のイベント
  events: ChatEvent[];
  unread: boolean;
  workflows: WorkflowTracker;
  subagents: SubagentTracker;
  bashTasks: BashTaskTracker;
  // 会話ログの行を、上の 3 つと質問に振り分ける
  tasks: TaskRouter;
  // Claude が読んだ・書いたファイルとコンテキストの使用量
  knowledge: KnowledgeTracker;
  // コンテキストの中身（読んだファイル・大きなツールの結果・発言ごとのやりとりなど）
  context: ContextTracker;
  // モデル・エフォート・コンテキスト・利用枠（stream-json の行と制御の要求の返事から作る。ターミナルモードの間は statusLine から）
  statusLine: StatusLineInfo | null;
  // 今の会話ログの行（uuid を持つもの）と、その行から作ったイベントの events 上の位置。巻き戻しの検出に使う
  chain: ChainEntry[];
  // ユーザーの操作を待っているもの（一覧の印）
  attention: SessionAttention;
  // 実行中のバックグラウンドタスク（サブエージェント・ワークフロー・Bash）の数
  background: number;
  // 許可の確認を出す直前に、フックが書いた入力（親の Claude が子の許可の確認に答えるときに読む。pendingPermission）
  permission: PermissionRequest | null;
  // Claude Code が答えを待っている要求（can_use_tool。request_id → 要求。来た順）
  requests: Map<string, CanUseToolRequest>;
  // initialize の返事が来た（コマンド・モデルの一覧など）。来るまでは起動中
  init: InitializeResponse | null;
  // 入力を受け付けられるようになった（ready を配信した）。worktree の準備が終わるまでは配信しない
  ready: boolean;
  // 分かっている権限モード（起動の引数・アプリでの切り替え・Claude Code が知らせたモード（init・status・発言の行）の、いちばん新しいもの）。
  // 子セッションの権限モードの上限にも使う
  knownMode: PermissionMode | null;
  size: { cols: number; rows: number };
  // 引き継いだ claude（前のアプリが起動したもの）が起動した時刻。これ以降の会話ログの行は、今も動いている claude が書いた
  aliveSince: number | null;
  // ターンの途中（Claude Code が作業中）。stream-json の行で決める（設計書 7 節）
  turnOpen: boolean;
  // 今のターンの、本体の最後の応答の uuid（ターンの終わりを、会話ログがここまで追いついてから出す）
  lastAssistant: string | null;
  // result が届き、チャットにターンの終わりを出すのを待っているもの
  turnEnding: { interrupted: boolean; waitFor: string | null; timer: NodeJS.Timeout } | null;
  // 今の（か、最後に始まった）ターンを始めたもの。ターンが終わったら other に戻す（compact-notice.ts）
  turnStarter: TurnStarter;
  // 今のターンで、始めたもの（turnStarter）を会話ログから決めた
  starterSeen: boolean;
  // 作業中の進み具合（ターンの間だけ）
  progress: Progress | null;
  progressTimer: NodeJS.Timeout | null;
  // 送ったが、まだ会話に出ていない発言（uuid → 発言）
  unsent: Map<string, UnsentPrompt & { at: number }>;
  // 送信の順番（画像を読む間に、あとから送ったものが追い越さないように）
  sendChain: Promise<void>;
  // 引き継いだ claude で、ホストに頼んだ送り直しが済んだ（前のアプリの頃の行を読み終えた）
  caughtUp: boolean;
  // Remote Control が実際につながっているか（会話ログの bridge_status・空の bridge-session で分かる）
  remoteConnected: boolean | null;
  // 会話ログを読み終えた（読み直しの途中の、古いつながりの状態で合わせないため）
  historyLoaded: boolean;
  // 読み直した会話ログの最後の Remote Control の URL（bridge-session 行。切れていれば null、行が無ければ undefined）
  lastBridgeUrl: string | null | undefined;
  // この起動で、会話のタイトルを作らせた（generate_session_title。最初のターンのあとに 1 回だけ）
  titleRequested: boolean;
  // worktree の準備の途中（Claude Code が worktree を作るのを待っている・node_modules の用意）。終わるまで ready を配信しない
  preparing: WorktreePreparing | null;
  // Claude Code が worktree を作り終えたか（新しい worktree で起動したときだけ。作れずに終わったら false）
  worktreeCreated: Promise<boolean> | null;
  // ファイルの変更を見張っているフォルダ（worktree は、Claude Code が作るまで見張れない）
  watched: string | null;
  // 見張っている、ワークスペースに追加したフォルダ
  watchedFolders: string[];
  // 起動を待って送る発言の数（ツールで返す状態で、作業中として扱う）
  pendingSubmits: number;
  // チェックリストの MCP サーバーを足して起動したか（引き継いだ claude は分からないので null）
  checklistMcp: boolean | null;
  // 最後に終わった claude の標準エラーの末尾（worktree を作れなかった理由など）
  stderr: string;
};

// アプリが開くコマンドのターミナル（worktree の npm install・yarn install など）。終了コードを返す。owner: セッションの id
export type RunTask = (owner: string, cwd: string, command: string, name: string) => Promise<number>;

type Listeners = {
  onSessionsChanged: (sessions: SessionSummary[]) => void;
  onChat: (batch: ChatBatch) => void;
  onPtyData: (sessionId: string, data: string) => void;
  onTurnCompleted: (session: SessionSummary, notice: TurnNotice) => void;
  // 作業中の進み具合（作業中でなければ null）
  onProgress: (sessionId: string, activity: Activity | null) => void;
  onWorkflows: (sessionId: string, runs: WorkflowRun[]) => void;
  onSubagents: (sessionId: string, runs: SubagentRun[]) => void;
  onBashTasks: (sessionId: string, tasks: BashTask[]) => void;
  onKnowledge: (sessionId: string, knowledge: SessionKnowledge) => void;
  onStatusLine: (sessionId: string, info: StatusLineInfo) => void;
  // ユーザーの操作待ちになった（質問・許可の確認）
  onAttention: (session: SessionSummary, attention: { kind: 'menu'; menu: Menu } | { kind: 'unsupported' }) => void;
  // フックが答えを待っている AskUserQuestion（いちばん前のもの）が変わった（無くなったら null）
  onQuestion?: (sessionId: string, question: PendingQuestion | null) => void;
};

export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();
  private focusedId: string | null = null;
  private closed = false;

  constructor(
    private readonly host: PtyHostApi,
    private readonly store: SessionStore,
    private readonly watchers: WorkspaceWatchers,
    private readonly statusLines: StatusLineWatcher,
    private readonly listeners: Listeners,
    // Remote Control を使えるか。開発版では使わない（起動するたびにスマホに通知が届くため）
    private readonly remoteControlAvailable = true,
    // 登録した設定ファイルを、起動する Claude Code に重ねる。無ければ設定ファイルは使えない
    private readonly settingsFiles: SettingsFiles | null = null,
    // worktree の npm install などを実行する（アプリはターミナルのタブに出す）。無ければ、画面に出さずに実行する
    private readonly runTask: RunTask = runQuietly,
    // 起動する Claude Code に、アプリ内ブラウザの MCP サーバーを足すときの材料（起動のたびに聞く。メニューでオフなら null）
    private readonly browser: () => BrowserMcpLaunch | null = () => null,
    // 起動する Claude Code に、セッションの MCP サーバーを足すときの材料（起動のたびに聞く。メニューでオフなら null）
    private readonly sessionsMcp: () => McpLaunch | null = () => null,
    // 起動する Claude Code に、チェックリストの MCP サーバーを足すときの材料（起動のたびに聞く。メニューでオフなら null）
    private readonly checklistMcp: () => McpLaunch | null = () => null,
    // 起動する Claude Code に、ウォークスルーの MCP サーバーを足すときの材料（起動のたびに聞く。メニューでオフなら null）
    private readonly walkthroughMcp: () => McpLaunch | null = () => null,
    // プロファイルの Claude Code の設定のフォルダ（CLAUDE_CONFIG_DIR として渡し、会話ログもその中を読む）。null は既定のプロファイル
    private readonly claudeDir: string | null = null,
    // 起動する Claude Code に、人のターミナルの MCP サーバーを足すときの材料（起動のたびに聞く。メニューでオフなら null）
    private readonly terminalMcp: () => McpLaunch | null = () => null,
  ) {}

  // フックが答えを待っている AskUserQuestion（セッションごと）
  private readonly questions = new PendingQuestions((id) => this.questionsChanged(id));

  // 状態が変わったかもしれないセッション（イベント・操作待ち・バックグラウンドの数・アーカイブ）を知らせる先
  private readonly stateListeners = new Set<(id: string) => void>();
  // 最後に一覧で画面へ渡した、セッションごとの状態
  private readonly shownStates = new Map<string, SessionState | null>();

  watchState(listener: (id: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private changed(id: string): void {
    // 状態が一覧で渡したものから変わったら、一覧を送り直す（画面は、チャットの状態を一覧の state から決める）
    if (this.shownStates.has(id) && this.shownStates.get(id) !== this.stateOf(id)) this.emitSessions();
    for (const listener of this.stateListeners) listener(id);
    this.restartForFoldersIfIdle(id);
  }

  // 外から見た状態が変わった（最適化圧縮の流れが始まった・終わった）ことを、見張っている先に知らせる
  notifyState(id: string): void {
    this.changed(id);
  }

  // 最適化圧縮の流れが、そのセッションに /clear を打って、新しい会話になるのを待っているか（profile.ts がつなぐ）。
  // その /clear で会話が替わったときは、reset に印を付ける（チャットの画面を消さない）
  compactClearing: (id: string) => boolean = () => false;

  // ターンが終わったときに、人に出す通知の種類（null なら出さない。profile.ts がつなぐ）。最適化圧縮の流れの途中のターンでは出さず、
  // 流れの最後のターンでは「コンテキストの最適化が完了しました」にする（compact-notice.ts）。ターンの終わりごとに、1 回だけ呼ぶ。
  // starter: 終わったターンを始めたもの
  turnNotice: (id: string, starter: TurnStarter) => TurnNotice | null = () => 'work';

  // 終わったターンで、Claude が人への報告（report_result）を預けたか（profile.ts がつなぐ）。報告があれば、バックグラウンドのタスクが
  // 動いていても、ターンの終わりに通知する（報告は、どう終わったかを伝えるもの）
  turnReported: (id: string) => boolean = () => false;

  // 最後に終わったターンが、人の中断で終わったか
  lastTurnInterrupted(id: string): boolean {
    const events = this.runtimes.get(id)?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === 'turn-end') return event.interrupted === true;
    }
    return false;
  }

  // 消した worktree を作り直している途中のセッション（まだ Claude Code を起動していない）
  private readonly restoring = new Set<string>();
  // Claude がアプリ内ブラウザでユーザーに操作を頼んでいるセッション（browser-control が知らせてくる）
  private readonly browserAsks = new Set<string>();

  list(): SessionSummary[] {
    return [...this.store.all()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => {
        const rt = this.runtimes.get(r.id);
        return {
          id: r.id,
          title: r.title,
          cwd: r.cwd,
          archived: r.archived,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          running: !!rt?.process,
          state: this.stateOf(r.id),
          mode: rt?.process ? (rt.knownMode ?? null) : null,
          unread: !!rt?.unread,
          attention: rt?.process ? (rt.attention ?? (this.browserAsks.has(r.id) ? 'browser' : null)) : null,
          backgroundTasks: rt?.process ? rt.background : 0,
          model: r.model ?? null,
          effort: r.effort ?? null,
          settingsFile: r.settingsFile ?? null,
          remoteControl: this.wantsRemote(r),
          autoCompact: r.autoCompact !== false,
          worktree: r.worktree
            ? { ...r.worktree, preparing: this.restoring.has(r.id) ? 'restoring' : rt?.process ? rt.preparing : null }
            : null,
          parentId: r.parentId ?? null,
          addedFolders: r.addedFolders ?? [],
        };
      });
  }

  // Claude Code が動いている、アーカイブしていないセッションと、その状態（一覧の文言と同じ）。アプリを終了するときの確認に使う
  liveSessions(): { title: string; state: string }[] {
    return this.store
      .all()
      .filter((r) => !r.archived && this.runtimes.get(r.id)?.process)
      .map((r) => ({ title: r.title ?? t('main.session.untitled'), state: stateLabel(this.runtimes.get(r.id)!, this.browserAsks.has(r.id)) }));
  }

  summary(id: string): SessionSummary | undefined {
    return this.list().find((s) => s.id === id);
  }

  cwdOf(id: string): string {
    const record = this.store.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);
    return record.cwd;
  }

  // parentId: 親の Claude が start_session で起動する子セッションなら、親セッションの ID
  create(cwd: string, options: NewSessionOptions, parentId: string | null = null): string {
    // 使えない設定ファイルなら、記録を作る前に断る（使えないまま標準の設定で始めてしまわないように）
    this.checkSettingsFile(options.settingsFile);
    const id = this.addRecord(cwd, options, null, parentId);
    this.start(id, options.mode);
    return id;
  }

  // claude --worktree で、新しい worktree に分けて始める。名前はアプリが決め、セッションのフォルダは worktree のフォルダにする。
  // Claude Code が worktree を作るのは待たずに返す（起動してから作るまでに何秒かかかる。そのあいだ、新規セッションの画面を
  // 止めないため。画面はすぐそのセッションに移り、準備の段階を出して待つ）。
  // created: 作り終えたら true。作っている途中に人がアーカイブした・一覧から消したら false（記録はそのまま）。
  // 作れずに Claude Code が終わったら、記録を消して、そのときの標準エラーを添えて失敗する
  async startInWorktree(cwd: string, options: NewSessionOptions, parentId: string | null = null): Promise<{ id: string; created: Promise<boolean> }> {
    this.checkSettingsFile(options.settingsFile);
    const plan = await planWorktree(cwd);
    // 元のフォルダのソース管理に、worktree が未追跡として出ないようにする
    await hideWorktrees(plan.root).catch(() => {});
    const id = this.addRecord(plan.path, options, { name: plan.name, branch: plan.branch, root: plan.root }, parentId);
    this.start(id, options.mode);
    return { id, created: this.untilWorktreeCreated(id) };
  }

  // worktree で始めて、Claude Code が worktree を作るまで待ってから返す（親の Claude が子セッションを始めるとき。
  // 作れなかった理由を、ツールの結果として返せるように）
  async createInWorktree(cwd: string, options: NewSessionOptions, parentId: string | null = null): Promise<string> {
    const { id, created } = await this.startInWorktree(cwd, options, parentId);
    if (!(await created)) throw new Error(t('main.worktree.closedWhileCreating'));
    return id;
  }

  private async untilWorktreeCreated(id: string): Promise<boolean> {
    let waiting = this.runtimes.get(id)?.worktreeCreated ?? null;
    while (waiting) {
      if (await waiting) return true;
      // 作っている途中に起動し直していたら（再起動）、新しい起動のほうを待つ
      const next = this.runtimes.get(id)?.worktreeCreated ?? null;
      if (next === waiting) break;
      waiting = next;
    }
    // 人がアーカイブした・一覧から消したのは、作れなかったのではない
    const record = this.store.get(id);
    if (!record || record.archived) return false;
    // 作れなかった理由は、Claude Code の標準エラー（「Error creating worktree」など）と終了コードで分かる
    const stderr = this.runtimes.get(id)?.stderr.trim() ?? '';
    await this.archive(id).catch(() => null);
    this.store.remove(id);
    this.emitSessions();
    if (/trust not yet accepted/i.test(stderr)) throw new Error(t('main.worktree.untrustedFolder'));
    throw new Error(`${t('main.worktree.createFailed')}${stderr ? `\n\n${stderr.split('\n').slice(-8).join('\n')}` : ''}`);
  }

  private addRecord(cwd: string, options: NewSessionOptions, worktree: SessionRecord['worktree'], parentId: string | null): string {
    const now = Date.now();
    const id = randomUUID();
    this.store.add({
      id,
      claudeSessionId: randomUUID(),
      cwd,
      title: null,
      titlePriority: 0,
      archived: false,
      model: options.model,
      effort: options.effort,
      settingsFile: options.settingsFile,
      remoteControl: options.remoteControl,
      worktree,
      ...(parentId ? { parentId, launchMode: options.mode } : {}),
      ...(options.addedFolders?.length ? { addedFolders: options.addedFolders } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  parentOf(id: string): string | null {
    return this.store.get(id)?.parentId ?? null;
  }

  // 子セッション（アーカイブしたものも）の ID
  childrenOf(id: string): string[] {
    return this.store
      .all()
      .filter((r) => r.parentId === id)
      .map((r) => r.id);
  }

  // 既存の会話（アプリの外で作られたもの）を取り込んで再開する
  importSession(claudeSessionId: string, cwd: string, title: string): string {
    const now = Date.now();
    const id = randomUUID();
    // タイトルは会話ログから読み直すので、仮の優先度（最初の発言相当）にしておく
    this.store.add({ id, claudeSessionId, cwd, title, titlePriority: 1, archived: false, createdAt: now, updatedAt: now });
    this.start(id);
    return id;
  }

  claudeSessionIds(): Set<string> {
    return new Set(this.store.all().map((r) => r.claudeSessionId));
  }

  // ユーザーが付けた名前は会話ログのタイトル（custom-title / ai-title）より優先する
  rename(id: string, title: string): void {
    const trimmed = title.trim();
    this.store.update(id, trimmed ? { title: trimmed, titlePriority: USER_TITLE_PRIORITY } : { title: null, titlePriority: 0 });
    this.emitSessions();
  }

  // 一覧から消す。worktree を消せなかったら、一覧には（アーカイブして）残したまま、理由を添えて失敗する
  // 子セッションは一緒にアーカイブしない（アーカイブした親を消すときに、戻しておいた子を止めないため）
  async remove(id: string, options?: ArchiveOptions): Promise<WorktreeRemoval | null> {
    const removal = await this.archive(id, options, false);
    void rm(this.statusLines.fileFor(id), { force: true });
    void rm(this.statusLines.askFileFor(id), { force: true });
    // stream-json の送受信の控えも消す
    new LineLog(this.streamLogFor(id)).remove();
    this.store.remove(id);
    this.emitSessions();
    return removal;
  }

  // 最近使ったセッションのフォルダ（裏で Claude Code を起動するときに使う。信頼済みなので確認が出ない）
  recentCwd(): string {
    return this.list().find((s) => !s.archived)?.cwd ?? this.list()[0]?.cwd ?? homedir();
  }

  // 今の会話ログのパス
  transcriptOf(id: string): string | null {
    const record = this.store.get(id);
    return record ? transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir) : null;
  }

  history(id: string): Promise<ChatEvent[]> {
    const record = this.store.get(id);
    if (!record) return Promise.resolve([]);
    return readChatLog(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir), record.cwd);
  }

  // 作業の書き出しの材料。動いているセッションも、会話ログを最初から読み直す（画像も画像置き場に入れ直す）
  async exportSource(id: string): Promise<ExportSource> {
    const record = this.store.get(id);
    if (!record) throw new Error(t('main.session.notFound'));
    const live = !!this.runtimes.get(id)?.process;
    const { events, branches } = await readExportLog(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir), record.cwd, live);
    return { events, branches, home: homedir() };
  }

  // 未起動・終了済みなら起動（再開）する。起動中なら何もしない。
  // worktree のセッションで、worktree を消していたら（アーカイブのときに消した）、残したブランチから作り直してから再開する。
  // まだ会話が無ければ、元のフォルダで claude --worktree <名前> を起動し、Claude Code は作り直した worktree をそのまま使う（実測）
  async open(id: string): Promise<void> {
    if (this.runtimes.get(id)?.process || this.restoring.has(id)) return;
    const record = this.store.get(id);
    if (record?.archived) this.store.update(id, { archived: false });
    if (record?.worktree && !existsSync(record.cwd)) {
      // 作り直してから起動するまで、一覧では「準備中」にする
      this.restoring.add(id);
      this.emitSessions();
      try {
        await restoreWorktree(record.worktree, record.cwd);
      } finally {
        this.restoring.delete(id);
        this.emitSessions();
      }
      this.start(id, record.launchMode ?? null);
      void this.prepareWorktree(id, 'restored');
      return;
    }
    // 子セッションは起動のモードで。ほかのセッションは、前回分かっていたモードで（無ければ設定の既定。startMode）
    this.start(id, record?.launchMode ?? null);
  }

  // アーカイブする。removeWorktree: worktree のセッションなら、Claude Code が終わるのを待ってから worktree も消す。
  // children: 子セッションも一緒にアーカイブする（親だけをアーカイブしない）
  async archive(id: string, options?: ArchiveOptions, children = true): Promise<WorktreeRemoval | null> {
    const rt = this.runtimes.get(id);
    const record = this.store.get(id);
    const removing = !!options?.removeWorktree && !!record?.worktree;
    // 消すときは、消している途中に Claude Code が書き込まないよう、終わるのを待つ
    if (removing) await rt?.process?.stop();
    else rt?.process?.kill();
    this.settingsFiles?.release(id);
    this.questions.releaseAll(id);
    if (rt) this.releaseRequests(id, rt);
    rt?.workflows.dispose();
    rt?.subagents.dispose();
    rt?.bashTasks.dispose();
    if (rt) this.stopProgress(id, rt);
    if (rt?.turnEnding) clearTimeout(rt.turnEnding.timer);
    if (rt?.watched) this.watchers.release(rt.watched);
    if (rt) this.watchFolders(rt, []);
    if (this.runtimes.get(id) === rt) this.runtimes.delete(id);
    this.store.update(id, { archived: true });
    this.emitSessions();
    this.changed(id);
    // 親だけをアーカイブしない。子も一緒にアーカイブする（子の worktree は消さない）
    for (const child of children ? this.childrenOf(id) : []) {
      if (!this.store.get(child)?.archived) await this.archive(child);
    }
    if (!removing || !record?.worktree) return null;
    return removeWorktree(record.worktree, record.cwd);
  }

  // worktree を消す前に、残っているもの（worktree のセッションでなければ null）
  async worktreeLeftovers(id: string): Promise<WorktreeLeftovers | null> {
    const record = this.store.get(id);
    return record?.worktree ? worktreeLeftovers(record.worktree, record.cwd) : null;
  }

  unarchive(id: string): void {
    this.store.update(id, { archived: false, updatedAt: Date.now() });
    this.emitSessions();
  }

  focus(id: string | null): void {
    this.focusedId = id;
    const rt = id ? this.runtimes.get(id) : undefined;
    if (rt?.unread) {
      rt.unread = false;
      this.emitSessions();
    }
  }

  // ツールで返す、今の状態（知らないセッションは null）。main が 1 つだけ持ち、画面にも一覧で渡す（設計書 7 節）
  stateOf(id: string): SessionState | null {
    const record = this.store.get(id);
    if (!record) return null;
    if (record.archived) return 'archived';
    if (this.restoring.has(id)) return 'starting';
    const rt = this.runtimes.get(id);
    if (!rt?.process) return 'exited';
    // Claude Code が答えを待っている要求（AskUserQuestion は質問、ほかは許可の確認）
    const request = firstRequest(rt);
    if (request) return request.tool_name === 'AskUserQuestion' ? 'question' : 'permission';
    // フックが答えを待っている質問
    if (this.questions.first(id)) return 'question';
    if (!rt.ready || rt.preparing) return 'starting';
    // result のあと、そのターンの最後の応答が会話ログに出るまで（turnEnding）も作業中。チャットのターンの終わりと揃える
    if (rt.pendingSubmits > 0 || rt.turnOpen || rt.turnEnding || sending(rt)) return 'working';
    if (rt.background > 0) return 'background';
    return 'idle';
  }

  // 子セッションの権限モードの上限にする、今の権限モード（分かっていなければ manual）
  modeOf(id: string): PermissionMode | null {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    return rt.knownMode ?? 'manual';
  }

  // 今のモデル（--model に渡せる ID）とエフォート。start_session で省いたときに、呼んだセッションに合わせるために使う。
  // Claude Code が知らせた今の値があればそれ、無ければ起動の指定（アプリで選んだもの）。どちらも無ければ null（Claude Code の既定のまま）
  currentModel(id: string): string | null {
    return this.runtimes.get(id)?.statusLine?.model?.id ?? this.store.get(id)?.model ?? null;
  }

  currentEffort(id: string): string | null {
    return this.runtimes.get(id)?.statusLine?.effort ?? this.store.get(id)?.effort ?? null;
  }

  // 今出している AskUserQuestion の質問。stream-json では画面が無いので null（質問は待っている要求として受け取る）
  askedQuestions(_id: string): AskQuestion[] | null {
    return null;
  }

  // 会話（動かしたことがあれば直近の起動からのイベント、なければ会話ログから作ったもの）
  async conversation(id: string): Promise<ChatEvent[]> {
    const rt = this.runtimes.get(id);
    return rt ? [...rt.events] : this.history(id);
  }

  snapshot(id: string): SessionSnapshot {
    const rt = this.runtimes.get(id);
    if (!rt) return { sessionId: id, fromSeq: 0, events: [] };
    return { sessionId: id, fromSeq: rt.seq - rt.events.length, events: rt.events };
  }

  subagents(id: string): SubagentRun[] {
    return this.runtimes.get(id)?.subagents.all() ?? [];
  }

  statusLine(id: string): StatusLineInfo | null {
    return this.runtimes.get(id)?.statusLine ?? null;
  }

  // Claude がアプリ内ブラウザでユーザーに操作を頼んだ・頼み終わった（一覧は「ブラウザでの操作待ち」）。
  // 状態の見張りにも知らせる（親の Claude には、子の状態 browser として見せて知らせる。sessions-control.ts）
  browserAskChanged(id: string, asking: boolean): void {
    if (asking === this.browserAsks.has(id)) return;
    if (asking) this.browserAsks.add(id);
    else this.browserAsks.delete(id);
    this.emitSessions();
    this.changed(id);
  }

  // Claude がアプリ内ブラウザでユーザーに操作を頼んでいるか
  browserAsking(id: string): boolean {
    return this.browserAsks.has(id);
  }

  // 許可の確認を出す直前に、フックがそのツールの名前と入力をファイルに書いた
  permissionRequested(id: string, raw: unknown, at: number): void {
    const rt = this.runtimes.get(id);
    const request = raw as { tool_name?: unknown; tool_input?: unknown; agent_type?: unknown; agent_id?: unknown } | null;
    if (!rt || !request || typeof request.tool_name !== 'string' || !request.tool_input || typeof request.tool_input !== 'object') return;
    const agent = typeof request.agent_type === 'string' ? request.agent_type : typeof request.agent_id === 'string' ? request.agent_id : null;
    // ファイルの変化は、1 回の書き込みで何度か知らされることがある。同じ書き込み（同じ時刻）は数え直さない
    if (rt.permission?.at === at) return;
    rt.permission = { seq: (rt.permission?.seq ?? 0) + 1, at, tool: request.tool_name, input: request.tool_input as Record<string, unknown>, agent };
    this.changed(id);
  }

  // 今出ている許可の確認の、ツールの名前と入力の全文（フックの入力から。stream-json では、待っている要求に全文がある）
  pendingPermission(_id: string): PermissionRequest | null {
    return null;
  }

  // AskUserQuestion を出す直前に、フックがその入力をファイルに書いた（stream-json では使わない）
  askQuestionsChanged(_id: string, _input: unknown): void {}

  // 質問のフック（question-hook.ts）が、AskUserQuestion の入力を渡した。返事（質問のカード・親の answer_question）を待って、
  // フックに返す結果にする。待つのをやめた（人がターミナルで答えた・Claude Code が終わった）ときは kind: none（フックは何も決めない）。
  // signal: フックとのつながりが切れた（Claude Code がフックを止めた）
  async waitQuestion(id: string, input: unknown, signal: AbortSignal): Promise<ToolResult> {
    const questions = askQuestionsOf(input);
    const reply = questions && this.runtimes.get(id)?.process ? await this.questions.wait(id, questions, signal) : null;
    return textResult(JSON.stringify(reply ?? { kind: 'none' }));
  }

  // フックが答えを待っている質問（いちばん前のもの）。無ければ null
  pendingQuestion(id: string): PendingQuestion | null {
    return this.questions.first(id);
  }

  // 待っている質問に返事をする（質問のカード）。その質問をもう待っていなければ false
  replyQuestion(id: string, questionId: string, reply: QuestionReply): boolean {
    return this.questions.reply(id, questionId, reply);
  }

  // 待っている質問のうち 1 問に答える（親の answer_question）。全部そろったら返事にする（sent）。もう待っていなければ null
  answerPendingQuestion(id: string, questionId: string, question: string, answer: string): 'sent' | 'waiting' | null {
    return this.questions.answerOne(id, questionId, question, answer);
  }

  // statusLine のファイルが書き換わった（ターミナルモードの TUI の間だけ動く。stream-json では、行から作る）
  statusLineChanged(id: string, info: StatusLineInfo): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.statusLine = info;
    this.listeners.onStatusLine(id, info);
    // /clear で新しい会話になると、statusLine の会話ログのパスが変わる
    if (info.transcriptPath) rt.process?.followTranscript(info.transcriptPath);
  }

  // このセッションの Remote Control を使うかを変える。次に起動するときの指定を変える（動いている claude をつなぐ・切るのは、
  // 制御の要求 remote_control で行う）
  async setRemoteControl(id: string, on: boolean): Promise<string | null> {
    if (!this.remoteControlAvailable) return t('main.remote.unavailable');
    const record = this.store.get(id);
    if (!record) return t('main.session.notFound');
    this.store.update(id, { remoteControl: on });
    this.emitSessions();
    return null;
  }

  // このセッションで、最適化圧縮を自動で始めるか（チャットのヘッダーの「自動」のトグル）
  setAutoCompact(id: string, on: boolean): void {
    if (!this.store.get(id)) return;
    this.store.update(id, { autoCompact: on });
    this.emitSessions();
    this.changed(id);
  }

  remoteAvailable(): boolean {
    return this.remoteControlAvailable;
  }

  // Remote Control が今つながっているか。null: つながるのを待っている。Claude Code が動いていなければ false
  remoteConnectedOf(id: string): boolean | null {
    const rt = this.runtimes.get(id);
    return rt?.process ? rt.remoteConnected : false;
  }

  // このセッションで Remote Control を使うか（開発版では使わない）
  private wantsRemote(record: SessionRecord): boolean {
    return this.remoteControlAvailable && record.remoteControl !== false;
  }

  knowledge(id: string): SessionKnowledge {
    return this.runtimes.get(id)?.knowledge.current() ?? { files: {}, contextTokens: null };
  }

  // コンテキストの中身（見ているときだけ取りに来る。使用量が変わったら取り直す）。
  // 起動していないセッション（アーカイブ済みなど）は、会話ログから読む
  async context(id: string): Promise<SessionContext> {
    const rt = this.runtimes.get(id);
    if (rt) return rt.context.current();
    const record = this.store.get(id);
    return record ? readContext(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir), record.cwd) : { items: [] };
  }

  // 今の Claude Code の会話の ID（/clear で新しい会話になると変わる）。知らないセッションは null
  claudeSessionOf(id: string): string | null {
    return this.store.get(id)?.claudeSessionId ?? null;
  }

  // このセッションの Claude Code に、チェックリストの MCP サーバーを足して起動したか。動いていない・引き継いだもの（分からない）は null
  hasChecklistMcp(id: string): boolean | null {
    const rt = this.runtimes.get(id);
    return rt?.process ? rt.checklistMcp : null;
  }

  // 裏で動いているもの（最適化圧縮の再開の文で、新しい会話に伝える）
  runningTasks(id: string): CarriedTask[] {
    const rt = this.runtimes.get(id);
    if (!rt) return [];
    return [
      ...rt.bashTasks.all().filter((task) => task.state === 'running').map((task) => ({ kind: 'bash' as const, label: task.description ? `${task.command} (${task.description})` : task.command })),
      ...rt.subagents.all().filter((r) => r.background && r.state === 'running').map((r) => ({ kind: 'agent' as const, label: r.description ?? r.agentId ?? '' })),
      ...rt.workflows.all().filter((r) => r.status === 'running').map((r) => ({ kind: 'workflow' as const, label: r.name })),
    ];
  }

  bashTasks(id: string): BashTask[] {
    return this.runtimes.get(id)?.bashTasks.all() ?? [];
  }

  // 動いているバックグラウンドのもの（サブエージェント・ワークフロー・Bash）を止める。止められなかったら理由を返す
  async stopTask(id: string, _ref: TaskRef): Promise<string | null> {
    const rt = this.runtimes.get(id);
    if (!rt?.process) return t('main.task.notRunning');
    return t('main.task.failed');
  }

  // サブエージェント・ワークフローのエージェントの会話
  agentLog(id: string, ref: AgentLogRef): Promise<ChatEvent[]> {
    const rt = this.runtimes.get(id);
    const record = this.store.get(id);
    if (!rt || !record) return Promise.resolve([]);
    const file =
      ref.kind === 'subagent'
        ? rt.subagents.logFile(ref.toolUseId, join(this.sessionDir(id), 'subagents'))
        : rt.workflows.agentLogFile(ref.toolUseId, ref.agentId);
    return file ? readAgentLog(file, record.cwd) : Promise.resolve([]);
  }

  workflows(id: string): WorkflowRun[] {
    return this.runtimes.get(id)?.workflows.all() ?? [];
  }

  // Claude Code の画面から読んだもの。stream-json では画面を読まないので、いつも null
  screen(_id: string): ScreenInfo | null {
    return null;
  }

  // 作業中の進み具合（作業中でなければ null）
  progress(id: string): Activity | null {
    return this.runtimes.get(id)?.progress?.current(Date.now()) ?? null;
  }

  // 権限モードを切り替える（画面のモード欄・親の configure_session）。子セッションは、起動し直しても切り替えたモードで起動するよう、
  // 起動のモード（launchMode）も変える。Claude Code が動いていない子は、次に起動するときのモードだけを変える
  async setMode(id: string, mode: PermissionMode): Promise<boolean> {
    const rt = this.runtimes.get(id);
    const child = !!this.store.get(id)?.parentId;
    if (!rt?.process) {
      if (child) this.store.update(id, { launchMode: mode });
      return child;
    }
    return false;
  }

  async rewind(_id: string, _text: string): Promise<boolean> {
    return false;
  }

  // カードの選択肢を選ぶ（画面のメニュー）。stream-json では画面が無いので選べない
  async choose(_id: string, _choice: ScreenChoice): Promise<ChooseResult> {
    return 'gone';
  }

  async chooseIf(_id: string, _choice: ScreenChoice, _expect: (menu: Menu) => boolean): Promise<ChooseResult> {
    return 'gone';
  }

  addedFoldersOf(id: string): string[] {
    return this.store.get(id)?.addedFolders ?? [];
  }

  // ワークスペースに追加したフォルダを変える（確かめは呼ぶ側で済ませる）。エクスプローラーのために見張りも合わせる。
  // 動いている claude には、手が空いたときに --resume で起動し直して渡す（作業中・確認待ち・バックグラウンドのタスクがあるうちは止めない）
  setAddedFolders(id: string, folders: string[]): void {
    const record = this.store.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);
    const rt = this.runtimes.get(id);
    this.store.update(id, { addedFolders: folders, ...(rt?.process ? { addedFoldersPending: true } : {}) });
    if (rt && !record.archived) this.watchFolders(rt, folders);
    this.emitSessions();
    this.restartForFoldersIfIdle(id);
  }

  // 追加フォルダを渡すための起動し直しを待っていて、手が空いていれば起動し直す。
  // 状態の知らせの途中（会話ログの行を読んでいるところなど）で止めないよう、今の処理が終わってから確かめ直す
  private restartForFoldersIfIdle(id: string): void {
    if (!this.store.get(id)?.addedFoldersPending || this.stateOf(id) !== 'idle') return;
    setImmediate(() => {
      if (this.closed || !this.store.get(id)?.addedFoldersPending || this.stateOf(id) !== 'idle') return;
      // 登録した設定ファイルが読めないなどで起動し直せなければ、動いている claude はそのまま（次に手が空いたとき、また試す）
      this.restart(id).catch(() => {});
    });
  }

  configure(id: string, options: SessionOptions): Promise<void> {
    const record = this.store.get(id);
    const settingsFile = options.settingsFile ?? null;
    const settingsChanged = (record?.settingsFile ?? null) !== settingsFile;
    if (settingsChanged) this.checkSettingsFile(settingsFile);
    // 設定ファイルを変えたら、モデルとエフォートは新しい設定の既定に戻す（前の設定のモデルが、新しい設定で使えるとは限らない）
    const model = settingsChanged ? null : options.model;
    const effort = settingsChanged ? null : options.effort;
    this.store.update(id, { model, effort, settingsFile });
    if (this.runtimes.get(id)?.process) return this.restart(id);
    this.emitSessions();
    return Promise.resolve();
  }

  // 登録した設定ファイルを使えるか確かめる。使えなければ理由を添えて投げる
  private checkSettingsFile(settingsFile: string | null | undefined): void {
    if (!settingsFile) return;
    if (!this.settingsFiles) throw new Error(t('main.settingsFile.unavailable'));
    this.settingsFiles.check(settingsFile);
  }

  // 設定ファイルを選んでいるセッションの起動前に、アプリの設定と登録した設定を合わせたファイルを書く。選んでいなければ null
  // browser: アプリ内ブラウザの MCP サーバーを足すか（合わせる設定に、JavaScript の実行の確認のフックを入れる）
  // sessions: セッションの MCP サーバーを足すか（合わせる設定に、子セッションの起動の確認のフックを入れる）
  // checklist: チェックリストの MCP サーバーを足すか（合わせる設定に、チェックリストを使い続けさせるフックを入れる）
  // terminal: 人のターミナルの MCP サーバーを、打つツールごと足すか（合わせる設定に、打つ前の確認のフックを入れる）
  private prepareSettings(
    id: string,
    settingsFile: string | null | undefined,
    browser: boolean,
    sessions: boolean,
    checklist: boolean,
    terminal: boolean,
  ): PreparedSettings | null {
    if (!settingsFile) {
      // 標準の設定に戻した（または初めから標準）。前の設定ファイルで合わせたファイルが残っていれば消す
      this.settingsFiles?.release(id);
      return null;
    }
    if (!this.settingsFiles) throw new Error(t('main.settingsFile.unavailable'));
    return this.settingsFiles.prepare(id, settingsFile, browser, sessions, checklist, terminal);
  }

  // Claude Code を起動し直して同じ会話を続ける（--resume）。スキル・CLAUDE.md・設定・MCP などを読み込み直すため。
  // 前の Claude Code が終わったのを確かめてから起動する（同じ会話を 2 つのプロセスが書かないように）。
  // 権限モードは、今のモードを --permission-mode で渡す（bypassPermissions は引き継がない）
  async restart(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    const process = rt?.process;
    if (!rt || !process) {
      await this.open(id);
      return;
    }
    // 起動し直せないと分かっているのに、動いている claude を止めないよう、先に設定ファイルを確かめる
    this.checkSettingsFile(this.store.get(id)?.settingsFile);
    let mode = rt.knownMode;
    // 子セッションは、起動したときのモードより強くしない
    const launchMode = this.store.get(id)?.launchMode;
    if (launchMode && mode && !modeWithin(mode, launchMode)) mode = launchMode;
    await process.stop();
    // 止めている間に、ほかで起動し直した・アーカイブした
    if (this.runtimes.get(id) !== rt || rt.process) return;
    this.start(id, mode && mode !== 'bypassPermissions' ? mode : null);
  }

  // ターミナルモードの TUI に打つ（人が画面で打った文字）
  write(id: string, data: string): void {
    this.runtimes.get(id)?.process?.write(data);
  }

  // 発言を送る（stream-json の user の行 1 つ）。画像は image のブロックに、入力欄に貼り付けた長い文（札）は pasted_content に入れる
  // （CLI が TUI と同じ <pasted_content> の囲みに入れる。実測）。同じセッションへの送信は、送った順に届ける（画像を読む間に追い越さない）。
  // priority: later はターンが終わってから別のターンにする（親からの指示・知らせ・予約）。省くと、作業中なら今のターンに取り込まれる
  submit(id: string, rawText: string, attachments: string[] = [], pastes: string[] = [], priority?: 'later'): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt?.process) return Promise.resolve();
    const run = async () => {
      const process = rt.process;
      const client = process?.client;
      if (!process || !client) throw new Error(t('main.send.notRunning'));
      const text = stripControlChars(rawText);
      const kept = pastes.map(stripControlChars).filter((p) => p.trim());
      const images = await Promise.all(attachments.map(imageBlock));
      if (rt.process !== process) throw new Error(t('main.send.exited'));
      const content: string | ContentBlock[] =
        images.length === 0 ? text : [...images.filter((b): b is ContentBlock => !!b), ...(text ? [{ type: 'text' as const, text }] : [])];
      const uuid = randomUUID();
      // スラッシュコマンドは発言として残らないものが多いので、送信中に出さない
      if (!text.trimStart().startsWith('/')) {
        rt.unsent.set(uuid, { id: uuid, text, pastes: kept, images: images.filter(Boolean).length, state: 'sending', at: Date.now() });
        this.emitQueue(id, rt);
      }
      client.send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid, ...(kept.length > 0 ? { pasted_content: kept } : {}), ...(priority ? { priority } : {}) });
      this.changed(id);
      // 受け付けの知らせも会話ログの行も来ないまま残らないよう、時間を区切る
      setTimeout(() => {
        if (rt.unsent.get(uuid)?.state !== 'sending') return;
        rt.unsent.delete(uuid);
        this.emitQueue(id, rt);
        this.changed(id);
      }, SENDING_TIMEOUT_MS).unref?.();
    };
    const next = rt.sendChain.then(run, run);
    rt.sendChain = next.catch(() => {});
    return next;
  }

  // 起動が終わる（入力を受け付けられる）のを待ってから、ターンが終わってから届く発言（priority: later）として送る
  // （子セッションへの指示・親への知らせ・予約）。作業中に送っても、作業中のターンには入らない（Claude Code が順番待ちにする。実測）。
  // 待っている間も、ツールで返す状態は作業中にする。待ちきれない・終わったときは、理由を添えて失敗する。
  // attachments: 画像のパス・pastes: 入力欄の札（submit と同じ）/ signal: 待っている間に取りやめる（予約の取り消し）
  async submitWhenReady(
    id: string,
    text: string,
    timeoutMs: number,
    { attachments = [], pastes = [], signal }: { attachments?: string[]; pastes?: string[]; signal?: AbortSignal } = {},
  ): Promise<void> {
    const rt = this.runtimes.get(id);
    const process = rt?.process;
    if (!rt || !process) throw new Error(t('main.send.notRunning'));
    rt.pendingSubmits += 1;
    this.changed(id);
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (rt.process !== process) throw new Error(t('main.send.exited'));
        if (signal?.aborted) throw new Error(t('main.send.cancelled'));
        if (rt.ready && !rt.preparing) break;
        if (Date.now() > deadline) throw new Error(t('main.send.busy'));
        await sleep(100);
      }
      await this.submit(id, text, attachments, pastes, 'later');
    } finally {
      rt.pendingSubmits -= 1;
      this.changed(id);
    }
  }

  // 中断で入力欄に戻った親からの指示を消す。stream-json の中断では、発言は会話に残り、入力欄に戻らない（実測）ので、何もしない
  withdrawParentDraft(_id: string): Promise<void> {
    return Promise.resolve();
  }

  // 中断で入力欄に戻った、最適化圧縮の文が出ているか。stream-json では入力欄に戻らない
  compactDraftShown(_id: string): boolean {
    return false;
  }

  withdrawCompactDraft(_id: string): Promise<void> {
    return Promise.resolve();
  }

  // 作業を中断する（interrupt。応答待ち・ツールの実行中・許可の確認待ちのどれでも止まる。裏のタスクは止めない。実測）
  interrupt(id: string): void {
    const client = this.runtimes.get(id)?.process?.client;
    void client?.request('interrupt').catch(() => {});
  }

  resize(id: string, cols: number, rows: number): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.size = { cols, rows };
    rt.process?.resize(cols, rows);
  }

  // 前のアプリが起動して、アプリの再起動をまたいで動いている claude を引き継ぐ
  async adopt(): Promise<void> {
    for (const info of await this.host.list()) {
      const record = this.store.get(info.tag);
      if (info.exitCode !== null) {
        this.host.forget(info.id);
        continue;
      }
      if (info.kind !== 'pipe' || !record || record.archived || this.runtimes.get(record.id)?.process) {
        if (info.kind === 'pty') this.host.attach(info).kill();
        else this.host.attachPipe(info).kill('SIGTERM');
        continue;
      }
      this.start(record.id, null, info);
    }
  }

  // アプリの終了時。claude は止めずに見るのをやめる（次に起動したアプリが引き継ぐ）。stop: claude も止める
  closeAll(stop: boolean): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, rt] of this.runtimes) {
      if (stop) {
        rt.process?.kill();
        this.settingsFiles?.release(id);
      } else rt.process?.detach();
      rt.workflows.dispose();
      rt.subagents.dispose();
      rt.bashTasks.dispose();
      if (rt.progressTimer) clearInterval(rt.progressTimer);
      if (rt.turnEnding) clearTimeout(rt.turnEnding.timer);
    }
    this.watchers.closeAll();
    this.store.flush();
  }

  isFocused(id: string): boolean {
    return this.focusedId === id;
  }

  // stream-json の送受信の控えのファイル（userData/stream-logs/<セッション ID>.log）
  private streamLogFor(id: string): string {
    return join(dirname(this.statusLines.dir), 'stream-logs', `${id}.log`);
  }

  // 起動するときの権限モード。指定（新規セッションの画面・子の起動のモード・起動し直すときの今のモード）があればそれ。
  // 無ければ、前回分かっていたモード、それも無ければ設定の defaultMode、それも無ければ auto（決めたこと。設計書 15 節）。
  // bypassPermissions は引き継がない（起動し直しと同じ）
  private startMode(record: SessionRecord, requested: PermissionMode | null, settings: PreparedSettings | null): PermissionMode {
    if (requested) return requested;
    if (record.knownMode && record.knownMode !== 'bypassPermissions') return record.knownMode;
    const configured = appMode(settingsDefaultMode(record.cwd, settings?.settingsFile ?? null, this.claudeDir));
    if (configured && configured !== 'bypassPermissions') return configured;
    return 'auto';
  }

  // mode: --permission-mode で渡す権限モード（このセッションだけ）。null なら startMode で決める。
  // adopted: 起動せずに引き継ぐ、動いている claude
  private start(id: string, mode: PermissionMode | null = null, adopted: HostedPipeInfo | null = null): void {
    const record = this.store.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);

    // 設定ファイルを使えなければ、何も変えずにここで断る（標準の設定に黙って切り替わらないように）。
    // 引き継ぐ claude は、前のアプリが起動したままなので、書き直さない
    const browser = adopted ? null : this.browser();
    const launch = adopted ? null : this.sessionsMcp();
    const checklist = adopted ? null : this.checklistMcp();
    const walkthrough = adopted ? null : this.walkthroughMcp();
    const terminalLaunch = adopted ? null : this.terminalMcp();
    // 子セッションには、子を動かすツールを見せない（孫は作れない）。人のターミナルも、読むツールだけ（打てるのは、人が見ている親だけ）
    const sessions = launch && record.parentId ? { ...launch, child: true } : launch;
    const terminal: TerminalMcpLaunch | null = terminalLaunch && record.parentId ? { ...terminalLaunch, child: true } : terminalLaunch;
    const settings = adopted ? null : this.prepareSettings(id, record.settingsFile, !!browser, !!sessions, !!checklist, !!terminal && !terminal.child);
    const permissionMode = adopted ? null : this.startMode(record, mode, settings);

    // 会話が一度も無いセッションは --resume できないため、新しいセッション ID で始め直す
    const resume = !!adopted || hasConversation(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir));
    if (!resume) this.store.update(id, { claudeSessionId: randomUUID() });
    const claudeSessionId = this.store.get(id)!.claudeSessionId;

    let rt = this.runtimes.get(id);
    if (!rt) {
      const workflows = new WorkflowTracker((runs) => {
        this.listeners.onWorkflows(id, runs);
        this.countBackground(id);
      });
      const subagents = new SubagentTracker(record.cwd, (runs) => {
        this.listeners.onSubagents(id, runs);
        this.countBackground(id);
      });
      const bashTasks = new BashTaskTracker((tasks) => {
        this.listeners.onBashTasks(id, tasks);
        this.countBackground(id);
      });
      const tasks = new TaskRouter({
        workflows,
        subagents,
        bashTasks,
        screen: () => null,
        sessionDir: () => this.sessionDir(id),
        // 人がターミナルや Remote Control で答えたら、その質問を待っているフックを終わらせる
        questionAnswered: (questions) => {
          if (questions) this.questions.answeredElsewhere(id, questions);
        },
      });
      rt = {
        process: null,
        seq: 0,
        events: [],
        unread: false,
        workflows,
        subagents,
        bashTasks,
        tasks,
        knowledge: new KnowledgeTracker(
          record.cwd,
          (value) => this.listeners.onKnowledge(id, value),
          () => this.store.get(id)?.addedFolders ?? [],
        ),
        context: new ContextTracker(record.cwd),
        statusLine: null,
        chain: [],
        attention: null,
        background: 0,
        permission: null,
        requests: new Map(),
        init: null,
        ready: false,
        knownMode: null,
        size: DEFAULT_PTY_SIZE,
        aliveSince: null,
        turnOpen: false,
        lastAssistant: null,
        turnEnding: null,
        turnStarter: 'other',
        starterSeen: false,
        progress: null,
        progressTimer: null,
        unsent: new Map(),
        sendChain: Promise.resolve(),
        caughtUp: true,
        remoteConnected: false,
        historyLoaded: false,
        lastBridgeUrl: undefined,
        titleRequested: false,
        preparing: null,
        worktreeCreated: null,
        watched: null,
        watchedFolders: [],
        pendingSubmits: 0,
        checklistMcp: null,
        stderr: '',
      };
      this.runtimes.set(id, rt);
    }
    rt.checklistMcp = adopted ? null : !!checklist;
    // worktree は、Claude Code が作るまでフォルダが無い（作ったあとで見張る）
    this.watch(rt, record.cwd);
    this.watchFolders(rt, record.addedFolders ?? []);
    // 新しく起動する claude には、今の追加フォルダを --add-dir で渡す（引き継ぐ claude は前の引数のままなので、待ちを残す）
    if (!adopted && record.addedFoldersPending) this.store.update(id, { addedFoldersPending: false });
    rt.events = [];
    rt.chain = [];
    // 再開すると過去の会話を読み直すので、そこから集め直す
    rt.knowledge.reset();
    rt.context.reset();
    this.pushEvents(id, [{ type: 'process-start' }]);
    const runtime = rt;
    runtime.attention = null;
    runtime.ready = false;
    runtime.init = null;
    runtime.requests.clear();
    runtime.unsent.clear();
    // 引き継ぐ claude は、前のアプリが決めたモードのまま動いているので、記録から戻す（Claude Code が知らせたら、そちらにする）
    runtime.knownMode = adopted ? (record.knownMode ?? null) : permissionMode;
    if (!adopted) this.store.update(id, { knownMode: permissionMode });
    runtime.aliveSince = adopted?.startedAt ?? null;
    runtime.turnOpen = false;
    runtime.lastAssistant = null;
    if (runtime.turnEnding) clearTimeout(runtime.turnEnding.timer);
    runtime.turnEnding = null;
    runtime.starterSeen = false;
    runtime.titleRequested = false;
    runtime.caughtUp = !adopted;
    this.stopProgress(id, runtime);
    // Remote Control のつながりは、会話ログ（bridge-session）と bridge_state で分かる
    runtime.remoteConnected = false;
    // 読み直す会話ログが無ければ（新しい会話）、読み終わりの知らせは来ないので、はじめから読み終えたことにする
    runtime.historyLoaded = fileSize(transcriptPath(record.cwd, claudeSessionId, this.claudeDir)) === 0;
    runtime.lastBridgeUrl = undefined;

    // 新しい worktree で始めるときは、Claude Code が作り終えるまで準備中にする。
    // 前の起動が worktree を作ったあと、起動が終わる前に終わって（起動し直して）いたら、その「作成中」は戻す
    // （戻さないと、起動が終わっても受け付けない。node_modules の用意の途中なら、終わるまで待たせたまま）
    const creating = !!record.worktree && !resume && !adopted && !existsSync(record.cwd);
    if (creating) runtime.preparing = 'creating';
    else if (runtime.preparing === 'creating') runtime.preparing = null;

    const process: ClaudeSession = new ClaudeSession(
      this.host,
      {
        sessionId: id,
        kind: 'stream',
        cwd: record.cwd,
        worktree: record.worktree?.name ?? null,
        worktreeRoot: record.worktree?.root ?? null,
        claudeSessionId,
        resume,
        // stream-json は、起動したあとに remote_control の要求でつなぐ
        remoteControlName: null,
        model: record.model ?? null,
        effort: record.effort ?? null,
        permissionMode,
        settings,
        statusFile: this.statusLines.fileFor(id),
        askFile: this.statusLines.askFileFor(id),
        browser,
        sessions,
        checklist,
        walkthrough,
        terminal,
        claudeDir: this.claudeDir,
        // 追加したあとで消した・動かしたフォルダは渡さない（エクスプローラーには残し、人が外せるようにする）
        addDirs: (record.addedFolders ?? []).filter((folder) => existsSync(folder)),
        streamLog: this.streamLogFor(id),
        ...rt.size,
      },
      {
        onData: (data) => this.listeners.onPtyData(id, data),
        stream: {
          onMessage: (message, past) => {
            if (runtime.process === process) this.handleStream(id, runtime, message, past);
          },
          onPermission: (requestId, request) => {
            if (runtime.process === process) this.requestAdded(id, runtime, requestId, request);
          },
          onCancel: (requestId) => {
            if (runtime.process === process) this.requestRemoved(id, runtime, requestId);
          },
          onCaughtUp: () => {
            if (runtime.process !== process) return;
            runtime.caughtUp = true;
            this.historySettled(id, runtime, true);
          },
        },
        onExit: (exitCode, stderr) => {
          if (runtime.process !== process) return;
          runtime.process = null;
          runtime.stderr = stderr ?? '';
          runtime.ready = false;
          this.settingsFiles?.release(id);
          this.questions.releaseAll(id);
          this.releaseRequests(id, runtime);
          rt.workflows.stopRunning();
          rt.subagents.stopRunning();
          rt.bashTasks.stopRunning();
          if (runtime.turnEnding) this.flushTurnEnd(id, runtime);
          runtime.turnOpen = false;
          this.stopProgress(id, runtime);
          if (runtime.unsent.size > 0) {
            runtime.unsent.clear();
            this.emitQueue(id, runtime);
          }
          this.pushEvents(id, [{ type: 'process-exit', exitCode }]);
          this.emitSessions();
        },
        onEntry: (entry, isHistory) => this.handleEntry(id, entry, isHistory),
        // 再開時、応答のないまま終わった過去のターンを作業中として扱わない。
        // 引き継いだ claude がターンの途中なら、本当に作業中なのでそのままにする（前のアプリの頃の行を読み終えてから決める）
        onHistoryLoaded: () => {
          runtime.historyLoaded = true;
          this.historySettled(id, runtime, adopted !== null);
        },
        onSwitch: (nextClaudeSessionId) => {
          this.store.update(id, { claudeSessionId: nextClaudeSessionId });
          this.changed(id);
          rt.chain = [];
          rt.knowledge.reset();
          rt.context.reset();
          this.pushEvents(id, [this.compactClearing(id) ? { type: 'reset', compact: true } : { type: 'reset' }]);
        },
      },
      adopted,
    );
    rt.process = process;
    process.start();
    void this.initialize(id, runtime, process, adopted);
    if (creating) {
      // この起動が続いているか。終わった・起動し直した・アーカイブした（止めたときは、終了の知らせが来ない）ら、待つのをやめる
      const alive = () => runtime.process === process && this.runtimes.get(id) === runtime;
      const waiting: Promise<boolean> = waitForWorktree(record.cwd, alive).then((created) => {
        if (created && alive()) {
          this.watch(runtime, record.cwd);
          // .git ができた時点では、git worktree add がまだファイルを書き出している（大きなリポジトリでは、git ls-files が空になる。実測）。
          // Claude Code は worktree を作り終えてから initialize に答えるので、それを待ってから node_modules を用意する
          void this.untilInitialized(runtime, alive).then((ready) => {
            if (ready) void this.prepareWorktree(id, 'created');
          });
        } else if (runtime.worktreeCreated === waiting && runtime.preparing === 'creating') {
          // 作っている途中に起動し直していたら、「作成中」は新しい起動のもの（消さない）
          runtime.preparing = null;
        }
        return created;
      });
      runtime.worktreeCreated = waiting;
    }
    this.emitSessions();
  }

  // 起動の直後に 1 回だけ initialize を送る。perTaskStopAffordance: 中断で裏のタスクまで止めない（TUI の Esc と同じ。実測）。
  // フックと MCP は initialize では渡さず、--settings・--mcp-config で渡す（ターミナルモードで開き直しても同じ設定にするため）。
  // 引き継いだ claude にも送り直す（コマンド・モデルの一覧を受け取るため）。返事のあと、形の違う設定ファイル（-p は黙って無視する）を確かめる
  private async initialize(id: string, rt: Runtime, process: ClaudeSession, adopted: HostedPipeInfo | null): Promise<void> {
    const client = process.client;
    if (!client) return;
    let init: InitializeResponse | null = null;
    try {
      init = await client.request<InitializeResponse>('initialize', { perTaskStopAffordance: true });
    } catch (error) {
      // 引き継いだ claude は、前のアプリが済ませている。新しい claude が答えなければ、終わりの知らせ（理由は標準エラー）を待つ
      if (!adopted) {
        console.error('initialize に答えがありませんでした', error);
        return;
      }
    }
    if (rt.process !== process) return;
    rt.init = init;
    if (init?.current_permission_mode) this.noteMode(id, rt, appMode(init.current_permission_mode));
    const settings = await client.request<SettingsResponse>('get_settings').catch(() => null);
    if (rt.process !== process) return;
    if (settings?.errors?.length) {
      // 形の違う設定ファイルは、Claude Code が黙って丸ごと無視する。登録した設定を黙って標準に切り替えないよう、止めて理由を出す
      const details = settings.errors.map((e) => describeSettingsError(e)).join('\n');
      this.pushEvents(id, [{ type: 'info', id: `settings-error:${Date.now()}`, text: t('main.settingsFile.rejected', { details }) }]);
      void process.stop();
      return;
    }
    this.updateStatus(id, rt, { effort: settings?.applied?.effort ?? null });
    // auto を使えないモデルなら、manual に戻す（決めたこと。設計書 15 節）
    if (rt.knownMode === 'auto' && init && !autoAvailable(init, rt.statusLine?.model?.id ?? null)) {
      await client.request('set_permission_mode', { mode: streamMode('manual') }).catch(() => {});
      this.noteMode(id, rt, 'manual');
    }
    if (!rt.preparing && !rt.ready) {
      rt.ready = true;
      this.pushEvents(id, [{ type: 'ready' }]);
    }
    this.emitSessions();
  }

  // initialize の返事が来るまで待つ。その前に終わった・起動し直した・アーカイブしたら（alive が false）false
  private async untilInitialized(rt: Runtime, alive: () => boolean): Promise<boolean> {
    for (;;) {
      if (!alive()) return false;
      if (rt.init || rt.ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // 見張る追加フォルダを folders に合わせる（増えたものを見張り、外したものをやめる）
  private watchFolders(rt: Runtime, folders: string[]): void {
    for (const folder of folders) if (!rt.watchedFolders.includes(folder)) this.watchers.retain(folder);
    for (const folder of rt.watchedFolders) if (!folders.includes(folder)) this.watchers.release(folder);
    rt.watchedFolders = [...folders];
  }

  // ファイルの変更を見張る（フォルダがあれば。同じセッションでは一度だけ）
  private watch(rt: Runtime, cwd: string): void {
    if (rt.watched || !existsSync(cwd)) return;
    this.watchers.retain(cwd);
    rt.watched = cwd;
  }

  // worktree に node_modules を用意する。終わるまで ready を配信しない（最初の指示は、準備が終わってから送られる）
  private async prepareWorktree(id: string, how: 'created' | 'restored'): Promise<void> {
    const record = this.store.get(id);
    const rt = this.runtimes.get(id);
    if (!record?.worktree || !rt) return;
    const { root, name, branch } = record.worktree;
    // 起動した Claude Code が先に起動を終えても、準備が終わるまで待たせる（await より前に決める）
    rt.preparing = 'copying';
    this.emitSessions();
    const step = (preparing: WorktreePreparing) => {
      if (this.runtimes.get(id) !== rt) return;
      rt.preparing = preparing;
      this.emitSessions();
    };
    const result = await prepareNodeModules(root, record.cwd, {
      onStep: step,
      install: (cwd, dir, command) => this.runTask(id, cwd, command, dir ? t('main.worktree.commandAt', { command, dir }) : command),
    }).catch((error: unknown): NodeModulesResult => {
      console.error('node_modules を用意できませんでした', error);
      return { cloned: [], failed: [], installs: [] };
    });
    if (this.runtimes.get(id) !== rt) return;
    rt.preparing = null;
    const notes = [t(how === 'created' ? 'main.worktree.started' : 'main.worktree.restored', { name, branch }), ...nodeModulesNotes(result)];
    this.pushEvents(id, [{ type: 'info', id: `worktree:${Date.now()}`, text: sentences(notes) }]);
    // 準備の間に起動を終えていたら、ここで受け付けられるようになったことにする
    if (!rt.ready && rt.init && rt.process) {
      rt.ready = true;
      this.pushEvents(id, [{ type: 'ready' }]);
    }
    this.emitSessions();
  }

  // 会話ログを読み終え、引き継いだ claude なら前のアプリの頃の行も読み終えたら、過去の会話の終わりを決める
  private historySettled(id: string, rt: Runtime, adopted: boolean): void {
    if (!rt.historyLoaded || !rt.caughtUp) return;
    if (!rt.turnOpen) this.pushEvents(id, [{ type: 'turn-end' }]);
    // 引き継いだ claude は、最後の bridge-session 行のつながりのまま動いている
    // （以前つないでいた会話を再開すると、フラグが無くてもつなぎ直すため）
    if (adopted && rt.lastBridgeUrl !== undefined) {
      rt.remoteConnected = rt.lastBridgeUrl !== null;
      this.pushEvents(id, [{ type: 'remote-control', url: rt.lastBridgeUrl }]);
    }
  }

  // stream-json の出力の 1 行（制御の要求と返事は StreamClient が受け持つ）。past: 引き継いだときの、前のアプリの頃の行
  // （状態だけを組み立て直し、通知やチャットの知らせは出さない）。状態は行の種類だけで決め、順番を仮定しない（設計書 6・7 節）
  private handleStream(id: string, rt: Runtime, message: StreamMessage, past: boolean): void {
    switch (message.type) {
      case 'system':
        this.handleSystem(id, rt, message, past);
        return;
      case 'assistant':
        this.handleAssistant(id, rt, message as AssistantMessage, past);
        return;
      case 'user': {
        const user = message as UserMessage;
        // スマホ・claude.ai から届いた発言（Remote Control）は、それでターンが始まる
        if (user.isReplay && user.origin?.kind === 'human' && !user.parent_tool_use_id) this.openTurn(id, rt, past);
        return;
      }
      case 'result':
        this.closeTurn(id, rt, message as ResultMessage, past);
        return;
      case 'command_lifecycle':
        this.handleLifecycle(id, rt, message as CommandLifecycleMessage, past);
        return;
      case 'stream_event':
        if (message.parent_tool_use_id || past) return;
        this.openTurn(id, rt, past);
        if (rt.progress?.streamEvent(message)) this.emitProgress(id, rt);
        return;
      case 'tool_progress':
        if (message.parent_tool_use_id || past) return;
        if (rt.progress?.tool()) this.emitProgress(id, rt);
        return;
      case 'rate_limit_event': {
        const rateLimits = rateLimitsOf(message);
        if (rateLimits) this.updateStatus(id, rt, { rateLimits });
        return;
      }
      case 'conversation_reset':
        // 新しい会話の ID は、このあとの system/init の session_id（new_conversation_id とは別。実測）
        return;
    }
  }

  private handleSystem(id: string, rt: Runtime, message: Extract<StreamMessage, { type: 'system' }>, past: boolean): void {
    switch (message.subtype) {
      case 'init': {
        const init = message as Extract<StreamMessage, { subtype: 'init' }>;
        this.noteMode(id, rt, appMode(init.permissionMode));
        this.updateStatus(id, rt, { model: init.model, version: init.claude_code_version, ...(init.effort ? { effort: init.effort } : {}) });
        // /clear のあとの新しい会話（init の session_id が変わる）。会話ログを乗り換える
        const record = this.store.get(id);
        if (record && init.session_id && init.session_id !== record.claudeSessionId) {
          rt.process?.followTranscript(transcriptPath(record.cwd, init.session_id, this.claudeDir));
        }
        return;
      }
      case 'status': {
        const mode = (message as Extract<StreamMessage, { subtype: 'status' }>).permissionMode;
        if (mode) this.noteMode(id, rt, appMode(mode));
        return;
      }
      case 'api_retry': {
        if (past) return;
        const retry = message as Extract<StreamMessage, { subtype: 'api_retry' }>;
        const text = t('chat.transcript.apiErrorRetrying', { message: retry.error_status ? `${retry.error} (${retry.error_status})` : retry.error, attempt: retry.attempt, max: retry.max_retries });
        this.pushEvents(id, [{ type: 'api-error', id: retry.uuid, text, retrying: true }]);
        return;
      }
    }
  }

  private handleAssistant(id: string, rt: Runtime, message: AssistantMessage, past: boolean): void {
    // サブエージェントの行は、モデル・コンテキスト・進み具合に使わない
    if (message.parent_tool_use_id) return;
    this.openTurn(id, rt, past);
    rt.lastAssistant = message.uuid;
    const usage = message.message.usage;
    const tokens = usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : 0;
    const size = rt.statusLine?.context?.size ?? null;
    this.updateStatus(id, rt, {
      ...(message.message.model && message.message.model !== '<synthetic>' ? { model: message.message.model } : {}),
      ...(tokens > 0 && size ? { context: { size, tokens, usedPercent: Math.round((tokens / size) * 100) } } : {}),
    });
  }

  // 送った発言の受け付けの知らせ。queued: 順番待ちに入った / started: ターンに取り込まれた / completed・cancelled・discarded: 終わった
  private handleLifecycle(id: string, rt: Runtime, message: CommandLifecycleMessage, past: boolean): void {
    if (message.state === 'started') this.openTurn(id, rt, past);
    const unsent = rt.unsent.get(message.command_uuid);
    if (!unsent) return;
    if (message.state === 'queued' && unsent.state === 'sending') {
      unsent.state = 'queued';
      this.emitQueue(id, rt);
    } else if (message.state === 'cancelled' || message.state === 'discarded' || message.state === 'completed') {
      rt.unsent.delete(message.command_uuid);
      this.emitQueue(id, rt);
    }
    this.changed(id);
  }

  // ターンが始まった。前のターンの終わりをまだ出していなければ、先に出す
  private openTurn(id: string, rt: Runtime, past: boolean): void {
    if (rt.turnOpen) return;
    if (rt.turnEnding) this.flushTurnEnd(id, rt);
    rt.turnOpen = true;
    rt.lastAssistant = null;
    rt.starterSeen = false;
    if (!past) this.startProgress(id, rt);
    this.emitSessions();
    this.changed(id);
  }

  // ターンが終わった（result）。チャットへのターンの終わりは、そのターンの最後の応答が会話ログに出てから出す（時間切れ付き）
  private closeTurn(id: string, rt: Runtime, result: ResultMessage, past: boolean): void {
    const open = rt.turnOpen;
    rt.turnOpen = false;
    this.stopProgress(id, rt);
    // 開いていないターンの result（重ねて届いた知らせなど）では、ターンの終わりも完了の知らせも出さない
    if (past || !open) return;
    if (rt.turnEnding) this.flushTurnEnd(id, rt);
    const interrupted = typeof result.terminal_reason === 'string' && result.terminal_reason.startsWith('aborted');
    const waitFor = rt.lastAssistant && !rt.chain.some((c) => c.uuid === rt.lastAssistant) ? rt.lastAssistant : null;
    rt.turnEnding = { interrupted, waitFor, timer: setTimeout(() => this.flushTurnEnd(id, rt), TURN_END_WAIT_MS) };
    if (result.total_cost_usd !== undefined) this.updateStatus(id, rt, { costUsd: result.total_cost_usd });
    if (!waitFor) this.flushTurnEnd(id, rt);
    this.emitSessions();
    this.changed(id);
    void this.refreshContext(id, rt);
  }

  // チャットにターンの終わりを出し、完了を知らせる
  private flushTurnEnd(id: string, rt: Runtime): void {
    const ending = rt.turnEnding;
    if (!ending) return;
    clearTimeout(ending.timer);
    rt.turnEnding = null;
    this.pushEvents(id, [ending.interrupted ? { type: 'turn-end', interrupted: true } : { type: 'turn-end' }]);
    this.turnCompleted(id, rt);
    this.requestTitle(id, rt);
  }

  // ターンが終わったときの未読と通知
  private turnCompleted(id: string, rt: Runtime): void {
    if (!this.isFocused(id)) rt.unread = true;
    const summary = this.summary(id);
    // 通知を出さないとき（下の、バックグラウンドのタスクが動いているあいだなど）も聞く。流れの途中で出さなかったことを、覚えさせる
    const notice = this.turnNotice(id, rt.turnStarter);
    rt.turnStarter = 'other';
    // バックグラウンドのタスクが動いているあいだは、まだ完了ではない（一覧も「完了待ち」）。
    // タスクが終わると Claude Code が続きを始めるので、通知はそのターンの終わりに出す。
    // ブラウザでの操作を頼んでいるあいだも同じ（2 分を過ぎると Claude Code が呼び出しをバックグラウンドに移し、Claude はターンを終えて返事を待つ）。
    // ただし Claude が報告を預けていれば、タスクが動いていても出す（タスクを残したまま、作業を終えたと報告している）
    if (notice && summary && summary.attention !== 'browser' && (summary.backgroundTasks === 0 || this.turnReported(id))) this.listeners.onTurnCompleted(summary, notice);
    this.emitSessions();
  }

  // 会話のタイトルを作らせる（-p は自動では作らないため。実測）。会話ログにまだタイトル（ai-title・custom-title）が無く、人が名前を
  // 付けていないセッションで、この起動の最初のターンが終わったあとに 1 回だけ。失敗は黙って捨てる（一覧は最初の発言のまま）
  private requestTitle(id: string, rt: Runtime): void {
    const record = this.store.get(id);
    const client = rt.process?.client;
    if (rt.titleRequested || !record || !client) return;
    rt.titleRequested = true;
    if (record.titlePriority > FIRST_PROMPT_TITLE_PRIORITY || !record.title) return;
    void generateTitle(client, record.title).catch(() => null);
  }

  // ターンの終わりに、コンテキストの使用量を聞き直す
  private async refreshContext(id: string, rt: Runtime): Promise<void> {
    const process = rt.process;
    const usage = await process?.client?.request<ContextUsageResponse>('get_context_usage').catch(() => null);
    if (!usage || rt.process !== process || typeof usage.maxTokens !== 'number') return;
    this.updateStatus(id, rt, { context: { size: usage.maxTokens, tokens: usage.totalTokens, usedPercent: usage.percentage } });
  }

  // モデル・エフォート・コンテキスト・利用枠を変えて、画面に知らせる（ターミナルモードの間の statusLine と同じ形）
  private updateStatus(
    id: string,
    rt: Runtime,
    patch: { model?: string; effort?: string | null; version?: string; context?: StatusLineInfo['context']; rateLimits?: StatusLineInfo['rateLimits']; costUsd?: number },
  ): void {
    const before = rt.statusLine;
    const record = this.store.get(id);
    const modelId = patch.model ?? before?.model?.id ?? null;
    const next: StatusLineInfo = {
      model: modelId ? { id: modelId, name: modelName(modelId) ?? modelId } : null,
      effort: record?.effort ?? (patch.effort !== undefined ? patch.effort : (before?.effort ?? null)),
      version: patch.version ?? before?.version ?? null,
      context: patch.context ?? before?.context ?? null,
      // 値が無いときに空で上書きしない
      rateLimits: patch.rateLimits ?? before?.rateLimits ?? null,
      costUsd: patch.costUsd ?? before?.costUsd ?? null,
      transcriptPath: null,
      updatedAt: Date.now(),
    };
    rt.statusLine = next;
    this.listeners.onStatusLine(id, next);
  }

  // 分かっている権限モードを変える（Claude Code が知らせたモード）
  private noteMode(id: string, rt: Runtime, mode: PermissionMode | null): void {
    if (!mode || mode === rt.knownMode) return;
    rt.knownMode = mode;
    this.store.update(id, { knownMode: mode });
    this.emitSessions();
  }

  private startProgress(id: string, rt: Runtime): void {
    this.stopProgress(id, rt);
    rt.progress = new Progress(Date.now());
    rt.progressTimer = setInterval(() => this.emitProgress(id, rt), PROGRESS_TICK_MS);
    rt.progressTimer.unref?.();
    this.emitProgress(id, rt);
  }

  private stopProgress(id: string, rt: Runtime): void {
    if (rt.progressTimer) clearInterval(rt.progressTimer);
    rt.progressTimer = null;
    if (!rt.progress) return;
    rt.progress = null;
    this.listeners.onProgress(id, null);
  }

  private emitProgress(id: string, rt: Runtime): void {
    if (rt.progress) this.listeners.onProgress(id, rt.progress.current(Date.now()));
  }

  // 送ったが、まだ会話に出ていない発言を、チャットに知らせる
  private emitQueue(id: string, rt: Runtime): void {
    this.pushEvents(id, [{ type: 'queue', prompts: [...rt.unsent.values()].map(({ at: _, ...prompt }) => prompt) }]);
  }

  // Claude Code が答えを待つ要求が来た（許可の確認・質問・プランの承認・ワークフローの確認）
  private requestAdded(id: string, rt: Runtime, requestId: string, request: CanUseToolRequest): void {
    rt.requests.set(requestId, request);
    this.updateAttention(id, rt);
  }

  // 待っていた要求が無くなった（答えた・Claude Code が取り下げた）
  private requestRemoved(id: string, rt: Runtime, requestId: string): void {
    if (!rt.requests.delete(requestId)) return;
    this.updateAttention(id, rt);
  }

  // 待っている要求をすべて捨てる（Claude Code が終わった・アーカイブした）
  private releaseRequests(id: string, rt: Runtime): void {
    if (rt.requests.size === 0) return;
    rt.requests.clear();
    this.updateAttention(id, rt);
  }

  // 操作待ちの種類を、待っている要求と、フックが答えを待っている質問から決める。操作待ちでなかったところから変わったら、通知する
  private updateAttention(id: string, rt: Runtime): void {
    const request = firstRequest(rt);
    const pending = this.questions.first(id);
    const attention: SessionAttention = request ? (request.tool_name === 'AskUserQuestion' ? 'question' : 'permission') : pending ? 'question' : null;
    if (attention === rt.attention) {
      this.emitSessions();
      this.changed(id);
      return;
    }
    const before = rt.attention;
    rt.attention = attention;
    this.emitSessions();
    this.changed(id);
    const summary = this.summary(id);
    if (!summary || !rt.process || before !== null || attention === null) return;
    if (request) this.listeners.onAttention(summary, { kind: 'menu', menu: requestMenu(request) });
    else if (pending) this.listeners.onAttention(summary, { kind: 'menu', menu: pendingMenu(pending) });
  }

  // フックが答えを待っている質問が増えた・減った・親が 1 問答えた
  private questionsChanged(id: string): void {
    this.listeners.onQuestion?.(id, this.questions.first(id));
    const rt = this.runtimes.get(id);
    if (rt) this.updateAttention(id, rt);
    else {
      this.emitSessions();
      this.changed(id);
    }
  }

  // 巻き戻しで会話が枝分かれしたら、親より後に表示していたものを捨てて、親の時点の表示に戻す
  private followBranch(id: string, rt: Runtime, entry: TranscriptEntry, isHistory: boolean): void {
    if (!entry.uuid || entry.isSidechain) return;
    const cut = branchCut(rt.chain, entry);
    if (cut) {
      const kept = rt.events.slice(0, cut.eventCut);
      rt.chain = rt.chain.slice(0, cut.chainCut);
      rt.events = kept;
      // replace は events に残さない（kept がそのまま置き換え後の状態）。通し番号だけ進める
      const fromSeq = rt.seq;
      rt.seq += 1;
      this.listeners.onChat({ sessionId: id, fromSeq, events: [{ type: 'replace', events: kept }], live: !isHistory });
    }
    rt.chain.push({ uuid: entry.uuid, type: entry.type, eventStart: rt.events.length });
  }

  // 今の会話ログのセッションのフォルダ（subagents/・workflows/ がある）
  private sessionDir(id: string): string {
    const record = this.store.get(id)!;
    return join(dirname(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir)), record.claudeSessionId);
  }

  // バックグラウンドタスクの数が変わったら、一覧の表示を更新する
  private countBackground(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const count =
      rt.subagents.all().filter((r) => r.background && r.state === 'running').length +
      rt.workflows.all().filter((r) => r.status === 'running').length +
      rt.bashTasks.all().filter((t) => t.state === 'running').length;
    if (count === rt.background) return;
    rt.background = count;
    this.emitSessions();
    this.changed(id);
  }

  private handleEntry(id: string, entry: unknown, isHistory: boolean): void {
    if (!isTranscriptEntry(entry)) return;
    const record = this.store.get(id);
    if (!record) return;

    let changed = false;
    const title = transcriptTitle(entry);
    // 優先度が高いものは常に採用。同じ優先度なら custom / ai タイトルは最新を、最初の発言は最初のものを使う
    const replaces =
      title &&
      title.title !== record.title &&
      (title.priority > record.titlePriority || (title.priority === record.titlePriority && title.priority > 1));
    if (title && replaces) {
      this.store.update(id, { title: title.title, titlePriority: title.priority });
      changed = true;
    }

    const rt = this.runtimes.get(id);
    // 引き継いだ claude が起動してから書いた行は、読み直した履歴でも今動いているもの（バックグラウンドのタスクや質問を追う）
    const past = isHistory && !(rt?.aliveSince && entryTime(entry) >= rt.aliveSince);
    rt?.tasks.track(entry, past, isHistory);
    if (rt && !past) this.noteMode(id, rt, permissionModeOf(entry));
    rt?.knowledge.handle(entry);
    rt?.context.handle(entry);

    if (rt) this.followBranch(id, rt, entry, isHistory);
    // Remote Control の URL は起動ごとに変わる。前に起動した claude の URL（読み直した過去の行）は出さない
    let events = toChatEvents(entry, record.cwd, false, rememberImage).filter((e) => !(past && e.type === 'remote-control'));
    // 今の claude のターンの終わりは、stream-json の result で決める（-p は turn_duration を書かない。ほかの行の終わりと二重にしない）
    if (rt && !isHistory) events = events.filter((e) => e.type !== 'turn-end');
    if (rt && isHistory) {
      const bridge = bridgeUrlOf(entry);
      if (bridge !== undefined) rt.lastBridgeUrl = bridge;
    }
    if (rt && !past) {
      const remote = [...events].reverse().find((e) => e.type === 'remote-control');
      if (remote) rt.remoteConnected = remote.url !== null;
      const starter = events.find((e) => e.type === 'user' || e.type === 'notice' || e.type === 'turn-start');
      if (starter) {
        // ターンを始めたもの。人の発言と、最適化圧縮の文（仕上げの頼み・再開の文）は、いつもターンの始まり。
        // ほかの知らせは、開いているターンの途中に届くことがあるので、まだ決めていないときだけ見る
        const compact = starter.type === 'notice' && !!starter.compact;
        if (!rt.starterSeen || starter.type === 'user' || compact) rt.turnStarter = turnStarterOf(starter);
        rt.starterSeen = true;
      }
      // 送った発言が会話に出たら、送信中の表示から外す（発言の行、作業中に送ったものは queued_command の attachment）
      const arrived = sentUuidOf(entry);
      if (arrived && rt.unsent.delete(arrived)) {
        this.emitQueue(id, rt);
        this.changed(id);
      }
    }
    if (events.length > 0) {
      const active = !isHistory && events.some((e) => e.type === 'user' || e.type === 'assistant-text' || e.type === 'tool-use');
      this.pushEvents(id, events, !isHistory);
      if (active) {
        // 一覧は更新の新しい順。すでに先頭なら並びは変わらないので、行ごとに一覧を送り直さない
        const wasFirst = this.list()[0]?.id === id;
        this.store.update(id, { updatedAt: Date.now() });
        if (!wasFirst) changed = true;
      }
    }
    // ターンの最後の応答が会話ログに出たら、待っていたターンの終わりを出す
    if (rt?.turnEnding && entry.uuid && rt.turnEnding.waitFor === entry.uuid) this.flushTurnEnd(id, rt);
    if (changed) this.emitSessions();
  }

  private pushEvents(id: string, events: ChatEvent[], live = true): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const fromSeq = rt.seq;
    rt.seq += events.length;
    rt.events.push(...events);
    this.listeners.onChat({ sessionId: id, fromSeq, events, live });
    this.changed(id);
  }

  private emitSessions(): void {
    const sessions = this.list();
    this.shownStates.clear();
    for (const s of sessions) this.shownStates.set(s.id, s.state);
    this.listeners.onSessionsChanged(sessions);
  }
}

// いちばん前の、Claude Code が答えを待っている要求
function firstRequest(rt: Runtime): CanUseToolRequest | null {
  return rt.requests.values().next().value ?? null;
}

// 送った発言のうち、まだ Claude Code に受け付けられていないものがあるか
function sending(rt: Runtime): boolean {
  for (const prompt of rt.unsent.values()) if (prompt.state === 'sending') return true;
  return false;
}

// 会話ログの行が、アプリが送った発言のものなら、その uuid（発言の行・作業中に送った発言の queued_command の attachment）
function sentUuidOf(entry: TranscriptEntry): string | null {
  if (entry.isSidechain) return null;
  if (entry.type === 'user' && entry.uuid) return entry.uuid;
  const source = entry.type === 'attachment' ? entry.attachment?.source_uuid : undefined;
  return typeof source === 'string' ? source : null;
}

// 添えた画像のファイルを、発言の image のブロックにする。読めなければ null（送らない）
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
async function imageBlock(path: string): Promise<ContentBlock | null> {
  const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!mediaType) return null;
  const data = await readFile(path).catch(() => null);
  return data ? { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } } : null;
}

// 形の違う設定ファイルの理由（get_settings の errors の 1 つ）
function describeSettingsError(error: unknown): string {
  const e = error as { file?: unknown; path?: unknown; message?: unknown } | null;
  return [e?.file, e?.path, e?.message].filter((v): v is string => typeof v === 'string' && v !== '').join(': ');
}

// 今のモデルで auto を使えるか（initialize の models の supportsAutoMode。分からなければ使えるものとする）
function autoAvailable(init: InitializeResponse, modelId: string | null): boolean {
  const model = init.models.find((m) => m.value === 'default') ?? init.models.find((m) => m.resolvedModel === modelId);
  return model?.supportsAutoMode !== false;
}

// 会話ログの権限モードの名前（Claude Code の名前。manual は default）
const TRANSCRIPT_MODES = new Map<string, PermissionMode>([
  ['default', 'manual'],
  ['acceptEdits', 'acceptEdits'],
  ['plan', 'plan'],
  ['auto', 'auto'],
  ['bypassPermissions', 'bypassPermissions'],
]);

// Claude Code が会話ログに書いた、その時点の権限モード（user 行・permission-mode 行）。書いていなければ null。
// サブエージェントの行（sidechain）は読まない（エージェントの定義で、本体と別のモードで動くことがある）。
// 知らない名前（dontAsk など）は、許す操作の多さが分からないので manual にする
function permissionModeOf(entry: TranscriptEntry): PermissionMode | null {
  if (entry.isSidechain || (entry.type !== 'user' && entry.type !== 'permission-mode')) return null;
  if (typeof entry.permissionMode !== 'string' || !entry.permissionMode) return null;
  return TRANSCRIPT_MODES.get(entry.permissionMode) ?? 'manual';
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

// 文をつないで 1 つの知らせにする。2 文以上なら、最後にも文の終わりの記号を付ける（日本語は付けない・英語はピリオド）
function sentences(notes: string[]): string {
  const text = notes.join(t('main.format.sentenceSeparator'));
  return notes.length > 1 ? text + t('main.format.sentenceEnd') : text;
}

// node_modules の用意の結果の知らせ（チャットに出す。1 つずつの文）。場所は worktree からの相対（'' はいちばん上）
function nodeModulesNotes(result: NodeModulesResult): string[] {
  const separator = t('main.format.shortListSeparator');
  const where = (dirs: string[]) => dirs.map((dir) => (dir ? `${dir}/node_modules` : 'node_modules')).join(separator);
  const notes: string[] = [];
  if (result.cloned.length > 0) notes.push(t('main.worktree.cloned', { paths: where(result.cloned) }));
  if (result.failed.length > 0) notes.push(t('main.worktree.cloneFailed', { paths: where(result.failed) }));
  const at = (dir: string) => dir || t('main.worktree.topDir');
  const ok = result.installs.filter((i) => i.exitCode === 0);
  const failed = result.installs.filter((i) => i.exitCode !== 0);
  if (ok.length > 0) {
    notes.push(t('main.worktree.installed', { commands: ok.map((i) => t('main.worktree.commandAt', { command: i.command, dir: at(i.dir) })).join(separator) }));
  }
  if (failed.length > 0) {
    const commands = failed.map((i) => t('main.worktree.commandFailedAt', { command: i.command, dir: at(i.dir), code: i.exitCode })).join(separator);
    notes.push(t('main.worktree.installFailed', { commands }));
  }
  return notes;
}

// ターミナルに出さずにコマンドを実行する（RunTask の既定。互換性の確認など）
function runQuietly(_owner: string, cwd: string, command: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd }, (err) => resolve(err ? (typeof err.code === 'number' ? err.code : 1) : 0));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 動いている Claude Code の状態の文言（セッション一覧の文言にそろえる）
function stateLabel(rt: Runtime, browserAsk: boolean): string {
  if (rt.attention === 'question') return t('main.state.question');
  if (rt.attention === 'permission') return t('main.state.permission');
  if (browserAsk) return t('main.state.browser');
  if (!rt.ready) return t('main.state.starting');
  const count = rt.background;
  if (rt.turnOpen) return count > 0 ? t('main.state.workingWithBackground', { count }) : t('main.state.working');
  if (count > 0) return t('main.state.waitingBackground', { count });
  return t('main.state.idle');
}

function entryTime(entry: TranscriptEntry): number {
  return entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0;
}

// 発言の行があるか。会話ログは 100MB を超えることもあるので、先頭から少しずつ読み、見つかったらやめる
function hasConversation(file: string): boolean {
  const MARK = '"type":"user"';
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const chunk = Buffer.alloc(256 * 1024);
    let position = 0;
    let tail = '';
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) return false;
      position += bytesRead;
      // 区切りをまたいだ目印も見つけられるよう、前の読みの末尾をつなげる（目印は ASCII なので、文字化けした端は影響しない）
      const text = tail + chunk.subarray(0, bytesRead).toString('latin1');
      if (text.includes(MARK)) return true;
      tail = text.slice(-MARK.length);
    }
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// 待っている要求の通知に使うメニュー（通知の本文は、許可ならツールの説明、質問なら質問文）
function requestMenu(request: CanUseToolRequest): Menu {
  if (request.tool_name === 'AskUserQuestion') {
    const questions = askQuestionsOf(request.input);
    return { kind: 'question', tabs: [], title: questions?.[0]?.question ?? '', context: [], options: [], multiSelect: false, hint: '' };
  }
  const command = typeof request.input.command === 'string' ? request.input.command : null;
  const detail = [request.description ?? request.title ?? request.display_name ?? request.tool_name, command].filter((v): v is string => !!v);
  return { kind: 'permission', tabs: [], title: request.title ?? request.tool_name, context: detail, options: [], multiSelect: false, hint: '' };
}

// フックが答えを待っている質問の通知に使うメニュー（通知の本文は質問文）
function pendingMenu(pending: PendingQuestion): Menu {
  return { kind: 'question', tabs: [], title: pending.questions[0]?.question ?? '', context: [], options: [], multiSelect: false, hint: '' };
}
