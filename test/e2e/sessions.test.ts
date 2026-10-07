import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sessionToolId } from '@shared/session-tools';
import { E2EApp } from './app';

// Claude がセッションの MCP で子セッションを始める。始める前に許可の確認がカードで出て、答えると、
// 子はアプリのふつうのセッションとして一覧に並び（親の下）、最初の指示で動き出す。親は子の一覧を読める

const PARENT = '子セッションに任せてください';
const CHILD = '子の作業として、返事だけしてください';
const CHILD_NAME = '子の作業';
const CHILD_REPLY = '子の返事です';
const PARENT_DONE = '子を始めました';

describe('Claude がセッションの MCP で子セッションを始める', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: PARENT,
          steps: [
            [{ type: 'tool_use', id: 'toolu_start', name: sessionToolId('start_session'), input: { prompt: CHILD, worktree: false, name: CHILD_NAME } }],
            [{ type: 'tool_use', id: 'toolu_list', name: sessionToolId('list_sessions'), input: {} }],
            [{ type: 'text', text: PARENT_DONE }],
          ],
        },
        { match: CHILD, steps: [[{ type: 'text', text: CHILD_REPLY }]] },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`sessions-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('子セッションを始める前に、許可の確認がカードで出る', async () => {
    await app.startSession(PARENT, { mode: 'manual' });
    const card = await app.menuCard('permission');
    expect(await card.textContent()).toContain(CHILD);
    await app.choose(card, /^Yes/);
  });

  it('子は一覧に並び、親は子の一覧を読める', async () => {
    await app.byText('.chat-list', PARENT_DONE).waitFor();
    await app.byText('.session-list .session-row', CHILD_NAME).waitFor();
    expect(app.api.toolResults.some((r) => r.includes(CHILD_NAME))).toBe(true);
  });

  it('子を開くと、最初の指示で動いた返事が出ている', async () => {
    await app.byText('.session-list .session-row', CHILD_NAME).click();
    await app.byText('.claude-header .claude-title', CHILD_NAME).waitFor();
    await app.byText('.chat-list', CHILD).waitFor();
    await app.byText('.chat-list', CHILD_REPLY).waitFor();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
