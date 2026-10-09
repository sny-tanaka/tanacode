import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { bridgeUrlOf, isHumanPrompt, isTranscriptEntry, promptDisplayText, toChatEvents, transcriptTitle, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import { bracketedPaste, promptKeys, stripControlChars } from '@shared/prompt-keys';
import { isParentMessageDraft, modeWithin, weakerMode, type SessionState } from '@shared/session-tools';
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
import { BashTaskTracker } from './bash-task-tracker';
import { branchCut, pulledBackPrompt, readAgentLog, readChatLog, readExportLog, type ChainEntry } from './chat-log';
import { ClaudeSession, transcriptPath } from './claude-session';
import type { BrowserMcpLaunch } from './browser-bridge';
import type { McpLaunch } from './mcp-bridge';
import type { PreparedSettings, SettingsFiles } from './settings-files';
import { KnowledgeTracker } from './knowledge-tracker';
import { ContextTracker, readContext } from './context-tracker';
import type { PtyHostApi } from './pty-host-client';
import type { HostedPtyInfo } from './pty-host-protocol';
import { rememberImage } from './image-cache';
import { askQuestionsOf } from './screen-parser';
import { TaskRouter } from './task-router';
import { ScreenTracker, type StopResult } from './screen-tracker';
import type { StatusLineWatcher } from './statusline';
import { SubagentTracker } from './subagent-tracker';
import { WorkflowTracker } from './workflow-tracker';
import type { SessionRecord, SessionStore } from './session-store';
import type { WorkspaceWatchers } from './workspace-watcher';
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

// 送ってから、打ち込んだ文字が Claude Code の入力欄から消えるまでの目安（その間は、入力欄に残った文字としてチャットに移さない）
const TYPING_MS = 5000;
// 送ってから発言が会話ログに出るまで、作業中として扱う上限（スラッシュコマンドなど、発言として残らないものもある）
const SUBMIT_GRACE_MS = 15_000;
// 打った文字が入力欄に出るのを待つ上限と、画面を見直す間隔（submit の untilTyped）。TYPED_MS は TYPING_MS より短くする
const TYPED_MS = 3000;
const TYPED_POLL_MS = 20;

// Claude Code の画面を見ていないときの pty サイズ。低いと、Claude Code は選択肢の一部だけを出す（↑/↓ で送る）ので、
// 画面から読むメニューが欠ける。見ているあいだだけ、ターミナルパネルの大きさに合わせる
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
  // 会話ログの行を、上の 3 つと画面の質問に振り分ける
  tasks: TaskRouter;
  // Claude が読んだ・書いたファイルとコンテキストの使用量
  knowledge: KnowledgeTracker;
  // コンテキストの中身（読んだファイル・大きなツールの結果・発言ごとのやりとりなど）
  context: ContextTracker;
  // statusLine から読んだモデル・コンテキスト・利用枠（応答のたびに更新）
  statusLine: StatusLineInfo | null;
  // 今の会話ログの行（uuid を持つもの）と、その行から作ったイベントの events 上の位置。巻き戻しの検出に使う
  chain: ChainEntry[];
  // 起動ごとに作り直す（pty の画面は起動ごとに別物）
  screen: ScreenTracker | null;
  // 選択メニューや認識できない対話画面が出ていて、ユーザーの操作を待っている
  attention: SessionAttention;
  // 実行中のバックグラウンドタスク（サブエージェント・ワークフロー・Bash）の数
  background: number;
  // 今回の起動で入力を受け付けられるようになった（ready を配信した）
  ready: boolean;
  // 今回の起動で --permission-mode に渡したモード（画面からモードを読めるまでの間、起動し直すときに使う）
  startMode: PermissionMode | null;
  // アプリが決めた権限モード（起動の引数か、アプリでの切り替え）。子セッションの権限モードの上限に使う。
  // 画面の文字は会話の中の文でも読めてしまうので、上限には画面から読んだモードだけを使わない
  knownMode: PermissionMode | null;
  size: { cols: number; rows: number };
  // 引き継いだ claude（前のアプリが起動したもの）が起動した時刻。これ以降の会話ログの行は、今も動いている claude が書いた
  aliveSince: number | null;
  // ターンの途中（Claude Code が作業中）。引き継いだ claude では、読み直した会話の時点でターンの途中だったかも表す
  turnOpen: boolean;
  // Claude Code の入力の順番待ち（会話ログの queue-operation）。完了通知も入る。human: ユーザーが送った発言
  queue: { text: string; human: boolean }[];
  // Remote Control が実際につながっているか（会話ログの bridge_status・空の bridge-session で分かる）。
  // null: --remote-control を付けて起動した・/remote-control でつないだあと、つながるのを待っている
  remoteConnected: boolean | null;
  // /remote-control で切り替えている途中（そのあいだに出るメニューを、質問や確認として扱わない）
  remoteSwitching: boolean;
  // 会話ログを読み終えた（読み直しの途中の、古いつながりの状態で合わせないため）
  historyLoaded: boolean;
  // 読み直した会話ログの最後の Remote Control の URL（bridge-session 行。切れていれば null、行が無ければ undefined）。
  // bridge-session 行には時刻が無く、引き継いだ claude が書いたものか分からないため、読み終えてから今のつながりとして使う
  lastBridgeUrl: string | null | undefined;
  // 合わせようとして失敗した向き。同じ向きには試し直さない（指定を変えたら、また試す）
  remoteTried: boolean | null;
  // worktree の準備の途中（Claude Code が worktree を作るのを待っている・node_modules の用意）。終わるまで ready を配信しない
  // （最初の指示を、準備が終わる前に送らないため）
  preparing: WorktreePreparing | null;
  // Claude Code が worktree を作り終えたか（新しい worktree で起動したときだけ。作れずに終わったら false）
  worktreeCreated: Promise<boolean> | null;
  // ファイルの変更を見張っているフォルダ（worktree は、Claude Code が作るまで見張れない）
  watched: string | null;
  // 送信の順番待ち。チャットの入力欄からの発言と、親セッションからの指示・知らせを、混ぜずに 1 つずつ打ち込む
  sendChain: Promise<void>;
  // 打ち込んでいる途中の文字（空白を除く）と、打ち込み始めた時刻。画面の draft から除いて画面に知らせる（チャットの入力欄に移さないため）
  typing: { text: string; at: number } | null;
  // 起動を待って送る発言の数と、送ってから発言が会話ログに出るまでの時刻（ツールで返す状態で、作業中として扱う）
  pendingSubmits: number;
  submittedAt: number | null;
};

// アプリが開くコマンドのターミナル（worktree の npm install・yarn install など）。終了コードを返す。owner: セッションの id
export type RunTask = (owner: string, cwd: string, command: string, name: string) => Promise<number>;

