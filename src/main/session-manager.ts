import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { bridgeUrlOf, isTranscriptEntry, toChatEvents, transcriptTitle, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import type {
  ChatBatch,
  NewSessionOptions,
  ScreenChoice,
  SessionOptions,
  SessionSnapshot,
  SessionAttention,
  SessionSummary,
} from '@shared/ipc';
import type { Activity, PermissionMode, ScreenInfo } from '@shared/screen';
import type { SubagentRun } from '@shared/subagent';
import type { SessionKnowledge } from '@shared/knowledge';
import type { StatusLineInfo } from '@shared/statusline';
import type { AgentLogRef, BashTask } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import { BashTaskTracker } from './bash-task-tracker';
import { branchCut, readAgentLog, readChatLog, type ChainEntry } from './chat-log';
import { ClaudeSession, transcriptPath } from './claude-session';
import { KnowledgeTracker } from './knowledge-tracker';
import type { PtyHost } from './pty-host-client';
import type { HostedPtyInfo } from './pty-host-protocol';
import { rememberImage } from './image-cache';
import { askQuestionsOf } from './screen-parser';
import { ScreenTracker } from './screen-tracker';
import type { StatusLineWatcher } from './statusline';
import { SubagentTracker } from './subagent-tracker';
import { WorkflowTracker, workflowLaunchOf } from './workflow-tracker';
import type { SessionRecord, SessionStore } from './session-store';
import type { WorkspaceWatchers } from './workspace-watcher';

// rename で付けた名前。会話ログのタイトル（最大 3）より常に優先する
const USER_TITLE_PRIORITY = 4;

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
  // Workflow ツールに直接渡されたスクリプト（tool_use ID ごと）。フェーズ名を読むのに使う
  workflowScripts: Map<string, string>;
  subagents: SubagentTracker;
  // Agent ツールの tool_use ID（結果の行がどのツールのものか分かるように）
  agentToolIds: Set<string>;
  // SendMessage の tool_use ID（結果が、前に起動したエージェントの再開かを見る）
  sendMessageIds: Set<string>;
  // 回答を待っている AskUserQuestion の tool_use ID
  askToolId: string | null;
  // run_in_background で呼んだ Bash の入力（tool_use ID ごと）
  bashInputs: Map<string, Record<string, unknown>>;
  bashTasks: BashTaskTracker;
  // Claude が読んだ・書いたファイルとコンテキストの使用量
  knowledge: KnowledgeTracker;
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
};

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
  // 選択メニューが新しく出た（質問・許可確認）
  onAttention: (session: SessionSummary) => void;
};

