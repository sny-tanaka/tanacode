import type { Meta, StoryObj } from '@storybook/react-vite';
import { ClaudeBar, ClickBox } from './PreviewPane';

// Claude がアプリ内ブラウザを操作しているときの表示。ツールバーの下の「Claude が操作中」の帯と、これから押す要素の枠。
// 本物のブラウザ（webview）は Storybook では動かないので、ページの代わりに白い地と作り物のボタンを置く

const meta = {
  title: 'ブラウザ/Claude が操作中',
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
