import { useState } from 'react';
import { t } from '@shared/i18n';
import { formatScheduleTime, type ScheduledMessage } from '@shared/scheduled';
import { parseUsageResume } from '@shared/usage-limit';
import { CloseIcon, EditIcon, IconButton, ScheduleIcon, SendIcon } from '../icons';
import { PastedChips } from './PastedChips';
import { needsAttention } from './scheduled';
import { SchedulePicker } from './SchedulePicker';

// チャットの末尾に出す、予約したメッセージ（時刻を指定して送信）。送るまでは点線の枠で、今すぐ送る・時刻を変える・取り消す（入力欄に戻す）ができる。
// Claude が自分に入れた予約（by: 'claude'）は、親セッションからの指示と同じく Claude の色で出して、人の予約と見分ける。取り消しても入力欄には戻さない。
// 利用枠で止まったセッションの再開の予約（by: 'usage-limit'。アプリが入れたもの）は、お知らせと同じ灰色の印にし、本文を囲みを外して出す
// （本文は、入れたときの画面の言語）。これも取り消しても入力欄には戻さない。
// 人の予約と Claude の予約は、枠の中で文を書き直せる（画像と札はそのまま）。利用枠の再開の予約は、本文を囲みごと持っているので書き直せない
export function ScheduledRow({
  message,
  onSendNow,
  onReschedule,
  onTake,
  edit,
}: {
  message: ScheduledMessage;
  onSendNow: () => void;
  onReschedule: (at: number) => void;
  // 予約をやめて、入力欄に戻す（Claude の予約は、取り消すだけ）
  onTake: () => void;
  // 文の書き直し。書いている文（draft）は、呼ぶ側が予約の id ごとに持つ（useScheduledEdits）
  edit?: ScheduledRowEdit;
}) {
  const sending = message.state === 'sending';
  const editing = edit?.draft !== undefined;
  const trouble = needsAttention(message);
  const claude = message.by === 'claude';
  const limit = message.by === 'usage-limit';
  // Claude の予約・利用枠の再開の予約は、取り消しても入力欄に戻らないので、ツールチップも「取り消す」だけにする
  const cancelTip = claude || limit ? t('schedule.row.cancel') : sending ? t('schedule.row.cancelSendingTip') : t('schedule.row.cancelTip');
  // 送っている途中は書き直せない（書き直している間に送り始めたら、保存のときに断られる）
  const editable = !!edit && !limit && !sending;
  return (
    <div className={`chat-user pending scheduled${claude ? ' by-claude' : ''}${limit ? ' by-tanacode' : ''}${trouble ? ' trouble' : ''}${editing ? ' editing' : ''}`}>
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
        {editing ? (
          <ScheduledEditor draft={edit.draft!} edit={edit} textOnly={message.attachments.length === 0 && message.pastes.length === 0} />
        ) : limit ? (
          (parseUsageResume(message.text)?.body ?? message.text)
        ) : (
          message.text
        )}
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
      {/* 予約の操作は、ホバーしなくても見えるようにする（reveal にしない）。書き直している間は、保存・やめるだけにする
          （今すぐ送ると、書き直す前の文が送られるため） */}
      {!editing && (
        <div className="chat-scheduled-actions">
          {editable && <IconButton size="sm" icon={EditIcon} label={t('schedule.row.edit')} tip={t('schedule.row.editTip')} onClick={() => edit.onStart()} />}
          {!sending && <IconButton size="sm" icon={SendIcon} label={t('schedule.row.sendNow')} tip={t('schedule.row.sendNowTip')} onClick={onSendNow} />}
          {!sending && <SchedulePicker size="sm" label={t('schedule.row.reschedule')} initial={trouble ? undefined : message.at} onPick={onReschedule} />}
          <IconButton size="sm" icon={CloseIcon} label={t('schedule.row.cancel')} tip={cancelTip} onClick={onTake} />
        </div>
      )}
    </div>
  );
}

export type ScheduledRowEdit = {
  // 書き直している文（書き直していなければ undefined）
  draft: string | undefined;
  onStart: () => void;
  onChange: (text: string) => void;
  // 保存する。断られたとき（送っている途中・もう送ったなど）は、呼ぶ側が理由を出し、書いた文は残す（この Promise は失敗させない）
  onSave: () => Promise<void>;
  onDiscard: () => void;
};

// 予約の文を書き直す欄。⌘Enter で保存、Esc でやめる。
// textOnly: 画像も札も無い予約（文を空にすると送るものが無くなるので、保存させない）
function ScheduledEditor({ draft, edit, textOnly }: { draft: string; edit: ScheduledRowEdit; textOnly: boolean }) {
  const [saving, setSaving] = useState(false);
  const empty = textOnly && !draft.trim();
  const save = () => {
    if (saving || empty) return;
    setSaving(true);
    void edit.onSave().finally(() => setSaving(false));
  };
  return (
    <span className="chat-scheduled-editor">
      <textarea
        autoFocus
        value={draft}
        aria-label={t('schedule.row.editLabel')}
        disabled={saving}
        onChange={(e) => edit.onChange(e.target.value)}
        onKeyDown={(e) => {
          // 変換中のキー（変換の取り消しの Esc・確定の Enter）は、変換に任せる
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            edit.onDiscard();
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <span className="chat-scheduled-editor-actions">
        <button type="button" className="ghost-button" data-tip={t('schedule.row.discard')} disabled={saving} onClick={edit.onDiscard}>
          {t('common.cancel')}
        </button>
        <button type="button" className="send-button" data-tip={t('schedule.row.saveTip')} disabled={saving || empty} onClick={save}>
          {t('schedule.row.save')}
        </button>
      </span>
    </span>
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
