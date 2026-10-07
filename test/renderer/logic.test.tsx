// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BranchChanges, SessionSummary } from '@shared/ipc';
import type { ScheduledMessage } from '@shared/scheduled';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';
import type { ChatItem } from '../../src/renderer/src/chat/chatState';
import { needsAttention, scheduledOf } from '../../src/renderer/src/chat/scheduled';
import { errorMessage } from '../../src/renderer/src/errorMessage';
import { describePicked } from '../../src/renderer/src/preview/picker';
import { normalizeUrl } from '../../src/renderer/src/preview/PreviewPane';
import { formatComments } from '../../src/renderer/src/review/comments';
import { branchPaths } from '../../src/renderer/src/scm/ScmPanel';
import { useScmView } from '../../src/renderer/src/scm/scmView';
import { isWorking, liveChildrenOf } from '../../src/renderer/src/sessions/sessionTree';
import { stableRuns } from '../../src/renderer/src/tasks/stableRuns';
import { buildTasks, elapsed, stoppable } from '../../src/renderer/src/tasks/taskList';
import { flowGroups, flowPhases } from '../../src/renderer/src/workflow/flow';
import { formatDuration, formatTokens, groupByPhase, shortModel } from '../../src/renderer/src/workflow/WorkflowCard';

// 画面の、React に頼らない（または小さなフックの）ロジック

const summary = (over: Partial<SessionSummary>): SessionSummary =>
  ({ id: 's', title: null, cwd: '/w', archived: false, running: true, attention: null, backgroundTasks: 0, worktree: null, parentId: null, ...over }) as SessionSummary;

describe('セッション', () => {
  it('isWorking: 作業中・起動中・操作待ち・バックグラウンドの完了待ち・worktree の準備中は手が離せない', () => {
    expect(isWorking(summary({}), 'idle')).toBe(false);
    expect(isWorking(summary({}), 'running')).toBe(true);
    expect(isWorking(summary({}), 'starting')).toBe(true);
    expect(isWorking(summary({ attention: 'question' }), 'idle')).toBe(true);
    expect(isWorking(summary({ backgroundTasks: 1 }), 'idle')).toBe(true);
    expect(isWorking(summary({ running: false, backgroundTasks: 1 }), 'idle')).toBe(false);
    expect(isWorking(summary({ running: false, worktree: { name: 'w', branch: 'b', root: '/r', preparing: 'installing' } }), 'not-started')).toBe(true);
  });

  it('liveChildrenOf: アーカイブしていない子だけ', () => {
    const list = [summary({ id: 'p' }), summary({ id: 'c1', parentId: 'p' }), summary({ id: 'c2', parentId: 'p', archived: true }), summary({ id: 'x', parentId: 'q' })];
    expect(liveChildrenOf(list, 'p').map((s) => s.id)).toEqual(['c1']);
  });

  it('errorMessage: IPC の失敗の前置きを外して、本文だけにする', () => {
    expect(errorMessage(new Error("Error invoking remote method 'sessions:create': Error: フォルダがありません"))).toBe('フォルダがありません');
    expect(errorMessage('そのまま')).toBe('そのまま');
  });
});

