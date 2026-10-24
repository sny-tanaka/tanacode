import { basename, join } from 'node:path';
import type { PermissionMode } from '@shared/screen';
import type { PreparedSettings } from './settings-files';
import { browserGateEnv, browserMcpServer, type BrowserMcpLaunch } from './browser-bridge';
import { checklistHookEnv, checklistMcpServer } from './checklist-bridge';
import { instructionsHookEnv, type InstructionsLaunch } from './instructions-launch';
import { instructionDirs } from './project-instructions';
import { walkthroughMcpServer } from './walkthrough-bridge';
import { mcpArgs, type McpLaunch, type McpServerEntry } from './mcp-bridge';
import { sessionsGateEnv, sessionsMcpServer, type SessionsMcpLaunch } from './sessions-bridge';
import { terminalGateEnv, terminalMcpServer, type TerminalMcpLaunch } from './terminal-bridge';
import type { PipeHandle, PtyHandle, PtyHostApi } from './pty-host-client';
import type { HostedInfo } from './pty-host-protocol';
import { ASK_FILE_ENV } from '@shared/chat';
import { STATUS_FILE_ENV, sessionSettings } from './statusline';
import { TranscriptFollower } from './transcript-follower';
import type { EntryHandler, MissingParentHandler, RemovedHandler } from './transcript-tail';
import { claudeConfigDir, projectLogDir } from './claude-config';
import { StreamClient, type StreamEvents } from './stream/client';
import { endSession } from './stream/internal';
import { LineLog } from './stream/log';
import { RETAIN_RULES, STREAM_ARGS, TRANSIENT_KINDS, type ElicitationRequest } from './stream/protocol';

// stream: チャット。claude -p の stream-json をパイプでつなぐ（StreamClient）/ tui: ターミナルモード。素の TUI を pty で動かし、人が画面で操作する
export type LaunchKind = 'stream' | 'tui';

// stream（チャット）は、権限モードをいつも渡す（渡さないと、Claude Code はユーザーの設定の既定で始まり、アプリが決めたモードにならない。
// 決めたこと。設計書 15 節）。TUI は null なら既定のまま
type Options = BaseOptions & ({ kind: 'stream'; permissionMode: PermissionMode } | { kind: 'tui'; permissionMode: PermissionMode | null });

type BaseOptions = {
  // アプリのセッション ID（常駐のホストで、どのセッションの claude かの目印にする）
  sessionId: string;
  // セッションのフォルダ（会話ログはここに書かれる。worktree のセッションでは worktree のフォルダ）
  cwd: string;
  claudeSessionId: string;
  // worktree の名前。新しい会話なら元のフォルダ（worktreeRoot）で claude --worktree <名前> を起動し、Claude Code に worktree を作らせる。
  // 再開は worktree のフォルダで --resume（Claude Code は会話ログの worktree-state から worktree に戻る）
  worktree?: string | null;
  worktreeRoot?: string | null;
  // true: 既存の会話を --resume で再開する / false: --session-id で新規に始める
  resume: boolean;
  // Remote Control の名前。null なら --remote-control を付けない（TUI だけ。stream-json は起動後に remote_control の要求でつなぐ）
  remoteControlName: string | null;
  // セッション限定の指定。/model や /effort と違い、ユーザーの既定値（~/.claude/settings.json）を書き換えない
  model: string | null;
  effort: string | null;
  // 設定ファイルを選んでいるとき、アプリの設定と登録した設定を合わせたファイルと、その model。null なら標準の設定のまま
  settings: PreparedSettings | null;
  // statusLine の JSON を書かせるファイル（--settings で足す statusLine が環境変数から読む。TUI の間だけ動く）
  statusFile: string;
  // フックが書くファイルの名前の元（質問のファイル。許可の確認の入力・止めるファイルの名前は、ここから作る）
  askFile: string;
  // アプリ内ブラウザの MCP サーバー（中継）を足すときの材料。null なら足さない（メニューでオフにしている）
  browser: BrowserMcpLaunch | null;
  // セッションの MCP サーバー（ほかのセッションを扱う中継）を足すときの材料。null なら足さない（メニューでオフにしている）
  sessions?: SessionsMcpLaunch | null;
  // チェックリストの MCP サーバーを足すときの材料。null なら足さない（メニューでオフにしている）
  checklist?: McpLaunch | null;
  walkthrough?: McpLaunch | null;
  // 人のターミナルの MCP サーバーを足すときの材料。null なら足さない（メニューでオフにしている）。child: 子セッション（読むツールだけで、打つ前の確認のフックも足さない）
  terminal?: TerminalMcpLaunch | null;
  // TANACODE.md を渡すフックを足すときの材料。null なら足さない
  instructions?: InstructionsLaunch | null;
  // プロファイルの Claude Code の設定のフォルダ（CLAUDE_CONFIG_DIR として渡す）。null・無しは既定のプロファイルで、アプリの環境変数のまま
  claudeDir?: string | null;
  // ワークスペースに追加したフォルダ（--add-dir）。Claude Code は、cwd と同じように読み書きを許す
  addDirs?: string[];
  // stream-json の送受信の控え（不具合を調べるため）。null なら控えない
  streamLog?: string | null;
  cols: number;
  rows: number;
};

