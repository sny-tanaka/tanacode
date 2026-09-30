import type { Meta, StoryObj } from '@storybook/react-vite';
import { NewSessionPane } from './NewSessionPane';

// 新規セッションの画面。アイコンと見出しを中央に置き、下にフォルダ・ブランチと入力欄を並べる

const noop = () => {};

// width は、チャットの列の幅（アプリでは列の境目を動かして変える）
function Pane({ width }: { width: number }) {
  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg-panel)', ['--w-claude' as string]: `${width}px` }}>
      <NewSessionPane
        folders={['/Users/me/work/tanacode', '/Users/me/work/cafe-menu']}
        cwd="/Users/me/work/tanacode"
        onCwdChange={noop}
        branch="develop"
        onOpenScm={noop}
        comments={[]}
        onCommentsChange={noop}
        onShowComment={noop}
        onStart={() => Promise.resolve()}
        onCancel={noop}
      />
    </div>
  );
}

const meta = {
  title: 'セッション/新規セッション',
  component: Pane,
  parameters: { bare: true },
  args: { width: 480 },
} satisfies Meta<typeof Pane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 既定の幅: Story = {};

// チャットの列を広げたとき
export const 広い幅: Story = { args: { width: 900 } };

// 列を細くしたとき
export const 細い幅: Story = { args: { width: 340 } };