describe('タスク', () => {
  it('stableRuns: 中身の変わらないものは前のオブジェクトを使い回し、何も変わらなければ前の Map を返す', () => {
    const a = { toolUseId: 'a', n: 1 };
    const b = { toolUseId: 'b', n: 1 };
    const first = stableRuns(undefined, [a, b]);
    const same = stableRuns(first, [{ ...a }, { ...b }]);
    expect(same).toBe(first);
    const changed = stableRuns(first, [{ ...a }, { ...b, n: 2 }]);
    expect(changed).not.toBe(first);
    expect(changed.get('a')).toBe(a);
    expect(changed.get('b')).toEqual({ toolUseId: 'b', n: 2 });
    expect(stableRuns(first, [a]).size).toBe(1);
  });

  it('buildTasks: サブエージェント・ワークフロー・Bash を、新しく始めた順に、状態と進み具合をそろえて並べる', () => {
    const items: ChatItem[] = [{ kind: 'tool', id: 'agent1', name: 'Agent', target: 'テストを直す', status: 'running', input: '' }];
    const subagents = new Map([
      ['agent1', { toolUseId: 'agent1', state: 'running', background: true, startedAt: 100, durationMs: null, toolCalls: 3, recent: [{ name: 'Read', target: 'a.ts' }] } as unknown as SubagentRun],
    ]);
    const workflows = new Map([
      [
        'wf1',
        {
          toolUseId: 'wf1',
          name: 'review',
          status: 'completed',
          startedAt: 50,
          durationMs: 9000,
          agents: [{ state: 'done' }, { state: 'done' }],
        } as unknown as WorkflowRun,
      ],
    ]);
    const bash = new Map([
      ['b1', { toolUseId: 'b1', taskId: 'x', command: 'npm run dev', description: null, state: 'running', startedAt: 200, endedAt: null, exitCode: null, output: 'ready\nlistening on 3000\n', truncated: false } as BashTask],
      ['b2', { toolUseId: 'b2', taskId: 'y', command: 'npm test', description: 'テスト', state: 'failed', startedAt: 10, endedAt: 70, exitCode: 1, output: '', truncated: false } as BashTask],
    ]);
    const tasks = buildTasks(items, subagents, workflows, bash);
    expect(tasks.map((t) => [t.key, t.name, t.state, t.progress])).toEqual([
      ['bash:b1', 'npm run dev', 'running', 'listening on 3000'],
      ['subagent:agent1', 'テストを直す', 'running', 'ツール 3回 · Read a.ts'],
      ['workflow:wf1', 'review', 'done', 'エージェント 2/2'],
      ['bash:b2', 'テスト', 'failed', '終了コード 1'],
    ]);
    expect(tasks.map(stoppable)).toEqual([true, true, false, false]);
    expect(elapsed(tasks[0], 1200)).toBe(1000);
    expect(elapsed(tasks[3], 1200)).toBe(60);
  });
});

describe('ワークフロー', () => {
  const agent = (over: Partial<WorkflowAgent>): WorkflowAgent => ({
    agentId: Math.random().toString(),
    label: null,
    phase: null,
    model: null,
    state: 'done',
    toolCalls: 0,
    lastTool: null,
    promptPreview: null,
    resultPreview: null,
    tokens: null,
    durationMs: null,
    startSeq: null,
    endSeq: null,
    ...over,
  });
  const run = (phases: string[], agents: WorkflowAgent[]): WorkflowRun =>
    ({ phases: phases.map((title) => ({ title, detail: null })), agents }) as unknown as WorkflowRun;

  it('flowPhases: 同じフェーズで前のエージェントが全部終わってから始まったものは、次の列にする', () => {
    const phases = flowPhases(
      run(['調べる', '直す'], [
        agent({ phase: '調べる', startSeq: 1, endSeq: 3 }),
        agent({ phase: '調べる', startSeq: 2, endSeq: 4 }),
        agent({ phase: '直す', startSeq: 5, endSeq: 6 }),
        agent({ phase: '直す', startSeq: 7, endSeq: 8 }),
      ]),
    );
    expect(phases.map((p) => [p.title, p.stages.map((s) => s.agents.length)])).toEqual([
      ['調べる', [2]],
      ['直す', [1, 1]],
    ]);
  });

  it('flowGroups: 前のフェーズが終わる前に始まったフェーズは、並んで動いたまとまりにする', () => {
    const groups = flowGroups(
      run(['実装', 'テスト設計', 'まとめ'], [
        agent({ phase: '実装', startSeq: 1, endSeq: 5 }),
        agent({ phase: 'テスト設計', startSeq: 2, endSeq: 3 }),
        agent({ phase: 'まとめ', startSeq: 6, endSeq: 7 }),
      ]),
    );
    expect(groups.map((g) => g.phases.map((p) => p.title))).toEqual([['実装', 'テスト設計'], ['まとめ']]);
  });

  it('groupByPhase: フェーズの分からないエージェントは「エージェント」にまとめる。表示の整え', () => {
    const groups = groupByPhase(run(['調べる'], [agent({ phase: '調べる' }), agent({ phase: null })]));
    expect(groups.map((g) => [g.title, g.agents.length])).toEqual([
      ['調べる', 1],
      ['エージェント', 1],
    ]);
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
    expect(shortModel('claude-opus-5[1m]')).toBe('opus-5[1m]');
    expect([formatDuration(5_000), formatDuration(125_000), formatDuration(3_725_000)]).toEqual(['5秒', '2分5秒', '1時間2分']);
    expect([formatTokens(999), formatTokens(12_345), formatTokens(123_456)]).toEqual(['999', '12.3k', '123k']);
  });
});

