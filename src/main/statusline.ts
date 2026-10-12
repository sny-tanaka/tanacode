import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gatedBrowserToolIds } from '@shared/browser-tools';
import { ASK_FILE_ENV } from '@shared/chat';
import type { RateLimit, StatusLineInfo } from '@shared/statusline';
import { BROWSER_GATE_COMMAND } from './browser-gate';
import { checklistHooks } from './checklist-hook';
import { sessionsGateCommand, SESSIONS_GATED_TOOL } from './sessions-bridge';
import { worktreeGuardCommand } from './worktree-guard';
import { claudeConfigDir, foreignClaudeMdExcludes } from './claude-config';

// Claude Code は statusLine のコマンドを応答のたびに実行し、モデル・コンテキスト・利用枠（rate_limits）の入った JSON を標準入力に渡す。
// アプリが起動する Claude Code にだけ --settings で statusLine を足し、その JSON をセッションごとのファイルに書かせて読む。
// ユーザーが自分の設定（~/.claude/settings.json）で statusLine を設定していれば（RunCat など）、同じ JSON をそのコマンドにも渡して表示もそのまま使う
export const STATUS_FILE_ENV = 'TANACODE_STATUS_FILE';

// アプリが起動する Claude Code にだけ渡す設定（--settings。ユーザーの設定ファイルは書き換えない。フックはユーザーのものと一緒に動く）。
// statusLine: 上のとおり。--settings の statusLine はプロジェクトの設定のものより優先されるので、プロジェクトの statusLine はこのセッションでは動かない。
// hooks: AskUserQuestion を出す前に、その入力（質問・選択肢の説明・プレビュー）をセッションごとのファイルに書かせる。
// 会話ログには答えたあとにしか書かれないので、質問のカードに説明やプレビューを出すにはこれが要る。
// Bash の前には、worktree やブランチを消す操作で確認を出させる（worktree-guard.ts）。
// browser のときだけ: アプリ内ブラウザで JavaScript を実行するツールの前に、今のページが localhost なら確認なし、それ以外なら確認を出させる（browser-gate.ts）。
// permissions.ask では、ページによって変えられない（localhost の開発中のページでも毎回確認が出る）。
// sessions のときだけ: 子セッションの起動の前に、権限モードによらず人の許可の確認を出させる（sessions-bridge.ts）。
// 許可の確認を出す直前（PermissionRequest）に、そのツールの名前と入力の全文をセッションごとのファイルに書かせる。
// 親の Claude が子の許可の確認に答える（sessions-control.ts の answer_permission）とき、画面に収まらない部分まで読ませるため。
// フックは書くだけで、何も決めない（確認は今までどおり出る）。ファイルの名前は、質問のファイルの名前から作る
// checklist のときだけ: 人の発言・ターンの終わり・会話の圧縮のあとに、今のチェックリストを Claude に渡す（checklist-hook.ts）
// claudeMdExcludes: 設定のフォルダが ~/.claude でないときだけ、~/.claude の指示ファイルを読ませない（claude-config.ts の foreignClaudeMdExcludes）。
// claudeDir: プロファイルの Claude Code の設定のフォルダ（ユーザー自身の statusLine を探す。null は既定のプロファイル）
export function sessionSettings(browser = false, sessions = false, claudeDir: string | null = null, checklist = false): string {
  return JSON.stringify(ownSettings(userStatusLineCommand(claudeDir), browser, sessions, claudeDir, checklist));
}

// sessionSettings の中身。inner: statusLine に同じ JSON を渡す、ユーザー自身の statusLine のコマンド（無ければ null）。
// 登録した設定ファイルを重ねるときは、そのファイルの statusLine を inner にして、settings-files.ts が合成する
export function ownSettings(inner: string | null, browser = false, sessions = false, claudeDir: string | null = null, checklist = false): Record<string, unknown> {
  const command = inner ? `tee "$${STATUS_FILE_ENV}" | ${inner}` : `cat > "$${STATUS_FILE_ENV}"`;
  const excludes = foreignClaudeMdExcludes(claudeDir);
  return {
    statusLine: { type: 'command', command },
    hooks: {
      PreToolUse: [
        { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `cat > "$${ASK_FILE_ENV}"` }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: worktreeGuardCommand() }] },
        ...(browser ? [{ matcher: gatedBrowserToolIds().join('|'), hooks: [{ type: 'command', command: BROWSER_GATE_COMMAND, timeout: 10 }] }] : []),
        ...(sessions ? [{ matcher: SESSIONS_GATED_TOOL, hooks: [{ type: 'command', command: sessionsGateCommand(), timeout: 10 }] }] : []),
      ],
      ...(sessions ? { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: PERMISSION_FILE_COMMAND, timeout: 10 }] }] } : {}),
      // 自動の最適化圧縮（チェックリストの MCP を足すときだけ。リストが無ければ引き継げない）: ツールの切れ目で止める・Claude Code の自動の圧縮を止める
      ...(checklist ? { ...checklistHooks(), PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: AUTO_COMPACT_STOP_COMMAND, timeout: 5 }] }] } : {}),
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
// 自動の最適化圧縮で、ターンの途中で止めるためのファイル。アプリが書き（止めるとき）、フックが名前を変えて中身を出す（止めた印）
const STOP_SUFFIX = '.auto-compact.json';
const STOP_HIT_SUFFIX = '.auto-compact.hit.json';