type Listeners = {
  onSessionsChanged: (sessions: SessionSummary[]) => void;
  onChat: (batch: ChatBatch) => void;
  onPtyData: (sessionId: string, data: string) => void;
  onTurnCompleted: (session: SessionSummary) => void;
  onScreen: (sessionId: string, info: ScreenInfo) => void;
  onActivity: (sessionId: string, activity: Activity | null) => void;
  onWorkflows: (sessionId: string, runs: WorkflowRun[]) => void;
  onSubagents: (sessionId: string, runs: SubagentRun[]) => void;
  onBashTasks: (sessionId: string, tasks: BashTask[]) => void;
  onKnowledge: (sessionId: string, knowledge: SessionKnowledge) => void;
  onStatusLine: (sessionId: string, info: StatusLineInfo) => void;
  // ユーザーの操作待ちになった。menu: 選択メニューが新しく出た（質問・許可確認）、unsupported: チャットでは操作できない画面が出た（ターミナルでの操作が要る）
  onAttention: (session: SessionSummary, attention: { kind: 'menu'; menu: Menu } | { kind: 'unsupported' }) => void;
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
  ) {}

  // 状態が変わったかもしれないセッション（イベント・画面の操作待ち・バックグラウンドの数・アーカイブ）を知らせる先
  private readonly stateListeners = new Set<(id: string) => void>();

  watchState(listener: (id: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private changed(id: string): void {
    for (const listener of this.stateListeners) listener(id);
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
          unread: !!rt?.unread,
          attention: rt?.process ? (rt.attention ?? (this.browserAsks.has(r.id) ? 'browser' : null)) : null,
          backgroundTasks: rt?.process ? rt.background : 0,
          model: r.model ?? null,
          effort: r.effort ?? null,
          settingsFile: r.settingsFile ?? null,
          remoteControl: this.wantsRemote(r),
          worktree: r.worktree
            ? { ...r.worktree, preparing: this.restoring.has(r.id) ? 'restoring' : rt?.process ? rt.preparing : null }
            : null,
          parentId: r.parentId ?? null,
        };
      });
  }

  // Claude Code が動いている、アーカイブしていないセッションと、その状態（一覧の文言と同じ）。アプリを終了するときの確認に使う
  liveSessions(): { title: string; state: string }[] {
    return this.store
      .all()
      .filter((r) => !r.archived && this.runtimes.get(r.id)?.process)
      .map((r) => ({ title: r.title ?? '新しいセッション', state: stateLabel(this.runtimes.get(r.id)!, this.browserAsks.has(r.id)) }));
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
  // Claude Code が worktree を作るのを待ってから返す（右パネルやエディタが、すぐ worktree を開けるように）。
  // 作れずに Claude Code が終わったら、記録を消して、そのときの画面を添えて失敗する
  async createInWorktree(cwd: string, options: NewSessionOptions, parentId: string | null = null): Promise<string> {
    this.checkSettingsFile(options.settingsFile);
    const plan = await planWorktree(cwd);
    // 元のフォルダのソース管理に、worktree が未追跡として出ないようにする
    await hideWorktrees(plan.root).catch(() => {});
    const id = this.addRecord(plan.path, options, { name: plan.name, branch: plan.branch, root: plan.root }, parentId);
    this.start(id, options.mode);
    const rt = this.runtimes.get(id);
    if (rt?.worktreeCreated && (await rt.worktreeCreated)) return id;
    const screen = rt?.screen?.text() ?? '';
    await this.archive(id).catch(() => null);
    this.store.remove(id);
    this.emitSessions();
    // claude --worktree は、まだ信頼していないフォルダでは、信頼の確認を出さずに終わる（実測）
    if (/trust not yet accepted/i.test(screen)) {
      throw new Error('このフォルダは、まだ Claude Code で信頼していません。一度 worktree なしで始めて、フォルダの信頼の確認に答えてから、worktree で始めてください');
    }
    throw new Error(`Claude Code が worktree を作れませんでした${screen ? `\n\n${screen.split('\n').slice(-8).join('\n')}` : ''}`);
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
    if (!record) throw new Error('セッションが見つかりません');
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
    // 子セッションは起動したときのモードで（ほかのセッションは、これまでどおり既定のまま）
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
    rt?.screen?.dispose();
    rt?.workflows.dispose();
    rt?.subagents.dispose();
    rt?.bashTasks.dispose();
    if (rt?.watched) this.watchers.release(rt.watched);
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

  // ツールで返す、今の状態（知らないセッションは null）
  stateOf(id: string): SessionState | null {
    const record = this.store.get(id);
    if (!record) return null;
    if (record.archived) return 'archived';
    if (this.restoring.has(id)) return 'starting';
    const rt = this.runtimes.get(id);
    if (!rt?.process) return 'exited';
    // 質問と読めても、AskUserQuestion を出していなければ質問ではない（コマンドの文字に ☐ があると、許可の確認が質問に見える）。
    // 親が答えられる質問と見せないよう、許可の確認として扱う
    if (rt.attention === 'question') return rt.screen?.askedQuestions ? 'question' : 'permission';
    if (rt.attention === 'permission') return 'permission';
    if (rt.attention === 'other') return 'waiting';
    if (!rt.ready || rt.preparing) return 'starting';
    if (rt.pendingSubmits > 0 || rt.turnOpen) return 'working';
    if (rt.submittedAt !== null && Date.now() - rt.submittedAt < SUBMIT_GRACE_MS) return 'working';
    if (rt.background > 0) return 'background';
    return 'idle';
  }

  // 子セッションの権限モードの上限にする、今の権限モード。アプリが決めたモード（起動の引数・アプリでの切り替え。無ければ manual）と、
  // 画面から読んだモードの弱いほう（画面の文字は偽れるので、強くする向きには使わない。ターミナルで下げたときは下げる）
  modeOf(id: string): PermissionMode | null {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    const known = rt.knownMode ?? 'manual';
    const shown = rt.screen?.current.mode;
    return shown ? weakerMode(shown, known) : known;
  }

  // 今出している AskUserQuestion の質問。出していなければ null
  askedQuestions(id: string): AskQuestion[] | null {
    return this.runtimes.get(id)?.screen?.askedQuestions ?? null;
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

  // Claude がアプリ内ブラウザでユーザーに操作を頼んだ・頼み終わった（一覧は「ブラウザでの操作待ち」）
  browserAskChanged(id: string, asking: boolean): void {
    if (asking === this.browserAsks.has(id)) return;
    if (asking) this.browserAsks.add(id);
    else this.browserAsks.delete(id);
    this.emitSessions();
  }

  // AskUserQuestion を出す直前に、フックがその入力をファイルに書いた（説明・プレビューを質問のカードに出すため）
  askQuestionsChanged(id: string, input: unknown): void {
    const questions = askQuestionsOf(input);
    if (questions) this.runtimes.get(id)?.screen?.setQuestions(questions);
  }

  // statusLine のファイルが書き換わった
  statusLineChanged(id: string, info: StatusLineInfo): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.statusLine = info;
    this.listeners.onStatusLine(id, info);
    // /clear で新しい会話になると、statusLine の会話ログのパスが変わる（Remote Control を使っていなくても追える）
    if (info.transcriptPath) rt.process?.followTranscript(info.transcriptPath);
  }

  // このセッションの Remote Control を切り替える。動いていれば /remote-control でその場でつなぐ・切る。
  // 止まっていれば、次に起動するときの指定だけ変える。切り替えられなかったら指定を戻して、理由を返す
  async setRemoteControl(id: string, on: boolean): Promise<string | null> {
    if (!this.remoteControlAvailable) return 'Remote Control は開発版では使えません（TANACODE_REMOTE_CONTROL=1 を付けて起動すると使えます）';
    const record = this.store.get(id);
    if (!record) return 'セッションが見つかりません';
    const fail = (reason: string) => {
      this.store.update(id, { remoteControl: !on });
      this.emitSessions();
      return reason;
    };
    this.store.update(id, { remoteControl: on });
    this.emitSessions();
    const rt = this.runtimes.get(id);
    rt && (rt.remoteTried = null);
    // 止まっている・起動の途中・つながるのを待っているときは、起動やつながりが済んでから合わせる（reconcileRemote）
    if (!rt?.process || !rt.screen || !rt.ready || !rt.historyLoaded || rt.remoteConnected === null || rt.remoteConnected === on) return null;
    if (rt.remoteSwitching) return fail('Remote Control を切り替えている途中です。少し待ってからもう一度押してください');
    const screen = rt.screen.current;
    if (screen.state.kind !== 'prompt') return fail('Claude Code が質問や確認の答えを待っているため、今は切り替えられません。答えてから切り替えてください');
    if (screen.draft) return fail('ターミナルの Claude Code の入力欄に書きかけの文字があるため、切り替えられません');
    const ok = await this.switchRemote(id, rt, record.cwd, on);
    // 画面では分からなくても、会話ログで目的の状態になっていれば済んでいる
    if (ok || rt.remoteConnected === on) return null;
    return fail('Claude Code の画面で Remote Control を切り替えられませんでした。ターミナルで /remote-control を操作してください');
  }

  remoteAvailable(): boolean {
    return this.remoteControlAvailable;
  }

  // このセッションで Remote Control を使うか（開発版では使わない）
  private wantsRemote(record: SessionRecord): boolean {
    return this.remoteControlAvailable && record.remoteControl !== false;
  }

  // 指定と、実際につながっているかがずれていたら、/remote-control で合わせる。
  // 切る指定の会話を再開すると、Claude Code が前のつながりを勝手に戻すので、それもここで切る
  private reconcileRemote(id: string): void {
    const rt = this.runtimes.get(id);
    const record = this.store.get(id);
    if (!rt?.process || !rt.screen || !record || !rt.ready || !rt.historyLoaded || rt.remoteSwitching || rt.remoteConnected === null) return;
    const want = this.wantsRemote(record);
    if (want === rt.remoteConnected || rt.remoteTried === want) return;
    const screen = rt.screen.current;
    if (screen.state.kind !== 'prompt' || screen.draft) return;
    void this.switchRemote(id, rt, record.cwd, want);
  }

  private async switchRemote(id: string, rt: Runtime, cwd: string, on: boolean): Promise<boolean> {
    const screen = rt.screen;
    if (!screen) return false;
    rt.remoteSwitching = true;
    rt.remoteTried = on;
    const ok = await screen.setRemoteControl(on ? remoteName(cwd) : null).catch(() => false);
    rt.remoteSwitching = false;
    // つないだときは bridge_status が届くまで待つ。切ったときは空の bridge-session が届くが、先に切れたことにする
    if (ok) rt.remoteConnected = on ? null : false;
    // 切り替えのあいだ止めていた画面の変化を、今の画面で送り直す
    if (rt.screen === screen) this.handleScreen(id, screen, screen.current);
    return ok;
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

  bashTasks(id: string): BashTask[] {
    return this.runtimes.get(id)?.bashTasks.all() ?? [];
  }

  // 動いているバックグラウンドのもの（サブエージェント・ワークフロー・Bash）を止める。止められなかったら理由を返す。
  // 本家と同じ操作（/tasks の画面で選んで x）を、画面にキーを送って行う。止まったかは、Claude Code が会話ログに書く完了通知で分かる
  async stopTask(id: string, ref: TaskRef): Promise<string | null> {
    const rt = this.runtimes.get(id);
    if (!rt?.process || !rt.screen) return 'セッションが動いていないため、止められません';
    const name = stopName(rt, ref);
    if (name === null) return '止められるもの（動いているバックグラウンドのタスク）が見つかりません';
    switch (await rt.screen.stopTask(name).catch((): StopResult => 'failed')) {
      case 'stopped':
        return null;
      case 'busy':
        return '別の操作の途中です。少し待ってからもう一度押してください';
      case 'not-prompt':
        return '質問や確認の答えを待っているため、今は止められません。答えてから止めてください';
      case 'draft':
        return 'ターミナルの入力欄に書きかけの文字があるため、止められません';
      case 'not-found':
        return '画面に見つかりませんでした。すでに終わったか、止まっています';
      case 'ambiguous':
        return '同じ名前のものが 2 つ以上あり、どれを止めるか決められません。ターミナルで /tasks を開いて止めてください';
      case 'failed':
        return '止められませんでした。ターミナルで /tasks を開いて止めてください';
    }
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

  screen(id: string): ScreenInfo | null {
    return this.runtimes.get(id)?.screen?.current ?? null;
  }

  // 画面に知らせる ScreenInfo。打ち込んでいる途中の文字は、入力欄に残った文字（draft）から除く
  screenForView(id: string): ScreenInfo | null {
    const rt = this.runtimes.get(id);
    const info = rt?.screen?.current;
    return rt && info ? shownScreen(rt, info) : null;
  }

  activity(id: string): Activity | null {
    return this.runtimes.get(id)?.screen?.currentActivity ?? null;
  }

  async setMode(id: string, mode: PermissionMode): Promise<boolean> {
    const rt = this.runtimes.get(id);
    const ok = (await rt?.screen?.setMode(mode)) ?? false;
    if (ok && rt) rt.knownMode = mode;
    return ok;
  }

  async rewind(id: string, text: string): Promise<boolean> {
    return (await this.runtimes.get(id)?.screen?.rewindTo(text)) ?? false;
  }

  // カードの選択肢を選ぶ。選べなかったときは理由を返す（画面がカードに出す）
  async choose(id: string, choice: ScreenChoice): Promise<ChooseResult> {
    return (await this.runtimes.get(id)?.screen?.choose(choice.optionId, choice.key, choice.text)) ?? 'gone';
  }

  // expect を満たすメニューのあいだだけ選ぶ（親が子の質問に答えるとき。途中で許可の確認などに変わったら、何も押さない）。選べたら true
  async chooseIf(id: string, choice: ScreenChoice, expect: (menu: Menu) => boolean): Promise<boolean> {
    return (await this.runtimes.get(id)?.screen?.choose(choice.optionId, choice.key, choice.text, expect)) === 'chosen';
  }

  configure(id: string, options: SessionOptions): void {
    const record = this.store.get(id);
    const settingsFile = options.settingsFile ?? null;
    const settingsChanged = (record?.settingsFile ?? null) !== settingsFile;
    if (settingsChanged) this.checkSettingsFile(settingsFile);
    // 設定ファイルを変えたら、モデルとエフォートは新しい設定の既定に戻す（前の設定のモデルが、新しい設定で使えるとは限らない）
    const model = settingsChanged ? null : options.model;
    const effort = settingsChanged ? null : options.effort;
    const modelChanged = (record?.model ?? null) !== model;
    // モデルや設定ファイルを変えたら、1M コンテキストかどうかは起動時の表示で分かり直す
    this.store.update(id, { model, effort, settingsFile, ...(modelChanged || settingsChanged ? { oneMillion: undefined } : {}) });
    if (this.runtimes.get(id)?.process) this.restart(id);
    else this.emitSessions();
  }

  // 登録した設定ファイルを使えるか確かめる。使えなければ理由を添えて投げる
  private checkSettingsFile(settingsFile: string | null | undefined): void {
    if (!settingsFile) return;
    if (!this.settingsFiles) throw new Error('設定ファイルを使えない状態です');
    this.settingsFiles.check(settingsFile);
  }

  // 設定ファイルを選んでいるセッションの起動前に、アプリの設定と登録した設定を合わせたファイルを書く。選んでいなければ null
  // browser: アプリ内ブラウザの MCP サーバーを足すか（合わせる設定に、JavaScript の実行の確認のフックを入れる）
  // sessions: セッションの MCP サーバーを足すか（合わせる設定に、子セッションの起動の確認のフックを入れる）
  private prepareSettings(id: string, settingsFile: string | null | undefined, browser: boolean, sessions: boolean): PreparedSettings | null {
    if (!settingsFile) {
      // 標準の設定に戻した（または初めから標準）。前の設定ファイルで合わせたファイルが残っていれば消す
      this.settingsFiles?.release(id);
      return null;
    }
    if (!this.settingsFiles) throw new Error('設定ファイルを使えない状態です');
    return this.settingsFiles.prepare(id, settingsFile, browser, sessions);
  }

  // Claude Code を起動し直して同じ会話を続ける（--resume）。スキル・CLAUDE.md・設定・MCP などを読み込み直すため。
  // 権限モードは起動し直すと既定に戻るので、--permission-mode で元のモードを渡す
  restart(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt?.process) {
      void this.open(id);
      return;
    }
    // 起動し直せないと分かっているのに、動いている claude を止めないよう、先に設定ファイルを確かめる
    this.checkSettingsFile(this.store.get(id)?.settingsFile);
    let mode = rt.screen?.current.mode ?? rt.startMode;
    // 子セッションは、起動したときのモードより強くしない（画面の文字は偽れるため）
    const launchMode = this.store.get(id)?.launchMode;
    if (launchMode && mode && !modeWithin(mode, launchMode)) mode = launchMode;
    rt.process.kill();
    rt.process = null;
    // バックグラウンドのタスクは一緒に止まる
    rt.workflows.stopRunning();
    rt.subagents.stopRunning();
    rt.bashTasks.stopRunning();
    this.start(id, mode && mode !== 'bypassPermissions' ? mode : null);
  }

  write(id: string, data: string): void {
    this.runtimes.get(id)?.process?.write(data);
  }

  // Claude Code の入力欄に打ち込んで送る。画像はパスを貼り付けとして送ると [Image #n] として添付される。
  // 同じセッションへの送信は 1 つずつ順に打ち込む（チャットの入力欄からの発言と、親セッションからの指示・知らせが混ざらないように）。
  // guarded: 打つ直前と Enter の直前に、入力欄に打ってよい状態かを確かめ、そうでなければ打たずに失敗する（submitWhenReady）
  submit(id: string, rawText: string, attachments: string[] = [], guarded = false): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt?.process) return Promise.resolve();
    const run = async () => {
      const process = rt.process;
      if (!process) return;
      if (guarded && !acceptsTyping(rt)) throw new Error('入力を受け付けられる状態ではなくなったため、送れませんでした');
      // ESC などが残ると、貼り付けの外に出てキー操作（Enter・Shift+Tab など）として届いてしまうので取り除く
      const text = stripControlChars(rawText);
      // 画面の折り返しで空白が変わるので、空白を除いて覚える
      rt.typing = { text: text.replace(/\s/g, ''), at: Date.now() };
      rt.submittedAt = Date.now();
      for (const path of attachments) {
        process.write(bracketedPaste(stripControlChars(path)));
        await sleep(300);
        process.write(' ');
      }
      if (text) {
        const before = rt.screen?.current.draft ?? '';
        // 改行を含む入力は貼り付けとして送る（promptKeys）
        process.write(promptKeys(text));
        // 打った文字が入力欄に出てから Enter を送る。決まった時間だけ待つと、Claude Code が忙しくて読むのが遅れたとき
        // （起動の直後に MCP サーバーがつながる間など）、文字と Enter が 1 度に届く。長い文字は貼り付けとみなされ、Enter は改行として入力欄に入る（送られない）
        await this.untilTyped(rt, process, before, text);
      } else {
        await sleep(50);
      }
      // Enter の直前にメニューが出ていたら、Enter はメニューの選択になってしまう
      if (guarded && (rt.screen?.current.state.kind !== 'prompt' || rt.attention !== null)) {
        throw new Error('質問や確認が出たため、送れませんでした');
      }
      process.write('\r');
      this.changed(id);
      // 発言として残らなかったとき（スラッシュコマンドなど）も、作業中として扱う時間が過ぎたら知らせ直す
      setTimeout(() => this.changed(id), SUBMIT_GRACE_MS + 100);
    };
    const next = rt.sendChain.then(run, run);
    rt.sendChain = next.catch(() => {});
    return next;
  }

  // 打った文字が入力欄に出る（Claude Code が読み終える）のを待つ。メニューが出たらやめる（Enter を送るかは submit が決める）。
  // TYPED_MS たっても出なければ、待つのをやめて Enter を送る（画面から読み取れない文字など）
  private async untilTyped(rt: Runtime, process: ClaudeSession, before: string, text: string): Promise<void> {
    const until = Date.now() + TYPED_MS;
    while (rt.process === process && Date.now() < until) {
      const info = rt.screen?.current;
      if (!info || info.state.kind === 'menu' || typedShown(info.draft, before, text)) return;
      await sleep(TYPED_POLL_MS);
    }
  }

  // 手が空く（ターンが終わり、入力を受け付けられる）のを待ってから送る（子セッションへの指示・親への知らせ）。
  // 作業中の Claude Code に打つと、そのあいだに出た許可の確認で、Enter や数字が選択になってしまうことがある。
  // 手が空いていれば、新しい確認が急に出ることはない（ツールを使うには、まず応答が要る）。
  // 待っている間も、ツールで返す状態は作業中にする。待ちきれない・終わったときは、理由を添えて失敗する。
  // attachments: 画像のパス（submit と同じ）/ signal: 待っている間に取りやめる（予約の取り消し。打ち込み始めたあとは止めない）
  async submitWhenReady(
    id: string,
    text: string,
    timeoutMs: number,
    { attachments = [], signal }: { attachments?: string[]; signal?: AbortSignal } = {},
  ): Promise<void> {
    const rt = this.runtimes.get(id);
    const process = rt?.process;
    if (!rt || !process) throw new Error('Claude Code が動いていません');
    rt.pendingSubmits += 1;
    this.changed(id);
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (rt.process !== process) throw new Error('Claude Code が終了しました');
        if (signal?.aborted) throw new Error('送るのを取りやめました');
        // 直前に送ったもの（まだ会話ログに出ていない）があれば、それが終わるまで待つ
        const sending = rt.submittedAt !== null && Date.now() - rt.submittedAt < SUBMIT_GRACE_MS;
        if (acceptsTyping(rt) && !sending) break;
        if (Date.now() > deadline) {
          const screen = rt.screen?.current;
          if (screen?.state.kind === 'menu') throw new Error('質問や確認の答えを待っているため、送れませんでした');
          if (screen?.draft) throw new Error('ターミナルの入力欄に書きかけの文字があるため、送れませんでした');
          throw new Error('Claude Code の手が空かないため、送れませんでした');
        }
        await sleep(200);
      }
      // 続けて待っているほかの送信が、同じ隙に打ち込まないよう、すぐに印を付ける
      rt.submittedAt = Date.now();
      await this.submit(id, text, attachments, true);
    } finally {
      rt.pendingSubmits -= 1;
      this.changed(id);
    }
  }

  // 中断で入力欄に戻った親からの指示を消す（親が止めたとき。人のチャットの入力欄に、囲みのまま移さないため）
  async withdrawParentDraft(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    for (let i = 0; i < 15 && rt?.process; i++) {
      const draft = rt.screen?.current.draft ?? '';
      if (rt.screen?.current.state.kind === 'prompt' && isParentMessageDraft(draft)) {
        rt.process.write('\x15'.repeat(draft.split('\n').length + 1));
        return;
      }
      await sleep(100);
    }
  }

  // 作業を中断する（Esc）。打ち込んでいる途中の文字はもう無いので、Claude Code が入力欄に戻した発言は、そのままチャットの入力欄に移す
  interrupt(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.typing = null;
    rt.process?.write('\x1b');
  }

  resize(id: string, cols: number, rows: number): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.size = { cols, rows };
    rt.process?.resize(cols, rows);
    rt.screen?.resize(cols, rows);
  }

  // 前のアプリが起動して、アプリの再起動をまたいで動いている claude を引き継ぐ
  async adopt(): Promise<void> {
    for (const info of await this.host.list()) {
      const record = this.store.get(info.tag);
      if (info.exitCode !== null) {
        this.host.forget(info.id);
        continue;
      }
      if (!record || record.archived || this.runtimes.get(record.id)?.process) {
        this.host.attach(info).kill();
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
      rt.screen?.dispose();
      rt.workflows.dispose();
      rt.subagents.dispose();
      rt.bashTasks.dispose();
    }
    this.watchers.closeAll();
    this.store.flush();
  }

  isFocused(id: string): boolean {
    return this.focusedId === id;
  }

  // mode: --permission-mode で渡す権限モード（このセッションだけ）。null なら既定のまま。
  // adopted: 起動せずに引き継ぐ、動いている claude
  private start(id: string, mode: PermissionMode | null = null, adopted: HostedPtyInfo | null = null): void {
    const record = this.store.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);

    // 設定ファイルを使えなければ、何も変えずにここで断る（標準の設定に黙って切り替わらないように）。
    // 引き継ぐ claude は、前のアプリが起動したままなので、書き直さない
    const browser = adopted ? null : this.browser();
    const launch = adopted ? null : this.sessionsMcp();
    const checklist = adopted ? null : this.checklistMcp();
    const walkthrough = adopted ? null : this.walkthroughMcp();
    // 子セッションには、子を動かすツールを見せない（孫は作れない）
    const sessions = launch && record.parentId ? { ...launch, child: true } : launch;
    const settings = adopted ? null : this.prepareSettings(id, record.settingsFile, !!browser, !!sessions);

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
        screen: () => this.runtimes.get(id)?.screen ?? null,
        sessionDir: () => this.sessionDir(id),
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
        knowledge: new KnowledgeTracker(record.cwd, (value) => this.listeners.onKnowledge(id, value)),
        context: new ContextTracker(record.cwd),
        statusLine: null,
        chain: [],
        screen: null,
        attention: null,
        background: 0,
        ready: false,
        startMode: null,
        knownMode: null,
        size: DEFAULT_PTY_SIZE,
        aliveSince: null,
        turnOpen: false,
        queue: [],
        remoteConnected: false,
        remoteSwitching: false,
        historyLoaded: false,
        lastBridgeUrl: undefined,
        remoteTried: null,
        preparing: null,
        worktreeCreated: null,
        watched: null,
        sendChain: Promise.resolve(),
        typing: null,
        pendingSubmits: 0,
        submittedAt: null,
      };
      this.runtimes.set(id, rt);
    }
    // worktree は、Claude Code が作るまでフォルダが無い（作ったあとで見張る）
    this.watch(rt, record.cwd);
    rt.events = [];
    rt.chain = [];
    // 再開すると過去の会話を読み直すので、そこから集め直す
    rt.knowledge.reset();
    rt.context.reset();
    this.pushEvents(id, [{ type: 'process-start' }]);
    const runtime = rt;
    runtime.screen?.dispose();
    runtime.attention = null;
    runtime.ready = false;
    runtime.startMode = mode;
    runtime.knownMode = mode;
    runtime.aliveSince = adopted?.startedAt ?? null;
    runtime.turnOpen = false;
    runtime.queue = [];
    // --remote-control を付けて起動するなら、つながるのを待つ。
    // 引き継いだ claude は付けて起動したか分からないが、つながった記録は起動のあとに書かれるので、会話ログを読み直すと分かる
    const remote = this.wantsRemote(record);
    runtime.remoteConnected = remote && !adopted ? null : false;
    runtime.remoteSwitching = false;
    // 読み直す会話ログが無ければ（新しい会話）、読み終わりの知らせは来ないので、はじめから読み終えたことにする
    runtime.historyLoaded = fileSize(transcriptPath(record.cwd, claudeSessionId, this.claudeDir)) === 0;
    runtime.lastBridgeUrl = undefined;
    runtime.remoteTried = null;
    // 引き継ぐときは、claude の今の画面の大きさで描き直してから、アプリの大きさに合わせる
    const screen = new ScreenTracker(
      adopted?.cols ?? rt.size.cols,
      adopted?.rows ?? rt.size.rows,
      (data) => runtime.process?.write(data),
      (info) => this.handleScreen(id, screen, info),
      record.oneMillion === true,
      (activity) => {
        if (runtime.screen === screen) this.listeners.onActivity(id, activity);
      },
    );
    rt.screen = screen;
    this.listeners.onActivity(id, null);

    // 新しい worktree で始めるときは、Claude Code が作り終えるまで準備中にする。
    // 前の起動が worktree を作ったあと、入力欄を出す前に終わって（起動し直して）いたら、その「作成中」は戻す
    // （戻さないと、入力欄が出ても受け付けない。node_modules の用意の途中なら、終わるまで待たせたまま）
    const creating = !!record.worktree && !resume && !adopted && !existsSync(record.cwd);
    if (creating) runtime.preparing = 'creating';
    else if (runtime.preparing === 'creating') runtime.preparing = null;

    rt.process = new ClaudeSession(
      this.host,
      {
        sessionId: id,
        cwd: record.cwd,
        worktree: record.worktree?.name ?? null,
        worktreeRoot: record.worktree?.root ?? null,
        claudeSessionId,
        resume,
        remoteControlName: remote ? remoteName(record.worktree?.root ?? record.cwd) : null,
        model: record.model ?? null,
        effort: record.effort ?? null,
        permissionMode: mode,
        settings,
        statusFile: this.statusLines.fileFor(id),
        askFile: this.statusLines.askFileFor(id),
        browser,
        sessions,
        checklist,
        walkthrough,
        claudeDir: this.claudeDir,
        ...rt.size,
      },
      {
        onData: (data) => {
          screen.feed(data);
          this.listeners.onPtyData(id, data);
        },
        onInput: () => screen.noteInput(),
        onExit: (exitCode) => {
          rt.process = null;
          this.settingsFiles?.release(id);
          rt.workflows.stopRunning();
          rt.subagents.stopRunning();
          rt.bashTasks.stopRunning();
          if (rt.queue.length > 0) this.updateQueue(id, rt, () => []);
          this.pushEvents(id, [{ type: 'process-exit', exitCode }]);
          this.emitSessions();
        },
        onEntry: (entry, isHistory) => this.handleEntry(id, entry, isHistory),
        // 再開時、応答のないまま終わった過去のターンを作業中として扱わない。
        // 引き継いだ claude がターンの途中なら、本当に作業中なのでそのままにする
        onHistoryLoaded: () => {
          if (!runtime.turnOpen) this.pushEvents(id, [{ type: 'turn-end' }]);
          // 引き継いだ claude は、最後の bridge-session 行のつながりのまま動いている
          // （以前つないでいた会話を再開すると、フラグが無くてもつなぎ直すため）
          if (adopted && runtime.lastBridgeUrl !== undefined) {
            runtime.remoteConnected = runtime.lastBridgeUrl !== null;
            this.pushEvents(id, [{ type: 'remote-control', url: runtime.lastBridgeUrl }]);
          }
          runtime.historyLoaded = true;
          this.reconcileRemote(id);
        },
        onSwitch: (nextClaudeSessionId) => {
          this.store.update(id, { claudeSessionId: nextClaudeSessionId });
          rt.chain = [];
          rt.knowledge.reset();
          rt.context.reset();
          this.pushEvents(id, [{ type: 'reset' }]);
        },
      },
      adopted,
    );
    rt.process.start();
    if (creating) {
      const process = rt.process;
      runtime.worktreeCreated = waitForWorktree(record.cwd, () => runtime.process === process).then((created) => {
        if (created && runtime.process === process) {
          this.watch(runtime, record.cwd);
          // .git ができた時点では、git worktree add がまだファイルを書き出している（大きなリポジトリでは、git ls-files が空になる。実測）。
          // Claude Code は worktree を作り終えてから入力欄を出すので、それを待ってから node_modules を用意する
          void this.untilScreenReady(runtime, process).then((ready) => {
            if (ready) void this.prepareWorktree(id, 'created');
          });
        } else if (runtime.preparing === 'creating') {
          runtime.preparing = null;
        }
        return created;
      });
    }
    if (adopted) void this.catchUpStatusLine(id, rt.process);
    // 引き継いだ claude は前のアプリの頃から動いていて、会話もしている。画面から入力欄を読めるのを待たずに、起動済みとする
    // （入力欄を読むのは画面が描き直されたときなので、読み取りがずれたまま Claude Code が何も描かずに待っていると、いつまでも「起動中」になる）
    if (adopted && hasConversation(transcriptPath(record.cwd, claudeSessionId, this.claudeDir))) screen.markReady();
    if (adopted && (adopted.cols !== rt.size.cols || adopted.rows !== rt.size.rows)) this.resize(id, rt.size.cols, rt.size.rows);
    this.emitSessions();
  }

  // Claude Code が入力欄を出すまで待つ。その前に終わった・起動し直したら false
  private async untilScreenReady(rt: Runtime, process: ClaudeSession): Promise<boolean> {
    for (;;) {
      if (rt.process !== process) return false;
      if (rt.screen?.current.ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
    // 起動した Claude Code が先に入力欄を出しても、準備が終わるまで待たせる（await より前に決める）
    rt.preparing = 'copying';
    this.emitSessions();
    const step = (preparing: WorktreePreparing) => {
      if (this.runtimes.get(id) !== rt) return;
      rt.preparing = preparing;
      this.emitSessions();
    };
    const result = await prepareNodeModules(root, record.cwd, {
      onStep: step,
      install: (cwd, dir, command) => this.runTask(id, cwd, command, dir ? `${command}（${dir}）` : command),
    }).catch((error: unknown): NodeModulesResult => {
      console.error('node_modules を用意できませんでした', error);
      return { cloned: [], failed: [], installs: [] };
    });
    if (this.runtimes.get(id) !== rt) return;
    rt.preparing = null;
    const where = `.claude/worktrees/${name}（ブランチ ${branch}）`;
    const notes = [how === 'created' ? `worktree ${where} で始めました` : `消していた worktree ${where} を作り直しました`, nodeModulesNote(result)];
    this.pushEvents(id, [{ type: 'info', id: `worktree:${Date.now()}`, text: notes.filter(Boolean).join('。') }]);
    // 準備の間に入力欄が出ていたら、ここで受け付けられるようになったことにする
    if (!rt.ready && rt.screen?.current.ready) {
      rt.ready = true;
      this.pushEvents(id, [{ type: 'ready' }]);
    }
    this.emitSessions();
  }

  // 引き継いだ claude が、アプリが止まっている間に書いた statusLine を読む。次の応答で書かれるのを待つと、
  // それまでモデル・コンテキストが出ず、アプリが止まっている間の /clear にも追従できない（前の会話を出したままになる）
  private async catchUpStatusLine(id: string, process: ClaudeSession): Promise<void> {
    const info = await this.statusLines.peek(id);
    const rt = this.runtimes.get(id);
    // 読んでいる間に新しいものが届いていれば、そちらを使う
    if (info && rt?.process === process && !rt.statusLine) this.statusLineChanged(id, info);
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

  // 応答の前に Esc で中断した発言は、Claude Code が会話から外して入力欄に戻す。会話ログには何も書かれないので、
  // 入力欄に戻ったのを画面で見て、発言の表示を取り消し、ターンを終える（戻った文字は、チャットの入力欄に移す）
  private withdrawPulledBack(id: string, rt: Runtime, draft: string): void {
    const cut = pulledBackPrompt(rt.events, draft);
    if (cut === null) return;
    const kept = rt.events.slice(0, cut);
    // 発言の行から後の行を、会話のつながりからも外す（発言の前の、イベントの無い行は残す）
    let at = -1;
    rt.chain.forEach((c, i) => {
      if (c.type === 'user' && c.eventStart === cut) at = i;
    });
    if (at !== -1) rt.chain = rt.chain.slice(0, at);
    rt.events = kept;
    // replace は events に残さない（kept がそのまま置き換え後の状態）。通し番号だけ進める
    const fromSeq = rt.seq;
    rt.seq += 1;
    this.listeners.onChat({ sessionId: id, fromSeq, events: [{ type: 'replace', events: kept }], live: true });
    rt.turnOpen = false;
    this.pushEvents(id, [{ type: 'turn-end' }]);
    this.emitSessions();
  }

  // 作業中に送った発言は、Claude Code が受け取るまで会話ログに発言として書かれず、順番待ち（queue-operation）にだけ書かれる。
  // それを追って、受け取られるまでチャットに「順番待ち」として出す
  private trackQueue(id: string, rt: Runtime, entry: TranscriptEntry): void {
    const e = entry as TranscriptEntry & { operation?: string; content?: unknown };
    if (entry.type !== 'queue-operation') return;
    const text = queuedText(e.content);
    if (e.operation === 'enqueue' && text !== null) {
      this.updateQueue(id, rt, (queue) => [...queue, { text, human: isHumanPrompt(text) }]);
    } else if (e.operation === 'dequeue') {
      this.updateQueue(id, rt, (queue) => queue.slice(1));
    } else if (e.operation === 'remove' && text !== null) {
      // 作業の途中で差し込まれたとき・入力欄に戻したとき
      this.updateQueue(id, rt, (queue) => {
        const i = queue.findIndex((q) => q.text === text);
        return i === -1 ? queue : [...queue.slice(0, i), ...queue.slice(i + 1)];
      });
    } else if (e.operation === 'popAll') {
      this.updateQueue(id, rt, () => []);
    }
  }

  private updateQueue(id: string, rt: Runtime, change: (queue: Runtime['queue']) => Runtime['queue']): void {
    const human = (queue: Runtime['queue']) => queue.filter((q) => q.human).map((q) => promptDisplayText(q.text));
    const before = human(rt.queue);
    rt.queue = change(rt.queue);
    const after = human(rt.queue);
    if (after.length !== before.length || after.some((t, i) => t !== before[i])) this.pushEvents(id, [{ type: 'queue', prompts: after }]);
  }

  // 今の会話ログのセッションのフォルダ（subagents/・workflows/ がある）
  private sessionDir(id: string): string {
    const record = this.store.get(id)!;
    return join(dirname(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir)), record.claudeSessionId);
  }

  private handleScreen(id: string, screen: ScreenTracker, info: ScreenInfo): void {
    const rt = this.runtimes.get(id);
    if (!rt || rt.screen !== screen) return;
    // /remote-control で切り替えている途中に出るメニューは、質問や確認として見せない
    if (rt.remoteSwitching) return;
    this.listeners.onScreen(id, shownScreen(rt, info));
    if (info.ready && !rt.ready && !rt.preparing) {
      rt.ready = true;
      this.pushEvents(id, [{ type: 'ready' }]);
    }
    const oneMillion = screen.oneMillionSeen;
    if (oneMillion !== null && this.store.get(id)?.oneMillion !== oneMillion) this.store.update(id, { oneMillion });
    if (info.state.kind === 'prompt') this.reconcileRemote(id);
    if (info.state.kind === 'prompt' && rt.turnOpen && screen.currentActivity === null) this.withdrawPulledBack(id, rt, info.draft);
    const attention = info.state.kind === 'menu' ? info.state.menu.kind : info.state.kind === 'unknown' ? 'other' : null;
    if (attention === rt.attention) return;
    const before = rt.attention;
    rt.attention = attention;
    this.emitSessions();
    this.changed(id);
    const summary = this.summary(id);
    // 終了したセッションは、最後の画面が残っていても通知しない（チャットの「操作できない画面」の案内も、動いているセッションだけ）
    if (summary && rt.process && before === null) {
      if (info.state.kind === 'menu') this.listeners.onAttention(summary, { kind: 'menu', menu: info.state.menu });
      else if (info.state.kind === 'unknown') this.listeners.onAttention(summary, { kind: 'unsupported' });
    }
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

    const model = modelOf(entry);
    if (model) this.runtimes.get(id)?.screen?.noteModel(model, isHistory);

    const rt = this.runtimes.get(id);
    // 引き継いだ claude が起動してから書いた行は、読み直した履歴でも今動いているもの（バックグラウンドのタスクや質問を追う）
    const past = isHistory && !(rt?.aliveSince && entryTime(entry) >= rt.aliveSince);
    rt?.tasks.track(entry, past, isHistory);
    if (rt && !past) this.trackQueue(id, rt, entry);
    rt?.knowledge.handle(entry);
    rt?.context.handle(entry);

    if (rt) this.followBranch(id, rt, entry, isHistory);
    // Remote Control の URL は起動ごとに変わる。前に起動した claude の URL（読み直した過去の行）は出さない
    const events = toChatEvents(entry, record.cwd, false, rememberImage).filter((e) => !(past && e.type === 'remote-control'));
    if (rt && isHistory) {
      const bridge = bridgeUrlOf(entry);
      if (bridge !== undefined) rt.lastBridgeUrl = bridge;
    }
    if (rt && !past) {
      const remote = [...events].reverse().find((e) => e.type === 'remote-control');
      if (remote) {
        rt.remoteConnected = remote.url !== null;
        this.reconcileRemote(id);
      }
      if (events.some((e) => e.type === 'user' || e.type === 'notice' || e.type === 'turn-start')) {
        rt.turnOpen = true;
        rt.submittedAt = null;
      }
      if (events.some((e) => e.type === 'turn-end')) rt.turnOpen = false;
    }
    if (events.length > 0) {
      const active = !isHistory && events.some((e) => e.type === 'user' || e.type === 'assistant-text' || e.type === 'tool-use');
      // 会話が動いているなら、入力欄が読めなくても Claude Code は入力を受け付けている。
      // 発言より先に ready を配信する（起動中の間はチャットの状態を変えないため）。
      // Remote Control の URL などは入力欄が出る前にも書かれるので数えない
      if (active) rt?.screen?.markReady();
      this.pushEvents(id, events, !isHistory);
      if (active) {
        // 一覧は更新の新しい順。すでに先頭なら並びは変わらないので、行ごとに一覧を送り直さない
        const wasFirst = this.list()[0]?.id === id;
        this.store.update(id, { updatedAt: Date.now() });
        if (!wasFirst) changed = true;
      }
      if (!isHistory && events.some((e) => e.type === 'turn-end')) {
        const rt = this.runtimes.get(id);
        if (rt && !this.isFocused(id)) rt.unread = true;
        changed = true;
        const summary = this.summary(id);
        // バックグラウンドのタスクが動いているあいだは、まだ完了ではない（一覧も「完了待ち」）。
        // タスクが終わると Claude Code が続きを始めるので、通知はそのターンの終わりに出す。
        // ブラウザでの操作を頼んでいるあいだも同じ（2 分を過ぎると Claude Code が呼び出しをバックグラウンドに移し、Claude はターンを終えて返事を待つ）
        if (summary && summary.backgroundTasks === 0 && summary.attention !== 'browser') this.listeners.onTurnCompleted(summary);
      }
    }
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
    this.listeners.onSessionsChanged(this.list());
  }
}

// 会話ログの応答のモデル ID を表示名にする（例: claude-sonnet-5 → Sonnet 5、claude-fable-5-1 → Fable 5.1）
function modelOf(entry: TranscriptEntry): string | null {
  const id = entry.type === 'assistant' ? entry.message?.model : undefined;
  // 新しい系統名のモデルにも対応できるよう、名前は決め打ちしない。
  // 小数点以下は 1 桁の数字だけ（claude-sonnet-5-20260101 の日付の先頭の 2 を、小数点以下と読まない）
  const m = id?.match(/^claude-([a-z]+)-(\d+)(?:-(\d)(?!\d))?(?:-\d{8})?/);
  if (!m) return null;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

// node_modules の用意の結果の知らせ（チャットに出す）。場所は worktree からの相対（'' はいちばん上）
function nodeModulesNote(result: NodeModulesResult): string | null {
  const where = (dirs: string[]) => dirs.map((dir) => (dir ? `${dir}/node_modules` : 'node_modules')).join('・');
  const notes: string[] = [];
  if (result.cloned.length > 0) notes.push(`${where(result.cloned)} を元のフォルダから複製しました`);
  if (result.failed.length > 0) notes.push(`${where(result.failed)} は複製できませんでした`);
  const at = (dir: string) => dir || 'いちばん上';
  const ok = result.installs.filter((i) => i.exitCode === 0);
  const failed = result.installs.filter((i) => i.exitCode !== 0);
  if (ok.length > 0) notes.push(`${ok.map((i) => `${i.command}（${at(i.dir)}）`).join('・')} を実行しました`);
  if (failed.length > 0) {
    notes.push(`${failed.map((i) => `${i.command}（${at(i.dir)}・終了コード ${i.exitCode}）`).join('・')} が失敗しました。ターミナルのタブで確かめてください`);
  }
  return notes.length > 0 ? notes.join('。') : null;
}

// ターミナルに出さずにコマンドを実行する（RunTask の既定。互換性の確認など）
function runQuietly(_owner: string, cwd: string, command: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd }, (err) => resolve(err ? (typeof err.code === 'number' ? err.code : 1) : 0));
  });
}