export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();
  private focusedId: string | null = null;
  private closed = false;

  constructor(
    private readonly host: PtyHost,
    private readonly store: SessionStore,
    private readonly watchers: WorkspaceWatchers,
    private readonly statusLines: StatusLineWatcher,
    private readonly listeners: Listeners,
    // Remote Control を使えるか。開発版では使わない（起動するたびにスマホに通知が届くため）
    private readonly remoteControlAvailable = true,
  ) {}

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
          attention: rt?.process ? rt.attention : null,
          backgroundTasks: rt?.process ? rt.background : 0,
          model: r.model ?? null,
          effort: r.effort ?? null,
          remoteControl: this.wantsRemote(r),
        };
      });
  }

  // Claude Code が動いている、アーカイブしていないセッションと、その状態（一覧の文言と同じ）。アプリを終了するときの確認に使う
  liveSessions(): { title: string; state: string }[] {
    return this.store
      .all()
      .filter((r) => !r.archived && this.runtimes.get(r.id)?.process)
      .map((r) => ({ title: r.title ?? '新しいセッション', state: stateLabel(this.runtimes.get(r.id)!) }));
  }

  summary(id: string): SessionSummary | undefined {
    return this.list().find((s) => s.id === id);
  }

  cwdOf(id: string): string {
    const record = this.store.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);
    return record.cwd;
  }

  create(cwd: string, options: NewSessionOptions): string {
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
      remoteControl: options.remoteControl,
      createdAt: now,
      updatedAt: now,
    });
    this.start(id, options.mode);
    return id;
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

  remove(id: string): void {
    this.archive(id);
    void rm(this.statusLines.fileFor(id), { force: true });
    void rm(this.statusLines.askFileFor(id), { force: true });
    this.store.remove(id);
    this.emitSessions();
  }

  // 最近使ったセッションのフォルダ（裏で Claude Code を起動するときに使う。信頼済みなので確認が出ない）
  recentCwd(): string {
    return this.list().find((s) => !s.archived)?.cwd ?? this.list()[0]?.cwd ?? homedir();
  }

  // 今の会話ログのパス
  transcriptOf(id: string): string | null {
    const record = this.store.get(id);
    return record ? transcriptPath(record.cwd, record.claudeSessionId) : null;
  }

  history(id: string): Promise<ChatEvent[]> {
    const record = this.store.get(id);
    if (!record) return Promise.resolve([]);
    return readChatLog(transcriptPath(record.cwd, record.claudeSessionId), record.cwd);
  }

  // 未起動・終了済みなら起動（再開）する。起動中なら何もしない
  open(id: string): void {
    if (this.runtimes.get(id)?.process) return;
    if (this.store.get(id)?.archived) this.store.update(id, { archived: false });
    this.start(id);
  }

  archive(id: string): void {
    const rt = this.runtimes.get(id);
    rt?.process?.kill();
    rt?.screen?.dispose();
    rt?.workflows.dispose();
    rt?.subagents.dispose();
    rt?.bashTasks.dispose();
    if (rt) this.watchers.release(this.cwdOf(id));
    this.runtimes.delete(id);
    this.store.update(id, { archived: true });
    this.emitSessions();
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

  bashTasks(id: string): BashTask[] {
    return this.runtimes.get(id)?.bashTasks.all() ?? [];
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

  activity(id: string): Activity | null {
    return this.runtimes.get(id)?.screen?.currentActivity ?? null;
  }

  async setMode(id: string, mode: PermissionMode): Promise<boolean> {
    return (await this.runtimes.get(id)?.screen?.setMode(mode)) ?? false;
  }

  async rewind(id: string, text: string): Promise<boolean> {
    return (await this.runtimes.get(id)?.screen?.rewindTo(text)) ?? false;
  }

  async choose(id: string, choice: ScreenChoice): Promise<void> {
    await this.runtimes.get(id)?.screen?.choose(choice.optionId, choice.key, choice.text);
  }

  configure(id: string, options: SessionOptions): void {
    const modelChanged = (this.store.get(id)?.model ?? null) !== options.model;
    // モデルを変えたら、1M コンテキストかどうかは起動時の表示で分かり直す
    this.store.update(id, { model: options.model, effort: options.effort, ...(modelChanged ? { oneMillion: undefined } : {}) });
    if (this.runtimes.get(id)?.process) this.restart(id);
    else this.emitSessions();
  }

  // Claude Code を起動し直して同じ会話を続ける（--resume）。スキル・CLAUDE.md・設定・MCP などを読み込み直すため。
  // 権限モードは起動し直すと既定に戻るので、--permission-mode で元のモードを渡す
  restart(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt?.process) {
      this.open(id);
      return;
    }
    const mode = rt.screen?.current.mode ?? rt.startMode;
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
    for (const rt of this.runtimes.values()) {
      if (stop) rt.process?.kill();
      else rt.process?.detach();
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

    // 会話が一度も無いセッションは --resume できないため、新しいセッション ID で始め直す
    const resume = !!adopted || hasConversation(transcriptPath(record.cwd, record.claudeSessionId));
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
      rt = {
        process: null,
        seq: 0,
        events: [],
        unread: false,
        workflows,
        workflowScripts: new Map(),
        subagents,
        agentToolIds: new Set(),
        sendMessageIds: new Set(),
        askToolId: null,
        bashInputs: new Map(),
        bashTasks: new BashTaskTracker((tasks) => {
          this.listeners.onBashTasks(id, tasks);
          this.countBackground(id);
        }),
        knowledge: new KnowledgeTracker(record.cwd, (value) => this.listeners.onKnowledge(id, value)),
        statusLine: null,
        chain: [],
        screen: null,
        attention: null,
        background: 0,
        ready: false,
        startMode: null,
        size: DEFAULT_PTY_SIZE,
        aliveSince: null,
        turnOpen: false,
        queue: [],
        remoteConnected: false,
        remoteSwitching: false,
        historyLoaded: false,
        lastBridgeUrl: undefined,
        remoteTried: null,
      };
      this.runtimes.set(id, rt);
      this.watchers.retain(record.cwd);
    }
    rt.events = [];
    rt.chain = [];
    // 再開すると過去の会話を読み直すので、そこから集め直す
    rt.knowledge.reset();
    this.pushEvents(id, [{ type: 'process-start' }]);
    const runtime = rt;
    runtime.screen?.dispose();
    runtime.attention = null;
    runtime.ready = false;
    runtime.startMode = mode;
    runtime.aliveSince = adopted?.startedAt ?? null;
    runtime.turnOpen = false;
    runtime.queue = [];
    // --remote-control を付けて起動するなら、つながるのを待つ。
    // 引き継いだ claude は付けて起動したか分からないが、つながった記録は起動のあとに書かれるので、会話ログを読み直すと分かる
    const remote = this.wantsRemote(record);
    runtime.remoteConnected = remote && !adopted ? null : false;
    runtime.remoteSwitching = false;
    // 読み直す会話ログが無ければ（新しい会話）、読み終わりの知らせは来ないので、はじめから読み終えたことにする
    runtime.historyLoaded = fileSize(transcriptPath(record.cwd, claudeSessionId)) === 0;
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

    rt.process = new ClaudeSession(
      this.host,
      {
        sessionId: id,
        cwd: record.cwd,
        claudeSessionId,
        resume,
        remoteControlName: remote ? remoteName(record.cwd) : null,
        model: record.model ?? null,
        effort: record.effort ?? null,
        permissionMode: mode,
        statusFile: this.statusLines.fileFor(id),
        askFile: this.statusLines.askFileFor(id),
        ...rt.size,
      },
      {
        onData: (data) => {
          screen.feed(data);
          this.listeners.onPtyData(id, data);
        },
        onExit: (exitCode) => {
          rt.process = null;
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
          this.pushEvents(id, [{ type: 'reset' }]);
        },
      },
      adopted,
    );
    rt.process.start();
    // 引き継いだ claude は前のアプリの頃から動いていて、会話もしている。画面から入力欄を読めるのを待たずに、起動済みとする
    // （入力欄を読むのは画面が描き直されたときなので、読み取りがずれたまま Claude Code が何も描かずに待っていると、いつまでも「起動中」になる）
    if (adopted && hasConversation(transcriptPath(record.cwd, claudeSessionId))) screen.markReady();
    if (adopted && (adopted.cols !== rt.size.cols || adopted.rows !== rt.size.rows)) this.resize(id, rt.size.cols, rt.size.rows);
    this.emitSessions();
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

  // バックグラウンドで動くもの（ワークフロー・サブエージェント）の起動・結果・完了通知を追う。
  // isHistory: 前に起動した claude が書いた行（今は動いていない）
  // isHistory: 前の起動の行（過去のもの）。replaying: 読み直している行（引き継いだ claude が書いた、今も続いている行を含む）
  private trackTasks(id: string, rt: Runtime, entry: TranscriptEntry, isHistory: boolean, replaying: boolean): void {
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'Workflow' && block.id && typeof block.input?.script === 'string') {
        rt.workflowScripts.set(block.id, block.input.script);
      }
      if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task') && block.id) {
        rt.agentToolIds.add(block.id);
        if (!isHistory) rt.subagents.start(block.id, this.sessionDir(id), isTrue(block.input?.run_in_background));
      }
      if (block.type === 'tool_use' && block.name === 'SendMessage' && block.id) rt.sendMessageIds.add(block.id);
      if (block.type === 'tool_result' && block.tool_use_id && rt.sendMessageIds.has(block.tool_use_id)) {
        const agentId = resumedAgentOf(entry.toolUseResult, block.content);
        if (agentId) rt.subagents.resume(block.tool_use_id, agentId, this.sessionDir(id), isHistory);
      }
      if (block.type === 'tool_result' && block.tool_use_id && rt.agentToolIds.has(block.tool_use_id)) {
        rt.subagents.finish(block.tool_use_id, entry.toolUseResult, !!block.is_error, isHistory);
      }
      // 質問の選択メニューは、画面ではなく AskUserQuestion の input から組み立てる（画面が低いと選択肢の一部しか出ない）
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.id && !isHistory) {
        rt.askToolId = block.id;
        rt.screen?.setQuestions(askQuestionsOf(block.input));
      }
      if (block.type === 'tool_result' && block.tool_use_id && block.tool_use_id === rt.askToolId) {
        rt.askToolId = null;
        // 読み直しで届いた答えは、今の画面の質問への答えではない
        rt.screen?.setQuestions(null, !replaying);
      }
      if (block.type === 'tool_use' && block.name === 'Bash' && block.id && block.input && isTrue(block.input.run_in_background)) {
        rt.bashInputs.set(block.id, block.input);
      }
      const bashInput = block.type === 'tool_result' && block.tool_use_id ? rt.bashInputs.get(block.tool_use_id) : undefined;
      if (bashInput) rt.bashTasks.start(block.tool_use_id!, bashInput, entry.toolUseResult, resultText(block.content), isHistory);
    }
    const launch = workflowLaunchOf(entry, rt.workflowScripts);
    if (launch) rt.workflows.add(launch, isHistory);

    const notice = taskNotificationOf(entry);
    const notified = notice?.text.match(/<tool-use-id>(.*?)<\/tool-use-id>[\s\S]*?<status>(.*?)<\/status>/);
    if (notice && notified) {
      rt.workflows.notified(notified[1], notified[2]);
      const result = notice.text.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim() ?? null;
      rt.subagents.notified(notified[1], notified[2], result, notice.usage);
      rt.bashTasks.notified(notified[1], notified[2]);
    }
  }

  // 作業中に送った発言は、Claude Code が受け取るまで会話ログに発言として書かれず、順番待ち（queue-operation）にだけ書かれる。
  // それを追って、受け取られるまでチャットに「順番待ち」として出す
  private trackQueue(id: string, rt: Runtime, entry: TranscriptEntry): void {
    const e = entry as TranscriptEntry & { operation?: string; content?: unknown };
    if (entry.type !== 'queue-operation') return;
    const text = queuedText(e.content);
    if (e.operation === 'enqueue' && text !== null) {
      const human = !text.includes('<task-notification>') && !text.trimStart().startsWith('<ci-monitor-event>');
      this.updateQueue(id, rt, (queue) => [...queue, { text, human }]);
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
    const human = (queue: Runtime['queue']) => queue.filter((q) => q.human).map((q) => q.text);
    const before = human(rt.queue);
    rt.queue = change(rt.queue);
    const after = human(rt.queue);
    if (after.length !== before.length || after.some((t, i) => t !== before[i])) this.pushEvents(id, [{ type: 'queue', prompts: after }]);
  }

  // 今の会話ログのセッションのフォルダ（subagents/・workflows/ がある）
  private sessionDir(id: string): string {
    const record = this.store.get(id)!;
    return join(dirname(transcriptPath(record.cwd, record.claudeSessionId)), record.claudeSessionId);
  }

  private handleScreen(id: string, screen: ScreenTracker, info: ScreenInfo): void {
    const rt = this.runtimes.get(id);
    if (!rt || rt.screen !== screen) return;
    // /remote-control で切り替えている途中に出るメニューは、質問や確認として見せない
    if (rt.remoteSwitching) return;
    this.listeners.onScreen(id, info);
    if (info.ready && !rt.ready) {
      rt.ready = true;
      this.pushEvents(id, [{ type: 'ready' }]);
    }
    const oneMillion = screen.oneMillionSeen;
    if (oneMillion !== null && this.store.get(id)?.oneMillion !== oneMillion) this.store.update(id, { oneMillion });
    if (info.state.kind === 'prompt') this.reconcileRemote(id);
    const attention = info.state.kind === 'menu' ? info.state.menu.kind : info.state.kind === 'unknown' ? 'other' : null;
    if (attention === rt.attention) return;
    const before = rt.attention;
    rt.attention = attention;
    this.emitSessions();
    const summary = this.summary(id);
    if (summary && before === null && info.state.kind === 'menu') this.listeners.onAttention(summary);
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
    if (rt) this.trackTasks(id, rt, entry, past, isHistory);
    if (rt && !past) this.trackQueue(id, rt, entry);
    rt?.knowledge.handle(entry);

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
      if (events.some((e) => e.type === 'user' || e.type === 'notice' || e.type === 'turn-start')) rt.turnOpen = true;
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
        if (summary) this.listeners.onTurnCompleted(summary);
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
  }

  private emitSessions(): void {
    this.listeners.onSessionsChanged(this.list());
  }
}

