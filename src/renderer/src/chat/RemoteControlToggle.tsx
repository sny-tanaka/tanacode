import { t } from '@shared/i18n';
import { RemoteIcon } from '../icons';
import { Toggle } from '../layout/Toggle';
import { useRemoteControlAvailable } from './sessionOptions';

// Remote Control を使うかのトグル（チャットのヘッダーと、新規セッションの画面）。
// connected: 実際につながっているか（null は、まだ始めていないセッション）/ locked: 今は切り替えられない（ターミナルモード）
export function RemoteControlToggle({
  on,
  connected,
  busy = false,
  locked = false,
  onChange,
}: {
  on: boolean;
  connected: boolean | null;
  busy?: boolean;
  locked?: boolean;
  onChange: (on: boolean) => void;
}) {
  const available = useRemoteControlAvailable();
  const state =
    connected === null
      ? on
        ? t('chat.remoteControl.willConnect')
        : t('chat.remoteControl.wontConnect')
      : connected
        ? t('chat.remoteControl.connected')
        : on
          ? t('chat.remoteControl.enabled')
          : t('chat.remoteControl.disconnected');
  return (
    <Toggle
      label={<RemoteIcon size={16} />}
      name="Remote Control"
      on={available && on}
      disabled={!available || locked}
      busy={busy}
      title={`Remote Control\n${available ? `${t('chat.remoteControl.about')}\n${state}${locked ? `\n${t('chat.remoteControl.lockedInTerminal')}` : ''}` : t('chat.remoteControl.unavailable')}`}
      onChange={onChange}
    />
  );
}
