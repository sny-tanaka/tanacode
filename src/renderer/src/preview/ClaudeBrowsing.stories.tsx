import type { Meta, StoryObj } from '@storybook/react-vite';
import { AskBar, ClaudeBar, ClickBox, TabStrip } from './PreviewPane';

// アプリ内ブラウザのタブと、Claude が操作しているときの表示（ツールバーの下の「Claude が操作中」の帯と、これから押す要素の枠）、
// Claude がユーザーに操作を頼んだときの「あなたの番です」の帯。
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
