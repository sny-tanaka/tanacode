import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import type { SessionSummary, SessionWorktree } from '@shared/ipc';
import { mockApi } from '../../../../.storybook/mockApi';
import { TooltipLayer } from '../layout/Tooltip';
import { ClaudePane } from './ClaudePane';
import { EMPTY_CHAT, type ChatItem } from './chatState';

// チャットのペイン全体。長い会話を上へスクロールすると、下端に「最新のメッセージへ」のボタンが出る

const noop = () => {};

const session: SessionSummary = {
  id: 's1',
  title: 'チャットのスクロール',
  cwd: '/Users/me/work/app',
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  running: false,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
};

// 発言と返答を交互に並べた、スクロールできる長さの会話
function conversation(count: number): ChatItem[] {
  return Array.from({ length: count }, (_, i): ChatItem =>
    i % 2 === 0
      ? { kind: 'user', id: `u${i}`, text: `${i / 2 + 1} 番目の質問です。この関数の役割を教えてください。` }
      : {
          kind: 'text',
          id: `t${i}`,
          text: `${(i + 1) / 2} 番目の返答です。\n\n- 入力を読み取り、形をそろえてから返します。\n- 失敗したときは \`null\` を返します。\n\n呼び出し元では、戻り値が \`null\` かどうかを先に確かめてください。`,
        },
  );
}

// worktree: worktree のセッション（preparing を入れると、準備の途中で起動を待っている）。pending: 起動を待っている最初の指示
function Pane({
  items,
  settingsFile = null,
  worktree = null,
  pending = null,
}: {
  items: ChatItem[];
  settingsFile?: string | null;
  worktree?: SessionWorktree | null;
  pending?: string | null;
}) {
  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg-panel)' }}>
      <ClaudePane
        session={{ ...session, settingsFile, worktree, running: !!worktree?.preparing }}
        sessions={[session]}
        onSelectSession={noop}
        chat={{ ...EMPTY_CHAT, status: worktree?.preparing ? 'starting' : 'idle', items }}
        screen={null}
        workflows={new Map()}
        subagents={new Map()}
        bashTasks={new Map()}
        contextTokens={null}
        statusLine={null}
        tasks={[]}
        activeTaskKey={null}
        onOpenTask={noop}
        onStopTask={noop}
        stoppingTasks={new Set()}
        terminalOpen={false}
        comments={[]}
        onCommentsChange={noop}
        onShowComment={noop}
        onOpenTerminal={noop}
        onShowContext={noop}
        onShowShell={noop}
        onToggleTerminal={noop}
        onOpenFile={noop}
        onResume={noop}
        onUnarchive={noop}
        onSend={noop}
        pending={pending === null ? null : { text: pending, attachments: [] }}
        sending={[]}
        onTakePending={() => null}
      />
      <TooltipLayer />
    </div>
  );
}

// ツールの呼び出しの間に思考が挟まる会話。思考はツールのまとまりに入れず、外に出す
const tool = (id: string, name: string, target: string): ChatItem => ({ kind: 'tool', id, name, target, status: 'done', input: '{}' });
const withThinking: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'ログイン画面のバグを直してください。' },
  { kind: 'thinking', id: 'th1', text: 'まずログイン画面の部品と、フォームの送信の処理を読む。' },
  tool('r1', 'Read', 'src/Login.tsx'),
  tool('r2', 'Grep', 'onSubmit'),
  { kind: 'thinking', id: 'th2', text: '送信のたびに二重に呼ばれている。useEffect の依存の配列が足りないのが原因らしい。' },
  tool('e1', 'Edit', 'src/Login.tsx'),
  tool('b1', 'Bash', 'npm test'),
  { kind: 'text', id: 't1', text: '`useEffect` の依存の配列を直しました。テストも通っています。' },
];

// 3 秒ごとに返答が増える。最下部にいれば追いかけ、上へスクロールしていれば追いかけずにボタンを出す
function GrowingPane() {
  const [count, setCount] = useState(30);
  useEffect(() => {
    const timer = setInterval(() => setCount((c) => c + 2), 3000);
    return () => clearInterval(timer);
  }, []);
  return <Pane items={conversation(count)} />;
}

const meta = {
  title: 'チャット/ペイン',
  component: Pane,
  parameters: { bare: true },
  args: { items: conversation(30) },
} satisfies Meta<typeof Pane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 長い会話: Story = {};

export const 思考を挟む会話: Story = { args: { items: withThinking } };

export const 返答が増える: Story = { render: () => <GrowingPane /> };

const LITELLM = { id: 'f1', name: 'litellm', path: '/Users/me/.claude/settings-litellm.json', error: null, model: 'sonnet' };

// 設定ファイルの選択欄は、登録が 0 件でも入力欄の下に出る（「管理…」から最初の 1 件を登録する）。標準のままなら、色は付かない
export const 設定ファイルが無い: Story = {
  beforeEach: () => mockApi({ 'settingsFiles.list': () => Promise.resolve([]) }),
};

// 登録した設定ファイルがあるとき。標準のままなので、色は付かない
export const 設定ファイルを選べる: Story = {
  beforeEach: () => mockApi({ 'settingsFiles.list': () => Promise.resolve([LITELLM]) }),
};

// 標準以外の設定ファイルで動いているセッション。取り違えないよう、選択欄に色が付く（一覧の行にも名前が出る）
export const 設定ファイルで動いている: Story = {
  beforeEach: () => mockApi({ 'settingsFiles.list': () => Promise.resolve([LITELLM]) }),
  args: { settingsFile: 'f1' },
};

// 選んでいた設定ファイルを登録から外したとき。黙って標準に見せず、「（登録なし）」と出す
export const 設定ファイルの登録なし: Story = {
  beforeEach: () => mockApi({ 'settingsFiles.list': () => Promise.resolve([]) }),
  args: { settingsFile: 'f1' },
};

const WORKTREE: SessionWorktree = { name: 'tc-1002-k3x9', branch: 'worktree-tc-1002-k3x9', root: '/Users/me/work/app', preparing: null };

// worktree の準備の途中（package-lock.json が元のフォルダと違うので npm install している）。最初の指示は、準備が終わるのを待って送る。
// 「ターミナルで見る」（モニターのアイコンのボタン）で、npm install の進み具合のタブを出す
export const worktreeの準備中: Story = {
  args: { items: [], worktree: { ...WORKTREE, preparing: 'installing' }, pending: 'ログイン画面のバグを直してください。' },
};

// worktree の準備が終わったあと。何をしたかを、知らせとして出す
export const worktreeで始めた: Story = {
  args: {
    items: [
      { kind: 'info', id: 'i1', text: 'worktree .claude/worktrees/tc-1002-k3x9（ブランチ worktree-tc-1002-k3x9）で始めました。node_modules は元のフォルダから複製しました' },
      ...conversation(2),
    ],
    worktree: WORKTREE,
  },
};