// セッションごとの statusLine のファイル（<dir>/<セッション ID>.json）と、AskUserQuestion の入力のファイル（<dir>/<セッション ID>.ask.json）を見張る
// 許可の確認の入力を書かせるフックのコマンド。質問のファイル（<id>.ask.json）と同じフォルダの <id>.permission.json に書く
// （ASK_FILE_ENV を含むので、チャットのフックの一覧には出ない）
export const PERMISSION_FILE_COMMAND = `cat > "\${${ASK_FILE_ENV}%${ASK_SUFFIX}}${PERMISSION_SUFFIX}"`;

// ツールのあと（PostToolUse）のフック。アプリが止めるファイル（<id>.auto-compact.json）を書いていれば、名前を変えて（最初の 1 回だけ効く）、
// 中身（{"continue": false, "stopReason": …}）を出す。Claude Code は、そこでターンを止める。ファイルが無ければ何もしない。
// ツールの呼び出しのたびに動くので、アプリには聞かず、ファイルを見るだけにする（Node のプロセスを起こさない）。
// サブエージェント（Agent ツール）の中のツールの呼び出しでも動く（実物の Claude Code 2.1.296 で確かめた。フックの入力に agent_id が付く）。
// そこで掴むと、サブエージェントが止まるだけで本体のターンは止まらず、印のファイルだけが残る。止めるファイルがあるときだけ入力を読み、
// agent_id があれば何もしない（本体の次のツールの切れ目まで待つ。入力の中の文字列は " が \" になるので、キーとしての agent_id だけに当たる）。
// （ASK_FILE_ENV を含むので、チャットのフックの一覧には出ない）
export const AUTO_COMPACT_STOP_COMMAND = `f="\${${ASK_FILE_ENV}%${ASK_SUFFIX}}${STOP_SUFFIX}"; h="\${${ASK_FILE_ENV}%${ASK_SUFFIX}}${STOP_HIT_SUFFIX}"; [ -f "$f" ] || exit 0; case "$(cat)" in *'"agent_id":"'*) exit 0;; esac; mv "$f" "$h" 2>/dev/null && cat "$h"; exit 0`;

export class StatusLineWatcher {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly dir: string,
    private readonly onChange: (sessionId: string, info: StatusLineInfo) => void,
    // input: AskUserQuestion の tool_input（質問の一覧）
    private readonly onAsk: (sessionId: string, input: unknown) => void = () => {},
    // request: PermissionRequest のフックの入力（tool_name・tool_input・agent_type）/ at: ファイルが書かれた時刻
    private readonly onPermission: (sessionId: string, request: unknown, at: number) => void = () => {},
  ) {}

  fileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

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
      if (name?.endsWith(ASK_SUFFIX)) {
        const sessionId = basename(name, ASK_SUFFIX);
        clearTimeout(this.timers.get(name));
        // 質問はすぐ画面に出るので、待つのは書き終わるまでの短い間だけ
        this.timers.set(name, setTimeout(() => void this.readAsk(sessionId), 50));
        return;
      }
      if (name?.endsWith(PERMISSION_SUFFIX)) {
        const sessionId = basename(name, PERMISSION_SUFFIX);
        clearTimeout(this.timers.get(name));
        // 確認はすぐ画面に出るので、待つのは書き終わるまでの短い間だけ
        this.timers.set(name, setTimeout(() => void this.readPermission(sessionId), 50));
        return;
      }
      if (!name?.endsWith('.json')) return;
      const sessionId = basename(name, '.json');
      // 書き込みの途中で読まないよう少し待つ
      clearTimeout(this.timers.get(sessionId));
      this.timers.set(sessionId, setTimeout(() => void this.read(sessionId), 150));
    });
  }

  // 今ファイルにある statusLine を読む（知らせない）。時刻はファイルが書かれた時刻
  async peek(sessionId: string): Promise<StatusLineInfo | null> {
    const file = this.fileFor(sessionId);
    const [text, written] = await Promise.all([readFile(file, 'utf8').catch(() => null), stat(file).then((s) => s.mtimeMs, () => Date.now())]);
    return text ? parseStatusLine(text, written) : null;
  }

  async read(sessionId: string): Promise<StatusLineInfo | null> {
    const text = await readFile(this.fileFor(sessionId), 'utf8').catch(() => null);
    const info = text ? parseStatusLine(text, Date.now()) : null;
    if (info) this.onChange(sessionId, info);
    return info;
  }

  private async readAsk(sessionId: string): Promise<void> {
    const text = await readFile(this.askFileFor(sessionId), 'utf8').catch(() => null);
    if (!text) return;
    try {
      this.onAsk(sessionId, (JSON.parse(text) as { tool_input?: unknown }).tool_input);
    } catch {
      // 書き込みの途中。次の変更で読み直す
    }
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
