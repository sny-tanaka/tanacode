import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gatedBrowserToolIds } from '@shared/browser-tools';
import { ASK_FILE_ENV } from '@shared/chat';
import type { RateLimit, StatusLineInfo } from '@shared/statusline';
import { BROWSER_GATE_COMMAND } from './browser-gate';
import { checklistHooks } from './checklist-hook';
import { SUPPRESS_OUTPUT } from './hook-output';
import { instructionsHooks } from './instructions-launch';
import { restartGateCommand, RESTART_GATED_TOOL, sessionsGateCommand, SESSIONS_GATED_TOOL } from './sessions-bridge';
import { TERMINAL_GATE_COMMAND, TERMINAL_GATED_TOOL } from './terminal-bridge';
import { worktreeGuardCommand } from './worktree-guard';
import { claudeConfigDir, foreignClaudeMdExcludes } from './claude-config';

// Claude Code は statusLine のコマンドを応答のたびに実行し、モデル・コンテキスト・利用枠（rate_limits）の入った JSON を標準入力に渡す。
// アプリが起動する Claude Code にだけ --settings で statusLine を足し、その JSON をセッションごとのファイルに書かせて読む。
// ユーザーが自分の設定（~/.claude/settings.json）で statusLine を設定していれば（RunCat など）、同じ JSON をそのコマンドにも渡して表示もそのまま使う
export const STATUS_FILE_ENV = 'TANACODE_STATUS_FILE';

// アプリが起動する Claude Code にだけ渡す設定（--settings。ユーザーの設定ファイルは書き換えない。フックはユーザーのものと一緒に動く）。
// チャット（stream-json）とターミナルモード（TUI）で同じ中身にする（設計書 4 節）。
// statusLine: 上のとおり。TUI の間だけ動く（stream-json では動かない。害は無い）。--settings の statusLine はプロジェクトの設定のものより
// 優先されるので、プロジェクトの statusLine はこのセッションでは動かない。
// hooks（どれも、アプリが足したものはチャットのフックの一覧に出さない）:
// - Bash の前には、worktree やブランチを消す操作で確認を出させる（worktree-guard.ts）。ask は stream-json では can_use_tool として届く
// - browser のときだけ: アプリ内ブラウザで JavaScript を実行するツールの前に、今のページが localhost なら確認なし、それ以外なら確認を出させる
//   （browser-gate.ts）。permissions.ask では、ページによって変えられない（localhost の開発中のページでも毎回確認が出る）
// - sessions のときだけ: 子セッションの起動と tanacode の再起動（restart_app）の前に、権限モードによらず人の許可の確認を出させる（sessions-bridge.ts）
// - terminal のときだけ: 人のターミナルに打つ前に、権限モードによらず、打つものを見せて人の許可の確認を出させる（terminal-bridge.ts）
// - checklist のときだけ: 人の発言・ターンの終わり・会話の圧縮のあとに、今のチェックリストを Claude に渡す（checklist-hook.ts）。
//   自動の最適化圧縮のため、ツールの切れ目で止めるフックと、Claude Code の自動の圧縮を止めるフックも
// - instructions のとき（アプリが起動するときはいつも）: 会話の始まり・再開・/clear・圧縮のあとに、TANACODE.md を Claude に渡す
//   （instructions-hook.ts）
// - 書くだけのフック（何も決めない。いつも足す）: 許可の確認を出す直前（PermissionRequest）のツールの名前と入力、Claude Code の知らせ
//   （Notification）、ターンの終わりのフック（Stop）を、セッションごとのファイルに書かせる。ターミナルモード（TUI）の間に、確認待ちと、
//   メニューが閉じたこと・TUI の権限モードを知るため（設計書 9 節）。Stop では、ターンの終わりは決めない（一緒に動くチェックリストの Stop の
//   フックが、文を渡して続けさせることがある。終わりは会話ログのターンの終わりの行で知る）。stream-json では使わない（can_use_tool と
//   result で分かる）。答えは {"suppressOutput":true} だけで、許可も断りも決めないので、can_use_tool と競わない（実測。suppressOutput は、
//   チャットに出す何も出力しなかったフックと見分けるため。hook-output.ts）
// claudeMdExcludes: 設定のフォルダが ~/.claude でないときだけ、~/.claude の指示ファイルを読ませない（claude-config.ts の foreignClaudeMdExcludes）。
// 描き方（tui）は決めない（画面を読まないので、ユーザーの設定のままにする）
// claudeDir: プロファイルの Claude Code の設定のフォルダ（ユーザー自身の statusLine を探す。null は既定のプロファイル）
export function sessionSettings(
  browser = false,
  sessions = false,
  claudeDir: string | null = null,
  checklist = false,
  terminal = false,
  instructions = false,
): string {
  return JSON.stringify(ownSettings(userStatusLineCommand(claudeDir), browser, sessions, claudeDir, checklist, terminal, instructions));
}

