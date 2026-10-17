import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChatEvent } from '@shared/chat';
import type { ChatBatch, NewSessionOptions, SessionSummary } from '@shared/ipc';
import type { Activity, Menu } from '@shared/screen';
import type { PendingPermission, PendingQuestion } from '@shared/questions';
import type { StatusLineInfo } from '@shared/statusline';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import type { BrowserMcpLaunch } from '../../src/main/browser-bridge';
import { transcriptPath } from '../../src/main/claude-session';
import type { TurnNotice } from '../../src/main/compact-notice';
import type { McpLaunch } from '../../src/main/mcp-bridge';
import type { PipeHandle, PtyHandle, PtyHostApi } from '../../src/main/pty-host-client';
import type { HostedInfo, HostedPipeInfo, HostedPtyInfo, PipeSpawnRequest, PtySpawnRequest } from '../../src/main/pty-host-protocol';
import { SessionManager, type RunTask } from '../../src/main/session-manager';
import type { SettingsFiles } from '../../src/main/settings-files';
import { SessionStore } from '../../src/main/session-store';
import { StatusLineWatcher } from '../../src/main/statusline';
import { WorkspaceWatchers } from '../../src/main/workspace-watcher';


// 本物の claude を起動せずに、本物の SessionManager を動かす部品（npm test 用。速く、決まった結果になる）。
// 常駐のホストを、テストが stream-json の行と終了を送る偽物（ScriptedHost）に差し替え、会話ログの行はテストが書き込む。
// 制御の要求（initialize など）には、台本の答えを自動で返す（ScriptedPipe.answers で変えられる）。
// 組み立て方は src/main/index.ts・test/cli/claude-run.ts と同じ（SessionStore・StatusLineWatcher・WorkspaceWatchers は本物）。
// 本物の Claude Code での振る舞いは npm run test:cli（test/cli）が確かめる。ここでは、その上の SessionManager の分岐を確かめる

// claude の代わりの pty。打たれたキー・大きさの変更・終了の頼みを控える
export class ScriptedPty implements PtyHandle {
  readonly writes: string[] = [];
  readonly resizes: [number, number][] = [];
  killed = false;
  detached = false;
  // 止めたら、すぐ終わる（終了を知らせる）。本物の claude は止めると終わる。ClaudeSession.stop は終わるのを待つ
  exitOnKill = false;
  // キーを受けたときの claude の反応（テストが決める。画面を描き直すなど）
  onWrite: ((data: string) => void) | null = null;
  private readonly dataListeners: ((data: string) => void)[] = [];
  private readonly exitListeners: ((code: number) => void)[] = [];
  // まだ受け手がいない間に送った出力
  private early: string[] = [];

