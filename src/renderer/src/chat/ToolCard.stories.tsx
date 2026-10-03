import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { ChatItem } from './chatState';
import { ToolCard } from './ToolCard';
import { ToolGroupRow } from './ToolGroupRow';
import type { ToolGroup } from './toolGroups';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const tool = (id: string, name: string, target: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool',
  id,
  name,
  target,
  status: 'done',
  input: JSON.stringify({ command: target }, null, 2),
  output: '',
  startedAt: 0,
  endedAt: 4200,
  ...extra,
});

const noop = () => {};

const meta = {
  title: 'チャット/ツールカード',
  component: ToolCard,
  args: { item: tool('t1', 'Bash', 'npm run typecheck'), subagent: undefined, bash: undefined, onOpenFile: noop, onOpenTask: null },
} satisfies Meta<typeof ToolCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 完了: Story = {};

export const 実行中: Story = { args: { item: tool('t2', 'Bash', 'npm run build', { status: 'running', endedAt: undefined }) } };

export const 失敗: Story = { args: { item: tool('t3', 'Bash', 'sleep 25', { status: 'error', output: 'Blocked: standalone sleep 25.' }) } };

export const 編集: Story = {
  args: {
    item: tool('t4', 'Edit', 'src/renderer/src/global.css', {
      filePath: '/Users/you/work/tanacode/src/renderer/src/global.css',
      added: 12,
      removed: 4,
    }),
  },
};

const group = (items: ToolItem[]): ToolGroup => ({ kind: 'tool-group', id: 'g1', items, tools: items });
const items = [
  tool('a', 'Read', 'src/main/session-manager.ts', { filePath: '/x/src/main/session-manager.ts' }),
  tool('b', 'Edit', 'src/main/session-manager.ts', { filePath: '/x/src/main/session-manager.ts', added: 8, removed: 2 }),
  tool('c', 'Bash', 'npm run typecheck', { status: 'error' }),
];
const groupArgs = { workflows: new Map(), subagents: new Map(), bashTasks: new Map(), onOpenFile: noop, onOpenTask: null, onToggle: noop };

// 本文と本文の間のツールの呼び出しをまとめた「N件の操作」の行
export const 操作のまとまり_閉じた状態: StoryObj<typeof ToolGroupRow> = {
  render: () => <ToolGroupRow group={group(items)} open={false} {...groupArgs} />,
};

export const 操作のまとまり_開いた状態: StoryObj<typeof ToolGroupRow> = {
  render: () => <ToolGroupRow group={group(items)} open {...groupArgs} />,
};

export const 操作のまとまり_実行中: StoryObj<typeof ToolGroupRow> = {
  render: () => (
    <ToolGroupRow group={group([...items.slice(0, 2), tool('d', 'Bash', 'npm run build', { status: 'running', endedAt: undefined })])} open={false} {...groupArgs} />
  ),
};

// 「進める」で、ツールを 1 つずつ動かして終わらせる。畳んだ行の下に実行中の行が出て、終わるとチェックを描いて消える
const STEPS = [
  tool('p1', 'Read', 'src/main/index.ts', { filePath: '/x/src/main/index.ts' }),
  tool('p2', 'Edit', 'src/main/index.ts', { filePath: '/x/src/main/index.ts', added: 3, removed: 1 }),
  tool('p3', 'Bash', 'npm run typecheck', { description: '型の誤りが無いか確認する' }),
  tool('p4', 'Bash', 'npm test', { status: 'error', description: 'テストを流して壊れていないか確かめる' }),
];

function Progress() {
  const [step, setStep] = useState(0);
  // step 番目までが始まっていて、step - 1 番目までが終わっている（最後に始まったものだけ実行中）
  const tools = STEPS.slice(0, Math.min(step + 1, STEPS.length)).map((t, i) =>
    i < step ? t : { ...t, status: 'running' as const, endedAt: undefined },
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="ghost-button" onClick={() => setStep((s) => Math.min(s + 1, STEPS.length))}>
          進める
        </button>
        <button className="ghost-button" onClick={() => setStep(0)}>
          最初から
        </button>
      </div>
      <ToolGroupRow group={group(tools)} open={false} {...groupArgs} />
    </div>
  );
}

export const 操作のまとまり_進行: StoryObj<typeof ToolGroupRow> = { render: () => <Progress /> };

// 「切り替える」で、実行中と完了（失敗）を行き来する。完了すると枠のグラデーションが薄くなって消え、チェックを描く
function Finish() {
  const [status, setStatus] = useState<ToolItem['status']>('running');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="ghost-button" onClick={() => setStatus('done')}>
          完了にする
        </button>
        <button className="ghost-button" onClick={() => setStatus('error')}>
          失敗にする
        </button>
        <button className="ghost-button" onClick={() => setStatus('running')}>
          実行中に戻す
        </button>
      </div>
      <ToolCard
        item={tool('f1', 'Bash', 'npm run build', { status, endedAt: status === 'running' ? undefined : 4200 })}
        subagent={undefined}
        bash={undefined}
        onOpenFile={noop}
        onOpenTask={null}
      />
    </div>
  );
}

