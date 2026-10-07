// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, HookRun } from '@shared/chat';
import type { AgentLogRef } from '@shared/task';
import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';
import { TaskPane } from '../../src/renderer/src/tasks/TaskPane';
import { TaskTray } from '../../src/renderer/src/tasks/TaskTray';
import type { TaskEntry } from '../../src/renderer/src/tasks/taskList';
import { WorkflowCard } from '../../src/renderer/src/workflow/WorkflowCard';
import { WorkflowFlow } from '../../src/renderer/src/workflow/WorkflowFlow';
import './dom';
import { mockApi } from './mock-api';

// タスク（入力欄の上のトレイ・エディタの場所に開く中身）と、ワークフロー（チャットのカード・フロー図）の、ボタン。
// 押したら、どのタスクを開く・止めるか、どのエージェントの会話を読むか（セッションとタスクの ID）まで確かめる

beforeAll(() => {
  // フロー図は線を引くために大きさの変化を見る。jsdom には無いので、何もしないものにする
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});
let api: ReturnType<typeof mockApi>;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const entry = (kind: TaskEntry['ref']['kind'], id: string, name: string, over: Partial<TaskEntry> = {}): TaskEntry => ({
  ref: { kind, toolUseId: id },
  key: `${kind}:${id}`,
  name,
  state: 'running',
  background: true,
  startedAt: 1_000,
  durationMs: null,
  progress: '',
  ...over,
});