type Handlers = {
  // TUI の出力（ターミナルモードの画面）
  onData: (data: string) => void;
  // Claude Code に入力を送った（TUI）
  onInput?: () => void;
  // stream-json の出力の行・答えを待つ要求・その取り下げ（stream）
  stream?: Omit<StreamEvents, 'onExit'>;
  // stderr: stream のときの標準エラーの末尾（起動できなかった理由など）
  onExit: (exitCode: number, stderr?: string) => void;
  onEntry: EntryHandler;
  onHistoryLoaded: () => void;
  // 会話ログから、もう出した行が消えた（取り消された応答。TranscriptTail を参照）
  onRemoved?: RemovedHandler;
  // 親の行がまだ届いていない行を読んだ。親がもう来ないなら true（TranscriptTail を参照）
  onMissingParent?: MissingParentHandler;
  onSwitch: (claudeSessionId: string) => void;
};

// 止めるときの待ち方（stop）。end_session で終わらなければ SIGTERM、それでも終わらなければ SIGKILL（どれもプロセスグループごと）
const STOP_STEP_MS = 3000;

// claude は常駐のホスト（アプリとは別のプロセス）が起動して持つ。アプリを再起動しても止まらず、起動し直したアプリが引き継ぐ
export class ClaudeSession {
  private pty: PtyHandle | null = null;
  private pipe: PipeHandle | null = null;
  // stream のとき、stream-json の行の読み書き
  client: StreamClient | null = null;
  private transcript: TranscriptFollower | null = null;
  // 会話ログの追いかけを作る前に届いた、乗り換え先の会話ログ（引き継いだ claude の送り直しの行で、アプリが見ていない間の /clear を知ったとき）
  private pendingFollow: string | null = null;
  private exitWaiters: (() => void)[] = [];
  private exited = false;
  // kill した。終わったかは終わりの知らせまで持つ（stop が待てるように）が、出力・行はもう表示に流さない
  private killed = false;

  constructor(
    private readonly host: PtyHostApi,
    private readonly options: Options,
    private readonly handlers: Handlers,
    // 前のアプリが起動して、まだ動いている claude（引き継ぐ）。null なら新しく起動する
    private readonly adopted: HostedInfo | null = null,
  ) {}

  get kind(): LaunchKind {
    return this.options.kind;
  }

  start(): void {
    if (this.options.kind === 'stream') this.startStream();
    else this.startTui();
    const { cwd, claudeSessionId } = this.options;
    this.transcript = new TranscriptFollower(
      transcriptPath(cwd, claudeSessionId, this.options.claudeDir ?? null),
      {
        onEntry: this.handlers.onEntry,
        onHistoryLoaded: this.handlers.onHistoryLoaded,
        onRemoved: this.handlers.onRemoved,
        onMissingParent: this.handlers.onMissingParent,
        onSwitch: (file) => this.handlers.onSwitch(basename(file, '.jsonl')),
      },
      // 引き継いだときは、アプリが見ていない間の /clear にも追従できるよう、claude が起動した時刻から探す
      this.adopted?.startedAt,
    );
    this.transcript.start();
    if (this.pendingFollow) void this.transcript.offer(this.pendingFollow);
    this.pendingFollow = null;
  }

  private startTui(): void {
    let proc: PtyHandle;
    if (this.adopted?.kind === 'pty') {
      proc = this.host.attach(this.adopted);
      // 引き継いだときは、今の画面を描き直してから続き（一覧を受け取ったあとに届いていた分も）を受け取る
      if (this.adopted.screen) this.handlers.onData(this.adopted.screen);
    } else {
      const { sessionId, cols, rows } = this.options;
      proc = this.host.spawn({ tag: sessionId, file: 'claude', args: claudeArgs(this.options), cwd: this.spawnCwd(), env: this.env(), cols, rows });
    }
    proc.onData((data) => {
      if (this.pty === proc && !this.killed) this.handlers.onData(data);
    });
    proc.onExit((exitCode) => {
      if (this.pty !== proc) return;
      this.pty = null;
      this.finish(exitCode);
    });
    this.pty = proc;
  }

