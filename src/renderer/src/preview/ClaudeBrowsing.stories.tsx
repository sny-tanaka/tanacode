import type { Meta, StoryObj } from '@storybook/react-vite';
import type { BrowserPopupFrame } from '@shared/ipc';
import { mockApi } from '../../../../.storybook/mockApi';
import { CredentialHint } from './CredentialHint';
import { PopupCanvas } from './PopupCanvas';
import { AskBar, ClaudeBar, ClickBox, LoginBar, RememberBar, TabStrip, ThrottleBadge, TouchPoints, viewportLabel } from './PreviewPane';

// アプリ内ブラウザのタブと、Claude が操作しているときの表示（ツールバーの下の「Claude が操作中」の帯と、これから押す要素の枠）、
// Claude がユーザーに操作を頼んだときの「あなたの番です」の帯、ページが HTTP の認証（Basic など）を求めたときの入力欄。
// 本物のブラウザ（webview）は Storybook では動かないので、ページの代わりに白い地と作り物のボタンを置く

const meta = {
  title: 'ブラウザ/タブと Claude の操作',
  component: ClaudeBar,
  parameters: { background: '--bg-panel' },
} satisfies Meta<typeof ClaudeBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// 操作の合間（続けて操作することが多いので、最後の操作のあとも少し出しておく）
export const 操作の合間: Story = { args: { label: null } };

// 操作している最中は、今の操作の名前を添える
export const スクリーンショット: Story = { args: { label: 'スクリーンショット' } };

// クリックする前に、押す要素に枠を出す（ページの上に重ねる。ページの中には描かない）
export const クリックする要素: Story = {
  args: { label: 'クリック' },
  render: (args) => (
    <div className="preview-pane" style={{ height: 320, border: '1px solid var(--border-subtle)' }}>
      <ClaudeBar {...args} />
      <div className="preview-body">
        <div className="preview-frame">
          <div style={{ padding: 24, font: '16px sans-serif', color: '#222' }}>
            <h1 style={{ margin: '0 0 16px', fontSize: 24 }}>メニュー</h1>
            <span style={{ display: 'inline-block', padding: '6px 14px', border: '1px solid #999', borderRadius: 4, background: '#f4f4f4' }}>注文する</span>
          </div>
          <ClickBox rect={{ x: 21, y: 69, width: 100, height: 39 }} />
        </div>
      </div>
    </div>
  ),
};

// Claude がスマホの機種の大きさにして（set_viewport の device）、指でなぞっている（touch の swipe）。
// 枠は機種の大きさのまま（入りきらなければ、まわりでスクロールする）。ツールバーの表示幅には機種の名前が出る。
// Claude がタブを遅くしている（throttle）間は、ツールバーに印が出て、押すと元の速さに戻る
export const スマホの大きさでタッチ: Story = {
  args: { label: 'タッチ' },
  render: (args) => (
    <div className="preview-pane" style={{ flex: 'none', width: 520, height: 560, border: '1px solid var(--border-subtle)' }}>
      <div className="preview-toolbar">
        <select className="preview-width" value="custom" onChange={() => {}}>
          <option value="custom">{viewportLabel(393, { height: 852, deviceScaleFactor: 3, device: 'iPhone 15' })}</option>
        </select>
        <ThrottleBadge throttle={{ cpu: 4, network: 'slow-3g' }} onClear={() => {}} />
      </div>
      <ClaudeBar {...args} />
      <div className="preview-body framed sized" style={{ '--preview-width': '393px', '--preview-height': '852px' } as React.CSSProperties}>
        <div className="preview-frame">
          <div style={{ padding: 24, font: '16px sans-serif', color: '#222' }}>
            <h1 style={{ margin: '0 0 16px', fontSize: 24 }}>パズル</h1>
            <div style={{ width: 240, height: 240, background: '#8cf', borderRadius: 8 }} />
          </div>
          <TouchPoints points={[{ x: 70, y: 180 }]} />
        </div>
      </div>
    </div>
  ),
};