describe('アプリ内ブラウザ', () => {
  it('normalizeUrl: スキームが無ければ http を付け、http(s) 以外は開かない', () => {
    expect(normalizeUrl('localhost:3000/a')).toBe('http://localhost:3000/a');
    expect(normalizeUrl(' https://example.com ')).toBe('https://example.com/');
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('javascript://%0aalert(1)')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });

  it('describePicked: 選んだ要素を 1 行ずつにまとめ、制御文字を除き、html の ``` でフェンスから抜けられないようにする', () => {
    const text = describePicked({ url: 'http://localhost:3000/\nx', selector: 'main > button', text: '  送信‮ \n する ', html: '<button>```\n送信</button>' } as never);
    const lines = text.split('\n');
    expect(lines.slice(0, 3)).toEqual(['アプリ内ブラウザ（http://localhost:3000/ x）で選んだ要素:', '- セレクタ: `main > button`', '- テキスト: 「送信 する」']);
    const fence = lines[3];
    expect(fence.startsWith('````')).toBe(true);
    expect(text).toContain('<button>```\n送信</button>');
  });
});

describe('レビューコメントと予約とソース管理', () => {
  it('formatComments: 番号・場所・引用・コメントを並べ、対応を頼む文を付ける', () => {
    expect(
      formatComments([
        { id: '1', path: 'src/a.ts', startLine: 3, endLine: 3, quote: 'const a = 1;', text: '名前を変える' },
        { id: '2', path: 'src/b.ts', startLine: 5, endLine: 7, quote: 'x\ny\nz', text: 'まとめる' },
      ]),
    ).toBe('以下はコードへのレビューコメントです。それぞれ対応してください。\n\n[1] src/a.ts:3\n```\nconst a = 1;\n```\n名前を変える\n\n[2] src/b.ts:5-7\n```\nx\ny\nz\n```\nまとめる');
  });

  it('scheduledOf と needsAttention: セッションの予約を時刻の早い順に。送れなかったものは人の対応が要る', () => {
    const m = (id: string, sessionId: string, at: number, state: string) => ({ id, sessionId, at, state }) as unknown as ScheduledMessage;
    const list = [m('a', 's1', 30, 'waiting'), m('b', 's2', 10, 'waiting'), m('c', 's1', 20, 'missed')];
    expect(scheduledOf(list, 's1').map((x) => x.id)).toEqual(['c', 'a']);
    expect(list.map(needsAttention)).toEqual([false, false, true]);
    expect(needsAttention(m('d', 's1', 0, 'failed'))).toBe(true);
  });

  it('branchPaths: 一覧はパス順、ツリーはフォルダの中を先にした見えている順', () => {
    const changes = { base: { ref: 'main', mergeBase: 'x', kind: 'branch' }, files: { 'z.ts': {}, 'src/b.ts': {}, 'a.ts': {}, 'src/lib/c.ts': {} } } as unknown as BranchChanges;
    expect(branchPaths(changes, 'list')).toEqual(['a.ts', 'src/b.ts', 'src/lib/c.ts', 'z.ts']);
    expect(branchPaths(changes, 'tree')).toEqual(['src/lib/c.ts', 'src/b.ts', 'a.ts', 'z.ts']);
    expect(branchPaths(null, 'list')).toEqual([]);
  });

  it('useScmView: 一覧かツリーかを覚えて、次に開いたときも同じにする', () => {
    localStorage.clear();
    const first = renderHook(() => useScmView());
    expect(first.result.current[0]).toBe('list');
    act(() => first.result.current[1]('tree'));
    expect(first.result.current[0]).toBe('tree');
    expect(renderHook(() => useScmView()).result.current[0]).toBe('tree');
  });
});
