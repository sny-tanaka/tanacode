import { RemoteIcon } from '../layout/icons';
import { Toggle } from '../layout/Toggle';
import { useRemoteControlAvailable } from './sessionOptions';

const UNAVAILABLE = 'Remote Control は開発版では使えません（TANACODE_REMOTE_CONTROL=1 を付けて起動すると使えます）';
const ABOUT = 'スマホの Claude アプリや claude.ai/code から、このセッションを操作できるようにする（/remote-control）';

// Remote Control を使うかのトグル（チャットのヘッダーと、新規セッションの画面）。
// connected: 実際につながっているか（null は、まだ始めていないセッション）
export function RemoteControlToggle({
  on,
  connected,
  busy = false,
  onChange,
}: {
  on: boolean;
  connected: boolean | null;
  busy?: boolean;
  onChange: (on: boolean) => void;
}) {
  const available = useRemoteControlAvailable();
  const state =
    connected === null
      ? on
        ? '始めるとつなぎます'
        : '始めてもつなぎません'
      : connected
        ? 'つながっています'
        : on
          ? 'リモートコントロールは有効です（起動やつながりが済むと、つながります）'
          : 'つないでいません';
  return (
    <Toggle
      label={<RemoteIcon size={15} />}
      name="Remote Control"
      on={available && on}
      disabled={!available}
      busy={busy}
      title={`Remote Control\n${available ? `${ABOUT}\n${state}` : UNAVAILABLE}`}
      onChange={onChange}
    />
  );
}
