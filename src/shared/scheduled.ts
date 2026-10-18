import { locale, t } from './i18n';
import { neutralizeTags, unwrapWholePaste, WAKEUP_TAG } from './session-tools';

// 予約したメッセージ（時刻を指定して送信）。main が保存して、時刻になったら Claude Code の入力欄に打ち込む
// state: scheduled: 時刻を待っている / sending: 時刻になり、Claude Code の手が空くのを待って送っている /
// missed: 時刻を大きく過ぎてから気づいた（アプリが閉じていた・Mac がスリープしていたなど）。送らずに、どうするかを人に任せる /
// failed: 送れなかった（error に理由）
export type ScheduledMessage = {
  id: string;
  sessionId: string;
  text: string;
  // 画像のパス（貼り付けとして送る。チャットの入力欄の添付と同じ）
  attachments: string[];
  // 入力欄に貼り付けた長い文（札）。打った文のあとに、1 つずつ貼り付けとして送る
  pastes: string[];
  at: number;
  createdAt: number;
  state: 'scheduled' | 'sending' | 'missed' | 'failed';
  error: string | null;
  // 人のものでない予約。人の予約には無い。
  // claude: Claude が自分に入れた予約（tanacode-sessions の schedule_wakeup）。時刻になると、本文を囲み（WAKEUP_TAG）に入れて送り、
  // チャットでは「Claude への知らせ」として出す /
  // usage-limit: 利用枠で止まったセッションに、枠が戻ったら続きを頼む予約（アプリが入れる。main の usage-limit-resume.ts）。
  // 本文は囲み（USAGE_RESUME_TAG）ごと持つ（前のバージョンのアプリは、知らない by を読み捨てて人の予約として送るが、それでも囲みごと届く）
  by?: ScheduledBy;
  // usage-limit の予約の、枠が戻る時刻。アプリが時刻を決めて並べている間だけ持つ（人が時刻を変えたら外し、並べ直さない）
  limitResetsAt?: number;
  // 予約のファイルを読めず（権限が無い・新しいバージョンのアプリが書いた形など）、保存しない。アプリを終えると消える。
  // 保存はせず、main が画面などに渡すときだけ付ける
  unsaved?: true;
};

export type ScheduledBy = 'claude' | 'usage-limit';

// 予定の時刻をこれより過ぎてから気づいたものは、送らずに missed にする。何時間も前の指示が、急に動き出さないように
export const SCHEDULE_LATE_MS = 5 * 60_000;

// Claude の予約を、Claude Code の入力欄に打ち込む形にする（囲みは WAKEUP_TAG）。本文は Claude が書いたものなので、囲みを閉じさせない
export function wakeupText(body: string): string {
  return `<${WAKEUP_TAG}>${neutralizeTags(body)}</${WAKEUP_TAG}>`;
}

const WAKEUP = new RegExp(`^<${WAKEUP_TAG}>([\\s\\S]*)</${WAKEUP_TAG}>\\s*$`);

// Claude の予約の知らせなら、本文。会話ログでは、全体が貼り付けの囲み（<pasted_content>）に入ることがあるので、先に外す
export function parseWakeup(text: string): { body: string } | null {
  const m = unwrapWholePaste(text).trim().match(WAKEUP);
  return m ? { body: m[1].trim() } : null;
}

// 予約の選択肢（Slack の予約投稿と同じく、すぐ選べるもの）。now からの時刻
export function schedulePresets(now: Date): { label: string; at: number }[] {
  const at = (days: number, hours: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hours, 0, 0, 0);
    return d.getTime();
  };
  // 次の月曜（今日が月曜なら、来週の月曜）
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    { label: t('schedule.preset.in30Minutes'), at: now.getTime() + 30 * 60_000 },
    { label: t('schedule.preset.in1Hour'), at: now.getTime() + 60 * 60_000 },
    { label: t('schedule.preset.tomorrowMorning'), at: at(1, 9) },
    { label: t('schedule.preset.nextMondayMorning'), at: at(toMonday, 9) },
  ];
}

// 時刻と曜日の書式。作るのに時間がかかるので、ロケールごとに一度だけ作る
const formatsByLocale = new Map<string, { time: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat }>();

function scheduleFormats(loc: string): { time: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat } {
  let formats = formatsByLocale.get(loc);
  if (!formats) {
    formats = { time: new Intl.DateTimeFormat(loc, { hour: 'numeric', minute: '2-digit' }), weekday: new Intl.DateTimeFormat(loc, { weekday: 'short' }) };
    formatsByLocale.set(loc, formats);
  }
  return formats;
}

// 予約の時刻の表示。今日は「15:00」、明日は「明日 9:00」、今年は「10/12（月）9:00」、それより先は年も付ける（英語では 3:00 PM のように 12 時間制）
export function formatScheduleTime(at: number, now: Date = new Date()): string {
  const d = new Date(at);
  const formats = scheduleFormats(locale());
  const time = formats.time.format(d);
  const day = (base: Date, days: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days).getTime();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (start === day(now, 0)) return time;
  if (start === day(now, 1)) return t('schedule.time.tomorrow', { time });
  if (start === day(now, -1)) return t('schedule.time.yesterday', { time });
  // 曜日の短い名前（日本語では「月」）
  const weekday = formats.weekday.format(d);
  const parts = { month: d.getMonth() + 1, day: d.getDate(), weekday, time };
  return d.getFullYear() === now.getFullYear() ? t('schedule.time.date', parts) : t('schedule.time.dateWithYear', { ...parts, year: d.getFullYear() });
}