// sessionSettings の中身。inner: statusLine に同じ JSON を渡す、ユーザー自身の statusLine のコマンド（無ければ null）。
// 登録した設定ファイルを重ねるときは、そのファイルの statusLine を inner にして、settings-files.ts が合成する
export function ownSettings(
  inner: string | null,
  browser = false,
  sessions = false,
  claudeDir: string | null = null,
  checklist = false,
  terminal = false,
  instructions = false,
): Record<string, unknown> {
  const command = inner ? `tee "$${STATUS_FILE_ENV}" | ${inner}` : `cat > "$${STATUS_FILE_ENV}"`;
  const excludes = foreignClaudeMdExcludes(claudeDir);
  const writeOnly = (fileCommand: string) => ({ hooks: [{ type: 'command', command: fileCommand, timeout: 10 }] });
  const checklistEvents = checklist ? checklistHooks() : {};
  // SessionStart は、TANACODE.md を先に（Claude に渡る順。チェックリストの今の状態は、プロジェクトの決まりのあとに読ませる）
  const sessionStart = [...(instructions ? instructionsHooks() : []), ...(checklistEvents.SessionStart ?? [])];
  return {
    statusLine: { type: 'command', command },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: worktreeGuardCommand() }] },
        ...(browser ? [{ matcher: gatedBrowserToolIds().join('|'), hooks: [{ type: 'command', command: BROWSER_GATE_COMMAND, timeout: 10 }] }] : []),
        ...(sessions ? [{ matcher: SESSIONS_GATED_TOOL, hooks: [{ type: 'command', command: sessionsGateCommand(), timeout: 10 }] }] : []),
        ...(sessions ? [{ matcher: RESTART_GATED_TOOL, hooks: [{ type: 'command', command: restartGateCommand(), timeout: 10 }] }] : []),
        ...(terminal ? [{ matcher: TERMINAL_GATED_TOOL, hooks: [{ type: 'command', command: TERMINAL_GATE_COMMAND, timeout: 10 }] }] : []),
      ],
      PermissionRequest: [{ matcher: '*', ...writeOnly(PERMISSION_FILE_COMMAND) }],
      Notification: [writeOnly(NOTIFICATION_FILE_COMMAND)],
      ...checklistEvents,
      ...(sessionStart.length > 0 ? { SessionStart: sessionStart } : {}),
      Stop: [writeOnly(IDLE_FILE_COMMAND), ...(checklistEvents.Stop ?? [])],
      // 自動の最適化圧縮（チェックリストの MCP を足すときだけ。リストが無ければ引き継げない）: ツールの切れ目で止める
      ...(checklist ? { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: AUTO_COMPACT_STOP_COMMAND, timeout: 5 }] }] } : {}),
    },
    ...(excludes.length > 0 ? { claudeMdExcludes: excludes } : {}),
  };
}

// ユーザー自身の設定（~/.claude/settings.json）の statusLine だけを探す。
// プロジェクトの設定（.claude/settings*.json）は見ない。clone したリポジトリのコマンドを --settings に写すと、
// Claude Code のフォルダの信頼の確認や管理ポリシーを通らずに動くおそれがあるため
export function userStatusLineCommand(claudeDir: string | null = null): string | null {
  let settings: { statusLine?: { type?: string; command?: string } } | null = null;
  try {
    settings = JSON.parse(readFileSync(join(claudeConfigDir(claudeDir), 'settings.json'), 'utf8'));
  } catch {
    // 無い・読めない設定は飛ばす
  }
  const line = settings?.statusLine;
  return line?.type === 'command' && line.command ? line.command : null;
}

type Raw = {
  transcript_path?: string;
  model?: { id?: string; display_name?: string };
  effort?: { level?: string };
  version?: string;
  cost?: { total_cost_usd?: number };
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    current_usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  };
  rate_limits?: Record<string, { used_percentage?: number; resets_at?: number } | undefined>;
};

