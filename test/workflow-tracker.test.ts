import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRun } from '@shared/workflow';
import { WorkflowTracker, workflowLaunchOf, type WorkflowLaunch } from '../src/main/workflow-tracker';

// ワークフロー（Workflow ツール）の追跡（WorkflowTracker）と、起動の行の読み取り（workflowLaunchOf）。
// ファイルと行の形は、Claude Code 2.1.292 をモックの API で動かして取ったもの（起動の toolUseResult・journal.jsonl・
// エージェントの会話ログと meta.json・完了時の記録 workflows/<runId>.json。2 つのエージェントが順に動くもの・エージェントが
// 失敗するもの・失敗したあと resumeFromRunId で再開したもの）に合わせた。
// 2.1.292 の meta.json には model が無く、止めた実行（killed）の記録は取っていないので、その 2 つは src の読み取りに合わせて組み立てた

const RUN_ID = 'wf_32a751a5-7d7';
const SCRIPT = `export const meta = { name: 'tanacode-check', description: '確認のワークフロー', phases: [{ title: '調べる', detail: '中身を見る' }, { title: 'まとめる' }] }
phase('調べる')
const a = await agent('ワークフローのエージェントAです', { label: '確認係', phase: '調べる' })
phase('まとめる')
const b = await agent('ワークフローのエージェントBです', { label: 'まとめ係', phase: 'まとめる' })
return a + b`;
const A = 'adf8806fcd36e8ca3';
const B = 'a6c8ea883a574e8c4';
const KEY_A = 'v2:f66eb4d009abb679a7cc3bcadad419a7c460fc32b8bc61587f09cf32c179c4bf';
const KEY_B = 'v2:e541a8b3abd65655dd604ac322992141c3cf0e1ffd06aeb30ba3c65dd7d0fc50';

let root: string;
let sessionDir: string;
let transcriptDir: string;
let finalFile: string;
let scriptPath: string;
let runs: WorkflowRun[][];
let tracker: WorkflowTracker;

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const journal = (...entries: unknown[]) => appendFileSync(join(transcriptDir, 'journal.jsonl'), entries.map(line).join(''));
const started = (agentId: string, key: string, label: string, phase: string) => ({ type: 'started', key, agentId, label, phase });
const done = (agentId: string, key: string, result: unknown) => ({ type: 'result', key, agentId, result });
const failed = (agentId: string, key: string) => ({ type: 'failed', key, agentId });
// エージェントの会話ログ（2.1.292 の形。仕事の発言・ツールの呼び出し・結果の文）
const agentLog = (agentId: string, at: number, ...entries: unknown[]) =>
  appendFileSync(join(transcriptDir, `agent-${agentId}.jsonl`), entries.map((e) => line({ isSidechain: true, agentId, timestamp: new Date(at).toISOString(), ...(e as object) })).join(''));