  private startStream(): void {
    const events: StreamEvents = {
      onMessage: (message, past) => !this.killed && this.handlers.stream?.onMessage(message, past),
      onPermission: (id, request, replayed) => !this.killed && this.handlers.stream?.onPermission(id, request, replayed),
      // MCP サーバーの質問は、受け取る先があるときだけ受け取る（無ければ、StreamClient が error で返す。待たせたままにしない）
      ...(this.handlers.stream?.onElicitation
        ? { onElicitation: (id: string, request: ElicitationRequest, replayed: boolean) => !this.killed && this.handlers.stream?.onElicitation?.(id, request, replayed) }
        : {}),
      onCancel: (id) => !this.killed && this.handlers.stream?.onCancel(id),
      onCaughtUp: () => !this.killed && this.handlers.stream?.onCaughtUp?.(),
      onUnknown: (event) => !this.killed && this.handlers.stream?.onUnknown?.(event),
      onExit: (exitCode, stderr) => {
        if (this.pipe !== pipe) return;
        this.pipe = null;
        this.finish(exitCode, stderr);
      },
    };
    const log = this.options.streamLog ? new LineLog(this.options.streamLog) : null;
    let pipe: PipeHandle;
    if (this.adopted?.kind === 'pipe') {
      pipe = this.host.attachPipe(this.adopted);
      this.pipe = pipe;
      this.client = new StreamClient(pipe, events, log);
      this.client.adopt(this.adopted);
      return;
    }
    const { sessionId } = this.options;
    pipe = this.host.spawnPipe({
      tag: sessionId,
      file: 'claude',
      args: claudeArgs(this.options),
      cwd: this.spawnCwd(),
      env: this.env(),
      retain: RETAIN_RULES,
      transient: TRANSIENT_KINDS,
    });
    this.pipe = pipe;
    this.client = new StreamClient(pipe, events, log);
    this.client.start();
  }

  // 新しい worktree で始めるときは、元のフォルダ（リポジトリのいちばん上）で起動する
  private spawnCwd(): string {
    const { worktree, worktreeRoot, resume, cwd } = this.options;
    return worktree && worktreeRoot && !resume ? worktreeRoot : cwd;
  }

  // アプリ内ブラウザを足すときは、JavaScript の実行の確認のフックが使う環境変数も（フックは Claude Code の環境で動く）。
  // セッションの MCP を足すときは、子セッションの起動の確認のフックが使う環境変数も。
  // チェックリストを足すときは、チェックリストを使い続けさせるフックが使う環境変数も。
  // 人のターミナルを足すとき（子セッションでないとき）は、打つ前の確認のフックが使う環境変数も。
  // TANACODE.md を渡すフックを足すときは、そのフックが使う環境変数（探すフォルダ）も
  private env(): Record<string, string> {
    const { sessionId, statusFile, askFile, kind, cwd, worktreeRoot } = this.options;
    return {
      ...claudeEnv(kind, this.options.claudeDir ?? null),
      [STATUS_FILE_ENV]: statusFile,
      [ASK_FILE_ENV]: askFile,
      ...(this.options.browser ? browserGateEnv(this.options.browser, sessionId) : {}),
      ...(this.options.sessions ? sessionsGateEnv(this.options.sessions) : {}),
      ...(this.options.checklist ? checklistHookEnv(this.options.checklist, sessionId) : {}),
      ...(this.options.terminal && !this.options.terminal.child ? terminalGateEnv(this.options.terminal, sessionId) : {}),
      ...(this.options.instructions ? instructionsHookEnv(this.options.instructions, instructionDirs(cwd, worktreeRoot), claudeConfigDir(this.options.claudeDir ?? null)) : {}),
    };
  }

  private finish(exitCode: number, stderr?: string): void {
    this.exited = true;
    this.transcript?.stop();
    for (const waiter of this.exitWaiters.splice(0)) waiter();
    this.handlers.onExit(exitCode, stderr);
  }

  // TUI に打つ
  write(data: string): void {
    if (!this.pty) return;
    this.pty.write(data);
    this.handlers.onInput?.();
  }

