import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taskNotificationOf } from '../../src/main/task-router';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、Claude が Monitor の見張りを TaskStop で止めたとき、タスクの一覧で止まったことになるかを確かめる。
// Monitor は止めても完了通知（status の付いた <task-notification>）が届かず、出力ファイルの場所も起動の結果に書かれない（2.1.319）。
// 前は、アプリを再起動するまで「実行中」のまま残っていた。
// 台本: Monitor で見張りを始める → 起動の結果に書かれたタスクの ID を TaskStop で止める（intercept で ID を読む）→ 文章で返事

const PROMPT = '見張りを始めて、すぐ止めてください';

const version = claudeVersion();

describe(`Claude Code ${version} の Monitor の TaskStop`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const monitor = () => run.bashTasks.find((t) => t.toolUseId === 'toolu_mon');

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [
      {
        match: PROMPT,
        steps: [
          [{ type: 'tool_use', id: 'toolu_mon', name: 'Monitor', input: { command: 'echo watch-start; sleep 600', description: '止める見張り', timeout_ms: 1800000 } }],
          // 2 番目は intercept で TaskStop を返す
          [{ type: 'text', text: '（使わない）' }],
          [{ type: 'text', text: '止めました' }],
        ],
      },
    ];
    // Monitor の起動の結果（「Monitor started (task <ID>, …」）を読んで、その ID を TaskStop で止める
    api.intercept = (_prompt, results) => {
      const taskId = results.map((r) => r.match(/Monitor started \(task (\w+)/)?.[1]).find(Boolean);
      return taskId ? [{ type: 'tool_use', id: 'toolu_stop', name: 'TaskStop', input: { task_id: taskId } }] : null;
    };
    run = new ClaudeRun(await api.start());
    await run.open();
    await run.send(PROMPT);
    await run.waitUntil('手が空く', () => run.idle && monitor(), 30_000);
  }, 60_000);

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('TaskStop で止めた Monitor は、完了通知が無くても止められたことになり、セッションも空く', async () => {
    const task = await run.waitUntil('Monitor が止まる', () => (monitor()?.state !== 'running' ? monitor() : null));
    expect(task).toMatchObject({ command: 'echo watch-start; sleep 600', description: '止める見張り', state: 'killed' });
    expect(task?.endedAt).toEqual(expect.any(Number));
    // 裏で動いているものが無くなったので、セッションも「バックグラウンドで実行中」でなくなる
    await run.waitUntil('セッションが空く', () => run.manager.stateOf(run.sessionId!) === 'idle');
  });

  it('前提: このバージョンの Claude Code は、TaskStop で止めた Monitor の完了通知を書かない（書くようになったら、この直しは要らない）', () => {
    const ended = run.entries.map((e) => taskNotificationOf(e)).filter((n) => n?.toolUseId === 'toolu_mon' && n.status !== null);
    expect(ended).toEqual([]);
  });
});
