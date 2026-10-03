import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { PermissionMode } from '@shared/screen';
import type { PreparedSettings } from './settings-files';
import { browserGateEnv, browserMcpArgs, type BrowserMcpLaunch } from './browser-bridge';
import type { PtyHandle, PtyHostApi } from './pty-host-client';
import type { HostedPtyInfo } from './pty-host-protocol';
import { ASK_FILE_ENV } from '@shared/chat';
import { STATUS_FILE_ENV, sessionSettings } from './statusline';
import { TranscriptFollower } from './transcript-follower';
import type { EntryHandler } from './transcript-tail';

type Options = {
  // アプリのセッション ID（pty ホストで、どのセッションの claude かの目印にする）
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
  // Remote Control の名前。null なら --remote-control を付けない
  remoteControlName: string | null;
  // セッション限定の指定。/model や /effort と違い、ユーザーの既定値（~/.claude/settings.json）を書き換えない
  model: string | null;
  effort: string | null;
  // --permission-mode。Shift+Tab と同じくこのセッションだけ。null なら既定のまま
  permissionMode: PermissionMode | null;
  // 設定ファイルを選んでいるとき、アプリの設定と登録した設定を合わせたファイルと、その model。null なら標準の設定のまま
  settings: PreparedSettings | null;
  // statusLine の JSON を書かせるファイル（--settings で足す statusLine が環境変数から読む）
  statusFile: string;
  // AskUserQuestion の入力を書かせるファイル（sessionSettings のフック）
  askFile: string;
  // アプリ内ブラウザの MCP サーバー（中継）を足すときの材料。null なら足さない（メニューでオフにしている）
  browser: BrowserMcpLaunch | null;
  cols: number;
  rows: number;
};

type Handlers = {
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
  onEntry: EntryHandler;
  onHistoryLoaded: () => void;
  onSwitch: (claudeSessionId: string) => void;
};

// claude は pty ホスト（アプリとは別の常駐プロセス）が起動して持つ。アプリを再起動しても止まらず、起動し直したアプリが引き継ぐ
export class ClaudeSession {
  private process: PtyHandle | null = null;
  private transcript: TranscriptFollower | null = null;

  constructor(
    private readonly host: PtyHostApi,
    private readonly options: Options,
    private readonly handlers: Handlers,
    // 前のアプリが起動して、まだ動いている claude（引き継ぐ）。null なら新しく起動する
    private readonly adopted: HostedPtyInfo | null = null,
  ) {}

  start(): void {
    const { sessionId, cwd, claudeSessionId, statusFile, askFile, cols, rows } = this.options;
    let proc: PtyHandle;
    if (this.adopted) {
      proc = this.host.attach(this.adopted);
      // 引き継いだときは、今の画面を描き直してから続き（一覧を受け取ったあとに届いていた分も）を受け取る
      if (this.adopted.screen) this.handlers.onData(this.adopted.screen);
    } else {
      const args = claudeArgs(this.options);
      // アプリ内ブラウザを足すときは、JavaScript の実行の確認のフックが使う環境変数も（フックは Claude Code の環境で動く）
      const env = { ...childEnv(), [STATUS_FILE_ENV]: statusFile, [ASK_FILE_ENV]: askFile, ...(this.options.browser ? browserGateEnv(this.options.browser, sessionId) : {}) };
      const { worktree, worktreeRoot, resume } = this.options;
      const spawnCwd = worktree && worktreeRoot && !resume ? worktreeRoot : cwd;
      proc = this.host.spawn({ tag: sessionId, file: 'claude', args, cwd: spawnCwd, env, cols, rows });
    }
    proc.onData((data) => {
      if (this.process === proc) this.handlers.onData(data);
    });
    proc.onExit((exitCode) => {
      if (this.process !== proc) return;
      this.process = null;
      this.transcript?.stop();
      this.handlers.onExit(exitCode);
    });
    this.process = proc;

    this.transcript = new TranscriptFollower(
      transcriptPath(cwd, claudeSessionId),
      {
        onEntry: this.handlers.onEntry,
        onHistoryLoaded: this.handlers.onHistoryLoaded,
        onSwitch: (file) => this.handlers.onSwitch(basename(file, '.jsonl')),
      },
      // 引き継いだときは、アプリが見ていない間の /clear にも追従できるよう、claude が起動した時刻から探す
      this.adopted?.startedAt,
    );
    this.transcript.start();
  }

