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
        {message.attachments.length > 0 && <span className="chat-user-meta">画像 {message.attachments.length} 枚</span>}
        <span className="chat-user-meta chat-scheduled-note">
          <ScheduleIcon size={12} />
          {noteOf(message)}
        </span>
      </span>
      {/* 予約の操作は、ホバーしなくても見えるようにする（reveal にしない） */}
      <div className="chat-scheduled-actions">
        {!sending && <IconButton size="sm" icon={SendIcon} label="今すぐ送る" tip="時刻を待たずに送る（Claude Code の手が空くのは待ちます）" onClick={onSendNow} />}
        {!sending && <SchedulePicker size="sm" label="時刻を変える" initial={trouble ? undefined : message.at} onPick={onReschedule} />}
        <IconButton size="sm" icon={CloseIcon} label="取り消す" tip={sending ? '送るのをやめて入力欄に戻す' : '予約をやめて入力欄に戻す'} onClick={onTake} />
      </div>
    </div>
  );
}

function noteOf(message: ScheduledMessage): string {
  const time = formatScheduleTime(message.at);
  switch (message.state) {
    case 'scheduled':
      return `${time} に送ります`;
    case 'sending':
      return '予約の時刻になりました。Claude Code の手が空いたら送ります…';
    case 'missed':
      return `${time} の予約を送っていません（アプリが閉じていた・Mac がスリープしていたなど）`;
    case 'failed':
      return `送れませんでした（${message.error ?? '理由は不明'}）`;
  }
}
