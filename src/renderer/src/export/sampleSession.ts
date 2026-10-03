import type { ChatEvent } from '@shared/chat';

// 作業の書き出しのストーリーとテストで使う、作り物のセッション（カフェのメニューに「季節限定」のバッジを付ける）

const T0 = Date.parse('2026-10-03T14:05:00+09:00');
const at = (minutes: number) => T0 + minutes * 60_000;

export const SAMPLE_HOME = '/Users/me';
export const SAMPLE_CWD = '/Users/me/work/cafe-menu';
const file = (path: string) => `${SAMPLE_CWD}/${path}`;

export const SAMPLE_EVENTS: ChatEvent[] = [
  { type: 'info', id: 'i1', text: 'AGENTS.md を読み込みました' },
  { type: 'user', id: 'u1', text: 'メニューの商品に「季節限定」のバッジを付けて。色は相談させて', at: at(0) },
  { type: 'assistant-text', id: 'a1', text: 'メニューの部品を確かめてから、バッジの部品を足します。', at: at(0.2) },
  {
    type: 'tool-use',
    id: 't1',
    name: 'TaskCreate',
    target: 'バッジの部品を作る',
    input: '{\n  "subject": "バッジの部品を作る"\n}',
    taskChange: { kind: 'create', subject: 'バッジの部品を作る', activeForm: 'バッジの部品を作っています' },
    at: at(0.3),
  },
  { type: 'tool-result', id: 't1', isError: false, createdTaskId: '1', at: at(0.3) },
  {
    type: 'tool-use',
    id: 't2',
    name: 'TaskCreate',
    target: 'メニューの一覧に出す',
    input: '{\n  "subject": "メニューの一覧に出す"\n}',
    taskChange: { kind: 'create', subject: 'メニューの一覧に出す', activeForm: 'メニューの一覧に出しています' },
    at: at(0.3),
  },
  { type: 'tool-result', id: 't2', isError: false, createdTaskId: '2', at: at(0.3) },
  { type: 'tool-use', id: 't3', name: 'Read', target: 'src/MenuItem.tsx', filePath: file('src/MenuItem.tsx'), input: `{\n  "file_path": "${file('src/MenuItem.tsx')}"\n}`, at: at(0.5) },
  {
    type: 'tool-result',
    id: 't3',
    isError: false,
    output: "1\texport function MenuItem({ item }: { item: Item }) {\n2\t  return (\n3\t    <li className=\"menu-item\">\n4\t      <span>{item.name}</span>\n5\t    </li>\n6\t  );\n7\t}",
    at: at(0.5),
  },
  { type: 'tool-use', id: 't4', name: 'TaskUpdate', target: '1', input: '{\n  "taskId": "1",\n  "status": "in_progress"\n}', taskChange: { kind: 'update', taskId: '1', status: 'in_progress' }, at: at(0.6) },
  { type: 'tool-result', id: 't4', isError: false, at: at(0.6) },
  { type: 'tool-use', id: 't5', name: 'Write', target: 'src/SeasonBadge.tsx', filePath: file('src/SeasonBadge.tsx'), input: '', at: at(1) },
  {
    type: 'tool-result',
    id: 't5',
    isError: false,
    added: 5,
    removed: 0,
    filePath: file('src/SeasonBadge.tsx'),
    line: 1,
    patch: ['+// 季節限定の商品に付けるバッジ', '+export function SeasonBadge() {', '+  return <span className="season-badge">季節限定</span>;', '+}', '+'],
    at: at(1.1),
  },
  { type: 'tool-use', id: 't6', name: 'Edit', target: 'src/MenuItem.tsx', filePath: file('src/MenuItem.tsx'), input: '', at: at(1.3) },
  {
    type: 'tool-result',
    id: 't6',
    isError: false,
    added: 1,
    removed: 0,
    filePath: file('src/MenuItem.tsx'),
    line: 4,
    patch: ['@@ -2,5 +2,6 @@', '   return (', '     <li className="menu-item">', '       <span>{item.name}</span>', '+      {item.seasonal && <SeasonBadge />}', '     </li>'],
    at: at(1.4),
  },
  {
    type: 'hook',
    id: 'h1',
    run: {
      event: 'PostToolUse',
      name: 'PostToolUse:Edit',
      command: 'npx prettier --check src',
      outcome: 'success',
      exitCode: 0,
      durationMs: 840,
      stdout: 'All matched files use Prettier code style!',
      stderr: '',
      message: '',
      toolUseId: 't6',
    },
  },
  { type: 'tool-use', id: 't7', name: 'TaskUpdate', target: '1', input: '{\n  "taskId": "1",\n  "status": "completed"\n}', taskChange: { kind: 'update', taskId: '1', status: 'completed' }, at: at(1.5) },
  { type: 'tool-result', id: 't7', isError: false, at: at(1.5) },
  { type: 'tool-use', id: 't8', name: 'TaskUpdate', target: '2', input: '{\n  "taskId": "2",\n  "status": "in_progress"\n}', taskChange: { kind: 'update', taskId: '2', status: 'in_progress' }, at: at(1.5) },
  { type: 'tool-result', id: 't8', isError: false, at: at(1.5) },
  {
    type: 'tool-use',
    id: 't9',
    name: 'Bash',
    target: 'npm test',
    description: 'テストを流して壊れていないか確かめる',
    input: '# テストを流して壊れていないか確かめる\nnpm test',
    at: at(2),
  },
  {
    type: 'tool-result',
    id: 't9',
    isError: false,
    output: ' ✓ src/MenuItem.test.tsx (3 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)',
    at: at(2.4),
  },
  { type: 'assistant-text', id: 'a2', text: '見た目を確かめるため、アプリ内ブラウザで開きます。', at: at(2.5) },
  { type: 'tool-use', id: 't10', name: 'mcp__tanacode-browser__screenshot', target: 'http://localhost:5173', input: '{}', at: at(2.6) },
  { type: 'tool-result', id: 't10', isError: false, images: ['sample:shot'], at: at(2.7) },
  { type: 'tool-use', id: 't11', name: 'AskUserQuestion', target: 'バッジの色', input: '{}', at: at(2.8) },
  {
    type: 'tool-result',
    id: 't11',
    isError: false,
    answers: [{ header: '色', question: 'バッジの色はどれにしますか？', answer: '桜色（推奨）' }],
    at: at(3.5),
  },
  { type: 'tool-use', id: 't12', name: 'TaskUpdate', target: '2', input: '{\n  "taskId": "2",\n  "status": "completed"\n}', taskChange: { kind: 'update', taskId: '2', status: 'completed' }, at: at(3.6) },
  { type: 'tool-result', id: 't12', isError: false, at: at(3.6) },
  {
    type: 'assistant-text',
    id: 'a3',
    text: [
      '## できたこと',
      '',
      '- 季節限定の商品に、桜色の **バッジ** を付けました',
      '- テストは 3 件とも通っています',
      '',
      '| ファイル | 変更 |',
      '| --- | --- |',
      '| `src/SeasonBadge.tsx` | 新しく作成 |',
      '| `src/MenuItem.tsx` | バッジを出す |',
      '',
      '```tsx',
      '{item.seasonal && <SeasonBadge />}',
      '```',
    ].join('\n'),
    at: at(3.8),
  },
  { type: 'turn-end' },
  { type: 'user', id: 'u2', text: 'ありがとう。添付の画面のように、バッジと名前の間を少し空けて', images: ['sample:attach'], at: at(12) },
  { type: 'thinking', id: 'th1', text: '添付の画像では、バッジと商品名の間がおよそ 8px 空いている。gap で空けるのがよい。' },
  { type: 'tool-use', id: 't13', name: 'Edit', target: 'src/menu.css', filePath: file('src/menu.css'), input: '', at: at(12.3) },
  {
    type: 'tool-result',
    id: 't13',
    isError: false,
    added: 1,
    removed: 1,
    filePath: file('src/menu.css'),
    line: 3,
    patch: ['@@ -1,4 +1,4 @@', ' .menu-item {', '   display: flex;', '-  gap: 4px;', '+  gap: 8px;', ' }'],
    at: at(12.4),
  },
  {
    type: 'tool-use',
    id: 't14',
    name: 'SendUserFile',
    target: 'before-after.png',
    input: '',
    sentFiles: { paths: [file('before-after.png')], caption: '直す前と後の比較です' },
    at: at(12.6),
  },
  { type: 'tool-result', id: 't14', isError: false, at: at(12.6) },
  { type: 'assistant-text', id: 'a4', text: 'バッジと名前の間を 4px から 8px に広げました。', at: at(12.8) },
  { type: 'turn-end' },
  { type: 'divider', id: 'd1', text: '会話を圧縮しました（120k tokens から）' },
  { type: 'user', id: 'u3', text: '/commit', at: at(30) },
  { type: 'tool-use', id: 't15', name: 'Bash', target: 'git commit', description: '変更をコミットする', input: '# 変更をコミットする\ngit commit -am "季節限定のバッジを付ける"', at: at(30.2) },
  { type: 'tool-result', id: 't15', isError: false, output: '[main 3f2a1c0] 季節限定のバッジを付ける\n 3 files changed, 7 insertions(+), 1 deletion(-)', at: at(30.4) },
  { type: 'assistant-text', id: 'a5', text: 'コミットしました。', at: at(30.5) },
  { type: 'turn-end' },
];

export const SAMPLE_BRANCHES = ['main'];

// 作り物の画像（SVG）。shot: アプリ内ブラウザのスクリーンショット / attach: 発言に添付した画像
export const SAMPLE_IMAGES: Record<string, string> = {
  'sample:shot': svgImage(800, 500, '#f6f1ea', '季節限定 · 桜のラテ ¥580'),
  'sample:attach': svgImage(600, 360, '#ffffff', 'バッジと名前の間を 8px'),
};

function svgImage(width: number, height: number, background: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${background}"/><rect x="40" y="40" width="${width - 80}" height="64" rx="10" fill="#e9dccb"/><rect x="64" y="60" width="72" height="24" rx="12" fill="#e8a0b4"/><text x="160" y="80" font-family="sans-serif" font-size="22" fill="#3b2f2a">${label}</text><rect x="40" y="132" width="${width - 80}" height="64" rx="10" fill="#efe6da"/><rect x="40" y="224" width="${width - 80}" height="64" rx="10" fill="#efe6da"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(svg)))}`;
}
