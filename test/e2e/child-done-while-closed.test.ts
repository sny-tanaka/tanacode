import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_EVENT_TAG, sessionToolId } from '@shared/session-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// 作業中の子を残してアプリを終え（Claude Code は動かしたまま）、閉じている間に子が作業を終えたら、
// 次のアプリが子を引き継いだところで、親に「作業が終わった」と知らせる。
// 直す前は、引き継いだあとの子の状態が「止まっている → 起動中 → 待機」と変わり、作業中から手が空いたように見えないので、知らせが届かなかった

const PARENT = '子セッションに、時間のかかる作業を任せてください';
const CHILD = '子の作業として、長いコマンドを 1 つ実行してください';
const CHILD_NAME = '閉じている間に終える子';
const PARENT_STARTED = '子を始めました。終わるのを待ちます';
const CHILD_DONE = '長いコマンドを終えました';
const PARENT_NOTICED = '子が終えたことを知りました';
// 子のコマンドの長さ。アプリを終えるまで作業中で、閉じている間に終わる長さにする
const CHILD_COMMAND = 'sleep 8 && echo child-done';

describe('アプリを閉じている間に子が作業を終えたら、次のアプリが親に知らせる', () => {
  let app: E2EApp;
  // 親に届いた、子の知らせ（子の ID）
  const noticed: string[] = [];
  let childId: string | null = null;
  let childDone = false;

  const respond = (prompt: string, results: string[]): Block[] | null => {
    const result = results.join('\n');
    // --- 親 ---
    if (prompt.includes(PARENT)) return [{ type: 'tool_use', id: 'toolu_start', name: sessionToolId('start_session'), input: { prompt: CHILD, worktree: false, name: CHILD_NAME } }];
    if (result.includes('"session_id"') && result.includes('"permission_mode"')) {
      childId = /"session_id":\s*"([0-9a-f-]{36})"/.exec(result)?.[1] ?? null;
      return [{ type: 'text', text: PARENT_STARTED }];
    }
    const event = new RegExp(`<${SESSION_EVENT_TAG} sessions="([0-9a-f-]+)"`).exec(prompt);
    if (event) {
      noticed.push(event[1]);
      return [{ type: 'text', text: PARENT_NOTICED }];
    }
    // --- 子 ---
    if (result.includes('child-done')) {
      childDone = true;
      return [{ type: 'text', text: CHILD_DONE }];
    }
    if (prompt.includes(CHILD)) return [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: CHILD_COMMAND, description: '長いコマンド' } }];
    return null;
  };

  beforeAll(async () => {
    app = await E2EApp.launch({ trusted: true });
    app.api.intercept = respond;
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`child-done-while-closed-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('親が子を始め、子が長いコマンドを実行している間に、アプリを動かしたまま終える。子は閉じている間に作業を終える', async () => {
    await app.startSession(PARENT);
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', PARENT_STARTED).waitFor();
    // 子がコマンドを始めた（子の作業中）
    await app.waitUntil('子のコマンドの実行', () => app.api.lastPrompts.some((p) => p.includes(CHILD)));
    await app.byText('.session-list .session-row', CHILD_NAME).waitFor();
    expect(childDone).toBe(false);
    await app.restart(async () => {
      // 閉じている間に、子が作業を終える（最後の応答まで返し、会話ログに書かれる間を置く）
      await app.waitUntil('閉じている間の子の作業の終わり', () => childDone, 60_000);
      await new Promise((r) => setTimeout(r, 2000));
    });
    expect(noticed).toEqual([]);
  });

  it('次のアプリが子を引き継いだら、親に知らせが 1 回届く', async () => {
    await app.waitUntil('親への知らせ', () => noticed.length > 0, 60_000);
    expect(noticed).toEqual([childId]);
    await app.byText('.session-list .session-row', PARENT).click();
    await app.byText('.chat-list', PARENT_NOTICED).waitFor();
    // しばらく待っても、知らせは増えない
    await new Promise((r) => setTimeout(r, 3000));
    expect(noticed).toHaveLength(1);
  });
});
