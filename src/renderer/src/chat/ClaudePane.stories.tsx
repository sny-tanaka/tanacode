import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import type { SessionSummary } from '@shared/ipc';
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
  remoteControl: false,
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

function Pane({ items }: { items: ChatItem[] }) {
  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg-panel)' }}>
      <ClaudePane
        session={session}
        chat={{ ...EMPTY_CHAT, status: 'idle', items }}
        screen={null}
        workflows={new Map()}
        subagents={new Map()}
        bashTasks={new Map()}
        contextTokens={null}
        statusLine={null}
        tasks={[]}
        activeTaskKey={null}
        onOpenTask={noop}
        terminalOpen={false}
        comments={[]}
        onCommentsChange={noop}
        onShowComment={noop}
        onOpenTerminal={noop}
        onToggleTerminal={noop}
        onOpenFile={noop}
        onResume={noop}
        onUnarchive={noop}
        onSend={noop}
        pending={null}
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