// Remote Control のセッション名（スマホの一覧に出る）
// 止めたいものを、本家の /tasks の画面で見分ける名前にする（Bash はコマンド・エージェントは説明・ワークフローは名前）。
// 動いていない・バックグラウンドでない（本体の作業の中で動いている）・名前が分からないものは null
function stopName(rt: Runtime, ref: TaskRef): string | null {
  if (ref.kind === 'bash') {
    const task = rt.bashTasks.all().find((t) => t.toolUseId === ref.toolUseId);
    return task?.state === 'running' ? task.command || null : null;
  }
  if (ref.kind === 'workflow') {
    const run = rt.workflows.all().find((w) => w.toolUseId === ref.toolUseId);
    return run?.status === 'running' ? run.name || null : null;
  }
  const run = rt.subagents.all().find((r) => r.toolUseId === ref.toolUseId);
  return run?.state === 'running' && run.background ? run.description || null : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 画面に知らせる ScreenInfo。打ち込んでいる途中の文字（送ったばかりで、まだ Claude Code の入力欄に残っているもの）は、
// 入力欄に残った文字として扱わない（チャットの入力欄に移すと、送った文字を消してしまう）。
// 貼り付けた文字や画像は入力欄では [Pasted text #1 +6 lines]・[Image #1] の目印になるので、除いて比べる
function shownScreen(rt: Runtime, info: ScreenInfo): ScreenInfo {
  // 親からの指示（中断で戻ったもの）は、人のチャットの入力欄に移さない（親が止めたら、withdrawParentDraft が消す）
  if (isParentMessageDraft(info.draft)) return { ...info, draft: '' };
  const typing = rt.typing;
  if (!typing || !info.draft || Date.now() - typing.at >= TYPING_MS) return info;
  const typed = info.draft.replace(/\[(?:Pasted text #\d+[^\]]*|Image #\d+)\]/g, '').replace(/\s/g, '');
  return typed === '' || typing.text.includes(typed) ? { ...info, draft: '' } : info;
}

// 打った文字（text）が、Claude Code の入力欄（画面の draft。打つ前は before）に出たか。画面の折り返しで空白が変わるので、空白を除いて比べる。
// 貼り付けとみなされた入力（複数行・長い文字）は、入力欄では [Pasted text #1 +6 lines] の目印になるので、目印で終わるようになったかで見る
export function typedShown(draft: string, before: string, text: string): boolean {
  if (draft === before) return false;
  if (/\[Pasted text #\d+[^\]]*\]\s*$/.test(draft)) return true;
  return draft.replace(/\s/g, '').endsWith(text.replace(/\s/g, ''));
}

// 入力欄に打ってよい状態か。手が空いていて（ターンの外・操作待ちでない）、入力欄に書きかけが無く、画面の操作の途中でもない
function acceptsTyping(rt: Runtime): boolean {
  const info = rt.screen?.current;
  return (
    !!rt.process &&
    rt.ready &&
    !rt.preparing &&
    !rt.turnOpen &&
    rt.attention === null &&
    info?.state.kind === 'prompt' &&
    !info.draft &&
    !rt.screen?.operating
  );
}

function remoteName(cwd: string): string {
  return `tanacode-${basename(cwd)}`;
}

// 動いている Claude Code の状態の文言（セッション一覧の文言にそろえる）
function stateLabel(rt: Runtime, browserAsk: boolean): string {
  if (rt.attention === 'question') return '質問への回答待ち';
  if (rt.attention === 'permission') return '実行の許可待ち';
  if (rt.attention === 'other') return '操作待ち';
  if (browserAsk) return 'ブラウザでの操作待ち';
  if (!rt.ready) return '起動中';
  const background = rt.background > 0 ? `バックグラウンド ${rt.background}件` : null;
  if (rt.turnOpen) return background ? `作業中（${background}）` : '作業中';
  if (background) return `${background}の完了待ち`;
  return '待機中';
}



// 順番待ちの発言の文字。画像つきのときは content が配列で来る
function queuedText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.map((b: { type?: unknown; text?: unknown }) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
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