  constructor(
    readonly id: string,
    readonly request: Omit<PtySpawnRequest, 'id' | 'kind'>,
  ) {}

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
    const early = this.early;
    this.early = [];
    early.forEach(listener);
  }

  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener);
  }

  write(data: string): void {
    this.writes.push(data);
    this.onWrite?.(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  // 止める頼みの合図（既定の止め方は undefined）
  readonly kills: ('SIGTERM' | 'SIGKILL' | undefined)[] = [];

  kill(signal?: 'SIGTERM' | 'SIGKILL'): void {
    this.killed = true;
    this.kills.push(signal);
    if (this.exitOnKill) this.exit(0);
  }

  detach(): void {
    this.detached = true;
  }

  // claude が画面に描いた（端末への出力）
  output(data: string): void {
    if (this.dataListeners.length === 0) this.early.push(data);
    else this.dataListeners.forEach((l) => l(data));
  }

  // claude が終わった
  exit(code: number): void {
    this.exitListeners.forEach((l) => l(code));
  }

  // 打たれたキーをつなげたもの
  get typed(): string {
    return this.writes.join('');
  }

  // 起動の引数（--session-id・--resume の値など）
  arg(name: string): string | null {
    const i = this.request.args.indexOf(name);
    return i >= 0 ? (this.request.args[i + 1] ?? null) : null;
  }
}

// 制御の要求への答え。値は返事の中身、Error なら error の返事、null なら答えない（テストが respond・fail で答える）。
// 関数なら、要求の中身から作る
export type ControlAnswer = Record<string, unknown> | Error | null | ((request: Record<string, unknown>) => Record<string, unknown> | Error | null);

// stream-json の claude の代わりのパイプ。アプリが書いた行・入力を閉じた・止める頼みを控え、テストが出力の行と終了を送る
export class ScriptedPipe implements PipeHandle {
  readonly sent: string[] = [];
  ended = false;
  readonly kills: ('SIGTERM' | 'SIGKILL' | undefined)[] = [];
  readonly replays: number[] = [];
  detached = false;
  // 入力の行を受けたときの claude の反応（テストが決める。制御の要求に答えるなど）
  onSend: ((line: string) => void) | null = null;
  // 制御の要求に、台本の答えを自動で返す（answers に無い種類は defaultAnswer）。false なら答えない
  autoAnswer = false;
  // 要求の種類（subtype）ごとの答え。defaultAnswer より先に見る
  readonly answers = new Map<string, ControlAnswer>();
  // end_session を受けたら終わる（本物は 0.1〜0.2 秒で終わる。実測）。止める頼み（kill）でも終わる
  exitOnEnd = false;
  exitedWith: number | null = null;
  private seq = 0;
  private readonly lineListeners: ((line: string, seq: number) => void)[] = [];
  private readonly exitListeners: ((code: number, stderr: string) => void)[] = [];
  private readonly replayedListeners: (() => void)[] = [];
  // まだ受け手がいない間に送った行
  private early: { line: string; seq: number }[] = [];

  constructor(
    readonly id: string,
    readonly request: Omit<PipeSpawnRequest, 'id' | 'kind'>,
  ) {}

  onLine(listener: (line: string, seq: number) => void): void {
    this.lineListeners.push(listener);
    const early = this.early;
    this.early = [];
    for (const item of early) listener(item.line, item.seq);
  }

  onExit(listener: (code: number, stderr: string) => void): void {
    this.exitListeners.push(listener);
  }

  send(line: string): void {
    this.sent.push(line);
    this.onSend?.(line);
    const value = JSON.parse(line) as { type?: string; request_id?: string; request?: Record<string, unknown> };
    if (value.type !== 'control_request' || !this.autoAnswer || !value.request_id || !value.request) return;
    const request = value.request;
    const subtype = String(request.subtype);
    const given = this.answers.has(subtype) ? this.answers.get(subtype)! : defaultAnswer(subtype, this);
    const answer = typeof given === 'function' ? given(request) : given;
    if (answer === null) return;
    const requestId = value.request_id;
    // 本物と同じく、要求を書き終えてから返事が届く
    queueMicrotask(() => {
      if (answer instanceof Error) this.fail(requestId, answer.message);
      else this.respond(requestId, answer);
      if (subtype === 'end_session' && this.exitOnEnd) this.exit(0);
    });
  }

  end(): void {
    this.ended = true;
  }

  kill(signal?: 'SIGTERM' | 'SIGKILL'): void {
    this.kills.push(signal);
    if (this.exitOnEnd) this.exit(signal === 'SIGKILL' ? 137 : 143);
  }

  // アプリの制御の要求に答える
  respond(requestId: string, response: Record<string, unknown> = {}): void {
    this.emit({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  fail(requestId: string, error: string): void {
    this.emit({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
  }

  // アプリが送った制御の要求（subtype を渡せば、その種類だけ）
  requests(subtype?: string): { request_id: string; request: Record<string, unknown> & { subtype: string } }[] {
    return this.messages
      .filter((m) => m.type === 'control_request')
      .map((m) => m as { request_id: string; request: Record<string, unknown> & { subtype: string } })
      .filter((m) => subtype === undefined || m.request.subtype === subtype);
  }

  // アプリが送った発言
  get prompts(): { uuid: string; message: { content: unknown }; priority?: string; pasted_content?: string[] }[] {
    return this.messages.filter((m) => m.type === 'user') as { uuid: string; message: { content: unknown }; priority?: string; pasted_content?: string[] }[];
  }

  replay(from: number): void {
    this.replays.push(from);
  }

  onReplayed(listener: () => void): void {
    this.replayedListeners.push(listener);
  }

  // 送り直しが終わった（ホストの replayed）
  replayed(): void {
    this.replayedListeners.forEach((l) => l());
  }

  detach(): void {
    this.detached = true;
  }

  // 次に出す行の通し番号を、seq の次にする（引き継いだパイプ）
  continueFrom(seq: number): void {
    this.seq = seq;
  }

  // claude が 1 行出した（JSON の値はそのまま行にする）。seq: 通し番号（省くと前の行の次。引き継ぎの送り直しを作るとき）
  emit(value: unknown, seq?: number): void {
    const line = typeof value === 'string' ? value : JSON.stringify(value);
    if (seq !== undefined) this.seq = seq - 1;
    seq = ++this.seq;
    if (this.lineListeners.length === 0) this.early.push({ line, seq });
    else this.lineListeners.forEach((l) => l(line, seq));
  }

  // claude が終わった（2 回目からは何もしない）
  exit(code: number, stderr = ''): void {
    if (this.exitedWith !== null) return;
    this.exitedWith = code;
    this.exitListeners.forEach((l) => l(code, stderr));
  }

  // アプリが書いた行を読んだもの
  get messages(): Record<string, unknown>[] {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  // 起動の引数（--session-id・--resume の値など）
  arg(name: string): string | null {
    const i = this.request.args.indexOf(name);
    return i >= 0 ? (this.request.args[i + 1] ?? null) : null;
  }
}

// 常駐のホストの代わり。起動した pty・パイプを控え、list で返すもの（引き継ぎ）はテストが決める。
// scripted: 起動・引き継いだパイプが、制御の要求に台本の答えを返し、止める頼みで終わる（ScriptedApp）。false なら、テストがすべて送る
export class ScriptedHost implements PtyHostApi {
  readonly spawned: ScriptedPty[] = [];
  readonly attached: ScriptedPty[] = [];
  readonly pipes: ScriptedPipe[] = [];
  readonly attachedPipes: ScriptedPipe[] = [];
  // 起動したものと引き継いだものを、作った順に
  readonly allPipes: ScriptedPipe[] = [];
  readonly forgotten: string[] = [];
  hosted: HostedInfo[] = [];

  // これから起動・引き継ぐパイプの、制御の要求への答え（ScriptedPipe.answers に写す）
  readonly answers = new Map<string, ControlAnswer>();

  constructor(private readonly scripted = false) {}

  private script(pipe: ScriptedPipe): ScriptedPipe {
    this.allPipes.push(pipe);
    pipe.autoAnswer = this.scripted;
    pipe.exitOnEnd = this.scripted;
    for (const [subtype, answer] of this.answers) pipe.answers.set(subtype, answer);
    return pipe;
  }

  list(): Promise<HostedInfo[]> {
    return Promise.resolve(this.hosted);
  }

  spawn(request: Omit<PtySpawnRequest, 'id' | 'kind'>): PtyHandle {
    const pty = new ScriptedPty(randomUUID(), request);
    this.spawned.push(pty);
    return pty;
  }

  spawnPipe(request: Omit<PipeSpawnRequest, 'id' | 'kind'>): PipeHandle {
    const pipe = this.script(new ScriptedPipe(randomUUID(), request));
    this.pipes.push(pipe);
    return pipe;
  }

  attach(info: HostedPtyInfo): PtyHandle {
    const pty = new ScriptedPty(info.id, { tag: info.tag, file: 'claude', args: [], cwd: '', env: {}, cols: info.cols, rows: info.rows });
    this.attached.push(pty);
    return pty;
  }

  attachPipe(info: HostedPipeInfo): PipeHandle {
    const pipe = this.script(new ScriptedPipe(info.id, { tag: info.tag, file: 'claude', args: [], cwd: '', env: {}, retain: [], transient: [] }));
    // これから出す行は、控えている行（lastSeq まで）の続きの番号
    pipe.continueFrom(info.lastSeq);
    this.attachedPipes.push(pipe);
    return pipe;
  }

  forget(id: string): void {
    this.forgotten.push(id);
  }
}

export type Attention = { kind: 'menu'; menu: Menu };

// SessionManager の、アプリが組み立てるときに渡す残りの引数（省けば SessionManager の既定）
export type ScriptedOptions = {
  remoteControlAvailable?: boolean;
  settingsFiles?: SettingsFiles | null;
  runTask?: RunTask;
  browser?: () => BrowserMcpLaunch | null;
  sessionsMcp?: () => McpLaunch | null;
  checklistMcp?: () => McpLaunch | null;
  walkthroughMcp?: () => McpLaunch | null;
  // プロファイルの Claude Code の設定のフォルダ（無ければ既定のプロファイル）
  claudeDir?: string | null;
};

// SessionManager と、それが配信したもの
export class ScriptedApp {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-scripted-')));
  readonly home = join(this.root, 'home');
  readonly cwd = join(this.root, 'work');
  readonly userData = join(this.root, 'userData');
  readonly host = new ScriptedHost(true);
  // これから起動する claude の、制御の要求への答え（起動の直後に答えるので、変えるなら起動の前に）
  readonly answers = this.host.answers;
  readonly claudeDir: string | null;
  readonly chat = new Map<string, ChatEvent[]>();
  readonly batches: ChatBatch[] = [];
  readonly attentions: { id: string; attention: Attention }[] = [];
  readonly turnsCompleted: SessionSummary[] = [];
  // 完了の知らせの種類を、届いた順に（turnsCompleted と同じ並び）
  readonly turnNotices: TurnNotice[] = [];
  // 作業中の進み具合の知らせ（最後のもの）
  readonly progress = new Map<string, Activity | null>();
  readonly bashTasks = new Map<string, BashTask[]>();
  readonly workflows = new Map<string, WorkflowRun[]>();
  readonly subagents = new Map<string, SubagentRun[]>();
  readonly statusLineInfos = new Map<string, StatusLineInfo>();
  // 画面に流した Claude Code の画面の出力（ターミナルモード）
  readonly ptyData: { id: string; data: string }[] = [];
  // 答えを待っている質問の知らせ（onQuestion）を、届いた順に
  readonly questionLog: { id: string; question: PendingQuestion | null }[] = [];
  // 答えを待っている許可の確認の知らせ（onPermission）を、届いた順に
  readonly permissionLog: { id: string; permission: PendingPermission | null }[] = [];
  sessions: SessionSummary[] = [];
  // 一覧を知らせるたびの中身（途中の「準備中」なども見られるように）
  readonly sessionLists: SessionSummary[][] = [];
  readonly manager: SessionManager;
  readonly statusLines: StatusLineWatcher;
  private readonly oldHome = process.env.HOME;

  constructor(options: ScriptedOptions = {}) {
    mkdirSync(join(this.home, '.claude'), { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
    // 会話ログのパス（transcriptPath）とユーザーの statusLine（sessionSettings）は homedir() を見る
    process.env.HOME = this.home;
    const statusDir = join(this.userData, 'statusline');
    mkdirSync(statusDir, { recursive: true });
    this.statusLines = new StatusLineWatcher(
      statusDir,
      (id, info) => this.manager.statusLineChanged(id, info),
    );
    this.manager = new SessionManager(
      this.host,
      new SessionStore(join(this.userData, 'sessions.json')),
      new WorkspaceWatchers(() => {}),
      this.statusLines,
      {
        onSessionsChanged: (sessions) => {
          this.sessions = sessions;
          this.sessionLists.push(sessions);
        },
        onChat: (sent) => {
          // アプリの IPC と同じく、送った時点の中身を写して受け取る
          const batch = structuredClone(sent);
          this.batches.push(batch);
          this.chat.set(batch.sessionId, [...(this.chat.get(batch.sessionId) ?? []), ...batch.events]);
        },
        onPtyData: (id, data) => this.ptyData.push({ id, data }),
        onTurnCompleted: (session, notice) => {
          this.turnsCompleted.push(session);
          this.turnNotices.push(notice);
        },
        onProgress: (id, activity) => this.progress.set(id, activity),
        onWorkflows: (id, runs) => this.workflows.set(id, runs),
        onSubagents: (id, runs) => this.subagents.set(id, runs),
        onBashTasks: (id, tasks) => this.bashTasks.set(id, tasks),
        onKnowledge: () => {},
        onStatusLine: (id, info) => this.statusLineInfos.set(id, info),
        onAttention: (session, attention) => this.attentions.push({ id: session.id, attention }),
        onQuestion: (id, question) => this.questionLog.push({ id, question }),
        onPermission: (id, permission) => this.permissionLog.push({ id, permission }),
      },
      options.remoteControlAvailable,
      options.settingsFiles,
      options.runTask,
      options.browser,
      options.sessionsMcp,
      options.checklistMcp,
      options.walkthroughMcp,
      options.claudeDir ?? null,
    );
    this.claudeDir = options.claudeDir ?? null;
  }

  // 新しいセッションを作る（Claude Code を起動する）。起動したパイプを返す
  create(options: Partial<NewSessionOptions> = {}, parentId: string | null = null): { id: string; pipe: ScriptedPipe } {
    const id = this.manager.create(
      this.cwd,
      { model: null, effort: null, settingsFile: null, mode: null, remoteControl: false, worktree: false, ...options },
      parentId,
    );
    return { id, pipe: this.pipe(id) };
  }

  // そのセッションでいちばん新しく起動した（引き継いだ）パイプ
  pipe(id: string): ScriptedPipe {
    const pipe = [...this.host.allPipes].reverse().find((p) => p.request.tag === id);
    if (!pipe) throw new Error(`${id} のパイプがありません`);
    return pipe;
  }

  // 起動が終わり（initialize の返事を受け）、発言を受け付けられるようになるのを待つ
  ready(id: string): Promise<void> {
    return this.waitFor('起動', () => this.manager.summary(id)?.running === true && this.manager.stateOf(id) !== 'starting');
  }

  // 今の claude の会話の ID（--session-id か --resume の値）
  claudeId(id: string): string {
    const pipe = this.pipe(id);
    const claudeId = pipe.arg('--session-id') ?? pipe.arg('--resume') ?? this.manager.claudeSessionOf(id);
    if (!claudeId) throw new Error('会話の ID が起動の引数にありません');
    return claudeId;
  }

  // そのセッションの会話ログ（今の claude の --session-id か --resume の会話）
  transcript(id: string): string {
    return transcriptPath(this.cwd, this.claudeId(id), this.claudeDir);
  }

  // 会話ログに行を書き足す（claude が書いたことにする）
  append(id: string, ...entries: Record<string, unknown>[]): void {
    const file = this.transcript(id);
    mkdirSync(dirname(file), { recursive: true });
    const claudeId = this.claudeId(id);
    appendFileSync(file, entries.map((e) => JSON.stringify({ sessionId: claudeId, cwd: this.cwd, ...e })).join('\n') + '\n');
  }

  // claude が応答した。会話ログに書き、stream-json にも出す（本体の assistant の行は、同じ uuid で両方に出る。実測）
  say(id: string, ...entries: Record<string, unknown>[]): void {
    this.append(id, ...entries);
    for (const entry of entries) if (entry.type === 'assistant') this.pipe(id).emit(stream.assistant(entry, this.claudeId(id)));
  }

  // ターンが終わった（result）
  finish(id: string, extra: Record<string, unknown> = {}): void {
    this.pipe(id).emit(stream.result(this.claudeId(id), extra));
  }

  // 画面から送る。送った発言の uuid（会話ログの行の uuid にもなる）を返す
  async send(id: string, text: string, attachments: string[] = [], pastes: string[] = []): Promise<string> {
    const before = this.pipe(id).prompts.length;
    await this.manager.submit(id, text, attachments, pastes);
    const sent = this.pipe(id).prompts[before];
    if (!sent) throw new Error('発言が送られていません');
    return sent.uuid;
  }

  // 人が発言して、Claude Code がターンを始めた（送る → command_lifecycle の started → 会話ログに同じ uuid の発言の行）。発言の uuid を返す
  async prompt(id: string, text: string): Promise<string> {
    const uuid = await this.send(id, text);
    this.pipe(id).emit(stream.lifecycle(uuid, 'started'));
    this.append(id, { ...line.user(text), uuid });
    return uuid;
  }

  events(id: string): ChatEvent[] {
    return this.chat.get(id) ?? [];
  }

  async waitFor(label: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > until) throw new Error(`${label}: 時間切れ`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  dispose(): void {
    this.manager.closeAll(true);
    process.env.HOME = this.oldHome;
    rmSync(this.root, { recursive: true, force: true });
  }
}

// 会話ログの行（Claude Code が書く形のうち、アプリが読むところ）。timestamp は今（起動より後の行は、今動いている claude が書いたもの）
let seq = 0;
const base = () => ({ uuid: randomUUID(), timestamp: new Date(Date.now() + seq++).toISOString(), isSidechain: false, userType: 'external' });

export const line = {
  user: (text: string) => ({ ...base(), type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' } }),
  text: (text: string) => ({ ...base(), type: 'assistant', message: { id: `msg_${seq}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] } }),
  toolUse: (id: string, name: string, input: Record<string, unknown>) => ({
    ...base(),
    type: 'assistant',
    message: { id: `msg_${seq}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] },
  }),
  toolResult: (id: string, content: string, extra: Record<string, unknown> = {}) => ({
    ...base(),
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    ...extra,
  }),
  turnEnd: () => ({ ...base(), type: 'system', subtype: 'turn_duration', durationMs: 100 }),
};

// 台本の claude の、制御の要求への既定の答え
export const INIT_RESPONSE = {
  commands: [],
  agents: [],
  models: [{ value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high'], supportsAutoMode: true }],
  account: { tokenSource: 'none', apiKeySource: 'none' },
  pid: 4242,
  claude_code_version: '2.1.301',
};

// 起動の --permission-mode（アプリの名前）を、Claude Code が返す名前にする
const STREAM_MODES: Record<string, string> = { manual: 'default' };

function defaultAnswer(subtype: string, pipe: ScriptedPipe): ControlAnswer {
  switch (subtype) {
    case 'initialize': {
      // 引き継いだパイプは起動の引数が分からないので、モードを答えない（テストが answers で決める）
      const mode = pipe.arg('--permission-mode');
      return { ...INIT_RESPONSE, ...(mode ? { current_permission_mode: STREAM_MODES[mode] ?? mode } : {}) };
    }
    case 'get_settings':
      return { effective: {}, sources: [], applied: { model: 'claude-opus-5-5', effort: null } };
    case 'get_context_usage':
      return { totalTokens: 12_000, maxTokens: 200_000, percentage: 6 };
    default:
      return {};
  }
}

// stream-json の出力の行（Claude Code が書く形のうち、アプリが読むところ）
export const stream = {
  init: (sessionId: string, extra: Record<string, unknown> = {}) => ({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    claude_code_version: '2.1.301',
    uuid: randomUUID(),
    ...extra,
  }),
  status: (permissionMode: string) => ({ type: 'system', subtype: 'status', status: null, permissionMode, uuid: randomUUID() }),
  // 会話ログの assistant の行（line.text など）を、同じ uuid の stream-json の行にする
  assistant: (entry: Record<string, unknown>, sessionId = 'session') => ({
    type: 'assistant',
    uuid: entry.uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: entry.message,
  }),
  result: (sessionId = 'session', extra: Record<string, unknown> = {}) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    terminal_reason: 'completed',
    num_turns: 1,
    total_cost_usd: 0.01,
    session_id: sessionId,
    uuid: randomUUID(),
    ...extra,
  }),
  // 中断で終わったターン（応答を待っている間なら aborted_streaming、ツールの途中・許可待ちなら aborted_tools。実測）
  interrupted: (sessionId = 'session', reason = 'aborted_streaming') =>
    stream.result(sessionId, { subtype: 'error_during_execution', is_error: true, terminal_reason: reason }),
  lifecycle: (commandUuid: string, state: 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded') => ({
    type: 'command_lifecycle',
    command_uuid: commandUuid,
    state,
    uuid: randomUUID(),
  }),
  // 書いている途中の行（content_block_start の種類: thinking・text・tool_use）
  blockStart: (kind: string, parent: string | null = null) => ({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: kind } },
    parent_tool_use_id: parent,
    uuid: randomUUID(),
  }),
  tokens: (outputTokens: number) => ({
    type: 'stream_event',
    event: { type: 'message_delta', delta: {}, usage: { output_tokens: outputTokens } },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  }),
  // スマホ・claude.ai から届いた発言（--replay-user-messages で戻る行）
  remoteUser: (text: string) => ({
    type: 'user',
    uuid: randomUUID(),
    isReplay: true,
    origin: { kind: 'human' },
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
  }),
};