// 2 本の指（touch の pinch・fingers 2）。数字で幅だけを決めた（高さは枠いっぱい）。枠が狭くても幅は縮めず、横にスクロールする。
// 遅くしているのは CPU だけ
export const 二本指: Story = {
  args: { label: 'タッチ' },
  render: (args) => (
    <div className="preview-pane" style={{ flex: 'none', width: 340, height: 420, border: '1px solid var(--border-subtle)' }}>
      <div className="preview-toolbar">
        <select className="preview-width" value="custom" onChange={() => {}}>
          <option value="custom">{viewportLabel(390, { height: 0, deviceScaleFactor: 3, device: null })}</option>
        </select>
        <ThrottleBadge throttle={{ cpu: 6, network: null }} onClear={() => {}} />
      </div>
      <ClaudeBar {...args} />
      <div className="preview-body framed sized" style={{ '--preview-width': '390px', '--preview-height': '100%' } as React.CSSProperties}>
        <div className="preview-frame">
          <div style={{ padding: 24, font: '16px sans-serif', color: '#222' }}>
            <h1 style={{ margin: '0 0 16px', fontSize: 24 }}>地図</h1>
            <div style={{ width: 300, height: 200, background: '#cfe8c8', borderRadius: 8 }} />
          </div>
          <TouchPoints
            points={[
              { x: 120, y: 160 },
              { x: 220, y: 160 },
            ]}
          />
        </div>
      </div>
    </div>
  ),
};

// ブラウザのタブ。新しいウィンドウで開くリンク（target=_blank）は、新しいタブで開く。読み込み中のタブには印、空のタブは「新しいタブ」
export const タブ: Story = {
  args: { label: null },
  render: () => (
    <div className="preview-pane" style={{ width: 760, height: 120, border: '1px solid var(--border-subtle)' }}>
      <TabStrip
        tabs={[
          { id: 'tab-1', title: 'メニュー｜カフェ', url: 'http://localhost:5173/', loading: false },
          { id: 'tab-2', title: '', url: 'http://localhost:5173/order/confirm?item=latte&size=large', loading: true },
          { id: 'tab-3', title: 'とても長いタイトルのページはタブの幅で省略して表示されるかどうか', url: 'http://localhost:5173/about', loading: false },
          { id: 'tab-4', title: '', url: '', loading: false },
        ]}
        active="tab-2"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />
    </div>
  ),
};

// Claude がユーザーに操作を頼んだ（ask_user_to_act）。「Claude が操作中」の帯の代わりに出す。
// 「できない」を押すと、ひとこと理由を書く欄に替わる（「戻る」か Esc で戻る）
export const あなたの番: Story = {
  args: { label: null },
  render: () => (
    <div className="preview-pane" style={{ maxWidth: 760, height: 220, border: '1px solid var(--border-subtle)' }}>
      <AskBar message="テスト用のアカウントでログインしてください。二段階認証のコードは、テスト用の端末に届きます" onAnswer={() => {}} />
      <div className="preview-body">
        <div className="preview-frame">
          <div style={{ padding: 24, font: '16px sans-serif', color: '#222' }}>
            <h1 style={{ margin: '0 0 16px', fontSize: 24 }}>ログイン</h1>
            <span style={{ display: 'inline-block', width: 240, height: 28, border: '1px solid #999', borderRadius: 4 }} />
          </div>
        </div>
      </div>
    </div>
  ),
};

// ログインを頼んだ（頼みの文にログインの語がある・ページにパスワード欄がある）。1Password のアイテムのリンクを渡せば Claude が入れられることを、
// リンクの取り方と、サイトごとにリンクを控える画面への入り口と一緒に添える。「もう出さない」を押すと、それからは出さない
export const あなたの番_ログイン: Story = {
  args: { label: null },
  beforeEach: () => localStorage.removeItem('tanacode.credentialHint.hidden'),
  render: () => (
    <div className="preview-pane" style={{ maxWidth: 760, height: 260, border: '1px solid var(--border-subtle)' }}>
      <AskBar message="テスト用のアカウントでログインしてください" login onAnswer={() => {}} />
      <div className="preview-body">
        <div className="preview-frame">
          <div style={{ padding: 24, font: '16px sans-serif', color: '#222' }}>
            <h1 style={{ margin: '0 0 16px', fontSize: 24 }}>ログイン</h1>
            <span style={{ display: 'inline-block', width: 240, height: 28, border: '1px solid #999', borderRadius: 4 }} />
          </div>
        </div>
      </div>
    </div>
  ),
};

