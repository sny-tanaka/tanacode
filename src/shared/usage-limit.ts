import { t } from './i18n';
import { formatScheduleTime } from './scheduled';
import { unwrapWholePaste } from './session-tools';

// プランの利用枠（5 時間・週）に当たって止まったこと。Claude Code は、枠に当たると API を呼ばずに、会話ログに合成の応答の行
// （model が <synthetic>・isApiErrorMessage・apiError: 'usage_limit_reached'・apiErrorParams.rate_limit_info）を書いて、ターンを終える
// （2.1.296・2.1.302 の実物で確かめた。2.1.289 は文だけで、時刻が無い）。resetsAt: 枠が戻る時刻（ミリ秒。分からなければ null）/
// window: 当たった枠（five_hour・seven_day など。分からなければ null）
export type UsageLimitStop = { resetsAt: number | null; window: string | null };

// 利用枠が戻ったときに、アプリが送る再開のメッセージの囲み
export const USAGE_RESUME_TAG = 'tanacode-usage-limit-reset';

// 再開のメッセージを送るのは、枠が戻る時刻のこれだけあと（ちょうどの時刻だと、まだ戻っていないことがある）。
// 同じプロファイルで続けて止まったセッションは、これだけずつずらす（戻った瞬間に一斉に動かないように）
export const USAGE_RESUME_DELAY_MS = 60_000;
export const USAGE_RESUME_STAGGER_MS = 60_000;

// 会話ログの行の、利用枠で止まった知らせ。違えば null。時刻は rate_limit_info（無ければ quotaLimits）の resetsAt（秒）
export function usageLimitOf(entry: { isApiErrorMessage?: boolean; apiError?: unknown; apiErrorParams?: unknown; quotaLimits?: unknown }): UsageLimitStop | null {
  if (!entry.isApiErrorMessage || entry.apiError !== 'usage_limit_reached') return null;
  const info = recordOf(recordOf(entry.apiErrorParams)?.rate_limit_info) ?? recordOf(entry.quotaLimits);
  const seconds = info?.resetsAt;
  const window = info?.rateLimitType;
  return {
    resetsAt: typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    window: typeof window === 'string' && window ? window : null,
  };
}

// チャットに出す、利用枠で止まった行の文（Claude Code の英語の文の代わり）。時刻が分からなければ null（元の文を出す）
export function usageLimitText(stop: UsageLimitStop): string | null {
  if (stop.resetsAt === null) return null;
  const time = formatScheduleTime(stop.resetsAt);
  if (stop.window === 'five_hour') return t('chat.transcript.usageLimitFiveHour', { time });
  if (stop.window?.startsWith('seven_day')) return t('chat.transcript.usageLimitWeekly', { time });
  return t('chat.transcript.usageLimit', { time });
}

// 再開のメッセージ。Claude だけが読むので英語。tanacode が送ったものだと分かるよう、囲みに入れる。
// 続けるか待つかは、最適化圧縮の再開の文と同じく、チェックリスト（いまの状態）と会話から Claude に決めさせる
export function usageResumeText(): string {
  return [
    `<${USAGE_RESUME_TAG}>`,
    "The usage limit of the user's plan stopped your previous turn, and it has reset now. tanacode sent this message by itself (the user did not type it), so that the work can go on.",
    '- First check where you stopped: the checklists (checklist_overview: the state list and the decisions list), if this session has them, and the end of this conversation.',
    '- If you were waiting for an answer from the user (or from the parent session that gave you the task), do not continue: tell the user briefly where things stand and what you are waiting for, and wait.',
    '- Otherwise, continue the work that was in progress from where it stopped. Continue only the work that was already under way; do not start anything new.',
    '- If the next step needs a permission or a decision that is not on the decisions list, stop and ask the user.',
    '- A step may have taken effect before the stop (a commit, a push, a file write). Check the actual state before you do it again.',
    `</${USAGE_RESUME_TAG}>`,
  ].join('\n');
}

const USAGE_RESUME = new RegExp(`^<${USAGE_RESUME_TAG}>([\\s\\S]*)</${USAGE_RESUME_TAG}>\\s*$`);

// 再開のメッセージなら、本文。会話ログでは、全体が貼り付けの囲み（<pasted_content>）に入ることがあるので、先に外す
export function parseUsageResume(text: string): { body: string } | null {
  const m = unwrapWholePaste(text).trim().match(USAGE_RESUME);
  return m ? { body: m[1].trim() } : null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
