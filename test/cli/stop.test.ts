import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskRef } from '@shared/task';
import { checkWorkflowApproval } from '../scenario';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、バックグラウンドで動いているものを、アプリから止められるかを確かめる。
// アプリの停止は stop_task（task_started の task_id。Bash は会話ログのタスクの ID でも）。止まったことは、Claude Code がそのタスクの
// 終わり（task_notification）を知らせるまで待って確かめる（SessionManager.stopTask）。
// 台本: バックグラウンドのサブエージェント → Bash 2 つ（名前の違うもの）→ 一覧で省略されるほど長いコマンドの Bash →
// 同じコマンドの Bash 2 つ → ワークフロー。どれも長く動かし続け、止めたものだけが止まる（ほかは動いたまま）ことを見る

const PROMPT = 'バックグラウンドでいろいろ動かしてください';
const AGENT_PROMPT = '長い仕事のサブエージェントです';
const WORKFLOW_AGENT_PROMPT = 'ワークフローのエージェントです';
const LONG_DELAY_MS = 120_000;
// 長いコマンド（前は /tasks の一覧で省略されて見つけにくかった）
const LONG_COMMAND = `echo long-command-start; ${'sleep 1; '.repeat(40)}sleep 700`;

const SCRIPT = `export const meta = { name: 'tanacode-stop', description: '止める確認のワークフロー', phases: [{ title: '調べる' }] }
phase('調べる')
const result = await agent('${WORKFLOW_AGENT_PROMPT}', { label: '確認係', phase: '調べる' })
return result`;

const version = claudeVersion();

describe(`Claude Code ${version} のバックグラウンドのタスクの停止`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const stop = (ref: TaskRef) => run.manager.stopTask(run.sessionId!, ref);
  const bash = (toolUseId: string) => run.bashTasks.find((t) => t.toolUseId === toolUseId);
  const idle = () => run.waitUntil('手が空く', () => run.idle);

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [
      {
        match: PROMPT,
        steps: [
          [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: '長い調べもの', prompt: AGENT_PROMPT, subagent_type: 'general-purpose', run_in_background: true } }],
          [{ type: 'tool_use', id: 'toolu_one', name: 'Bash', input: { command: 'echo one; sleep 600', description: '一つめ', run_in_background: true } }],
          [{ type: 'tool_use', id: 'toolu_two', name: 'Bash', input: { command: 'echo two; sleep 601', description: '二つめ', run_in_background: true } }],
          [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: LONG_COMMAND, description: '長いコマンド', run_in_background: true } }],
          [{ type: 'tool_use', id: 'toolu_dup1', name: 'Bash', input: { command: 'sleep 602', description: '同じコマンドの一つめ', run_in_background: true } }],
          [{ type: 'tool_use', id: 'toolu_dup2', name: 'Bash', input: { command: 'sleep 602', description: '同じコマンドの二つめ', run_in_background: true } }],
          [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { script: SCRIPT } }],
          [{ type: 'text', text: '起動しました' }],
        ],
      },
      { match: AGENT_PROMPT, delayMs: LONG_DELAY_MS, steps: [[{ type: 'text', text: 'サブエージェントの結果' }]] },
      { match: WORKFLOW_AGENT_PROMPT, delayMs: LONG_DELAY_MS, steps: [[{ type: 'text', text: 'ワークフローの結果' }]] },
    ];
    run = new ClaudeRun(await api.start());
    await run.open();
    await run.send(PROMPT);
    const permission = await run.permission('ワークフローの確認');
    checkWorkflowApproval(permission);
    run.replyPermission(permission, { kind: 'allow' });
    await run.waitUntil(
      'すべてが動いている',
      () => (run.bashTasks.length === 5 && run.subagentRuns.some((r) => r.state === 'running') && run.workflowRuns.some((w) => w.status === 'running' && w.agents.length > 0) ? true : null),
      30_000,
    );
    await idle();
  }, 90_000);

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('同じコマンドが 2 つあっても、止めたものだけが止まる（ID で止めるので取り違えない）', async () => {
    expect(await stop({ kind: 'bash', toolUseId: 'toolu_dup1' })).toBeNull();
    await run.waitUntil('Bash が止まる', () => (bash('toolu_dup1')?.state !== 'running' ? true : null));
    expect(bash('toolu_dup2')?.state).toBe('running');
    await idle();
  });

  it('Bash を止める（ほかは動いたまま）。止めても、確認や質問として知らせない', async () => {
    const attentions = run.attentions.length;
    expect(await stop({ kind: 'bash', toolUseId: 'toolu_one' })).toBeNull();
    const task = await run.waitUntil('Bash が止まる', () => (bash('toolu_one')?.state !== 'running' ? bash('toolu_one') : null));
    expect(task.output).toContain('one');
    expect(bash('toolu_two')?.state).toBe('running');
    expect(run.attentions.length).toBe(attentions);
    await idle();
  });

  it('長いコマンドの Bash も止める', async () => {
    expect(await stop({ kind: 'bash', toolUseId: 'toolu_long' })).toBeNull();
    await run.waitUntil('Bash が止まる', () => (bash('toolu_long')?.state !== 'running' ? true : null));
    expect(bash('toolu_two')?.state).toBe('running');
    await idle();
  });

  it('バックグラウンドのサブエージェントを止める', async () => {
    expect(await stop({ kind: 'subagent', toolUseId: 'toolu_agent' })).toBeNull();
    await run.waitUntil('サブエージェントが止まる', () => (run.subagentRuns.find((r) => r.toolUseId === 'toolu_agent')?.state === 'stopped' ? true : null));
    await idle();
  });

  it('ワークフローを止める', async () => {
    expect(await stop({ kind: 'workflow', toolUseId: 'toolu_wf' })).toBeNull();
    await run.waitUntil('ワークフローが止まる', () => (run.workflowRuns.find((w) => w.toolUseId === 'toolu_wf')?.status === 'killed' ? true : null));
    await idle();
  });

  it('もう動いていないものは、止めようとせず理由を返す', async () => {
    expect(await stop({ kind: 'bash', toolUseId: 'toolu_one' })).toContain('見つかりません');
    // 止めたもの以外（二つめの Bash）は動いたまま
    expect(bash('toolu_two')?.state).toBe('running');
    expect(await stop({ kind: 'bash', toolUseId: 'toolu_nothing' })).toContain('見つかりません');
  });
});
