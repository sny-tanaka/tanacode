import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import { BashTaskTracker } from '../../src/main/bash-task-tracker';
import { SubagentTracker } from '../../src/main/subagent-tracker';
import { TaskRouter, taskNotificationOf } from '../../src/main/task-router';
import { WorkflowTracker } from '../../src/main/workflow-tracker';
import { checkWorkflowApproval } from '../scenario';
import { ClaudeRun, claudeVersion, menuOf, sleep } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、バックグラウンドで動くものを、アプリと同じトラッカーで追えるかを確かめる。
// 台本: サブエージェント（Agent）→ バックグラウンドの Bash → ワークフロー（Workflow）→ 文章で返事。
// サブエージェントとワークフローのエージェントも、それぞれの台本でモックの API に答えてもらう。
// ワークフローのエージェントは応答を大きく遅らせ、ほかのものがすべて済んでから（待機中に）完了通知が届くようにする

const PROMPT = 'バックグラウンドの作業を試してください';
const AGENT_PROMPT = 'サブエージェントの仕事です';
const WORKFLOW_AGENT_PROMPT = 'ワークフローのエージェントです';
// サブエージェントの応答ごとの遅れ（所要時間が通知に載るかを見る）
const AGENT_DELAY_MS = 1000;
// ワークフローのエージェントの応答の遅れ（実行中の journal を読むため。ほかの通知より後に、待機中に届くようにする）
const WORKFLOW_AGENT_DELAY_MS = 5000;

const SCRIPT = `export const meta = { name: 'tanacode-check', description: '確認のワークフロー', phases: [{ title: '調べる' }] }
phase('調べる')
const result = await agent('${WORKFLOW_AGENT_PROMPT}', { label: '確認係', phase: '調べる' })
return result`;

const version = claudeVersion();

