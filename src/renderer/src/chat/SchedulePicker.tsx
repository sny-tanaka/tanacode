import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { t } from '@shared/i18n';
import { formatScheduleTime, schedulePresets } from '@shared/scheduled';
import { IconButton, ScheduleIcon } from '../icons';

// メニューの高さの目安。ボタンの上にこれだけ空いていなければ、下に開く
const MENU_HEIGHT = 300;

// 時刻を指定して送信（予約）の時刻を選ぶ。すぐ選べる選択肢（30 分後・明日の朝など）と、日付と時刻の指定。
// メニューは画面に固定して開く（チャットの一覧の中で開いても、スクロールの枠で切れないように）
export function SchedulePicker({
  label,
  tip,
  size = 'md',
  disabled = false,
  initial,
  onPick,
  className,
}: {
  label: string;
  tip?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  // 日付と時刻の欄の初期値（予約の時刻を変えるとき）。無ければ、次のちょうどの時刻
  initial?: number;
  onPick: (at: number) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [position, setPosition] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // ボタンの右端にそろえ、上が空いていれば上に、無ければ下に開く
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    setPosition(rect.top > MENU_HEIGHT ? { right, bottom: window.innerHeight - rect.top + 6 } : { right, top: rect.bottom + 6 });
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const current = new Date();
    setNow(current);
    const start = new Date(initial ?? nextHour(current));
    setDate(dateValue(start));
    setTime(timeValue(start));
    setOpen(true);
  };

  const pick = (at: number) => {
    setOpen(false);
    onPick(at);
  };

  const custom = new Date(`${date}T${time}`).getTime();
  const valid = Number.isFinite(custom) && custom > now.getTime();

  return (
    <div className={`schedule-picker${className ? ` ${className}` : ''}`} ref={ref}>
      <IconButton icon={ScheduleIcon} size={size} label={label} tip={tip} pressed={open} disabled={disabled} onClick={toggle} />
      {open && (
        <div className="schedule-menu" style={position} role="dialog" aria-label={label}>
          <div className="schedule-menu-heading">{t('schedule.picker.heading')}</div>
          {schedulePresets(now).map((preset) => (
            <button key={preset.label} className="schedule-menu-item" onClick={() => pick(preset.at)}>
              <span>{preset.label}</span>
              <span className="schedule-menu-time">{formatScheduleTime(preset.at, now)}</span>
            </button>
          ))}
          <div className="schedule-menu-sep" />
          <div className="schedule-menu-heading">{t('schedule.picker.custom')}</div>
          <div className="schedule-custom">
            <input type="date" aria-label={t('schedule.picker.date')} value={date} min={dateValue(now)} onChange={(e) => setDate(e.target.value)} />
            <input type="time" aria-label={t('schedule.picker.time')} value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="schedule-custom-actions">
            {!valid && date && time && <span className="schedule-menu-note">{t('schedule.picker.futureOnly')}</span>}
            <button className="send-button" disabled={!valid} onClick={() => pick(custom)}>
              {t('schedule.picker.submit')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function nextHour(now: Date): number {
  const d = new Date(now);
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
}

const pad = (n: number) => String(n).padStart(2, '0');
// <input type="date"> と <input type="time"> の値（その Mac の時刻）
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
