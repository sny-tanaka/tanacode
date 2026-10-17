import type { Activity, PermissionMode } from '@shared/screen';
import type { RateLimit, StatusLineInfo } from '@shared/statusline';
import type { UsageLimit } from '@shared/usage';
import type { PermissionModeName, RateLimitEvent, StreamEventMessage, UsageResponse, UsageWindow } from './protocol';

// stream-json の行から、アプリの表示に使う値を作る小さな関数（SessionManager が使う）

// Claude Code の権限モードの名前（default など）を、アプリの名前（manual など）にする。知らない名前（dontAsk など）は、
// 許す操作の多さが分からないので manual にする
export function appMode(name: string | null | undefined): PermissionMode | null {
  switch (name) {
    case 'default':
    case 'manual':
      return 'manual';
    case 'acceptEdits':
    case 'plan':
    case 'auto':
    case 'bypassPermissions':
      return name;
    case undefined:
    case null:
    case '':
      return null;
    default:
      return 'manual';
  }
}

// アプリの権限モードを、制御の要求（set_permission_mode）で渡す名前にする
export function streamMode(mode: PermissionMode): PermissionModeName {
  return mode === 'manual' ? 'default' : mode;
}

// 経過時間を、Claude Code の画面と同じ表記にする（5s・1m 5s・1h 2m。画面の WorkingNote が今の言語の表記に直す）
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// トークン数を、Claude Code の画面と同じ表記にする（225・1.2k）
export function tokensText(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

// 作業中の進み具合（書いている途中の行・ツールの経過から）。経過時間は、ターンの始まりからアプリが数える。
// 書いている途中の文そのものは、チャットの最後に出す（stream/partial.ts）。サブエージェントの行は数えない
export class Progress {
  private phase: Activity['phase'] = 'waiting';
  // 今の応答の、受け取ったトークン数（message_delta の output_tokens は、その応答の累積）
  private tokens: number | null = null;

  constructor(private readonly startedAt: number) {}

  // 書いている途中の行。進み具合が変わったら true
  streamEvent(message: StreamEventMessage): boolean {
    const { event } = message;
    const before = `${this.phase}:${this.tokens}`;
    if (event.type === 'message_start') {
      this.phase = 'waiting';
      this.tokens = null;
    } else if (event.type === 'content_block_start') {
      const kind = event.content_block?.type;
      this.phase = kind === 'thinking' || kind === 'redacted_thinking' ? 'thinking' : kind === 'text' ? 'writing' : 'working';
    } else if (event.type === 'message_delta' && typeof event.usage?.output_tokens === 'number') {
      this.tokens = event.usage.output_tokens;
    } else if (event.type === 'content_block_delta' && this.phase === 'waiting') {
      this.phase = 'writing';
    }
    return before !== `${this.phase}:${this.tokens}`;
  }

  // ツールの実行中
  tool(): boolean {
    if (this.phase === 'working') return false;
    this.phase = 'working';
    return true;
  }

  current(now: number): Activity {
    return { phase: this.phase, elapsed: elapsedText(now - this.startedAt), tokens: this.tokens === null ? null : tokensText(this.tokens) };
  }
}

// rate_limit_event の利用枠（utilization は 0〜1、resetsAt は秒。実測）。無ければ null
export function rateLimitsOf(event: RateLimitEvent): StatusLineInfo['rateLimits'] {
  const windows = event.rate_limit_info.unifiedWindows;
  if (!windows) return null;
  const of = (w: { utilization?: unknown; resetsAt?: unknown } | undefined): RateLimit | null =>
    typeof w?.utilization === 'number' ? { percent: Math.round(w.utilization * 1000) / 10, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null } : null;
  return { fiveHour: of(windows.five_hour), sevenDay: of(windows.seven_day) };
}

// get_usage の返事から読んだ利用枠。modelsKnown: モデル別の週の枠の一覧（model_scoped）が返事にあったか。
// Claude Code（2.1.302）は、/usage に出すモデルの許可リストを通した行があればその一覧を、サーバーの返事にモデル別の行が 1 つも
// 無ければ空の配列を付け、それ以外（許可リストを通る行が無い・サーバーに聞けなかった）は付けない。無いときは、前の値を期限つきで残す
// （UsageMonitor）
export type UsageReport = { limits: UsageLimit[]; modelsKnown: boolean };

// get_usage の利用枠（utilization は 0〜100、resets_at は ISO の時刻。実測）。5 時間枠・週の枠と、モデル別の週の枠。
// 出す枠は Claude Code の /usage と同じ（2.1.302）: seven_day_opus は読まない。seven_day_sonnet は、プランが max・team か
// 分からない（null）ときだけ（model_scoped があっても出す。同じ名前のモデルが一覧にあれば、一覧の方を使う）。
// utilization の無い枠は出さない。使えなければ null
export function usageLimitsOf(response: UsageResponse): UsageReport | null {
  const limits = response.rate_limits;
  if (!response.rate_limits_available || !limits) return null;
  const of = (label: string, w: UsageWindow | undefined, model?: string): UsageLimit | null => {
    if (!w || typeof w.utilization !== 'number') return null;
    const at = w.resets_at ? Date.parse(w.resets_at) : NaN;
    return { label, ...(model ? { model } : {}), percent: w.utilization, resetsAt: Number.isNaN(at) ? null : at };
  };
  const modelsKnown = Array.isArray(limits.model_scoped);
  const models = (modelsKnown ? limits.model_scoped! : [])
    .filter((m) => typeof m?.display_name === 'string' && m.display_name)
    .map((m) => of('週', m, m.display_name));
  const named = new Set(models.filter((m) => m).map((m) => m!.model!.toLowerCase()));
  const plan = response.subscription_type;
  const sonnet = plan === 'max' || plan === 'team' || plan === null ? of('週', limits.seven_day_sonnet, 'Sonnet') : null;
  const legacy = sonnet && !named.has('sonnet') ? [sonnet] : [];
  return { limits: [of('5時間', limits.five_hour), of('週', limits.seven_day), ...models, ...legacy].filter((l): l is UsageLimit => !!l), modelsKnown };
}

// 応答のモデルの ID を表示名にする（例: claude-sonnet-5 → Sonnet 5、claude-fable-5-1 → Fable 5.1）。読めなければ null
export function modelName(id: string | null | undefined): string | null {
  // 新しい系統名のモデルにも対応できるよう、名前は決め打ちしない。
  // 小数点以下は 1 桁の数字だけ（claude-sonnet-5-20260101 の日付の先頭の 2 を、小数点以下と読まない）
  const m = id?.match(/^claude-([a-z]+)-(\d+)(?:-(\d)(?!\d))?(?:-\d{8})?/);
  if (!m) return null;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}
