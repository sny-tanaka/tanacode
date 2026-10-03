import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { gatedBrowserToolIds } from '@shared/browser-tools';
import { ASK_FILE_ENV } from '@shared/chat';
import type { RateLimit, StatusLineInfo } from '@shared/statusline';
import { BROWSER_GATE_COMMAND } from './browser-gate';
import { SESSIONS_GATE_COMMAND, SESSIONS_GATED_TOOL } from './sessions-bridge';
import { WORKTREE_GUARD_COMMAND } from './worktree-guard';

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
// sessions のときだけ: 子セッションの起動の前に、権限モードによらず人の許可の確認を出させる（sessions-bridge.ts）
export function sessionSettings(browser = false, sessions = false): string {
  return JSON.stringify(ownSettings(userStatusLineCommand(), browser, sessions));
}

// sessionSettings の中身。inner: statusLine に同じ JSON を渡す、ユーザー自身の statusLine のコマンド（無ければ null）。
// 登録した設定ファイルを重ねるときは、そのファイルの statusLine を inner にして、settings-files.ts が合成する
export function ownSettings(inner: string | null, browser = false, sessions = false): Record<string, unknown> {
  const command = inner ? `tee "$${STATUS_FILE_ENV}" | ${inner}` : `cat > "$${STATUS_FILE_ENV}"`;
  return {
    statusLine: { type: 'command', command },
    hooks: {
      PreToolUse: [
        { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `cat > "$${ASK_FILE_ENV}"` }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: WORKTREE_GUARD_COMMAND }] },
        ...(browser ? [{ matcher: gatedBrowserToolIds().join('|'), hooks: [{ type: 'command', command: BROWSER_GATE_COMMAND, timeout: 10 }] }] : []),
        ...(sessions ? [{ matcher: SESSIONS_GATED_TOOL, hooks: [{ type: 'command', command: SESSIONS_GATE_COMMAND, timeout: 10 }] }] : []),
      ],
    },
  };
}

// ユーザー自身の設定（~/.claude/settings.json）の statusLine だけを探す。
// プロジェクトの設定（.claude/settings*.json）は見ない。clone したリポジトリのコマンドを --settings に写すと、
// Claude Code のフォルダの信頼の確認や管理ポリシーを通らずに動くおそれがあるため
export function userStatusLineCommand(): string | null {
  let settings: { statusLine?: { type?: string; command?: string } } | null = null;
  try {
    settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
  } catch {
    // 無い・読めない設定は飛ばす
  }
  const line = settings?.statusLine;
  return line?.type === 'command' && line.command ? line.command : null;
}

type Raw = {
  transcript_path?: string;
  model?: { id?: string; display_name?: string };
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

// セッションごとの statusLine のファイル（<dir>/<セッション ID>.json）と、AskUserQuestion の入力のファイル（<dir>/<セッション ID>.ask.json）を見張る
export class StatusLineWatcher {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly dir: string,
    private readonly onChange: (sessionId: string, info: StatusLineInfo) => void,
    // input: AskUserQuestion の tool_input（質問の一覧）
    private readonly onAsk: (sessionId: string, input: unknown) => void = () => {},
  ) {}

  fileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  askFileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}${ASK_SUFFIX}`);
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

  close(): void {
    this.watcher?.close();
    this.timers.forEach((t) => clearTimeout(t));
  }
}
