import type { Meta, StoryObj } from '@storybook/react-vite';
import { EditorPane, type OpenFile } from './EditorPane';

// エディタ。画像（PNG など）は絵として出す。ペインより大きければ縮めて全体を見せ、小さければ原寸で真ん中に置く。
// 透過の部分は市松模様で見える。バイナリと大きすぎるファイルは、表示できない旨を出す

// 透過の背景に、円と四角を描いた PNG（実物と同じ data URL）
function png(width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext('2d')!;
  const gradient = c.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#d97757');
  gradient.addColorStop(1, '#6a9bcc');
  c.fillStyle = gradient;
  c.beginPath();
  c.arc(width * 0.35, height * 0.5, Math.min(width, height) * 0.35, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#788c5d';
  c.fillRect(width * 0.55, height * 0.3, width * 0.35, height * 0.4);
  return canvas.toDataURL('image/png');
}

const noop = () => {};

function Pane({ files }: { files: OpenFile[] }) {
  return (
    <div style={{ height: 520, display: 'flex', flexDirection: 'column', border: '1px solid var(--border-subtle)' }}>
      <EditorPane
        sessionId="s1"
        files={files}
        activePath={files[0].path}
        changes={{}}
        mergeBase={null}
        onShowDiff={noop}
        onOpenFile={noop}
        reveal={null}
        onActivate={noop}
        onClose={noop}
        onSave={async () => {}}
        onCursor={noop}
        comments={[]}
        onAddComment={noop}
        onRemoveComment={noop}
      />
    </div>
  );
}

const meta = {
  title: 'エディタ/エディタ',
  parameters: { width: 720 },
} satisfies Meta;
export default meta;

type Story = StoryObj<typeof meta>;

export const 画像: Story = {
  render: () => <Pane files={[{ path: 'design/screenshot.png', content: { kind: 'image', url: png(480, 300) } }]} />,
};
export const 小さい画像: Story = {
  render: () => <Pane files={[{ path: 'build/icon-64.png', content: { kind: 'image', url: png(64, 64) } }]} />,
};
export const 大きい画像: Story = {
  render: () => <Pane files={[{ path: 'design/retina.png', content: { kind: 'image', url: png(2880, 1800) } }]} />,
};
export const バイナリ: Story = {
  render: () => <Pane files={[{ path: 'release/tanacode.dmg', content: { kind: 'binary' } }]} />,
};
export const 大きすぎる: Story = {
  render: () => <Pane files={[{ path: 'public/intro.mp4', content: { kind: 'too-large', size: 14 * 1024 * 1024 } }]} />,
};