describe('TaskTray（入力欄の上のタスクの一覧）', () => {
  beforeEach(() => {
    api = mockApi();
    api.install();
  });
  const row = (name: string) => screen.getByText(name).closest('.task-row') as HTMLElement;
  const stopOf = (name: string) => row(name).querySelector('.task-stop') as HTMLButtonElement;

  it('行を押すとそのタスクを開き、止めるボタンはそのタスクを止める（開きはしない）', () => {
    const onOpen = vi.fn();
    const onStop = vi.fn();
    const tasks = [entry('bash', 'b1', 'npm run dev'), entry('subagent', 'a1', '調査', { background: false }), entry('workflow', 'w1', 'review')];
    render(<TaskTray tasks={tasks} activeKey="workflow:w1" onOpen={onOpen} onStop={onStop} stopping={new Set()} />);
    expect(row('review').className).toContain('active');
    fireEvent.click(row('調査'));
    expect(onOpen).toHaveBeenCalledWith(tasks[1]);
    // 本体の作業の中で動いているサブエージェントは止められない
    expect(stopOf('調査')).toBeNull();
    fireEvent.click(stopOf('npm run dev'));
    expect(onStop).toHaveBeenCalledWith(tasks[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('止めている途中のタスクは、止めるボタンを押せない', () => {
    const onStop = vi.fn();
    render(<TaskTray tasks={[entry('bash', 'b1', 'npm run dev')]} activeKey={null} onOpen={() => {}} onStop={onStop} stopping={new Set(['bash:b1'])} />);
    expect(stopOf('npm run dev').disabled).toBe(true);
    expect(stopOf('npm run dev').getAttribute('aria-label')).toBe('止めています');
    fireEvent.click(stopOf('npm run dev'));
    expect(onStop).not.toHaveBeenCalled();
  });

  it('見出しを押すと畳み、もう一度押すと開く', () => {
    render(<TaskTray tasks={[entry('bash', 'b1', 'npm run dev'), entry('bash', 'b2', 'npm test')]} activeKey={null} onOpen={() => {}} onStop={() => {}} stopping={new Set()} />);
    const head = screen.getByText('タスク').closest('button')!;
    expect(head.textContent).toContain('実行中 2');
    fireEvent.click(head);
    expect(screen.queryByText('npm run dev')).toBeNull();
    expect(screen.queryByText('npm test')).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText('npm run dev')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('多いときは 3 件まで出し、「ほか N 件」を押すと全部出す。出したタスクも押せば開く', () => {
    const onOpen = vi.fn();
    const tasks = [1, 2, 3, 4, 5].map((n) => entry('bash', `b${n}`, `コマンド ${n}`));
    render(<TaskTray tasks={tasks} activeKey={null} onOpen={onOpen} onStop={() => {}} stopping={new Set()} />);
    expect(document.querySelectorAll('.task-row')).toHaveLength(3);
    expect(screen.queryByText('コマンド 5')).toBeNull();
    fireEvent.click(screen.getByText('ほか 2 件'));
    expect(document.querySelectorAll('.task-row')).toHaveLength(5);
    expect(screen.queryByText(/ほか/)).toBeNull();
    fireEvent.click(row('コマンド 5'));
    expect(onOpen).toHaveBeenCalledWith(tasks[4]);
  });

  it('終わったタスクは、チェックを描く間だけ残って押せば開ける。そのあとは消える', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const running = entry('bash', 'b1', 'npm test');
    const { rerender } = render(<TaskTray tasks={[running]} activeKey={null} onOpen={onOpen} onStop={() => {}} stopping={new Set()} />);
    const done = { ...running, state: 'done' as const, durationMs: 3_000 };
    rerender(<TaskTray tasks={[done]} activeKey={null} onOpen={onOpen} onStop={() => {}} stopping={new Set()} />);
    expect(row('npm test').className).toContain('leaving');
    expect(row('npm test').textContent).toContain('完了');
    // 終わったものは止められない
    expect(stopOf('npm test')).toBeNull();
    fireEvent.click(row('npm test'));
    expect(onOpen).toHaveBeenCalledWith(done);
    act(() => vi.advanceTimersByTime(1_800));
    expect(screen.queryByText('npm test')).toBeNull();
  });

  it('別のセッションのタスクに描き直した直後に押しても、新しいタスクを開く・止める', () => {
    const onOpen = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(<TaskTray tasks={[entry('bash', 'b1', 'npm run dev')]} activeKey={null} onOpen={onOpen} onStop={onStop} stopping={new Set()} />);
    const next = [entry('bash', 'c1', 'cargo watch'), entry('workflow', 'c2', 'migrate')];
    rerender(<TaskTray tasks={next} activeKey={null} onOpen={onOpen} onStop={onStop} stopping={new Set()} />);
    expect(screen.queryByText('npm run dev')).toBeNull();
    fireEvent.click(row('migrate'));
    fireEvent.click(stopOf('cargo watch'));
    expect(onOpen.mock.calls).toEqual([[next[1]]]);
    expect(onStop.mock.calls).toEqual([[next[0]]]);
  });
});

// サブエージェントの会話ログ。本文の間のツールの呼び出しは「N件の操作」に、ツールに付かない hooks は 1 行に畳まれる
const hook = (command: string): HookRun => ({
  event: 'Stop',
  name: 'Stop',
  command,
  outcome: 'success',
  exitCode: 0,
  durationMs: 120,
  stdout: '',
  stderr: '',
  message: '',
  toolUseId: null,
});
const agentLog = (prefix: string): ChatEvent[] => [
  { type: 'user', id: `${prefix}u`, text: `${prefix}: 調べて` },
  { type: 'tool-use', id: `${prefix}t1`, name: 'Bash', target: 'ls src', description: `${prefix} のファイルを一覧する`, input: 'ls src', at: 0 },
  { type: 'tool-result', id: `${prefix}t1`, isError: false, output: 'index.ts', at: 1 },
  { type: 'assistant-text', id: `${prefix}a1`, text: `${prefix} の調べた結果です。` },
  { type: 'hook', id: `${prefix}h1`, run: hook(`${prefix}-notify.sh`) },
  { type: 'assistant-text', id: `${prefix}a2`, text: `${prefix} はここまで。` },
];

const agent = (agentId: string, label: string, phase: string | null, over: Partial<WorkflowAgent> = {}): WorkflowAgent => ({
  agentId,
  label,
  phase,
  model: 'claude-sonnet-5',
  state: 'done',
  toolCalls: 3,
  lastTool: null,
  promptPreview: `${label} のプロンプト`,
  resultPreview: `${label} の結果`,
  tokens: 1_000,
  durationMs: 5_000,
  startSeq: 0,
  endSeq: 1,
  ...over,
});
const workflowRun = (toolUseId: string, agents: WorkflowAgent[], over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  toolUseId,
  runId: `run-${toolUseId}`,
  name: `wf-${toolUseId}`,
  summary: '',
  status: 'completed',
  phases: [{ title: 'Fleet', detail: null }],
  agents,
  startedAt: null,
  durationMs: 10_000,
  totalTokens: 2_000,
  totalToolCalls: 6,
  resumed: false,
  resumedLater: false,
  ...over,
});

describe('TaskPane（タスクの中身）', () => {
  beforeEach(() => {
    api = mockApi({
      'tasks.agentLog': ((sessionId: string, ref: AgentLogRef) => Promise.resolve(agentLog(`${sessionId}/${ref.kind === 'workflow' ? ref.agentId : ref.toolUseId}`))) as never,
    });
    api.install();
  });
  const props = { subagent: undefined, workflow: undefined, bash: undefined, stopping: false, onStop: () => {}, onClose: () => {}, onOpenFile: () => {} };
  const groupHead = (text: RegExp) => screen.getByText(text).closest('button') as HTMLButtonElement;

  it('サブエージェント: 畳んだ操作の行を押すと開いてツールのカードを出し、もう一度押すと畳む', async () => {
    render(<TaskPane {...props} sessionId="s1" task={entry('subagent', 'a1', '調査', { state: 'done', durationMs: 1_000 })} />);
    await screen.findByText('s1/a1 の調べた結果です。');
    expect(api.argsOf('tasks.agentLog')).toEqual([['s1', { kind: 'subagent', toolUseId: 'a1' }]]);
    const head = groupHead(/1件の操作/);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('s1/a1 のファイルを一覧する')).toBeNull();
    fireEvent.click(head);
    expect(groupHead(/1件の操作/).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('s1/a1 のファイルを一覧する')).toBeTruthy();
    fireEvent.click(groupHead(/1件の操作/));
    expect(screen.queryByText('s1/a1 のファイルを一覧する')).toBeNull();
  });

  it('サブエージェント: 畳んだ hooks の行を押すと、1 件ずつの一覧を出す', async () => {
    render(<TaskPane {...props} sessionId="s1" task={entry('subagent', 'a1', '調査', { state: 'done', durationMs: 1_000 })} />);
    await screen.findByText('s1/a1 の調べた結果です。');
    expect(screen.queryByText('s1/a1-notify.sh')).toBeNull();
    // hooks の行（きっかけの Stop を出す）。操作の行とは別
    const hooks = [...document.querySelectorAll<HTMLButtonElement>('.tool-group-head')].find((b) => b.textContent!.includes('Stop'))!;
    expect(hooks.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(hooks);
    expect(hooks.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('s1/a1-notify.sh')).toBeTruthy();
    fireEvent.click(hooks);
    expect(screen.queryByText('s1/a1-notify.sh')).toBeNull();
  });

  it('サブエージェント: 別のセッションのタスクに描き直すと、そのセッションのタスクの会話を読み、開く行もその会話のものになる', async () => {
    const { rerender } = render(<TaskPane {...props} sessionId="s1" task={entry('subagent', 'a1', '調査', { state: 'done', durationMs: 1_000 })} />);
    await screen.findByText('s1/a1 の調べた結果です。');
    fireEvent.click(groupHead(/1件の操作/));
    rerender(<TaskPane {...props} sessionId="s2" task={entry('subagent', 'a9', '別の調査', { state: 'done', durationMs: 1_000 })} />);
    await screen.findByText('s2/a9 の調べた結果です。');
    expect(api.argsOf('tasks.agentLog')).toEqual([
      ['s1', { kind: 'subagent', toolUseId: 'a1' }],
      ['s2', { kind: 'subagent', toolUseId: 'a9' }],
    ]);
    // 前の会話で開いた行は持ち越さない
    expect(groupHead(/1件の操作/).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(groupHead(/1件の操作/));
    expect(screen.getByText('s2/a9 のファイルを一覧する')).toBeTruthy();
    expect(screen.queryByText('s1/a1 のファイルを一覧する')).toBeNull();
  });

  const RUN = workflowRun('wf1', [agent('x1', 'correctness', 'Fleet'), agent('x2', 'security', 'Fleet', { startSeq: 0, endSeq: 2 })]);
  const agentItem = (name: string) => document.querySelector(`.task-agent[title="${name}"]`) as HTMLButtonElement;
  const flowNode = (name: string) => document.querySelector(`.flow-node[title="${name}"]`) as HTMLButtonElement;
  const overview = () => screen.getByText('概要').closest('button') as HTMLButtonElement;

  it('ワークフロー: 一覧のエージェントを押すとその会話を出し、「概要」を押すとフロー図に戻る', async () => {
    render(<TaskPane {...props} sessionId="s1" task={entry('workflow', 'wf1', 'review', { state: 'done', durationMs: 1_000 })} workflow={RUN} />);
    expect(overview().className).toContain('active');
    expect(screen.getByText('エージェントをクリックすると、その中のやりとりを開きます')).toBeTruthy();
    fireEvent.click(agentItem('security'));
    await screen.findByText('s1/x2 の調べた結果です。');
    expect(api.argsOf('tasks.agentLog')).toEqual([['s1', { kind: 'workflow', toolUseId: 'wf1', agentId: 'x2' }]]);
    expect(agentItem('security').className).toContain('active');
    expect(overview().className).not.toContain('active');
    fireEvent.click(agentItem('correctness'));
    await screen.findByText('s1/x1 の調べた結果です。');
    fireEvent.click(overview());
    expect(overview().className).toContain('active');
    expect(screen.queryByText('s1/x1 の調べた結果です。')).toBeNull();
    expect(screen.getByText('エージェントをクリックすると、その中のやりとりを開きます')).toBeTruthy();
  });

  it('ワークフロー: フロー図のエージェントを押しても、一覧で選んだのと同じく、その会話を出す', async () => {
    render(<TaskPane {...props} sessionId="s1" task={entry('workflow', 'wf1', 'review', { state: 'done', durationMs: 1_000 })} workflow={RUN} />);
    fireEvent.click(flowNode('correctness'));
    await screen.findByText('s1/x1 の調べた結果です。');
    expect(api.argsOf('tasks.agentLog')).toEqual([['s1', { kind: 'workflow', toolUseId: 'wf1', agentId: 'x1' }]]);
    expect(agentItem('correctness').className).toContain('active');
  });

  it('ワークフロー: 別のセッションのワークフローに描き直した直後に押しても、そのセッションのそのワークフローのエージェントの会話を読む', async () => {
    const { rerender } = render(<TaskPane {...props} sessionId="s1" task={entry('workflow', 'wf1', 'review', { state: 'done', durationMs: 1_000 })} workflow={RUN} />);
    fireEvent.click(agentItem('security'));
    await screen.findByText('s1/x2 の調べた結果です。');
    const other = workflowRun('wf2', [agent('y1', 'migrate', 'Fleet'), agent('y2', 'verify', 'Fleet', { startSeq: 2, endSeq: 3 })]);
    rerender(<TaskPane {...props} sessionId="s2" task={entry('workflow', 'wf2', 'migration', { state: 'done', durationMs: 1_000 })} workflow={other} />);
    // 別のワークフローでは、選んでいたエージェントを持ち越さず、概要から
    expect(overview().className).toContain('active');
    fireEvent.click(agentItem('verify'));
    await screen.findByText('s2/y2 の調べた結果です。');
    fireEvent.click(overview());
    fireEvent.click(flowNode('migrate'));
    await screen.findByText('s2/y1 の調べた結果です。');
    expect(api.argsOf('tasks.agentLog').slice(1)).toEqual([
      ['s2', { kind: 'workflow', toolUseId: 'wf2', agentId: 'y2' }],
      ['s2', { kind: 'workflow', toolUseId: 'wf2', agentId: 'y1' }],
    ]);
  });
});

describe('WorkflowCard（チャットのワークフローのカード）', () => {
  beforeEach(() => {
    api = mockApi();
    api.install();
  });
  const rowOf = (name: string) => screen.getByText(name).closest('button') as HTMLButtonElement;

  it('エージェントの行を押すと結果（無ければプロンプト）を開き、もう一度押すと閉じる', () => {
    const run = workflowRun('wf1', [agent('x1', 'correctness', 'Fleet'), agent('x2', 'security', 'Fleet', { state: 'running', resultPreview: null, durationMs: null, endSeq: null })], { status: 'running' });
    render(<WorkflowCard run={run} fallbackName="review" onOpen={null} />);
    fireEvent.click(rowOf('correctness'));
    expect(screen.getByText(/correctness の結果/).textContent).toContain('結果');
    fireEvent.click(rowOf('security'));
    expect(screen.getByText(/security のプロンプト/).textContent).toContain('プロンプト');
    fireEvent.click(rowOf('correctness'));
    expect(screen.queryByText(/correctness の結果/)).toBeNull();
    expect(screen.getByText(/security のプロンプト/)).toBeTruthy();
  });

  it('フェーズが分からない実行中のエージェントも、行を押すと開く', () => {
    const run = workflowRun('wf1', [agent('x1', 'scan', null, { state: 'running', resultPreview: null })], { status: 'running', phases: [{ title: 'Scan', detail: null }, { title: 'Fix', detail: null }] });
    render(<WorkflowCard run={run} fallbackName="review" onOpen={null} />);
    fireEvent.click(rowOf('scan'));
    expect(screen.getByText(/scan のプロンプト/)).toBeTruthy();
  });

  it('「開く」を押すと中身を大きく開く', () => {
    const onOpen = vi.fn();
    render(<WorkflowCard run={workflowRun('wf1', [agent('x1', 'correctness', 'Fleet')])} fallbackName="review" onOpen={onOpen} />);
    fireEvent.click(screen.getByLabelText('開く'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('別の実行に描き直した直後に押しても、新しい実行のエージェントを開く', () => {
    const { rerender } = render(<WorkflowCard run={workflowRun('wf1', [agent('x1', 'correctness', 'Fleet')])} fallbackName="review" onOpen={null} />);
    rerender(<WorkflowCard run={workflowRun('wf2', [agent('y1', 'migrate', 'Fleet')])} fallbackName="migration" onOpen={null} />);
    expect(screen.queryByText('correctness')).toBeNull();
    fireEvent.click(rowOf('migrate'));
    expect(screen.getByText(/migrate の結果/)).toBeTruthy();
  });
});

describe('WorkflowFlow（ワークフローのフロー図）', () => {
  beforeEach(() => {
    api = mockApi();
    api.install();
  });
  const node = (name: string) => document.querySelector(`.flow-node[title="${name}"]`) as HTMLButtonElement;

  it('エージェントを押すと、そのエージェントを開く', () => {
    const onOpenAgent = vi.fn();
    const run = workflowRun('wf1', [agent('x1', 'correctness', 'Fleet'), agent('x2', 'aggregate', 'Merge', { startSeq: 2, endSeq: 3 })], {
      phases: [
        { title: 'Fleet', detail: null },
        { title: 'Merge', detail: null },
      ],
    });
    render(<WorkflowFlow run={run} onOpenAgent={onOpenAgent} />);
    fireEvent.click(node('aggregate'));
    fireEvent.click(node('correctness'));
    expect(onOpenAgent.mock.calls).toEqual([['x2'], ['x1']]);
  });

  it('別の実行に描き直した直後に押しても、新しい実行のエージェントを、新しく渡した受け手で開く', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<WorkflowFlow run={workflowRun('wf1', [agent('x1', 'correctness', 'Fleet')])} onOpenAgent={first} />);
    rerender(<WorkflowFlow run={workflowRun('wf2', [agent('y1', 'migrate', 'Fleet')])} onOpenAgent={second} />);
    await waitFor(() => expect(node('correctness')).toBeNull());
    fireEvent.click(node('migrate'));
    expect(second).toHaveBeenCalledWith('y1');
    expect(first).not.toHaveBeenCalled();
  });
});