describe(`Claude Code ${version} のバックグラウンドの作業`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  // 会話ログの完了通知の行と、読み取った中身
  const notifications = () =>
    run.entries.flatMap((entry) => {
      const notice = taskNotificationOf(entry);
      return notice ? [{ entry, notice }] : [];
    });

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [
      {
        match: PROMPT,
        steps: [
          [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: '調べもの', prompt: AGENT_PROMPT, subagent_type: 'general-purpose' } }],
          [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 1 && echo bg-done', description: '裏で待つ', run_in_background: true } }],
          [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { script: SCRIPT } }],
          [{ type: 'text', text: '起動しました' }],
        ],
      },
      {
        match: AGENT_PROMPT,
        delayMs: AGENT_DELAY_MS,
        steps: [
          [{ type: 'tool_use', id: 'toolu_sub_bash', name: 'Bash', input: { command: 'echo sub-agent', description: 'サブの作業' } }],
          [{ type: 'text', text: 'サブエージェントの結果' }],
        ],
      },
      { match: WORKFLOW_AGENT_PROMPT, delayMs: WORKFLOW_AGENT_DELAY_MS, steps: [[{ type: 'text', text: 'ワークフローの結果' }]] },
    ];
    run = new ClaudeRun(await api.start());
    await run.open();
  });

  afterAll(async () => {
    if (process.env.TANACODE_RECORD) run?.recordScreens(join('test', 'fixtures', 'claude-code', version));
    await run?.stop();
    await api?.stop();
  });

  it('ワークフローを始める前の確認がメニューとして読める', async () => {
    await run.send(PROMPT);
    const menu = await run.waitFor('ワークフローの確認', menuOf('other', /workflow/i));
    run.capture('workflow-approval');
    checkWorkflowApproval(menu);
    await run.answer(menu.title, menu.options.find((o) => /^Yes/.test(o.label))!.id);
  });

  it('ワークフローの実行中に、journal からエージェントの状態が読める', async () => {
    const workflow = await run.waitFor('ワークフローのエージェントの開始', () =>
      run.workflowRuns.find((w) => w.toolUseId === 'toolu_wf' && w.status === 'running' && w.agents.length > 0),
    );
    expect(workflow.agents).toHaveLength(1);
    expect(workflow.agents[0]).toMatchObject({ label: '確認係', phase: '調べる', state: 'running', resultPreview: null });
    // 完了時の記録（workflows/<runId>.json）はまだ無い。読めたのは journal から
    expect(existsSync(join(run.sessionDir(), 'workflows', `${workflow.runId}.json`))).toBe(false);
  });

  it('サブエージェントの進み具合と結果を読める', async () => {
    const agent = await run.waitFor('サブエージェントの完了', () => run.subagentRuns.find((r) => r.toolUseId === 'toolu_agent' && r.state !== 'running'));
    expect(agent).toMatchObject({ state: 'done', result: 'サブエージェントの結果' });
    expect(agent.agentId).toBeTruthy();
    expect(agent.toolCalls).toBe(1);
    // 使用量は完了通知の <usage> から（待機中に届いた通知にも付いている）
    expect(agent.tokens).toBeGreaterThan(0);
    expect(agent.durationMs).toBeGreaterThanOrEqual(AGENT_DELAY_MS * 2);
  });

  it('バックグラウンドの Bash の出力と終わりを読める', async () => {
    const task = await run.waitFor('Bash の完了', () => run.bashTasks.find((t) => t.toolUseId === 'toolu_bg' && t.state !== 'running'));
    expect(task).toMatchObject({ state: 'completed', exitCode: 0, description: '裏で待つ' });
    expect(task.output).toContain('bg-done');
  });

  it('ワークフローのフェーズ・エージェント・結果を読める', async () => {
    const workflow = await run.waitFor('ワークフローの完了', () => run.workflowRuns.find((w) => w.toolUseId === 'toolu_wf' && w.status !== 'running'), 30_000);
    expect(workflow).toMatchObject({ status: 'completed', name: 'tanacode-check', summary: '確認のワークフロー' });
    expect(workflow.phases.map((p) => p.title)).toEqual(['調べる']);
    expect(workflow.agents).toHaveLength(1);
    expect(workflow.agents[0]).toMatchObject({ label: '確認係', phase: '調べる', state: 'done', resultPreview: 'ワークフローの結果' });
  });

  it('会話ログの完了通知から、どのタスクがどうなったかと結果・使用量が読める', async () => {
    // 待機中に届いた通知は、Claude Code が発言として書き、それを受けて動く。ワークフローの通知のターンが終わるまで待つ
    const delivered = () => notifications().some(({ entry, notice }) => entry.type === 'user' && notice.toolUseId === 'toolu_wf');
    await run.waitFor('ワークフローの完了通知', delivered, 30_000);
    const of = (toolUseId: string) => notifications().filter(({ notice }) => notice.toolUseId === toolUseId).map(({ notice }) => notice);
    // 同じ通知が、順番待ち（queue-operation）・作業中の差し込み（attachment）・発言（user）の形で書かれる。どの形でも同じに読める
    const agent = of('toolu_agent');
    expect(agent.length).toBeGreaterThan(0);
    for (const notice of agent) {
      expect(notice).toMatchObject({ status: 'completed', result: 'サブエージェントの結果' });
      expect(notice.usage).toMatchObject({ toolUses: 1 });
      expect(notice.usage!.totalTokens).toBeGreaterThan(0);
      expect(notice.usage!.durationMs).toBeGreaterThanOrEqual(AGENT_DELAY_MS * 2);
    }
    const bash = of('toolu_bg');
    expect(bash.length).toBeGreaterThan(0);
    for (const notice of bash) expect(notice).toMatchObject({ status: 'completed', usage: null });
    const workflow = of('toolu_wf');
    expect(workflow.length).toBeGreaterThan(0);
    for (const notice of workflow) {
      expect(notice.status).toBe('completed');
      expect(notice.result).toContain('ワークフローの結果');
    }
  });

  it('待機中に届いた完了通知が、チャットの知らせ（notice）になる', () => {
    const delivered = notifications().filter(({ entry }) => entry.type === 'user');
    // ワークフローは、ほかのものが済んでから終わる
    expect(delivered.map(({ notice }) => notice.toolUseId)).toContain('toolu_wf');
    for (const { entry, notice } of delivered) {
      const summary = notice.text.match(/<summary>(.*?)<\/summary>/s)?.[1]?.trim();
      expect(summary).toBeTruthy();
      expect(run.chatEvents).toContainEqual({ type: 'notice', id: entry.uuid, text: summary });
    }
    // 完了通知は順番待ちの発言として出さない
    expect(run.chatEvents.filter((e) => e.type === 'queue')).toEqual([]);
  });

  it('完了通知だけで、それぞれの完了が分かる（出力ファイル・完了時の記録を使わずに）', async () => {
    // トラッカーには、Bash の出力ファイル（[exited with code]）とワークフローの完了時の記録・journal という後ろ盾がある。
    // それらが無いことにして会話ログの行だけを流し込み、完了通知の読み取りだけで終わりが分かるかを見る
    const replay = async (skipNotifications: boolean) => {
      const empty = join(run.root, `no-files-${skipNotifications}`);
      mkdirSync(empty, { recursive: true });
      const workflows = new WorkflowTracker(() => {});
      const subagents = new SubagentTracker(run.cwd, () => {});
      const bashTasks = new BashTaskTracker(() => {});
      const router = new TaskRouter({ workflows, subagents, bashTasks, screen: () => null, sessionDir: () => empty });
      for (const { entry } of run.seen) {
        if (skipNotifications && taskNotificationOf(entry)) continue;
        router.track(withoutFiles(entry, empty), false, false);
      }
      // ワークフローの完了は、ファイルを読み直してから決まる（無いので通知の状態になる）
      for (let i = 0; i < 40 && workflows.all().some((w) => w.status === 'running') && !skipNotifications; i++) await sleep(50);
      const result = { workflows: workflows.all(), subagents: subagents.all(), bashTasks: bashTasks.all() };
      workflows.dispose();
      subagents.dispose();
      bashTasks.dispose();
      return result;
    };
    const notified = await replay(false);
    expect(notified.bashTasks.find((t) => t.toolUseId === 'toolu_bg')).toMatchObject({ state: 'completed' });
    expect(notified.subagents.find((r) => r.toolUseId === 'toolu_agent')).toMatchObject({ state: 'done', result: 'サブエージェントの結果', toolCalls: 1 });
    expect(notified.workflows.find((w) => w.toolUseId === 'toolu_wf')).toMatchObject({ status: 'completed', agents: [] });
    // 通知の行を除くと、どれも終わったことが分からない（後ろ盾を使っていない）
    const silent = await replay(true);
    expect(silent.bashTasks.find((t) => t.toolUseId === 'toolu_bg')?.state).toBe('running');
    expect(silent.subagents.find((r) => r.toolUseId === 'toolu_agent')?.state).toBe('running');
    expect(silent.workflows.find((w) => w.toolUseId === 'toolu_wf')?.status).toBe('running');
  });
});

// 会話ログの行から、トラッカーが読むファイルの場所を消す（Bash の出力ファイル）・空のフォルダに向ける（ワークフロー）
function withoutFiles(entry: TranscriptEntry, empty: string): TranscriptEntry {
  const copy = JSON.parse(JSON.stringify(entry).replace(/Output is being written to: [^"\\]+/g, '')) as TranscriptEntry & {
    toolUseResult?: Record<string, unknown>;
  };
  const result = copy.toolUseResult;
  if (result && typeof result.transcriptDir === 'string') result.transcriptDir = join(empty, 'subagents', 'workflows', String(result.runId));
  return copy;
}
