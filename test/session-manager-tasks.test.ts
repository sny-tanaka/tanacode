import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenTracker, type StopResult } from '../src/main/screen-tracker';
import { line, ScriptedApp } from './helpers/scripted-claude';

// バックグラウンドで動くもの（Bash・サブエージェント・ワークフロー）の数・止める・エージェントの会話（SessionManager）

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
const sessionDir = (id: string) => join(dirname(app.transcript(id)), app.pty(id).arg('--session-id')!);

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

describe('stopTask', () => {
  const stopTask = () => vi.spyOn(ScreenTracker.prototype, 'stopTask');

  it('止めるものを、本家の /tasks の画面での名前（Bash はコマンド・サブエージェントは説明・ワークフローは名前）で探す', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('並べて'), ...backgroundBash('toolu_b', 'npm run dev'), ...backgroundAgent('toolu_a', 'テストを調べる', 'a1'), ...workflow('toolu_w', 'レビュー', join(app.root, 'wf')));
    await app.waitFor('バックグラウンドの数', () => app.manager.summary(id)?.backgroundTasks === 3);
    const spy = stopTask().mockResolvedValue('stopped');
    expect(await app.manager.stopTask(id, { kind: 'bash', toolUseId: 'toolu_b' })).toBeNull();
    expect(await app.manager.stopTask(id, { kind: 'subagent', toolUseId: 'toolu_a' })).toBeNull();
    expect(await app.manager.stopTask(id, { kind: 'workflow', toolUseId: 'toolu_w' })).toBeNull();
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['npm run dev', 'テストを調べる', 'レビュー']);
  });

  it('動いていないセッション・止められるものが無いときは、画面を操作せずに理由を返す', async () => {
    const spy = stopTask();
    expect(await app.manager.stopTask('nope', { kind: 'bash', toolUseId: 'x' })).toBe('セッションが動いていないため、止められません');
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('調べて'), ...foregroundAgent('toolu_f', '手前で調べる'));
    await app.waitFor('サブエージェント', () => app.manager.subagents(id).length === 1);
    const none = '止められるもの（動いているバックグラウンドのタスク）が見つかりません';
    // 本体の作業の中で動いているサブエージェント・知らないもの
    expect(await app.manager.stopTask(id, { kind: 'subagent', toolUseId: 'toolu_f' })).toBe(none);
    expect(await app.manager.stopTask(id, { kind: 'bash', toolUseId: 'toolu_x' })).toBe(none);
    expect(await app.manager.stopTask(id, { kind: 'workflow', toolUseId: 'toolu_x' })).toBe(none);
    // 説明の無いサブエージェントは、/tasks の画面で見分けられない
    app.append(id, line.toolUse('toolu_n', 'Agent', { prompt: '調べて', run_in_background: true }));
    await app.waitFor('サブエージェント', () => app.manager.subagents(id).length === 2);
    expect(await app.manager.stopTask(id, { kind: 'subagent', toolUseId: 'toolu_n' })).toBe(none);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each<[StopResult, string | null]>([
    ['stopped', null],
    ['busy', '別の操作の途中です。少し待ってからもう一度押してください'],
    ['not-prompt', '質問や確認の答えを待っているため、今は止められません。答えてから止めてください'],
    ['draft', 'ターミナルの入力欄に書きかけの文字があるため、止められません'],
    ['not-found', '画面に見つかりませんでした。すでに終わったか、止まっています'],
    ['ambiguous', '同じ名前のものが 2 つ以上あり、どれを止めるか決められません。ターミナルで /tasks を開いて止めてください'],
    ['failed', '止められませんでした。ターミナルで /tasks を開いて止めてください'],
  ])('画面の操作の結果 %s を、理由の文にする', async (result, message) => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('起動して'), ...backgroundBash('toolu_b', 'npm run dev'));
    await app.waitFor('バックグラウンド', () => app.manager.summary(id)?.backgroundTasks === 1);
    stopTask().mockResolvedValue(result);
    expect(await app.manager.stopTask(id, { kind: 'bash', toolUseId: 'toolu_b' })).toBe(message);
  });

  it('画面の操作が失敗（例外）したら、止められなかったと返す', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('起動して'), ...backgroundBash('toolu_b', 'npm run dev'));
    await app.waitFor('バックグラウンド', () => app.manager.summary(id)?.backgroundTasks === 1);
    stopTask().mockRejectedValue(new Error('画面が読めません'));
    expect(await app.manager.stopTask(id, { kind: 'bash', toolUseId: 'toolu_b' })).toBe('止められませんでした。ターミナルで /tasks を開いて止めてください');
  });

  it('Claude Code の /tasks の画面に、名前で探して止めるよう頼む（打つのは /tasks）', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    app.append(id, line.user('起動して'), ...backgroundBash('toolu_b', 'npm run dev'));
    await app.waitFor('バックグラウンド', () => app.manager.summary(id)?.backgroundTasks === 1);
    // /tasks の画面が出ないので、見つからない（入力欄はそのまま）
    expect(await app.manager.stopTask(id, { kind: 'bash', toolUseId: 'toolu_b' })).toBe('画面に見つかりませんでした。すでに終わったか、止まっています');
    expect(pty.writes.slice(0, 2)).toEqual(['/tasks', '\r']);
  }, 10_000);
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