// 狭い幅のログインの頼み。案内のボタンは、文の下に回る
export const あなたの番_ログイン_狭い幅: Story = {
  args: { label: null },
  beforeEach: () => localStorage.removeItem('tanacode.credentialHint.hidden'),
  render: () => (
    <div className="preview-pane" style={{ width: 380, height: 320, border: '1px solid var(--border-subtle)' }}>
      <AskBar message="ステージングの管理画面にログインしてください" login onAnswer={() => {}} />
    </div>
  ),
};

// Claude がチャットで渡されたリンクで 1Password から入れたあと、そのサイトでは次からこのアイテムを使うかを聞く。
// Claude は返事を待たずに続けている（ページの上には、入れたあとのページが出ている）。「使う」で、サイトごとの控えに足す
export const 次からこのアイテムを使うか: Story = {
  args: { label: null },
  render: () => (
    <div className="preview-pane" style={{ maxWidth: 760, height: 220, border: '1px solid var(--border-subtle)' }}>
      <RememberBar offer={{ id: 'r1', site: 'staging.example.com', title: 'ステージングのテスト用アカウント' }} onAnswer={() => {}} />
      <div className="preview-body">
        <div className="preview-frame">
          <div style={{ padding: 24, font: '16px sans-serif', color: '#222' }}>ダッシュボード</div>
        </div>
      </div>
    </div>
  ),
};

// 狭い幅では、ボタンが下の行に回る
export const 次からこのアイテムを使うか_狭い幅: Story = {
  args: { label: null },
  render: () => (
    <div className="preview-pane" style={{ width: 380, height: 220, border: '1px solid var(--border-subtle)' }}>
      <RememberBar offer={{ id: 'r1', site: 'very-long-branch-name-for-review.stg.internal.example.com:8443', title: 'レビュー環境の管理者' }} onAnswer={() => {}} />
    </div>
  ),
};

// 案内だけ（Basic 認証の入力の帯など、ほかの帯にも同じものを置く。「もう出さない」を渡さなければ、そのボタンは出さない）
export const 案内だけ: Story = {
  args: { label: null },
  render: () => (
    <div className="preview-ask" style={{ maxWidth: 760 }}>
      <CredentialHint />
    </div>
  ),
};

// 幅が狭いときは、ボタンが下の行に回る。長い頼みは、帯の中でスクロールする
export const あなたの番_狭い幅: Story = {
  args: { label: null },
  render: () => (
    <div className="preview-pane" style={{ width: 380, height: 220, border: '1px solid var(--border-subtle)' }}>
      <AskBar
        message={'決済のテスト画面で、次のカードで支払ってください。\n1. カード番号はテスト用のもの（決済サービスの文書にあるもの）\n2. 有効期限は未来の日付\n3. 支払いが終わったら、注文の完了画面まで進めてください\n4. 完了画面が出なければ「できない」で教えてください'}
        onAnswer={() => {}}
      />
    </div>
  ),
};

const LOGIN = { id: 'login-1', origin: 'https://stg.example.com', realm: 'Staging', proxy: false, insecure: false, retry: false, popup: false };

// ページが HTTP の認証（Basic 認証）を求めた。ページには 401 の本文が出ていて、その上に入力欄を出す。
// 入れた値はページにだけ渡し、Claude には渡さない（Claude には、1Password のリンクがあれば fill_credential で答え、無ければ人に頼むよう伝える）。
// 1Password のアイテムのリンクを渡せば Claude が答えられることの案内を添える（「もう出さない」まで）
export const サイトのログイン: Story = {
  args: { label: null },
  beforeEach: () => localStorage.removeItem('tanacode.credentialHint.hidden'),
  render: () => (
    <div className="preview-pane" style={{ maxWidth: 760, height: 300, border: '1px solid var(--border-subtle)' }}>
      <LoginBar login={LOGIN} onAnswer={() => {}} />
      <div className="preview-body">
        <div className="preview-frame">
          <div style={{ padding: 24, font: '16px sans-serif', color: '#222' }}>401 Unauthorized</div>
        </div>
      </div>
    </div>
  ),
};

