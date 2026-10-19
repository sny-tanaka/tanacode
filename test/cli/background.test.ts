import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import { BashTaskTracker } from '../../src/main/bash-task-tracker';
import { SubagentTracker } from '../../src/main/subagent-tracker';
import { TaskRouter, taskNotificationOf } from '../../src/main/task-router';
import { WorkflowTracker } from '../../src/main/workflow-tracker';
import { checkWorkflowApproval } from '../scenario';
import { ClaudeRun, claudeVersion, sleep } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、バックグラウンドで動くものを、アプリと同じトラッカーで追えるかを確かめる。
// 台本: サブエージェント（Agent）とバックグラウンドの Bash（並べて呼ぶ）→ ワークフロー（Workflow）→ 文章で返事。
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
          // サブエージェントとバックグラウンドの Bash は、1 つの応答で並べて呼ぶ。Bash の呼び出しは、サブエージェントの起動の結果が
          // 会話ログに出てから送る（下の holdTool）。会話ログでは呼び出しと結果が交互の行になり、API に送る 1 通ずつと合わないので、
          // Claude Code はその 2 通を API の要求の控え（api-request-blob）に書く。控えの中の結果で、終わったことにしないかを見る
          [
            { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: '調べもの', prompt: AGENT_PROMPT, subagent_type: 'general-purpose' } },
            { type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 1 && echo bg-done', description: '裏で待つ', run_in_background: true } },
          ],
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
    // 本物のモデルが、並べて呼ぶ次の呼び出しを書いている間に、先の呼び出しが動いて結果ができるのと同じ並びにする。結果ができたことは
    // stream-json の行で見る（会話ログには、応答を流し終えてからまとめて書かれる）
    const streamed = () => run.streamLines().flatMap((line) => parsed(line));
    api.holdTool = (id) => (id === 'toolu_agent' ? run.waitUntil('サブエージェントの起動の結果', () => hasResult(streamed(), 'user', 'toolu_agent')) : Promise.resolve());
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('ワークフローを始める前の確認が、許可の確認（Workflow）として届き、許すと始まる', async () => {
    await run.send(PROMPT);
    const permission = await run.permission('ワークフローの確認');
    checkWorkflowApproval(permission);
    run.replyPermission(permission, { kind: 'allow' });
  });

  it('ワークフローの実行中に、journal からエージェントの状態が読める', async () => {
    const workflow = await run.waitUntil('ワークフローのエージェントの開始', () =>
      run.workflowRuns.find((w) => w.toolUseId === 'toolu_wf' && w.status === 'running' && w.agents.length > 0),
    );
    expect(workflow.agents).toHaveLength(1);
    expect(workflow.agents[0]).toMatchObject({ label: '確認係', phase: '調べる', state: 'running', resultPreview: null });
    // 完了時の記録（workflows/<runId>.json）はまだ無い。読めたのは journal から
    expect(existsSync(join(run.sessionDir(), 'workflows', `${workflow.runId}.json`))).toBe(false);
  });

  it('サブエージェントの進み具合と結果を読める', async () => {
    const agent = await run.waitUntil('サブエージェントの完了', () => run.subagentRuns.find((r) => r.toolUseId === 'toolu_agent' && r.state !== 'running'));
    // 起動の知らせの結果は、API の要求の控えにも（toolUseResult なしで）もう一度書かれている。それで終わったことにせず、完了通知で終わる
    expect(hasResult(run.entries, 'api-request-blob', 'toolu_agent')).toBe(true);
    expect(agent).toMatchObject({ state: 'done', result: 'サブエージェントの結果' });
    expect(agent.agentId).toBeTruthy();
    expect(agent.toolCalls).toBe(1);
    // 使用量は完了通知の <usage> から（待機中に届いた通知にも付いている）
    expect(agent.tokens).toBeGreaterThan(0);
    expect(agent.durationMs).toBeGreaterThanOrEqual(AGENT_DELAY_MS * 2);
  });

  it('バックグラウンドの Bash の出力と終わりを読める', async () => {
    const task = await run.waitUntil('Bash の完了', () => run.bashTasks.find((t) => t.toolUseId === 'toolu_bg' && t.state !== 'running'));
    expect(task).toMatchObject({ state: 'completed', exitCode: 0, description: '裏で待つ' });
    expect(task.output).toContain('bg-done');
  });

  it('ワークフローのフェーズ・エージェント・結果を読める', async () => {
    const workflow = await run.waitUntil('ワークフローの完了', () => run.workflowRuns.find((w) => w.toolUseId === 'toolu_wf' && w.status !== 'running'), 30_000);
    expect(workflow).toMatchObject({ status: 'completed', name: 'tanacode-check', summary: '確認のワークフロー' });
    expect(workflow.phases.map((p) => p.title)).toEqual(['調べる']);
    expect(workflow.agents).toHaveLength(1);
    expect(workflow.agents[0]).toMatchObject({ label: '確認係', phase: '調べる', state: 'done', resultPreview: 'ワークフローの結果' });
  });

  it('会話ログの完了通知から、どのタスクがどうなったかと結果・使用量が読める', async () => {
    // 待機中に届いた通知は、Claude Code が発言として書き、それを受けて動く。ワークフローの通知のターンが終わるまで待つ
    const delivered = () => notifications().some(({ entry, notice }) => entry.type === 'user' && notice.toolUseId === 'toolu_wf');
    await run.waitUntil('ワークフローの完了通知', delivered, 30_000);
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
    expect(run.chatEvents.flatMap((e) => (e.type === 'queue' ? e.prompts : [])).filter((p) => p.text.includes('<task-notification>'))).toEqual([]);
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
      const router = new TaskRouter({ workflows, subagents, bashTasks, sessionDir: () => empty });
      for (const { entry } of run.seen) {
        if (skipNotifications && taskNotificationOf(entry)) continue;
        router.track(withoutFiles(entry, empty), false);
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

// 行のうち、その種類の行で、そのツールの結果を含むものがあるか
function hasResult(entries: TranscriptEntry[], type: string, toolUseId: string): boolean {
  return entries.some(
    (entry) =>
      entry.type === type && Array.isArray(entry.message?.content) && entry.message.content.some((b) => b.type === 'tool_result' && b.tool_use_id === toolUseId),
  );
}

// JSON の行。読めなければ無し
function parsed(line: string): TranscriptEntry[] {
  try {
    return [JSON.parse(line) as TranscriptEntry];
  } catch {
    return [];
  }
}

// 会話ログの行から、トラッカーが読むファイルの場所を消す（Bash の出力ファイル）・空のフォルダに向ける（ワークフロー）
function withoutFiles(entry: TranscriptEntry, empty: string): TranscriptEntry {
  const copy = JSON.parse(JSON.stringify(entry).replace(/Output is being written to: [^"\\]+/g, '')) as TranscriptEntry & {
    toolUseResult?: Record<string, unknown>;
  };
  const result = copy.toolUseResult;
  if (result && typeof result.transcriptDir === 'string') result.transcriptDir = join(empty, 'subagents', 'workflows', String(result.runId));
  return copy;
}
