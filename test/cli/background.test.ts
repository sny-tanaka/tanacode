import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkWorkflowApproval } from '../scenario';
import { ClaudeRun, claudeVersion, menuOf } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、バックグラウンドで動くものを、アプリと同じトラッカーで追えるかを確かめる。
// 台本: サブエージェント（Agent）→ バックグラウンドの Bash → ワークフロー（Workflow）→ 文章で返事。
// サブエージェントとワークフローのエージェントも、それぞれの台本でモックの API に答えてもらう

const PROMPT = 'バックグラウンドの作業を試してください';
const AGENT_PROMPT = 'サブエージェントの仕事です';
const WORKFLOW_AGENT_PROMPT = 'ワークフローのエージェントです';

const SCRIPT = `export const meta = { name: 'tanacode-check', description: '確認のワークフロー', phases: [{ title: '調べる' }] }
phase('調べる')
const result = await agent('${WORKFLOW_AGENT_PROMPT}', { label: '確認係', phase: '調べる' })
return result`;

const version = claudeVersion();

describe(`Claude Code ${version} のバックグラウンドの作業`, () => {
  let api: MockApi;
  let run: ClaudeRun;

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
        steps: [
          [{ type: 'tool_use', id: 'toolu_sub_bash', name: 'Bash', input: { command: 'echo sub-agent', description: 'サブの作業' } }],
          [{ type: 'text', text: 'サブエージェントの結果' }],
        ],
      },
      { match: WORKFLOW_AGENT_PROMPT, steps: [[{ type: 'text', text: 'ワークフローの結果' }]] },
    ];
    run = new ClaudeRun(await api.start());
    await run.open();
  });

  afterAll(async () => {
    if (process.env.TANACODE_RECORD) run?.recordScreens(join('test', 'fixtures', 'claude-code', version));
    run?.stop();
    await api?.stop();
  });

  it('ワークフローを始める前の確認がメニューとして読める', async () => {
    await run.send(PROMPT);
    const menu = await run.waitFor('ワークフローの確認', menuOf('other', /workflow/i));
    run.capture('workflow-approval');
    checkWorkflowApproval(menu);
    await run.answer(menu.title, menu.options.find((o) => /^Yes/.test(o.label))!.id);
  });

  it('サブエージェントの進み具合と結果を読める', async () => {
    const agent = await run.waitFor('サブエージェントの完了', () => run.subagentRuns.find((r) => r.toolUseId === 'toolu_agent' && r.state !== 'running'));
    expect(agent).toMatchObject({ state: 'done', result: 'サブエージェントの結果' });
    expect(agent.agentId).toBeTruthy();
    expect(agent.toolCalls).toBeGreaterThanOrEqual(1);
  });

  it('バックグラウンドの Bash の出力と終わりを読める', async () => {
    const task = await run.waitFor('Bash の完了', () => run.bashTasks.find((t) => t.toolUseId === 'toolu_bg' && t.state !== 'running'));
    expect(task).toMatchObject({ state: 'completed', exitCode: 0, description: '裏で待つ' });
    expect(task.output).toContain('bg-done');
  });

  it('ワークフローのフェーズ・エージェント・結果を読める', async () => {
    const workflow = await run.waitFor('ワークフローの完了', () => run.workflowRuns.find((w) => w.toolUseId === 'toolu_wf' && w.status !== 'running'));
    expect(workflow).toMatchObject({ status: 'completed', name: 'tanacode-check', summary: '確認のワークフロー' });
    expect(workflow.phases.map((p) => p.title)).toEqual(['調べる']);
    expect(workflow.agents).toHaveLength(1);
    expect(workflow.agents[0]).toMatchObject({ label: '確認係', phase: '調べる', state: 'done', resultPreview: 'ワークフローの結果' });
  });
});
