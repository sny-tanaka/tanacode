import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskRef } from '@shared/task';
import { checkWorkflowApproval } from '../scenario';
import { ClaudeRun, claudeVersion, menuOf, sleep } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、バックグラウンドで動いているものを、アプリから止められるかを確かめる。
// アプリの停止は、本家の /tasks の画面を開き、行を選んで x を送る操作（ScreenTracker.stopTask）。
// 台本: バックグラウンドのサブエージェント → Bash 2 つ（名前の違うもの）→ 同じコマンドの Bash 2 つ → ワークフロー。
// どれも長く動かし続け、止めたものだけが止まる（ほかは動いたまま）ことと、画面が入力欄に戻ることを見る

const PROMPT = 'バックグラウンドでいろいろ動かしてください';
const AGENT_PROMPT = '長い仕事のサブエージェントです';
const WORKFLOW_AGENT_PROMPT = 'ワークフローのエージェントです';
const LONG_DELAY_MS = 120_000;
// 一覧で省略されるほど長いコマンド
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
  const idle = () => run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.draft === '');

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
    const menu = await run.waitFor('ワークフローの確認', menuOf('other', /workflow/i));
    checkWorkflowApproval(menu);
    await run.answer(menu.title, menu.options.find((o) => /^Yes/.test(o.label))!.id);
    await run.waitFor('すべてが動いている', () =>
      run.bashTasks.length === 5 && run.subagentRuns.some((r) => r.state === 'running') && run.workflowRuns.some((w) => w.status === 'running' && w.agents.length > 0) ? true : null,
    30_000);
    await idle();
    await sleep(1500);
  }, 90_000);

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('同じコマンドが 2 つあるときは、決められないと断って、何も止めない', async () => {
    const message = await stop({ kind: 'bash', toolUseId: 'toolu_dup1' });
    expect(message).toContain('2 つ以上');
    // 画面は入力欄に戻り、どれも動いたまま
    await idle();
    expect(bash('toolu_dup1')?.state).toBe('running');
    expect(bash('toolu_dup2')?.state).toBe('running');
  });

  it('一覧の途中の Bash を、コマンドで見つけて止める（ほかは動いたまま）', async () => {
    const attentions = run.attentions.length;
    expect(await stop({ kind: 'bash', toolUseId: 'toolu_one' })).toBeNull();
    const task = await run.waitFor('Bash が止まる', () => (bash('toolu_one')?.state === 'killed' ? bash('toolu_one') : null));
    expect(task.output).toContain('one');
    expect(bash('toolu_two')?.state).toBe('running');
    // /tasks の画面が開いている間も、メニューや操作できない画面として知らせない
    expect(run.attentions.length).toBe(attentions);
    await idle();
    expect(run.screen.current.draft).toBe('');
  });

  it('一覧で「…」と省略される長いコマンドも、頭で見つけて止める', async () => {
    expect(await stop({ kind: 'bash', toolUseId: 'toolu_long' })).toBeNull();
    await run.waitFor('Bash が止まる', () => (bash('toolu_long')?.state === 'killed' ? true : null));
    expect(bash('toolu_two')?.state).toBe('running');
    await idle();
  });

  it('バックグラウンドのサブエージェントを、説明で見つけて止める', async () => {
    expect(await stop({ kind: 'subagent', toolUseId: 'toolu_agent' })).toBeNull();
    await run.waitFor('サブエージェントが止まる', () => (run.subagentRuns.find((r) => r.toolUseId === 'toolu_agent')?.state === 'stopped' ? true : null));
    await idle();
  });

  it('ワークフローを、名前で見つけて止める', async () => {
    expect(await stop({ kind: 'workflow', toolUseId: 'toolu_wf' })).toBeNull();
    await run.waitFor('ワークフローが止まる', () => (run.workflowRuns.find((w) => w.toolUseId === 'toolu_wf')?.status === 'killed' ? true : null));
    await idle();
  });

  it('もう動いていないものは、止めようとせず理由を返す', async () => {
    expect(await stop({ kind: 'bash', toolUseId: 'toolu_one' })).toContain('見つかりません');
    // 止めたもの以外（二つめの Bash）は動いたまま
    expect(bash('toolu_two')?.state).toBe('running');
    expect(await stop({ kind: 'bash', toolUseId: 'toolu_nothing' })).toContain('見つかりません');
  });

  it('入力欄に書きかけの文字があるときは、打たずに断る', async () => {
    run.type('書きかけ');
    await run.waitFor('書きかけが映る', (info) => (info.draft.includes('書きかけ') ? true : null));
    expect(await stop({ kind: 'bash', toolUseId: 'toolu_dup1' })).toContain('書きかけ');
    // 打った文字はそのまま残る（送られていない）
    expect(run.screen.current.draft).toContain('書きかけ');
    run.type('\x15');
  });
});

