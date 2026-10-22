import type { Meta, StoryObj } from '@storybook/react-vite';
import { EditorPane, type OpenFile } from './EditorPane';
import logoSvg from './sample-logo.svg?raw';

// エディタ。画像（PNG など）は絵として出す。ペインより大きければ縮めて全体を見せ、小さければ原寸で真ん中に置く。
// 透過の部分は市松模様で見える。SVG は、文字（ソース）としても画像としても見られる（Markdown と同じ、プレビュー・並べる・ソースの切り替え）。PDF は組み込みのビューアで出す（ページ送り・拡大・検索・印刷）。
// 対応していない形式（バイナリ）と大きすぎるファイルは、その旨と「Finder で開く」のボタンを出す。どのファイルでも、パンくずの右端にも「Finder で開く」のボタンが出る

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

// 1 ページだけの、文字入りの PDF（xref の位置まで正しいもの。実物と同じバイト列）
function pdf(text: string): Uint8Array<ArrayBuffer> {
  const stream = `BT /F1 24 Tf 30 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out) as Uint8Array<ArrayBuffer>;
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
        onSave={async () => true}
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
// 透過の背景に、円と四角を描いた SVG（見本は sample-logo.svg を、文字列のまま読む。.tsx に svg の開きタグを書くと、アイコンの置き場の決まり（test/icons.test.ts）に当たる）
export const SVG: Story = {
  render: () => <Pane files={[{ path: 'design/logo.svg', content: { kind: 'text', text: logoSvg } }]} />,
};
export const PDF: Story = {
  render: () => <Pane files={[{ path: 'docs/spec.pdf', content: { kind: 'pdf', data: pdf('Hello PDF in tanacode') } }]} />,
};
export const バイナリ: Story = {
  render: () => <Pane files={[{ path: 'release/tanacode.dmg', content: { kind: 'binary' } }]} />,
};
export const 大きすぎる: Story = {
  render: () => <Pane files={[{ path: 'public/intro.mp4', content: { kind: 'too-large', size: 14 * 1024 * 1024 } }]} />,
};

// Markdown はプレビューで開く。mermaid のコードブロックは図にする
// （フローチャートは dagre-d3-es、円グラフは @mermaid-js/parser で描く。mermaid を上げたときの確かめ用）
const markdown = `# 設計メモ

起動からセッションの作成までの流れ。

\`\`\`mermaid
flowchart LR
  A[アプリの起動] --> B{前回のセッション}
  B -- あり --> C[セッションを戻す]
  B -- なし --> D[新しいセッション]
  C --> E[Claude Code]
  D --> E
\`\`\`

\`\`\`mermaid
pie title 変更したファイル
  "src/main" : 5
  "src/renderer" : 8
  "src/shared" : 2
\`\`\`
`;

export const Markdown: Story = {
  render: () => <Pane files={[{ path: 'docs/設計メモ.md', content: { kind: 'text', text: markdown } }]} />,
};

// HTML の混ざった README（GitHub が描くものは残し、見た目を偽る style・フォーム・ボタンは描かない）
const readme = `<div align="center">
  <h1>cafe-menu</h1>
  <p>季節のドリンクのメニューを作るアプリ <sup>β</sup></p>
</div>

<p style="position:fixed;inset:0;background:red">この段落の style は消える</p>

<form><input type="text" placeholder="消える入力欄"><button>消えるボタン</button></form>

保存は <kbd>⌘</kbd> + <kbd>S</kbd>。

<details open>
<summary>開発の始め方</summary>

\`\`\`ts
const menu = loadMenu('autumn');
\`\`\`

</details>

- [x] メニューの一覧
- [ ] 季節ごとの切り替え
`;

// 見出しの id が、mermaid の図を描くときの id（mermaid-1 など）とぶつからないか（ぶつかると、mermaid が見出しを消す）
const mermaidHeading = `# mermaid 1

図の前の段落。

\`\`\`mermaid
flowchart LR
  A[見出し] --> B[図]
\`\`\`
`;

export const 見出しと図のid: Story = {
  render: () => <Pane files={[{ path: 'docs/図.md', content: { kind: 'text', text: mermaidHeading } }]} />,
};

export const HTMLの混ざったMarkdown: Story = {
  render: () => <Pane files={[{ path: 'README.md', content: { kind: 'text', text: readme } }]} />,
};