export const 実行中から完了へ: StoryObj<typeof ToolCard> = { render: () => <Finish /> };

export const 説明つき: Story = {
  args: { item: tool('d1', 'Bash', 'grep -rn "matchMedia" src/test', { description: 'jest.setup.ts と matchMediaMock の内容を確認する' }) },
};

// ツールの説明（description）があるもの。畳んだ行の下の実行中の行と、開いたときのカードの見出しに説明が出る
const described: ToolGroup = {
  kind: 'tool-group',
  id: 'g2',
  items: [
    tool('q1', 'Bash', 'cat jest.setup.ts', { description: 'jest.setup.ts と matchMediaMock の内容を確認する' }),
    tool('q2', 'Bash', 'cat DetailGroup.test.tsx', { status: 'running', endedAt: undefined, description: 'DetailGroup.test.tsx の within() スコープパターンを確認する' }),
  ],
  tools: [],
};
described.tools = described.items.filter((i): i is ToolItem => i.kind === 'tool');

export const 操作のまとまり_説明つき: StoryObj<typeof ToolGroupRow> = {
  render: () => <ToolGroupRow group={described} open={false} {...groupArgs} />,
};

export const 操作のまとまり_説明つき_開いた状態: StoryObj<typeof ToolGroupRow> = {
  render: () => <ToolGroupRow group={described} open {...groupArgs} />,
};

// セッションのツール（tanacode-sessions）。対象のセッションを一覧から探して名前を出し、カードのクリックでそのセッションへ移る（右の矢印）
const CHILD_ID = 'c0ffee12-3456-4789-8abc-def012345678';
const SESSIONS = [{ id: CHILD_ID, title: 'API の実装' }];
const sessionArgs = { sessions: SESSIONS, onSelectSession: noop };
const startPrompt = '検索の API（/api/search）を実装してください。\n入力は q（文字列）と limit（数）。終わったら npm test が通ることを確かめてください。';

// start_session は結果に session_id が入る。対象の欄には最初の指示を出し、起動した子の名前は下の行に出す
export const セッション_子セッションを始める: Story = {
  args: {
    item: tool('st1', 'mcp__tanacode-sessions__start_session', startPrompt.split('\n')[0], {
      input: JSON.stringify({ prompt: startPrompt, worktree: true, name: 'API の実装' }, null, 2),
      output: JSON.stringify(
        {
          session_id: CHILD_ID,
          name: 'API の実装',
          folder: '/Users/you/work/tanacode/.claude/worktrees/tc-1003-a1b2',
          worktree: { name: 'tc-1003-a1b2', branch: 'worktree-tc-1003-a1b2' },
          permission_mode: 'acceptEdits',
          state: 'starting',
          note: '起動が終わりしだい、最初の指示を送ります。結果は wait_sessions で待ってください',
        },
        null,
        2,
      ),
    }),
    ...sessionArgs,
  },
};

// send_message は入力に session_id が入る（先頭 8 文字でもよい）。対象の欄には、ID の代わりにセッションの名前を出す
export const セッション_子セッションに指示: Story = {
  args: {
    item: tool('sm1', 'mcp__tanacode-sessions__send_message', CHILD_ID.slice(0, 8), {
      input: JSON.stringify({ session_id: CHILD_ID.slice(0, 8), message: 'limit の上限は 100 にしてください' }, null, 2),
      output: JSON.stringify({ session_id: CHILD_ID, state: 'working', note: '子は作業中なので、順番待ちになりました' }, null, 2),
    }),
    ...sessionArgs,
  },
};

// 一覧に無いセッション（一覧から削除した子など）は、ID のまま出して、移る操作を付けない
export const セッション_一覧に無いセッション: Story = {
  args: {
    item: tool('gs1', 'mcp__tanacode-sessions__get_session', 'deadbeef', {
      input: JSON.stringify({ session_id: 'deadbeef' }, null, 2),
      status: 'error',
      output: '見えるセッションに、ID が deadbeef のものはありません（list_sessions で確かめてください）',
    }),
    ...sessionArgs,
  },
};

// 畳んだ行の要約は「セッション N」、実行中の行はツールの名前（「子セッションを待つ…」）
const sessionGroup = group([
  tool('sg1', 'mcp__tanacode-sessions__list_sessions', '', { input: '{}' }),
  tool('sg2', 'mcp__tanacode-sessions__start_session', startPrompt.split('\n')[0], {
    input: JSON.stringify({ prompt: startPrompt, worktree: true }, null, 2),
    output: JSON.stringify({ session_id: CHILD_ID, state: 'starting' }, null, 2),
  }),
  tool('sg3', 'mcp__tanacode-sessions__wait_sessions', '', { input: '{}', status: 'running', endedAt: undefined }),
]);

export const セッション_操作のまとまり: StoryObj<typeof ToolGroupRow> = {
  render: () => <ToolGroupRow group={sessionGroup} open={false} {...groupArgs} {...sessionArgs} />,
};

export const セッション_操作のまとまり_開いた状態: StoryObj<typeof ToolGroupRow> = {
  render: () => <ToolGroupRow group={sessionGroup} open {...groupArgs} {...sessionArgs} />,
};