// 動いているものが 1 つだけのとき、/tasks は一覧を飛ばして、そのものの詳細を出す。
// Bash・サブエージェントは止めると画面が閉じ、ワークフローは画面が残る（Esc で閉じる）
describe(`Claude Code ${version} のバックグラウンドのタスクの停止（1 つだけのとき）`, () => {
  const only = async (tool: { id: string; name: string; input: Record<string, unknown> }, ready: (run: ClaudeRun) => boolean) => {
    const api = new MockApi();
    api.conversations = [
      { match: PROMPT, steps: [[{ type: 'tool_use', ...tool }], [{ type: 'text', text: '起動しました' }]] },
      { match: AGENT_PROMPT, delayMs: LONG_DELAY_MS, steps: [[{ type: 'text', text: 'サブエージェントの結果' }]] },
      { match: WORKFLOW_AGENT_PROMPT, delayMs: LONG_DELAY_MS, steps: [[{ type: 'text', text: 'ワークフローの結果' }]] },
    ];
    const run = new ClaudeRun(await api.start());
    await run.open();
    await run.send(PROMPT);
    if (tool.name === 'Workflow') {
      const menu = await run.waitFor('ワークフローの確認', menuOf('other', /workflow/i));
      await run.answer(menu.title, menu.options.find((o) => /^Yes/.test(o.label))!.id);
    }
    await run.waitFor('動いている', () => (ready(run) ? true : null), 30_000);
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.draft === '');
    await sleep(1500);
    return { run, close: async () => (await run.stop(), await api.stop()) };
  };

  it('Bash', async () => {
    const { run, close } = await only(
      { id: 'toolu_bg', name: 'Bash', input: { command: 'echo only; sleep 600', description: '一つだけ', run_in_background: true } },
      (r) => r.bashTasks.length === 1,
    );
    try {
      const attentions = run.attentions.length;
      expect(await run.manager.stopTask(run.sessionId!, { kind: 'bash', toolUseId: 'toolu_bg' })).toBeNull();
      await run.waitFor('Bash が止まる', () => (run.bashTasks[0].state === 'killed' ? true : null));
      expect(run.attentions.length).toBe(attentions);
      await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.draft === '');
    } finally {
      await close();
    }
  }, 60_000);

  it('サブエージェント', async () => {
    const { run, close } = await only(
      { id: 'toolu_ag', name: 'Agent', input: { description: '長い調べもの', prompt: AGENT_PROMPT, subagent_type: 'general-purpose', run_in_background: true } },
      (r) => r.subagentRuns.some((a) => a.state === 'running'),
    );
    try {
      expect(await run.manager.stopTask(run.sessionId!, { kind: 'subagent', toolUseId: 'toolu_ag' })).toBeNull();
      await run.waitFor('サブエージェントが止まる', () => (run.subagentRuns[0].state === 'stopped' ? true : null));
      await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.draft === '');
    } finally {
      await close();
    }
  }, 60_000);

  it('ワークフロー（止めても画面が残るので、閉じて入力欄に戻す）', async () => {
    const { run, close } = await only(
      { id: 'toolu_wf', name: 'Workflow', input: { script: SCRIPT } },
      (r) => r.workflowRuns.some((w) => w.status === 'running' && w.agents.length > 0),
    );
    try {
      const attentions = run.attentions.length;
      expect(await run.manager.stopTask(run.sessionId!, { kind: 'workflow', toolUseId: 'toolu_wf' })).toBeNull();
      await run.waitFor('ワークフローが止まる', () => (run.workflowRuns[0].status === 'killed' ? true : null));
      expect(run.attentions.length).toBe(attentions);
      await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.draft === '');
      // 入力欄に戻っていて、書きかけの文字（x など）が残っていない
      expect(run.screen.current.draft).toBe('');
    } finally {
      await close();
    }
  }, 60_000);
});