  // statusLine が教えてくれた今の会話ログ（/clear で変わる）
  followTranscript(file: string): void {
    // stream はつないだ直後に送り直しの行が届くことがあり、そのときはまだ追いかけを作っていない。作ったあとに渡す
    if (!this.transcript) this.pendingFollow = file;
    else void this.transcript.offer(file);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  // 止めて、終わるのを待つ（切り替え・起動し直し・worktree を消す前。同じ会話を 2 つのプロセスが書かないように）。
  // stream は end_session（裏のタスクを待たずに終わる。実測）、TUI は SIGHUP。終わらなければ SIGTERM、さらに SIGKILL（プロセスグループごと）。
  // 終わったら true。SIGKILL のあとも終わったと分からなければ（ホストが落ちたなど）false
  async stop(stepMs = STOP_STEP_MS): Promise<boolean> {
    if (this.exited) return true;
    if (!this.pty && !this.pipe) return true;
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    if (this.client && this.pipe) {
      // end_session を受け付けなかった（受け口が無いなど）ときは、待たずに SIGTERM へ
      const asked = await endSession(this.client).then(
        () => true,
        () => false,
      );
      if (asked && (await within(stepMs))) return true;
    } else {
      this.pty?.kill();
      if (await within(stepMs)) return true;
    }
    this.pipe?.kill('SIGTERM');
    if (this.pty) this.pty.kill('SIGTERM');
    if (await within(stepMs)) return true;
    this.pipe?.kill('SIGKILL');
    if (this.pty) this.pty.kill('SIGKILL');
    return within(stepMs);
  }

  // すぐ止める（終わるのは待たない）。出力・行はもう表示に流さないが、終わったかは終わりの知らせまで持ち、終わったら onExit が来る
  // （待っている要求の後始末を通す。stop で終わるのを待つこともできる）
  kill(): void {
    this.killed = true;
    this.transcript?.stop();
    this.transcript = null;
    this.pty?.kill();
    this.pipe?.kill('SIGTERM');
  }

  // アプリの終了時。claude は動かしたまま、見るのをやめる（次に起動したアプリが引き継ぐ）
  detach(): void {
    this.transcript?.stop();
    this.transcript = null;
    const pty = this.pty;
    this.pty = null;
    this.pipe = null;
    pty?.detach();
    this.client?.detach();
  }
}

// claude に付ける引数。Claude Code との互換性の確認（test/cli）も同じものを使う。
// kind を省くと tui（ターミナルモード）
export function claudeArgs(
  options: Pick<Options, 'claudeSessionId' | 'resume' | 'remoteControlName' | 'model' | 'effort' | 'permissionMode'> &
    Partial<Pick<Options, 'kind' | 'settings' | 'worktree' | 'browser' | 'sessions' | 'checklist' | 'walkthrough' | 'sessionId' | 'claudeDir' | 'terminal' | 'addDirs' | 'instructions'>>,
): string[] {
  const {
    kind = 'tui',
    claudeSessionId,
    resume,
    remoteControlName,
    model,
    effort,
    permissionMode,
    settings = null,
    worktree = null,
    browser = null,
    sessions = null,
    checklist = null,
    walkthrough = null,
    sessionId = '',
    claudeDir = null,
    terminal = null,
    addDirs = [],
    instructions = null,
  } = options;
  const args: string[] = kind === 'stream' ? [...STREAM_ARGS] : [];
  args.push(resume ? '--resume' : '--session-id', claudeSessionId);
  // 新しい会話だけ。再開では付けない（worktree のフォルダで起動すれば、Claude Code が会話ログから worktree に戻る）
  if (worktree && !resume) args.push('--worktree', worktree);
  // stream-json には効かない（起動後に remote_control の要求でつなぐ）
  if (remoteControlName && kind === 'tui') args.push('--remote-control', remoteControlName);
  // --resume は前回のモデルを引き継ぐので、既定に戻すときも明示する。
  // --model は設定ファイルの model を上書きするので、登録した設定ファイルに model があれば、選んでいないときはそれを渡す
  args.push('--model', model ?? settings?.model ?? 'default');
  if (effort) args.push('--effort', effort);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  // --add-dir も値をいくつも取るので、--settings より前に置く（次の -- で終わる）
  if (addDirs.length > 0) args.push('--add-dir', ...addDirs);
  // アプリ内ブラウザ・セッション・チェックリスト・ウォークスルー・ターミナルの MCP サーバー。--mcp-config・--allowedTools は値をいくつも取るので、次の -- で終わるよう --settings より前に置く
  const servers: McpServerEntry[] = [];
  if (browser) servers.push(browserMcpServer(browser, sessionId));
  if (sessions) servers.push(sessionsMcpServer(sessions, sessionId));
  if (checklist) servers.push(checklistMcpServer(checklist, sessionId));
  if (walkthrough) servers.push(walkthroughMcpServer(walkthrough, sessionId));
  if (terminal) servers.push(terminalMcpServer(terminal, sessionId));
  args.push(...mcpArgs(servers));
  // このセッションだけの設定。ユーザーの設定ファイルは書き換えない。どちらの起動でも同じ中身にする（statusline.ts の ownSettings）。
  // --settings は 2 回渡しても合わさらない（最後の 1 つだけが使われる）ので、設定ファイルを選んでいるときは合わせたファイルを 1 つ渡す
  args.push('--settings', settings ? settings.settingsFile : sessionSettings(!!browser, !!sessions, claudeDir, !!checklist, !!terminal && !terminal.child, !!instructions));
  return args;
}

// 会話ログのファイル（Claude Code の設定のフォルダの projects の下）。claudeDir: プロファイルの設定のフォルダ（null は既定のプロファイル）
export function transcriptPath(cwd: string, claudeSessionId: string, claudeDir: string | null = null): string {
  return join(projectLogDir(cwd, claudeDir), `${claudeSessionId}.jsonl`);
}

// tanacode を Claude Code の中から起動したとき（開発用のビルドなど）に受け継ぐ、親の Claude Code がそのセッションのために付ける変数。
// 子の claude とそのツールに渡さない（子セッション扱いになって起動を断られる・会話ログを保存しない、親の会話の ID・メッセージの
// トークンが子のツールから読める）。CLAUDE_CODE_USE_BEDROCK のようなユーザーの設定は残すので、名前を並べて消す
const PARENT_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  // Claude Code がツールに付ける、エージェントの中で動いている印
  'AI_AGENT',
];

