import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { line, ScriptedApp } from './helpers/scripted-claude';

// バックグラウンドで動くもの（Bash・サブエージェント・ワークフロー）の数・エージェントの会話（SessionManager）

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => {
  vi.restoreAllMocks();
  app.dispose();
});

// 会話ログの行（Claude Code が書く形）
const backgroundBash = (toolUseId: string, command: string) => [
  line.toolUse(toolUseId, 'Bash', { command, run_in_background: true }),
  line.toolResult(toolUseId, `Command running in background with ID: ${toolUseId}. Output is being written to: /nonexistent/${toolUseId}.output`, {
    toolUseResult: { backgroundTaskId: toolUseId },
  }),
];
const backgroundAgent = (toolUseId: string, description: string, agentId: string) => [
  line.toolUse(toolUseId, 'Agent', { description, prompt: '調べて', run_in_background: true }),
  line.toolResult(toolUseId, 'Async agent launched', { toolUseResult: { status: 'async_launched', agentId } }),
];
const foregroundAgent = (toolUseId: string, description: string) => [line.toolUse(toolUseId, 'Agent', { description, prompt: '調べて' })];
const workflow = (toolUseId: string, name: string, transcriptDir: string) => [
  line.toolUse(toolUseId, 'Workflow', { script: 'export default async function () {}' }),
  line.toolResult(toolUseId, 'Workflow started', {
    toolUseResult: { taskType: 'local_workflow', runId: `run-${toolUseId}`, transcriptDir, workflowName: name, summary: '' },
  }),
];

// 会話ログのセッションのフォルダ（subagents/ がある）
const sessionDir = (id: string) => join(dirname(app.transcript(id)), app.claudeId(id));

describe('バックグラウンドのタスクの数', () => {
  it('動いている Bash・バックグラウンドのサブエージェント・ワークフローを数え、一覧に出す。本体の作業の中のサブエージェントは数えない', async () => {
    const { id } = app.create();
    await app.ready(id);
    const dir = join(app.root, 'wf');
    app.append(id, line.user('並べて調べて'), ...backgroundBash('toolu_b', 'npm run dev'), ...backgroundAgent('toolu_a', 'テストを調べる', 'a1'), ...foregroundAgent('toolu_f', '手前で調べる'), ...workflow('toolu_w', 'レビュー', dir));
    await app.waitFor('バックグラウンドの数', () => app.manager.summary(id)?.backgroundTasks === 3);
    expect(app.manager.workflows(id).map((w) => [w.name, w.status])).toEqual([['レビュー', 'running']]);
    expect(app.workflows.get(id)).toEqual(app.manager.workflows(id));
    expect(app.manager.subagents(id).map((r) => [r.description, r.background, r.state])).toEqual([
      ['テストを調べる', true, 'running'],
      ['手前で調べる', false, 'running'],
    ]);
    expect(app.subagents.get(id)).toEqual(app.manager.subagents(id));
  });
});

describe('バックグラウンドのタスクが動いている間のターンの終わり', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('ふつうは完了を知らせないが、Claude が報告（report_result）を預けていれば知らせる', async () => {
    const reported = new Set<string>();
    app.manager.turnReported = (id) => reported.has(id);
    const { id } = app.create();
    await app.ready(id);
    app.say(id, line.user('サーバーを起動して'), ...backgroundBash('toolu_b', 'npm run dev'), line.text('起動しました'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end') && app.manager.summary(id)?.backgroundTasks === 1);
    await sleep(100);
    expect(app.turnsCompleted).toEqual([]);
    reported.add(id);
    app.say(id, line.user('もう一つ起動して'), ...backgroundBash('toolu_c', 'npm run watch'), line.text('起動しました'));
    app.finish(id);
    await app.waitFor('報告つきのターンの終わり', () => app.turnsCompleted.length === 1);
    expect(app.manager.summary(id)?.backgroundTasks).toBe(2);
    expect(app.turnNotices).toEqual(['work']);
  });

  it('ブラウザでの操作を頼んでいる間は、報告があっても知らせない（返事を待っている）', async () => {
    app.manager.turnReported = () => true;
    const { id } = app.create();
    await app.ready(id);
    app.manager.browserAskChanged(id, true);
    app.say(id, line.user('ログインして'), line.text('ブラウザで操作してください'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end') && app.manager.stateOf(id) === 'idle');
    await sleep(100);
    expect(app.turnsCompleted).toEqual([]);
  });
});

describe('agentLog', () => {
  const agentLine = (text: string) => ({ ...line.text(text), isSidechain: true });

  it('サブエージェントは subagents/agent-<ID>.jsonl、ワークフローのエージェントは、ワークフローの会話ログのフォルダから読む', async () => {
    const { id } = app.create();
    await app.ready(id);
    const dir = join(app.root, 'wf');
    app.append(id, line.user('調べて'), ...backgroundAgent('toolu_a', 'テストを調べる', 'a1'), ...workflow('toolu_w', 'レビュー', dir));
    await app.waitFor('バックグラウンドの数', () => app.manager.summary(id)?.backgroundTasks === 2);
    const subagents = join(sessionDir(id), 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-a1.jsonl'), `${JSON.stringify(agentLine('サブエージェントの返事'))}\n`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-w1.jsonl'), `${JSON.stringify(agentLine('ワークフローの返事'))}\n`);
    const texts = (events: { type: string; text?: string }[]) => events.filter((e) => e.type === 'assistant-text').map((e) => e.text);
    expect(texts(await app.manager.agentLog(id, { kind: 'subagent', toolUseId: 'toolu_a' }))).toEqual(['サブエージェントの返事']);
    expect(texts(await app.manager.agentLog(id, { kind: 'workflow', toolUseId: 'toolu_w', agentId: 'w1' }))).toEqual(['ワークフローの返事']);
  });

  it('知らないセッション・知らないタスク・まだ ID の分からないサブエージェントは空', async () => {
    expect(await app.manager.agentLog('nope', { kind: 'subagent', toolUseId: 'x' })).toEqual([]);
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('調べて'), ...foregroundAgent('toolu_f', '手前で調べる'));
    await app.waitFor('サブエージェント', () => app.manager.subagents(id).length === 1);
    expect(await app.manager.agentLog(id, { kind: 'subagent', toolUseId: 'toolu_f' })).toEqual([]);
    expect(await app.manager.agentLog(id, { kind: 'workflow', toolUseId: 'toolu_x', agentId: 'w1' })).toEqual([]);
  });
});
