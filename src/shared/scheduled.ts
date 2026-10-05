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
  at: number;
  createdAt: number;
  state: 'scheduled' | 'sending' | 'missed' | 'failed';
  error: string | null;
};

// 予定の時刻をこれより過ぎてから気づいたものは、送らずに missed にする。何時間も前の指示が、急に動き出さないように
export const SCHEDULE_LATE_MS = 5 * 60_000;

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
    { label: '30 分後', at: now.getTime() + 30 * 60_000 },
    { label: '1 時間後', at: now.getTime() + 60 * 60_000 },
    { label: '明日の朝', at: at(1, 9) },
    { label: '次の月曜の朝', at: at(toMonday, 9) },
  ];
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 予約の時刻の表示。今日は「15:00」、明日は「明日 9:00」、今年は「10/12（月）9:00」、それより先は年も付ける
export function formatScheduleTime(at: number, now: Date = new Date()): string {
  const d = new Date(at);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (base: Date, days: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days).getTime();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (start === day(now, 0)) return time;
  if (start === day(now, 1)) return `明日 ${time}`;
  if (start === day(now, -1)) return `昨日 ${time}`;
  const date = `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）${time}`;
  return d.getFullYear() === now.getFullYear() ? date : `${d.getFullYear()}/${date}`;
}