// アプリが起動する Claude Code・シェルの環境変数。claudeDir: プロファイルの Claude Code の設定のフォルダ（CLAUDE_CONFIG_DIR にする。
// null は既定のプロファイルで、アプリの環境変数のまま）
export function childEnv(claudeDir: string | null = null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of PARENT_SESSION_ENV) delete env[key];
  // 親の tanacode がそのセッションの Claude Code に付けたつなぎ先（ソケット・セッション ID など）も受け継がない。
  // この tanacode は、子ごとに自分のものを付け直す（無いまま親のものが残ると、子のフックが親の tanacode につながる）
  for (const key of Object.keys(env)) if (key.startsWith('TANACODE_')) delete env[key];
  // 親の tanacode がチャットの Claude Code に付けた変数も受け継がない。この tanacode が、起動の種類ごとに付け直す（claudeEnv。
  // 受け継ぐと、ターミナルモードの Claude Code まで、要約をモデルで作らなくなる）
  delete env[FILE_CHECKPOINTING_ENV];
  delete env[CLASSIFIER_SUMMARY_ENV];
  delete env.ELECTRON_RUN_AS_NODE;
  if (claudeDir) env.CLAUDE_CONFIG_DIR = claudeDir;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

// stream-json の Claude Code で、巻き戻し（rewind_files）に要るファイルの控えを有効にする環境変数
export const FILE_CHECKPOINTING_ENV = 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING';

// Claude Code が Remote Control のために作る、ターンの途中とターンの終わりの要約（スマホ・claude.ai のセッションの一覧に出る一言）の
// 作り方。0 にすると、モデルを呼ばずに応答の文などから作る。-p では、モデルで作るとき、作り終えるまで Stop フックと result を出さない
// （チャットの作業中が、1 回 1.5〜5.5 秒延びた。Stop のフックがターンの終わりを止めると、止めるたびに作り直す。2.1.302 で実測。今のチェックリストのフックは止めない）。
// TUI では裏で作るので待たない
export const CLASSIFIER_SUMMARY_ENV = 'CLAUDE_CODE_CLASSIFIER_SUMMARY';

// Claude Code に渡す環境変数。端末の種類（TERM・COLORTERM）は TUI だけ。stream-json では、ファイルの控えを有効にし、
// Remote Control の要約をモデルで作らせない（作り終えるまで、チャットの完了を待たせないため）
export function claudeEnv(kind: LaunchKind, claudeDir: string | null = null): Record<string, string> {
  const env = childEnv(claudeDir);
  if (kind === 'tui') return env;
  delete env.TERM;
  delete env.COLORTERM;
  env[FILE_CHECKPOINTING_ENV] = '1';
  env[CLASSIFIER_SUMMARY_ENV] = '0';
  return env;
}