  write(data: string): void {
    this.process?.write(data);
  }

  // statusLine が教えてくれた今の会話ログ（/clear で変わる）
  followTranscript(file: string): void {
    void this.transcript?.offer(file);
  }

  resize(cols: number, rows: number): void {
    this.process?.resize(cols, rows);
  }

  // 止めて、終わるのを待つ（worktree を消す前に。消している途中に Claude Code が書き込まないように）
  stop(timeoutMs = 10_000): Promise<void> {
    const proc = this.process;
    if (!proc) {
      this.kill();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      proc.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
      this.kill();
    });
  }

  kill(): void {
    this.transcript?.stop();
    this.transcript = null;
    const proc = this.process;
    this.process = null;
    proc?.kill();
  }

  // アプリの終了時。claude は動かしたまま、見るのをやめる（次に起動したアプリが引き継ぐ）
  detach(): void {
    this.transcript?.stop();
    this.transcript = null;
    const proc = this.process;
    this.process = null;
    proc?.detach();
  }
}

// claude に付ける引数。Claude Code との互換性の確認（test/cli）も同じものを使う
export function claudeArgs(
  options: Pick<Options, 'claudeSessionId' | 'resume' | 'remoteControlName' | 'model' | 'effort' | 'permissionMode'> &
    Partial<Pick<Options, 'settings' | 'worktree' | 'browser' | 'sessionId'>>,
): string[] {
  const { claudeSessionId, resume, remoteControlName, model, effort, permissionMode, settings = null, worktree = null, browser = null, sessionId = '' } = options;
  const args = [resume ? '--resume' : '--session-id', claudeSessionId];
  // 新しい会話だけ。再開では付けない（worktree のフォルダで起動すれば、Claude Code が会話ログから worktree に戻る）
  if (worktree && !resume) args.push('--worktree', worktree);
  if (remoteControlName) args.push('--remote-control', remoteControlName);
  // --resume は前回のモデルを引き継ぐので、既定に戻すときも明示する。
  // --model は設定ファイルの model を上書きするので、登録した設定ファイルに model があれば、選んでいないときはそれを渡す
  args.push('--model', model ?? settings?.model ?? 'default');
  if (effort) args.push('--effort', effort);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  // アプリ内ブラウザの MCP サーバー。--mcp-config・--allowedTools は値をいくつも取るので、次の -- で終わるよう --settings より前に置く
  if (browser) args.push(...browserMcpArgs(browser, sessionId));
  // このセッションだけの設定。ユーザーの設定ファイルは書き換えない。
  // --settings は 2 回渡しても合わさらない（最後の 1 つだけが使われる）ので、設定ファイルを選んでいるときは合わせたファイルを 1 つ渡す
  // アプリ内ブラウザを足すときは、JavaScript の実行の確認（localhost 以外のページだけ。browser-gate.ts のフック）も、この設定に入れる
  args.push('--settings', settings ? settings.settingsFile : sessionSettings(!!browser));
  return args;
}

// Claude Code は cwd の英数字以外を '-' に置き換えたディレクトリに会話ログを書く
export function transcriptPath(cwd: string, claudeSessionId: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${claudeSessionId}.jsonl`);
}

export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Claude Code 上から起動したとき、子セッション扱い（起動拒否・会話ログ保存オフ）になるのを防ぐ
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.ELECTRON_RUN_AS_NODE;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}