const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const toolCall = (name: string | undefined, input: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }] },
});
const answer = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const setTime = (file: string, at: number) => utimesSync(file, new Date(at), new Date(at));
// 完了時の記録（2.1.292 の形から、アプリが読まないものを除いた）
const progressAgent = (agentId: string, label: string, phase: string, extra: Record<string, unknown>) => ({
  type: 'workflow_agent',
  label,
  phaseTitle: phase,
  agentId,
  model: 'claude-opus-5-5',
  state: 'done',
  ...extra,
});
const finalRecord = (extra: Record<string, unknown> = {}) => ({
  runId: RUN_ID,
  taskId: 'wb7qvqa8p',
  result: 'Aの結果Bの結果',
  agentCount: 2,
  durationMs: 4636,
  summary: '確認のワークフロー',
  workflowName: 'tanacode-check',
  status: 'completed',
  phases: [{ title: '調べる', detail: '中身を見る' }, { title: 'まとめる' }],
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: '調べる' },
    { type: 'workflow_phase', index: 2, title: 'まとめる' },
    progressAgent(A, '確認係', '調べる', { startedAt: 1_000, lastToolName: 'Bash', promptPreview: 'ワークフローのエージェントAです', tokens: 100, toolCalls: 1, durationMs: 3090, resultPreview: 'Aの結果' }),
    progressAgent(B, 'まとめ係', 'まとめる', { startedAt: 4_092, promptPreview: 'ワークフローのエージェントBです', tokens: 100, toolCalls: 0, durationMs: 1529, resultPreview: 'Bの結果' }),
  ],
  totalTokens: 200,
  totalToolCalls: 1,
  ...extra,
});
const writeFinal = (record: unknown, at = Date.now()) => {
  writeFileSync(finalFile, typeof record === 'string' ? record : JSON.stringify(record));
  setTime(finalFile, at);
};
const launch = (extra: Partial<WorkflowLaunch> = {}): WorkflowLaunch => ({
  toolUseId: 'toolu_wf',
  runId: RUN_ID,
  name: 'tanacode-check',
  summary: '確認のワークフロー',
  transcriptDir,
  scriptPath,
  script: SCRIPT,
  launchedAt: Date.now(),
  ...extra,
});
const run = (toolUseId = 'toolu_wf') => tracker.all().find((r) => r.toolUseId === toolUseId)!;
const internals = () => tracker as unknown as { poll: () => Promise<void>; polling: boolean; timer: NodeJS.Timeout | null };
// ポーリングの途中なら終わるのを待ってから、もう一度読む
async function refresh(): Promise<void> {
  for (let i = 0; i < 200 && internals().polling; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await internals().poll();
}
// 完了通知・再開など、順番待ちで読むものが終わるまで待つ
const settle = (check: () => unknown) => vi.waitFor(() => expect(check()).toBeTruthy(), { timeout: 3000, interval: 10 });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-workflow-'));
  sessionDir = join(root, 'projects', '-work-app', 's1');
  transcriptDir = join(sessionDir, 'subagents', 'workflows', RUN_ID);
  finalFile = join(sessionDir, 'workflows', `${RUN_ID}.json`);
  scriptPath = join(sessionDir, 'workflows', 'scripts', `tanacode-check-${RUN_ID}.js`);
  mkdirSync(transcriptDir, { recursive: true });
  mkdirSync(join(sessionDir, 'workflows', 'scripts'), { recursive: true });
  runs = [];
  tracker = new WorkflowTracker((next) => runs.push(next));
});

afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('workflowLaunchOf', () => {
  // 2.1.292 の起動の結果の行
  const entry = (toolUseResult: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
    type: 'user',
    timestamp: '2026-10-07T13:51:06.639Z',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_wf', type: 'tool_result', content: 'Workflow launched in background. Task ID: wb7qvqa8p', is_error: false }] },
    toolUseResult,
    ...extra,
  });
  const result = {
    status: 'async_launched',
    taskId: 'wb7qvqa8p',
    taskType: 'local_workflow',
    workflowName: 'tanacode-check',
    runId: RUN_ID,
    summary: '確認のワークフロー',
    transcriptDir: '/home/me/.claude/projects/-work-app/s1/subagents/workflows/wf_32a751a5-7d7',
    scriptPath: '/home/me/.claude/projects/-work-app/s1/workflows/scripts/tanacode-check-wf_32a751a5-7d7.js',
  };

  it('起動の結果から、名前・説明・場所と、Workflow ツールに渡したスクリプトを読む', () => {
    expect(workflowLaunchOf(entry(result), new Map([['toolu_wf', SCRIPT]]))).toEqual({
      toolUseId: 'toolu_wf',
      runId: RUN_ID,
      name: 'tanacode-check',
      summary: '確認のワークフロー',
      transcriptDir: result.transcriptDir,
      scriptPath: result.scriptPath,
      script: SCRIPT,
      launchedAt: Date.parse('2026-10-07T13:51:06.639Z'),
    });
  });

  it('名前・説明・スクリプトの場所が無ければ、runId・空・null。時刻が読めなければ今の時刻', () => {
    const before = Date.now();
    const launch = workflowLaunchOf(entry({ taskType: 'local_workflow', runId: RUN_ID, transcriptDir: '/t' }, { timestamp: 'いつか' }), new Map());
    expect(launch).toMatchObject({ name: RUN_ID, summary: '', scriptPath: null, script: null });
    expect(launch!.launchedAt).toBeGreaterThanOrEqual(before);
    expect(workflowLaunchOf(entry({ taskType: 'local_workflow', runId: RUN_ID, transcriptDir: '/t' }, { timestamp: undefined }), new Map())!.launchedAt).toBeGreaterThanOrEqual(before);
  });

  it('ワークフローの起動でない行は null', () => {
    const scripts = new Map<string, string>();
    expect(workflowLaunchOf({ ...entry(result), type: 'assistant' }, scripts)).toBeNull();
    expect(workflowLaunchOf(entry(undefined), scripts)).toBeNull();
    expect(workflowLaunchOf(entry({ ...result, taskType: 'local_bash' }), scripts)).toBeNull();
    expect(workflowLaunchOf(entry({ ...result, runId: 7 }), scripts)).toBeNull();
    expect(workflowLaunchOf(entry({ ...result, transcriptDir: undefined }), scripts)).toBeNull();
    expect(workflowLaunchOf(entry(result, { message: { content: 'ただの文' } }), scripts)).toBeNull();
    expect(workflowLaunchOf(entry(result, { message: { content: [] } }), scripts)).toBeNull();
    expect(workflowLaunchOf(entry(result, { message: { content: [{ type: 'text', text: 'x' }] } }), scripts)).toBeNull();
  });
});

