import { t } from '@shared/i18n';
import { AwayIcon } from '../icons';
import { Toggle } from '../layout/Toggle';

// 離席モードのスイッチ（チャットのヘッダー。子でないセッションだけ）。オンの間は、人に回った許可の確認・質問を、
// 決まった時間だけ待って、答えが無ければアプリが断る（@shared/away-mode）。Claude に頼んで切り替えることもできる。
// terminal: ターミナルモード（アプリは答えられないので、断らない。Claude に決まりを伝えるだけ）
export function AwayToggle({ on, terminal = false, onChange }: { on: boolean; terminal?: boolean; onChange: (on: boolean) => void }) {
  return (
    <Toggle
      label={<AwayIcon size={16} />}
      name={t('chat.away.name')}
      on={on}
      title={`${t('chat.away.name')}\n${t('chat.away.about')}\n${t(on ? 'chat.away.stateOn' : 'chat.away.stateOff')}${terminal ? `\n${t('chat.away.terminal')}` : ''}`}
      onChange={onChange}
    />
  );
}