// 入れたものが通らなかった・暗号化されていない http（この Mac の外）・長いホスト名（省略せずに折り返す）。
// Claude が ask_user_to_act で頼んでいるときは、「あなたの番です」の帯の下に出る
export const サイトのログイン_警告と狭い幅: Story = {
  args: { label: null },
  beforeEach: () => localStorage.removeItem('tanacode.credentialHint.hidden'),
  render: () => (
    <div className="preview-pane" style={{ width: 380, height: 640, border: '1px solid var(--border-subtle)' }}>
      <AskBar message="STG に Basic 認証でログインしてください" onAnswer={() => {}} />
      <LoginBar
        login={{ ...LOGIN, origin: 'http://very-long-branch-name-for-review.stg.internal.example.com:8080', realm: '社内の検証環境（アカウントは管理者に聞いてください）', insecure: true, retry: true }}
        onAnswer={() => {}}
      />
    </div>
  ),
};

// プロキシの認証と、タブから開いた別ウインドウのページの認証。プロキシの認証には fill_credential で答えられないので、1Password の案内を出さない
export const サイトのログイン_プロキシと別ウインドウ: Story = {
  args: { label: null },
  beforeEach: () => localStorage.removeItem('tanacode.credentialHint.hidden'),
  render: () => (
    <div className="preview-pane" style={{ maxWidth: 760, height: 320, border: '1px solid var(--border-subtle)' }}>
      <LoginBar login={{ ...LOGIN, origin: 'proxy.corp.example.com:3128', realm: '', proxy: true }} onAnswer={() => {}} />
      <LoginBar login={{ ...LOGIN, id: 'login-2', origin: 'https://sso.example.com', popup: true }} onAnswer={() => {}} />
    </div>
  ),
};

// ページが開いたポップアップ（ログインの窓など）は、タブのあとに「ポップアップ」の印を付けたタブとして並ぶ
export const ポップアップのタブ: Story = {
  args: { label: null },
  render: () => (
    <div className="preview-pane" style={{ width: 760, height: 120, border: '1px solid var(--border-subtle)' }}>
      <TabStrip
        tabs={[
          { id: 'tab-1', title: 'メニュー｜カフェ', url: 'http://localhost:5173/', loading: false },
          { id: 'popup-12', title: 'Sign in - Example', url: 'https://accounts.example.com/signin', loading: false, popup: true },
          { id: 'popup-13', title: '', url: 'about:blank', loading: false, popup: true },
        ]}
        active="popup-12"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />
    </div>
  ),
};

// ポップアップの画面を映したところ。main が送ってくる絵の代わりに、ここで描いたログインの画面を送る（画素は main と同じ BGRA の順）。
// 上の帯の「実物を開く」で、本物の別ウインドウを出す
export const ポップアップを映す: Story = {
  args: { label: null },
  beforeEach: () =>
    mockApi({
      'browser.onPopupFrame': (listener: unknown) => {
        const timer = setTimeout(() => (listener as (frame: BrowserPopupFrame) => void)(loginFrame(480, 360, window.devicePixelRatio || 1)), 50);
        return () => clearTimeout(timer);
      },
    }),
  render: () => (
    <div className="preview-pane" style={{ flex: 'none', width: 640, height: 480, border: '1px solid var(--border-subtle)' }}>
      <div className="preview-body">
        <PopupCanvas sessionId="S1" tabId="popup-12" visible />
      </div>
    </div>
  ),
};

// 作り物のログインの画面の絵（width・height は CSS の px）
function loginFrame(width: number, height: number, scale: number): BrowserPopupFrame {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const g = canvas.getContext('2d')!;
  g.scale(scale, scale);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, width, height);
  g.fillStyle = '#222';
  g.font = 'bold 20px sans-serif';
  g.fillText('Example にサインイン', 24, 48);
  g.font = '14px sans-serif';
  g.fillText('メールアドレス', 24, 88);
  g.strokeStyle = '#999';
  g.strokeRect(24, 98, 280, 32);
  g.fillText('パスワード', 24, 158);
  g.strokeRect(24, 168, 280, 32);
  g.fillStyle = '#1a73e8';
  g.fillRect(24, 224, 120, 36);
  g.fillStyle = '#fff';
  g.fillText('次へ', 70, 247);
  const rgba = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const bgra = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    bgra[i] = rgba[i + 2]!;
    bgra[i + 1] = rgba[i + 1]!;
    bgra[i + 2] = rgba[i]!;
    bgra[i + 3] = rgba[i + 3]!;
  }
  return { sessionId: 'S1', tabId: 'popup-12', width: canvas.width, height: canvas.height, scale, data: bgra };
}
