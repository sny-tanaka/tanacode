import logo from '../assets/logo.png';

// ウインドウの上の帯。左の信号ボタンの右に、アプリのロゴ（アイコンと名前）とバージョンを並べる。
// フォルダはセッション一覧とエクスプローラー、ブランチは下のバーで分かるので、ここには出さない
export function TitleBar() {
  return (
    <header className="titlebar">
      <img className="titlebar-logo" src={logo} alt="tanacode" />
      <span className="titlebar-version">v{__APP_VERSION__}</span>
    </header>
  );
}
