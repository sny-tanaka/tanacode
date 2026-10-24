import { t } from '@shared/i18n';
import { formatScheduleTime, type ScheduledMessage } from '@shared/scheduled';
import { parseUsageResume } from '@shared/usage-limit';
import { CloseIcon, IconButton, ScheduleIcon, SendIcon } from '../icons';
import { PastedChips } from './PastedChips';
import { needsAttention } from './scheduled';
import { SchedulePicker } from './SchedulePicker';

// チャットの末尾に出す、予約したメッセージ（時刻を指定して送信）。送るまでは点線の枠で、今すぐ送る・時刻を変える・取り消す（入力欄に戻す）ができる。
// Claude が自分に入れた予約（by: 'claude'）は、親セッションからの指示と同じく Claude の色で出して、人の予約と見分ける。取り消しても入力欄には戻さない。
// 利用枠で止まったセッションの再開の予約（by: 'usage-limit'。アプリが入れたもの）は、お知らせと同じ灰色の印にし、本文を囲みを外して出す
// （本文は、入れたときの画面の言語）。これも取り消しても入力欄には戻さない
export function ScheduledRow({
  message,
  onSendNow,
  onReschedule,
  onTake,
}: {
  message: ScheduledMessage;
  onSendNow: () => void;
  onReschedule: (at: number) => void;
  // 予約をやめて、入力欄に戻す（Claude の予約は、取り消すだけ）
  onTake: () => void;
}) {
  const sending = message.state === 'sending';
  const trouble = needsAttention(message);
  const claude = message.by === 'claude';
  const limit = message.by === 'usage-limit';
  // Claude の予約・利用枠の再開の予約は、取り消しても入力欄に戻らないので、ツールチップも「取り消す」だけにする
  const cancelTip = claude || limit ? t('schedule.row.cancel') : sending ? t('schedule.row.cancelSendingTip') : t('schedule.row.cancelTip');
  return (
    <div className={`chat-user pending scheduled${claude ? ' by-claude' : ''}${limit ? ' by-tanacode' : ''}${trouble ? ' trouble' : ''}`}>
      <span className="chat-prompt">{claude || limit ? '»' : '›'}</span>
      <span className="chat-user-text">
        {claude && (
          <span className="chat-scheduled-by" data-tip={t('schedule.row.claudeTip')}>
            {t('schedule.row.claude')}
          </span>
        )}
        {limit && (
          <span className="chat-scheduled-by" data-tip={t('schedule.row.usageLimitTip', { item: t('main.menu.usageLimitResume') })}>
            {t('schedule.row.usageLimit')}
          </span>
        )}
        {limit ? (parseUsageResume(message.text)?.body ?? message.text) : message.text}
        <PastedChips pastes={message.pastes} />
        {message.attachments.length > 0 && <span className="chat-user-meta">{t('schedule.row.images', { count: message.attachments.length })}</span>}
        <span className="chat-user-meta chat-scheduled-note">
          <ScheduleIcon size={12} />
          {noteOf(message)}
        </span>
        {message.unsaved && (
          <span className="chat-user-meta chat-scheduled-unsaved" data-tip={t('schedule.row.unsavedTip')}>
            {t('schedule.row.unsaved')}
          </span>
        )}
      </span>
      {/* 予約の操作は、ホバーしなくても見えるようにする（reveal にしない） */}
      <div className="chat-scheduled-actions">
        {!sending && <IconButton size="sm" icon={SendIcon} label={t('schedule.row.sendNow')} tip={t('schedule.row.sendNowTip')} onClick={onSendNow} />}
        {!sending && <SchedulePicker size="sm" label={t('schedule.row.reschedule')} initial={trouble ? undefined : message.at} onPick={onReschedule} />}
        <IconButton size="sm" icon={CloseIcon} label={t('schedule.row.cancel')} tip={cancelTip} onClick={onTake} />
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