export function parseStatusLine(text: string, updatedAt: number): StatusLineInfo | null {
  let raw: Raw;
  try {
    raw = JSON.parse(text) as Raw;
  } catch {
    return null;
  }
  const limit = (key: string): RateLimit | null => {
    const v = raw.rate_limits?.[key];
    return typeof v?.used_percentage === 'number'
      ? { percent: v.used_percentage, resetsAt: typeof v.resets_at === 'number' ? v.resets_at * 1000 : null }
      : null;
  };
  const cw = raw.context_window;
  const usage = cw?.current_usage;
  return {
    model: raw.model?.id ? { id: raw.model.id, name: raw.model.display_name ?? raw.model.id } : null,
    effort: typeof raw.effort?.level === 'string' && raw.effort.level ? raw.effort.level : null,
    version: raw.version ?? null,
    context:
      typeof cw?.context_window_size === 'number' && typeof cw.used_percentage === 'number'
        ? {
            size: cw.context_window_size,
            usedPercent: cw.used_percentage,
            tokens: (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
          }
        : null,
    rateLimits: raw.rate_limits ? { fiveHour: limit('five_hour'), sevenDay: limit('seven_day') } : null,
    costUsd: raw.cost?.total_cost_usd ?? null,
    transcriptPath: raw.transcript_path ?? null,
    updatedAt,
  };
}

const ASK_SUFFIX = '.ask.json';
const PERMISSION_SUFFIX = '.permission.json';
const NOTIFICATION_SUFFIX = '.notification.json';
const IDLE_SUFFIX = '.idle.json';
// 自動の最適化圧縮で、ターンの途中で止めるためのファイル。アプリが書き（止めるとき）、フックが名前を変えて中身を出す（止めた印）
const STOP_SUFFIX = '.auto-compact.json';
const STOP_HIT_SUFFIX = '.auto-compact.hit.json';

// 書くだけのフックのコマンド。<dir>/<id>.ask.json（ASK_FILE_ENV。名前の元にするだけで、このファイルはもう書かない・読まない）と同じフォルダの、
// <id> に種類の名前を付けたファイルに、フックの入力を書く。何も決めないので、アプリのフックの印（suppressOutput）だけを書く（hook-output.ts）
// （ASK_FILE_ENV を含むので、チャットのフックの一覧には出ない）
const fileCommand = (suffix: string) => `cat > "\${${ASK_FILE_ENV}%${ASK_SUFFIX}}${suffix}"; printf '%s\\n' '${SUPPRESS_OUTPUT}'`;
// 許可の確認の直前（PermissionRequest）: <id>.permission.json
export const PERMISSION_FILE_COMMAND = fileCommand(PERMISSION_SUFFIX);
// Claude Code の知らせ（Notification。確認待ち・入力待ちなど）: <id>.notification.json
export const NOTIFICATION_FILE_COMMAND = fileCommand(NOTIFICATION_SUFFIX);
// ターンの終わり（Stop）: <id>.idle.json
export const IDLE_FILE_COMMAND = fileCommand(IDLE_SUFFIX);

// ツールのあと（PostToolUse）のフック。アプリが止めるファイル（<id>.auto-compact.json）を書いていれば、名前を変えて（最初の 1 回だけ効く）、
// 中身（{"continue": false, "stopReason": …}）を出す。Claude Code は、そこでターンを止める。ファイルが無ければ何もしない。
// ツールの呼び出しのたびに動くので、アプリには聞かず、ファイルを見るだけにする（Node のプロセスを起こさない）。
// サブエージェント（Agent ツール）の中のツールの呼び出しでも動く（実物の Claude Code 2.1.296 で確かめた。フックの入力に agent_id が付く）。
// そこで掴むと、サブエージェントが止まるだけで本体のターンは止まらず、印のファイルだけが残る。止めるファイルがあるときは入力を見て、
// agent_id があれば何もしない（本体の次のツールの切れ目まで待つ。入力の中の文字列は " が \" になるので、キーとしての agent_id だけに当たる）。
// 止めるファイルが無いときも、入力は最後まで読んで捨てる。Claude Code（2.1.302）は、入力を書き終える前にフックが標準入力を閉じると（EPIPE）、
// フックの失敗として扱い、標準出力も捨てる（入力にはツールの結果が入るので、パイプに入りきらないことがある）。
// （ASK_FILE_ENV を含むので、チャットのフックの一覧には出ない）
export const AUTO_COMPACT_STOP_COMMAND = `f="\${${ASK_FILE_ENV}%${ASK_SUFFIX}}${STOP_SUFFIX}"; h="\${${ASK_FILE_ENV}%${ASK_SUFFIX}}${STOP_HIT_SUFFIX}"; n='${SUPPRESS_OUTPUT}'; [ -f "$f" ] || { cat >/dev/null; echo "$n"; exit 0; }; case "$(cat)" in *'"agent_id":"'*) echo "$n"; exit 0;; esac; mv "$f" "$h" 2>/dev/null && cat "$h" || echo "$n"; exit 0`;

// セッションごとの statusLine のファイル（<dir>/<セッション ID>.json）と、書くだけのフックが書くファイル（.permission.json など）を見張る
export class StatusLineWatcher {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly dir: string,
    private readonly onChange: (sessionId: string, info: StatusLineInfo) => void,
    // request: PermissionRequest のフックの入力（tool_name・tool_input・agent_type）/ at: ファイルが書かれた時刻
    private readonly onPermission: (sessionId: string, request: unknown, at: number) => void = () => {},
    // 書くだけの Stop のフックが書いた（ターミナルモードの TUI が、ターンを終えようとした。フックが続けさせることもある）
    // input: Stop のフックの入力（permission_mode など）。読めなければ null
    private readonly onIdle: (sessionId: string, input: unknown) => void = () => {},
  ) {}

  fileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  // 書くだけのフックが書くファイルの名前の元（<id>.ask.json。フックは、この名前の .ask.json を種類ごとの名前に替えて書く。
  // 前は AskUserQuestion の入力をこのファイルに書いていた）。起動する Claude Code に ASK_FILE_ENV で渡す
  askFileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}${ASK_SUFFIX}`);
  }

  permissionFileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}${PERMISSION_SUFFIX}`);
  }

  // 自動の最適化圧縮の、止めるファイルと、フックが止めた印のファイル
  stopFileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}${STOP_SUFFIX}`);
  }

  stopHitFileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}${STOP_HIT_SUFFIX}`);
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.watcher = watch(this.dir, (_event, name) => {
      // 前のバージョンのフックが書いた AskUserQuestion の入力のファイルは、statusLine としては読まない
      if (name?.endsWith(ASK_SUFFIX)) return;
      if (name?.endsWith(PERMISSION_SUFFIX)) {
        const sessionId = basename(name, PERMISSION_SUFFIX);
        clearTimeout(this.timers.get(name));
        // 確認はすぐ画面に出るので、待つのは書き終わるまでの短い間だけ
        this.timers.set(name, setTimeout(() => void this.readPermission(sessionId), 50));
        return;
      }
      if (name?.endsWith(IDLE_SUFFIX)) {
        const sessionId = basename(name, IDLE_SUFFIX);
        clearTimeout(this.timers.get(name));
        this.timers.set(name, setTimeout(() => void this.readIdle(sessionId), 50));
        return;
      }
      // 通知のフックのファイルは読まない（確認・質問は PermissionRequest のフックで分かる）
      if (name?.endsWith(NOTIFICATION_SUFFIX)) return;
      if (!name?.endsWith('.json')) return;
      const sessionId = basename(name, '.json');
      // 書き込みの途中で読まないよう少し待つ
      clearTimeout(this.timers.get(sessionId));
      this.timers.set(sessionId, setTimeout(() => void this.read(sessionId), 150));
    });
  }

  // 今ファイルにある statusLine を読む（知らせない）。時刻はファイルが書かれた時刻。無い・読めなければ null。
  // アプリを起動し直して TUI を引き継ぐとき、引き継ぐ前の値を、その場で読む
  peek(sessionId: string): StatusLineInfo | null {
    const file = this.fileFor(sessionId);
    const written = mtimeOf(file);
    if (written === null) return null;
    const text = readText(file);
    return text ? parseStatusLine(text, written) : null;
  }

  // 書くだけの PermissionRequest のフックが、最後に書いた入力と、書いた時刻（知らせない）。無い・読めなければ null
  peekPermission(sessionId: string): { request: unknown; at: number } | null {
    const file = this.permissionFileFor(sessionId);
    const at = mtimeOf(file);
    const text = at === null ? null : readText(file);
    if (at === null || !text) return null;
    try {
      return { request: JSON.parse(text), at };
    } catch {
      return null;
    }
  }

  // 書くだけの Stop のフックが、最後に書いた時刻。無ければ null
  stopHookAt(sessionId: string): number | null {
    return mtimeOf(join(this.dir, `${sessionId}${IDLE_SUFFIX}`));
  }

  async read(sessionId: string): Promise<StatusLineInfo | null> {
    const text = await readFile(this.fileFor(sessionId), 'utf8').catch(() => null);
    const info = text ? parseStatusLine(text, Date.now()) : null;
    if (info) this.onChange(sessionId, info);
    return info;
  }

  private async readIdle(sessionId: string): Promise<void> {
    const text = await readFile(join(this.dir, `${sessionId}${IDLE_SUFFIX}`), 'utf8').catch(() => null);
    let input: unknown = null;
    try {
      input = text ? JSON.parse(text) : null;
    } catch {
      // 書き込みの途中でも、ターンの終わりは知らせる（入力は使わない）
    }
    this.onIdle(sessionId, input);
  }

  private async readPermission(sessionId: string): Promise<void> {
    const file = this.permissionFileFor(sessionId);
    const [text, at] = await Promise.all([readFile(file, 'utf8').catch(() => null), stat(file).then((s) => s.mtimeMs, () => null)]);
    if (!text || at === null) return;
    try {
      this.onPermission(sessionId, JSON.parse(text), at);
    } catch {
      // 書き込みの途中。次の変更で読み直す
    }
  }

  close(): void {
    this.watcher?.close();
    this.timers.forEach((t) => clearTimeout(t));
  }
}

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