// 会話ログの応答のモデル ID を表示名にする（例: claude-sonnet-5 → Sonnet 5、claude-fable-5-1 → Fable 5.1）
function modelOf(entry: TranscriptEntry): string | null {
  const id = entry.type === 'assistant' ? entry.message?.model : undefined;
  // 新しい系統名のモデルにも対応できるよう、名前は決め打ちしない
  const m = id?.match(/^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?/);
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

// Remote Control のセッション名（スマホの一覧に出る）
function remoteName(cwd: string): string {
  return `tanacode-${basename(cwd)}`;
}

// 動いている Claude Code の状態の文言（セッション一覧の文言にそろえる）
function stateLabel(rt: Runtime): string {
  if (rt.attention === 'question') return '質問への回答待ち';
  if (rt.attention === 'permission') return '実行の許可待ち';
  if (rt.attention === 'other') return '操作待ち';
  if (!rt.ready) return '起動中';
  const background = rt.background > 0 ? `バックグラウンド ${rt.background}件` : null;
  if (rt.turnOpen) return background ? `作業中（${background}）` : '作業中';
  if (background) return `${background}の完了待ち`;
  return '待機中';
}

// run_in_background は真偽値のほか、文字列の "true" で来ることもある
function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

export type TaskUsage = { durationMs: number | null; totalTokens: number | null; toolUses: number | null };

// バックグラウンドのタスクの完了通知（<task-notification>）。書かれ方は 3 通りあり、同じ通知が複数の形で書かれることもある
// （受け取る側は何度受け取っても同じ結果になる）:
// - ユーザーの発言の行（Claude が待っているときに届いた）
// - attachment の queued_command（Claude の作業中に届いて、そのターンに差し込まれた。所要時間などが付く）
// - queue-operation の enqueue（届いた時点のキュー。どの通知にもある）
export function taskNotificationOf(entry: TranscriptEntry): { text: string; usage: TaskUsage | null } | null {
  const e = entry as TranscriptEntry & { operation?: string; content?: unknown };
  let text: unknown = null;
  let usage: TaskUsage | null = null;
  if (entry.type === 'user') text = entry.message?.content;
  else if (entry.type === 'queue-operation' && e.operation === 'enqueue') text = e.content;
  else if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
    text = entry.attachment.prompt;
    const u = entry.attachment.usage as Record<string, unknown> | undefined;
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    if (u) usage = { durationMs: num(u.durationMs), totalTokens: num(u.totalTokens), toolUses: num(u.toolUses) };
  }
  return typeof text === 'string' && text.includes('<task-notification>') ? { text, usage } : null;
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

// SendMessage の結果から、再開したエージェントの ID を読む（{"success":true,"resumedAgentId":"…"}）
function resumedAgentOf(toolUseResult: unknown, content: unknown): string | null {
  const read = (value: unknown): string | null => {
    const id = (value as { resumedAgentId?: unknown } | null)?.resumedAgentId;
    return typeof id === 'string' && id ? id : null;
  };
  if (read(toolUseResult)) return read(toolUseResult);
  try {
    return read(JSON.parse(resultText(content)));
  } catch {
    return null;
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: { text?: unknown }) => (typeof b.text === 'string' ? b.text : '')).join('\n');
}