describe('WorkflowTracker', () => {
  it('起動するとスクリプトのフェーズで実行中として知らせ、journal と会話ログからエージェントの進み具合を読む', async () => {
    const t0 = Date.now();
    tracker.add(launch({ launchedAt: t0 }), false);
    expect(runs[0]).toEqual([
      expect.objectContaining({
        toolUseId: 'toolu_wf',
        runId: RUN_ID,
        name: 'tanacode-check',
        status: 'running',
        phases: [{ title: '調べる', detail: '中身を見る' }, { title: 'まとめる', detail: null }],
        agents: [],
        resumed: false,
        resumedLater: false,
      }),
    ]);
    expect(run().startedAt).toBeGreaterThanOrEqual(t0);
    expect(internals().timer).not.toBeNull();
    // 同じ起動をもう一度渡されても増えない
    tracker.add(launch({ launchedAt: t0 }), false);
    expect(tracker.all()).toHaveLength(1);

    // 1 つ目のエージェントが始まった（meta.json は少し遅れて書かれる）
    journal({ type: 'launched' }, started(A, KEY_A, '確認係', '調べる'));
    agentLog(A, t0 + 50, prompt('ワークフローのエージェントAです'), toolCall('Bash', { command: 'echo wf-a' }));
    await refresh();
    expect(run().agents).toEqual([
      {
        agentId: A,
        label: '確認係',
        phase: '調べる',
        model: null,
        state: 'running',
        toolCalls: 1,
        lastTool: 'Bash',
        promptPreview: 'ワークフローのエージェントAです',
        resultPreview: null,
        tokens: null,
        durationMs: null,
        startSeq: 0,
        endSeq: null,
      },
    ]);
    // meta.json に model があれば使う（2.1.292 には無い）
    writeFileSync(join(transcriptDir, `agent-${A}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', description: '確認係', workflowPhase: '調べる', model: 'claude-opus-5-5' }));
    // 結果が返り、2 つ目が始まる。2 つ目の会話ログはまだ無い
    journal(done(A, KEY_A, 'Aの結果'), started(B, KEY_B, 'まとめ係', 'まとめる'));
    writeFileSync(join(transcriptDir, `agent-${B}.meta.json`), '{壊れた');
    await refresh();
    expect(run().agents.map((a) => [a.agentId, a.state, a.model, a.resultPreview, a.startSeq, a.endSeq])).toEqual([
      [A, 'done', 'claude-opus-5-5', 'Aの結果', 0, 1],
      [B, 'running', null, null, 2, null],
    ]);
    // 変わっていなければ知らせない
    const count = runs.length;
    await refresh();
    expect(runs.length).toBe(count);
  });

  it('結果が長い・文字でないものは、切り詰め・JSON にして出す。失敗したエージェントは failed。書きかけの行は次に読む', async () => {
    tracker.add(launch(), false);
    journal(started(A, KEY_A, '確認係', '調べる'), started(B, KEY_B, 'まとめ係', 'まとめる'), done(A, KEY_A, { items: ['x'.repeat(400)] }), failed(B, KEY_B));
    appendFileSync(join(transcriptDir, 'journal.jsonl'), '壊れた行\n{"type":"started","agentId":"c3"');
    await refresh();
    expect(run().agents.map((a) => a.state)).toEqual(['done', 'failed']);
    expect(run().agents[0].resultPreview).toBe(JSON.stringify({ items: ['x'.repeat(400)] }).slice(0, 300));
    // 書き終わった行と、agentId の無い行
    appendFileSync(join(transcriptDir, 'journal.jsonl'), `,"label":"三つ目","phase":"まとめる"}\n${line({ type: 'launched' })}`);
    await refresh();
    expect(run().agents.map((a) => [a.agentId, a.label, a.state])).toEqual([
      [A, '確認係', 'done'],
      [B, 'まとめ係', 'failed'],
      ['c3', '三つ目', 'running'],
    ]);
    // ラベル・フェーズの無い started
    journal({ type: 'started', agentId: 'd4' });
    // 時刻の読めない行
    agentLog('d4', Date.now(), { ...answer('考え中'), timestamp: 'いつか' }, toolCall(undefined), { type: 'user', message: { content: [{ type: 'tool_result' }] } });
    await refresh();
    expect(run().agents.at(-1)).toMatchObject({ agentId: 'd4', label: null, phase: null, toolCalls: 1, lastTool: null, promptPreview: null });
    // 再開すると、同じエージェントの started がもう一度書かれることがある。開始の順番は最初のもの、終わりは最後のもの
    journal(started(A, KEY_A, '確認係', '調べる'), done(A, KEY_A, 'Aの結果（やり直し）'));
    await refresh();
    expect(run().agents.filter((a) => a.agentId === A)).toEqual([expect.objectContaining({ state: 'done', resultPreview: 'Aの結果（やり直し）', startSeq: 0, endSeq: 6 })]);
  });

  it('完了時の記録があれば、それで置き換える（フェーズ・エージェント・数値。順番は journal から）', async () => {
    const t0 = Date.now();
    tracker.add(launch({ launchedAt: t0 }), false);
    journal({ type: 'launched' }, started(A, KEY_A, '確認係', '調べる'), done(A, KEY_A, 'Aの結果'), started(B, KEY_B, 'まとめ係', 'まとめる'), done(B, KEY_B, 'Bの結果'));
    writeFinal(finalRecord());
    await refresh();
    expect(run()).toMatchObject({
      status: 'completed',
      summary: '確認のワークフロー',
      phases: [{ title: '調べる', detail: '中身を見る' }, { title: 'まとめる', detail: null }],
      durationMs: 4636,
      totalTokens: 200,
      totalToolCalls: 1,
    });
    expect(run().agents).toEqual([
      {
        agentId: A,
        label: '確認係',
        phase: '調べる',
        model: 'claude-opus-5-5',
        state: 'done',
        toolCalls: 1,
        lastTool: 'Bash',
        promptPreview: 'ワークフローのエージェントAです',
        resultPreview: 'Aの結果',
        tokens: 100,
        durationMs: 3090,
        startSeq: 0,
        endSeq: 1,
      },
      expect.objectContaining({ agentId: B, lastTool: null, toolCalls: 0, startSeq: 2, endSeq: 3, resultPreview: 'Bの結果' }),
    ]);
    // 終わったら読むのをやめる
    await refresh();
    expect(internals().timer).toBeNull();
    // 完了通知が届いても、記録の状態のまま
    const count = runs.length;
    tracker.notified('toolu_wf', 'failed');
    expect(run().status).toBe('completed');
    expect(runs.length).toBe(count);
  });

  it('journal に無いエージェントは、記録の開始時刻と所要時間から順番を振る（同じ時刻なら終わりを先に）。失敗・動いたままのものも読む', async () => {
    tracker.add(launch(), false);
    writeFinal(
      finalRecord({
        status: 'killed',
        phases: [{ detail: '名前の無いフェーズの説明' }],
        workflowProgress: [
          { type: 'workflow_phase', title: '調べる' },
          { type: 'workflow_phase' },
          progressAgent('p2', '二', '調べる', { startedAt: 150, durationMs: 10, state: 'error' }),
          progressAgent('p1', '一', '調べる', { startedAt: 100, durationMs: 50, resultPreview: 'r'.repeat(400) }),
          progressAgent('p3', '三', '調べる', { startedAt: 120, state: 'failed', durationMs: null }),
          // 止めた実行で動いていたもの。所要時間があっても、終わりの順番は振らない
          progressAgent('p4', '四', '調べる', { startedAt: 155, state: 'progress', durationMs: 3 }),
          progressAgent('p5', '五', '調べる', { state: 'start' }),
          { type: 'workflow_agent', agentId: 7 },
          { type: 'other' },
        ],
        durationMs: 'たくさん',
      }),
    );
    await refresh();
    expect(run()).toMatchObject({ status: 'killed', durationMs: null, phases: [{ title: '調べる', detail: null }, { title: '', detail: '名前の無いフェーズの説明' }] });
    const seq = Object.fromEntries(run().agents.map((a) => [a.agentId, [a.state, a.startSeq, a.endSeq]]));
    // p1: 100〜150、p3: 120〜（所要時間なし）、p2: 150〜160、p4: 155〜（動いたまま）。150 は p1 の終わりを先に
    expect(seq).toEqual({ p1: ['done', 0, 2], p3: ['failed', 1, null], p2: ['failed', 3, 5], p4: ['stopped', 4, null], p5: ['stopped', null, null] });
    expect(run().agents.find((a) => a.agentId === 'p1')!.resultPreview).toHaveLength(300);
  });

  it('起動より前に書かれた記録（同じ runId の前の実行）・読めない記録は使わない', async () => {
    const t0 = Date.now();
    tracker.add(launch({ launchedAt: t0 }), false);
    journal(started(A, KEY_A, '確認係', '調べる'));
    writeFinal(finalRecord(), t0 - 5000);
    await refresh();
    expect(run()).toMatchObject({ status: 'running', durationMs: null });
    writeFinal('{壊れた');
    await refresh();
    expect(run().status).toBe('running');
    writeFinal('');
    await refresh();
    expect(run().status).toBe('running');
    // 状態・フェーズ・エージェントの無い記録は、エージェントなしの completed とみなす
    writeFinal(finalRecord({ status: undefined, phases: undefined, workflowProgress: undefined }));
    await refresh();
    expect(run()).toMatchObject({ status: 'completed', agents: [] });
  });

  it('完了通知が届いたら、記録が無くても通知の状態で終える。動いたままのエージェントは止まったことにする', async () => {
    tracker.add(launch(), false);
    journal(started(A, KEY_A, '確認係', '調べる'));
    await refresh();
    tracker.notified('toolu_wf', 'failed');
    await settle(() => run().status !== 'running');
    expect(run()).toMatchObject({ status: 'failed', agents: [expect.objectContaining({ agentId: A, state: 'stopped' })] });
    // 知らない起動の通知は無視する
    const count = runs.length;
    tracker.notified('toolu_unknown', 'completed');
    expect(runs.length).toBe(count);
  });

  it('完了通知で読み直したときに記録が書かれていれば、記録の状態にする', async () => {
    // ポーリングより先に通知が届く
    internals().polling = true;
    tracker.add(launch(), false);
    writeFinal(finalRecord({ status: 'completed' }));
    tracker.notified('toolu_wf', 'failed');
    await settle(() => run().status !== 'running');
    internals().polling = false;
    expect(run().status).toBe('completed');
  });

  it('過去の会話から読んだものは、ファイルを一度だけ読み、記録が無ければ通知の状態（無ければ stopped）にする', async () => {
    journal(started(A, KEY_A, '確認係', '調べる'));
    tracker.add(launch({ toolUseId: 'toolu_old' }), true);
    await settle(() => run('toolu_old').status !== 'running');
    expect(run('toolu_old')).toMatchObject({ status: 'stopped', startedAt: null, agents: [expect.objectContaining({ state: 'stopped' })] });
    expect(internals().timer).toBeNull();

    // 読み終わる前に完了通知が来ていれば、その状態
    tracker = new WorkflowTracker((next) => runs.push(next));
    tracker.add(launch({ toolUseId: 'toolu_old2' }), true);
    tracker.notified('toolu_old2', 'completed');
    await settle(() => run('toolu_old2').status !== 'running');
    expect(run('toolu_old2').status).toBe('completed');

    // 記録があれば記録の状態
    writeFinal(finalRecord({ status: 'failed' }));
    tracker.add(launch({ toolUseId: 'toolu_old3', launchedAt: Date.now() }), true);
    await settle(() => run('toolu_old3')?.status !== 'running');
    expect(run('toolu_old3').status).toBe('failed');
  });

  it('スクリプトが渡されていなければ、保存されたスクリプトのファイルからフェーズを読む。無ければフェーズなし', () => {
    writeFileSync(scriptPath, "export const meta = {\n  name: 'saved',\n  phases: [\n    { title: \"前半\", detail: `説明` },\n    { title: '後半' },\n    { detail: '名前なし' },\n  ],\n}\n");
    tracker.add(launch({ toolUseId: 'toolu_saved', script: null }), false);
    expect(run('toolu_saved').phases).toEqual([
      { title: '前半', detail: '説明' },
      { title: '後半', detail: null },
    ]);
    tracker.add(launch({ toolUseId: 'toolu_missing', runId: 'wf_other', script: null, scriptPath: join(root, 'missing.js') }), false);
    expect(run('toolu_missing').phases).toEqual([]);
    tracker.add(launch({ toolUseId: 'toolu_none', runId: 'wf_none', script: null, scriptPath: null }), false);
    expect(run('toolu_none').phases).toEqual([]);
    tracker.add(launch({ toolUseId: 'toolu_nometa', runId: 'wf_nometa', script: 'return 1' }), false);
    expect(run('toolu_nometa').phases).toEqual([]);
  });

  it('エージェントの会話ログの場所', () => {
    tracker.add(launch(), false);
    expect(tracker.agentLogFile('toolu_wf', A)).toBe(join(transcriptDir, `agent-${A}.jsonl`));
    expect(tracker.agentLogFile('toolu_unknown', A)).toBeNull();
  });

  it('Claude Code が終わったら、実行中のものを止まったことにする。動いているものが無ければ知らせない', async () => {
    tracker.add(launch(), false);
    journal(started(A, KEY_A, '確認係', '調べる'));
    await refresh();
    const count = runs.length;
    tracker.stopRunning();
    expect(runs.length).toBe(count + 1);
    expect(run()).toMatchObject({ status: 'stopped', agents: [expect.objectContaining({ state: 'stopped' })] });
    expect(internals().timer).toBeNull();
    tracker.stopRunning();
    expect(runs.length).toBe(count + 1);
    // 止まったものの通知は、覚えるだけ
    tracker.notified('toolu_wf', 'completed');
    expect(run().status).toBe('stopped');
  });

  it('読む順番を待っている間に止まった実行は、読まない', async () => {
    tracker.add(launch(), false);
    await settle(() => !internals().polling);
    journal(started(A, KEY_A, '確認係', '調べる'));
    // 完了通知などの読み込みが先に並んでいる
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = (tracker as unknown as { runs: Map<string, unknown> }).runs.get('toolu_wf');
    void (tracker as unknown as { enqueue: (t: unknown, task: () => Promise<void>) => Promise<void> }).enqueue(t, () => gate);
    const polling = internals().poll();
    tracker.stopRunning();
    release();
    await polling;
    expect(run()).toMatchObject({ status: 'stopped', agents: [] });
  });

  it('1 秒ごとに読む。読んでいる途中に重ねて読まない', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    tracker.add(launch(), false);
    await settle(() => !internals().polling);
    journal(started(A, KEY_A, '確認係', '調べる'));
    internals().polling = true;
    await internals().poll();
    expect(run().agents).toEqual([]);
    internals().polling = false;
    vi.advanceTimersByTime(1000);
    await settle(() => run().agents.length === 1);
  });

  describe('再開（resumeFromRunId）', () => {
    // 2.1.292 で、2 つ目のエージェント（後半係）が失敗した実行を再開したときの journal。前の実行の行に、再開した実行の行が書き足される
    const FIRST = 'a7ba20a8080cd69bd';
    const FAILED = 'a1599f2687e8bf701';
    const RETRY = 'ac3ad256bf54d5585';
    const K1 = 'v2:dff55140a05634dc8742918da266eb1704347ac81d03717462df4f7459fc8686';
    const K2 = 'v2:45b8c2a8a739b7bd2c3d6efc23bc8cce4c9272d5b1d850fbcb96194b0dcba978';

    it('前の実行は、再開の時刻より前のものだけで組み立て直し、再開した実行は、置き換わったエージェントを除いて読む', async () => {
      const t0 = Date.now() - 20_000;
      tracker.add(launch({ toolUseId: 'toolu_wf', launchedAt: t0 }), false);
      journal({ type: 'launched' }, started(FIRST, K1, '前半係', '前半'), done(FIRST, K1, 'Aの結果'), started(FAILED, K2, '後半係', '後半'), failed(FAILED, K2));
      agentLog(FIRST, t0 + 40, prompt('一つ目のエージェントです'), toolCall('Bash', { command: 'echo a' }), answer('Aの結果'));
      agentLog(FAILED, t0 + 2000, prompt('二つ目のエージェントです'));
      setTime(join(transcriptDir, `agent-${FIRST}.jsonl`), t0 + 2000);
      setTime(join(transcriptDir, `agent-${FAILED}.jsonl`), t0 + 3700);
      // 前の実行の完了時の記録（失敗したまま completed）
      const firstRecord = finalRecord({
        status: 'completed',
        durationMs: 3714,
        workflowProgress: [
          { type: 'workflow_phase', title: '前半' },
          { type: 'workflow_phase', title: '後半' },
          progressAgent(FIRST, '前半係', '前半', { startedAt: t0 + 40, toolCalls: 1, durationMs: 1999, resultPreview: 'Aの結果' }),
          progressAgent(FAILED, '後半係', '後半', { startedAt: t0 + 2000, state: 'error', durationMs: 1676 }),
        ],
      });
      writeFinal(firstRecord, t0 + 3720);
      await refresh();
      expect(run()).toMatchObject({ status: 'completed', durationMs: 3714 });

      // 少したってから再開する
      const t1 = t0 + 10_000;
      tracker.notified('toolu_wf', 'completed');
      tracker.add(launch({ toolUseId: 'toolu_wf2', launchedAt: t1, script: null }), false);
      expect(run('toolu_wf2')).toMatchObject({ resumed: true, status: 'running' });
      await settle(() => run('toolu_wf').resumedLater);
      journal(started(RETRY, K2, '後半係', '後半'));
      agentLog(RETRY, t1 + 20, prompt('二つ目のエージェントです'));
      await refresh();
      // 再開した実行: 前の実行で済んだ前半係と、やり直しの後半係（失敗した方は置き換わったので出さない）
      expect(run('toolu_wf2').agents.map((a) => [a.agentId, a.state])).toEqual([
        [FIRST, 'done'],
        [RETRY, 'running'],
      ]);
      // 前の実行は、自分の記録のまま
      expect(run('toolu_wf')).toMatchObject({ status: 'completed', resumedLater: true, durationMs: 3714 });
      expect(run('toolu_wf').agents.map((a) => [a.agentId, a.state])).toEqual([
        [FIRST, 'done'],
        [FAILED, 'failed'],
      ]);

      // 再開した実行が終わり、記録が書き直される
      journal(done(RETRY, K2, 'Bの結果'));
      writeFinal(
        finalRecord({
          durationMs: 851,
          workflowProgress: [
            progressAgent(FIRST, '前半係', '前半', { startedAt: t1 + 10, cached: true, resultPreview: 'Aの結果' }),
            progressAgent(RETRY, '後半係', '後半', { startedAt: t1 + 20, durationMs: 828, resultPreview: 'Bの結果' }),
          ],
        }),
        t1 + 900,
      );
      await refresh();
      expect(run('toolu_wf2')).toMatchObject({ status: 'completed', durationMs: 851 });
      expect(run('toolu_wf2').agents.map((a) => [a.agentId, a.state, a.startSeq, a.endSeq])).toEqual([
        [FIRST, 'done', 0, 1],
        [RETRY, 'done', 4, 5],
      ]);
      // 前の実行は、書き直された記録（再開した実行のもの）を使わない
      expect(run('toolu_wf').durationMs).toBe(3714);
    });

    it('名前が同じでもフェーズの違うエージェントは、置き換わったものとみなさない', async () => {
      const t0 = Date.now() - 20_000;
      const t1 = t0 + 10_000;
      journal(started(FIRST, K1, '確認係', '前半'), done(FIRST, K1, 'Aの結果'));
      agentLog(FIRST, t0 + 40, prompt('一つ目のエージェントです'));
      tracker.add(launch({ toolUseId: 'toolu_wf', launchedAt: t0 }), false);
      tracker.add(launch({ toolUseId: 'toolu_wf2', launchedAt: t1 }), false);
      journal(started('n2', K2, '確認係', '後半'));
      agentLog('n2', t1 + 20, prompt('二つ目のエージェントです'));
      await refresh();
      expect(run('toolu_wf2').agents.map((a) => [a.agentId, a.phase, a.state])).toEqual([
        [FIRST, '前半', 'done'],
        ['n2', '後半', 'running'],
      ]);
    });

    it('記録の無い前の実行は、再開の時刻までに始まったエージェントで組み立て直し、通知が無ければ止まったことにする', async () => {
      const t0 = Date.now() - 20_000;
      // スクリプトは保存したファイルから読む（組み立て直すときも読み直す）
      writeFileSync(scriptPath, SCRIPT);
      tracker.add(launch({ toolUseId: 'toolu_wf', launchedAt: t0, script: null }), false);
      journal(started(FIRST, K1, '前半係', '前半'));
      agentLog(FIRST, t0 + 40, prompt('一つ目のエージェントです'));
      setTime(join(transcriptDir, `agent-${FIRST}.jsonl`), t0 + 100);
      await refresh();
      const t1 = t0 + 10_000;
      // 前の実行が止まったまま、再開する。再開した実行で前半係がやり直される
      journal(started('n1', K2, '後半係', '後半'));
      agentLog('n1', t1 + 20, prompt('一つ目のエージェントです'));
      tracker.add(launch({ toolUseId: 'toolu_wf2', launchedAt: t1 }), false);
      await settle(() => run('toolu_wf').status !== 'running');
      expect(run('toolu_wf')).toMatchObject({ status: 'stopped', resumedLater: true, phases: [{ title: '調べる', detail: '中身を見る' }, { title: 'まとめる', detail: null }] });
      // 再開の時刻より後に始まった n1 は、前の実行に入れない
      expect(run('toolu_wf').agents.map((a) => [a.agentId, a.state])).toEqual([[FIRST, 'stopped']]);
      await refresh();
      // 再開した実行には、前の実行で動いたまま止まった前半係は入れない（会話ログが再開の前から書かれていない。やり直されたものでなくても）
      expect(run('toolu_wf2').agents.map((a) => a.agentId)).toEqual(['n1']);
    });

    it('過去の会話を読み直すときは、前の実行の完了通知を先に覚えておき、組み立て直したあとの状態にする', async () => {
      const t0 = Date.now() - 20_000;
      journal(started(FIRST, K1, '前半係', '前半'), done(FIRST, K1, 'Aの結果'));
      agentLog(FIRST, t0 + 40, prompt('一つ目のエージェントです'));
      tracker.add(launch({ toolUseId: 'toolu_wf', launchedAt: t0 }), true);
      tracker.notified('toolu_wf', 'completed');
      tracker.add(launch({ toolUseId: 'toolu_wf2', launchedAt: t0 + 10_000 }), true);
      await settle(() => run('toolu_wf').status !== 'running' && run('toolu_wf2').status !== 'running');
      expect(run('toolu_wf')).toMatchObject({ status: 'completed', resumedLater: true, agents: [expect.objectContaining({ agentId: FIRST, state: 'done' })] });
      expect(run('toolu_wf2')).toMatchObject({ status: 'stopped', resumed: true });
    });

    it('過去の会話を読み直すとき、記録が再開した実行のものなら、前の実行は journal から組み立てる', async () => {
      const t0 = Date.now() - 20_000;
      const t1 = t0 + 10_000;
      journal(started(FIRST, K1, '前半係', '前半'), done(FIRST, K1, 'Aの結果'), started(FAILED, K2, '後半係', '後半'), failed(FAILED, K2), started(RETRY, K2, '後半係', '後半'), done(RETRY, K2, 'Bの結果'));
      agentLog(FIRST, t0 + 40, prompt('一つ目のエージェントです'));
      agentLog(FAILED, t0 + 2000, prompt('二つ目のエージェントです'));
      agentLog(RETRY, t1 + 20, prompt('二つ目のエージェントです'));
      writeFinal(finalRecord({ durationMs: 851, workflowProgress: [progressAgent(FIRST, '前半係', '前半', { cached: true }), progressAgent(RETRY, '後半係', '後半', { durationMs: 828 })] }), t1 + 900);
      // 読み直しでは、2 つの起動が続けて届く
      tracker.add(launch({ toolUseId: 'toolu_wf', launchedAt: t0 }), true);
      tracker.add(launch({ toolUseId: 'toolu_wf2', launchedAt: t1 }), true);
      await settle(() => run('toolu_wf').status !== 'running' && run('toolu_wf2').status !== 'running');
      expect(run('toolu_wf')).toMatchObject({ status: 'stopped', durationMs: null });
      expect(run('toolu_wf').agents.map((a) => [a.agentId, a.state])).toEqual([
        [FIRST, 'done'],
        [FAILED, 'failed'],
      ]);
      expect(run('toolu_wf2')).toMatchObject({ status: 'completed', durationMs: 851 });
      expect(run('toolu_wf2').agents.map((a) => a.agentId)).toEqual([FIRST, RETRY]);
    });
  });
});
