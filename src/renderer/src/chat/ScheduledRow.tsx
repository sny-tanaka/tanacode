import { t } from '@shared/i18n';
import { formatScheduleTime, type ScheduledMessage } from '@shared/scheduled';
import { CloseIcon, IconButton, ScheduleIcon, SendIcon } from '../icons';
import { needsAttention } from './scheduled';
import { SchedulePicker } from './SchedulePicker';

// チャットの末尾に出す、予約したメッセージ（時刻を指定して送信）。送るまでは点線の枠で、今すぐ送る・時刻を変える・取り消す（入力欄に戻す）ができる
export function ScheduledRow({
  message,
  onSendNow,
  onReschedule,
  onTake,
}: {
  message: ScheduledMessage;
  onSendNow: () => void;
  onReschedule: (at: number) => void;
  // 予約をやめて、入力欄に戻す
  onTake: () => void;
}) {
  const sending = message.state === 'sending';
  const trouble = needsAttention(message);
  return (
    <div className={`chat-user pending scheduled${trouble ? ' trouble' : ''}`}>
      <span className="chat-prompt">›</span>
      <span className="chat-user-text">
        {message.text}
        {message.attachments.length > 0 && <span className="chat-user-meta">{t('schedule.row.images', { count: message.attachments.length })}</span>}
        <span className="chat-user-meta chat-scheduled-note">
          <ScheduleIcon size={12} />
          {noteOf(message)}
        </span>
      </span>
      {/* 予約の操作は、ホバーしなくても見えるようにする（reveal にしない） */}
      <div className="chat-scheduled-actions">
        {!sending && <IconButton size="sm" icon={SendIcon} label={t('schedule.row.sendNow')} tip={t('schedule.row.sendNowTip')} onClick={onSendNow} />}
        {!sending && <SchedulePicker size="sm" label={t('schedule.row.reschedule')} initial={trouble ? undefined : message.at} onPick={onReschedule} />}
        <IconButton size="sm" icon={CloseIcon} label={t('schedule.row.cancel')} tip={sending ? t('schedule.row.cancelSendingTip') : t('schedule.row.cancelTip')} onClick={onTake} />
      </div>
    </div>
  );
}

function noteOf(message: ScheduledMessage): string {
  const time = formatScheduleTime(message.at);
  switch (message.state) {
    case 'scheduled':
      return t('schedule.note.scheduled', { time });
    case 'sending':
      return t('schedule.note.sending');
    case 'missed':
      return t('schedule.note.missed', { time });
    case 'failed':
      return t('schedule.note.failed', { error: message.error ?? t('schedule.note.unknownReason') });
  }
}
