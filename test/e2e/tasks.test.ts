import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// Claude がバックグラウンドで動かすもの（サブエージェント・バックグラウンドの Bash・ワークフロー）が、タスクの一覧に出て、
// 開くと中身（サブエージェントの会話・ワークフローのフェーズとエージェント）が見え、動いているものを画面から止められる

const PROMPT = 'バックグラウンドの作業を試してください';
const AGENT_PROMPT = 'サブエージェントの仕事です';
const WORKFLOW_AGENT_PROMPT = 'ワークフローのエージェントです';
const SCRIPT = `export const meta = { name: 'tanacode-check', description: '確認のワークフロー', phases: [{ title: '調べる' }] }
phase('調べる')
const result = await agent('${WORKFLOW_AGENT_PROMPT}', { label: '確認係', phase: '調べる' })
return result`;

describe('バックグラウンドの作業を、タスクの画面で見て止める', () => {
  let app: E2EApp;
  const card = (name: string) => app.page.locator('.task-list .task-card', { has: app.page.locator('.task-card-name', { hasText: name }) });

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: PROMPT,
          steps: [
            [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: '調べもの', prompt: AGENT_PROMPT, subagent_type: 'general-purpose' } }],
            [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 1 && echo bg-done', description: '裏で待つ', run_in_background: true } }],
            [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: 'sleep 300 && echo long-done', description: '長く待つ', run_in_background: true } }],
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
        { match: WORKFLOW_AGENT_PROMPT, delayMs: 2000, steps: [[{ type: 'text', text: 'ワークフローの結果' }]] },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`tasks-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('ワークフローを始める前の確認に、カードで答えられる', async () => {
    await app.startSession(PROMPT, { mode: 'manual' });
    const menu = await app.menuCard('other');
    expect(await menu.textContent()).toMatch(/workflow/i);
    await app.choose(menu, /^Yes/);
    await app.byText('.chat-list', '起動しました').waitFor();
  });

  it('タスクの一覧に、サブエージェント・Bash・ワークフローが出る', async () => {
    await app.page.click('.activity-bar [aria-label^="タスク"]');
    await card('調べもの').locator('.task-card-state.done').waitFor();
    await card('裏で待つ').locator('.task-card-state.done').waitFor();
    await card('長く待つ').locator('.task-card-state.running').waitFor();
    await app.page.locator('.task-list .task-card', { hasText: 'ワークフロー' }).locator('.task-card-state.done').waitFor({ timeout: 60_000 });
  });

  it('サブエージェントを開くと、その会話と結果が見える', async () => {
    await card('調べもの').click();
    await app.byText('.task-pane', 'サブエージェントの結果').first().waitFor();
    await app.byText('.task-pane', AGENT_PROMPT).first().waitFor();
  });

  it('ワークフローを開くと、フェーズとエージェントが見える', async () => {
    await app.page.locator('.task-list .task-card', { hasText: 'ワークフロー' }).click();
    await app.byText('.task-pane', '調べる').first().waitFor();
    await app.byText('.task-pane', '確認係').first().waitFor();
  });

  it('動いている Bash を、画面から止められる', async () => {
    const long = card('長く待つ');
    await long.hover();
    await long.locator('.task-stop').click();
    await card('長く待つ').locator('.task-card-state.stopped').waitFor();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
