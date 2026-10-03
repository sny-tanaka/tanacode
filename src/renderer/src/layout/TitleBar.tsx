import { REPO_URL, type AppUpdate } from '@shared/app-update';
import logo from '../assets/logo.png';
import { AppUpdateMark } from './AppUpdate';
import { BellIcon } from '../icons';
import { Toggle } from './Toggle';

// ウインドウの上の帯。左の信号ボタンの右に、アプリのロゴ（アイコンと名前）とバージョン・新しいバージョンの印を並べ、右端に通知のベルを置く。
// ロゴを押すと、GitHub の tanacode のリポジトリを開く（ツールチップは出さず、カーソルだけ変える）。
// フォルダはセッション一覧とエクスプローラー、ブランチは下のバーで分かるので、ここには出さない。
// notifications: macOS の通知を出すか（null は、設定を読み込むまで。そのあいだはベルを出さない）
// update: 新しいバージョンを確かめた結果（null は、まだ分からない・確かめる設定がオフ。そのあいだは印を出さない）
export function TitleBar({
  notifications,
  onNotificationsChange,
  update,
}: {
  notifications: boolean | null;
  onNotificationsChange: (on: boolean) => void;
  update: AppUpdate | null;
}) {
  return (
    <header className="titlebar">
      <button className="titlebar-logo-link" aria-label="GitHub の tanacode のページを開く" onClick={() => window.open(REPO_URL)}>
        <img className="titlebar-logo" src={logo} alt="tanacode" />
      </button>
      <span className="titlebar-version">v{__APP_VERSION__}</span>
      <AppUpdateMark update={update} />
      <span className="spacer" />
      {notifications !== null && (
        <div className="titlebar-actions">
          <Toggle
            label={<BellIcon size={16} />}
            name="通知"
            on={notifications}
            title={`通知\n作業の完了や確認待ちを、macOS の通知で知らせる\n${notifications ? '通知を出しています' : '通知を止めています'}`}
            onChange={onNotificationsChange}
          />
        </div>
      )}
    </header>
  );
}
