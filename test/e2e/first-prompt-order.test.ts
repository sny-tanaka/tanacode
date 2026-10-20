import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sessionToolId } from '@shared/session-tools';
import { E2EApp } from './app';

// 親の Claude が子を始めた直後（子の Claude Code が起動を終える前）に send_message で指示を送っても、子には start_session の
// 最初の指示が先に届く（どちらも、子が受け付けられるようになるのを待って送る。待ち始めた順に送る）

const PARENT = '子を始めて、すぐ続きも頼んでください（ORDER）';
const CHILD = '最初の指示です（ORDER の子）';
const CHILD_NAME = '順番を確かめる子';
const NEXT = '続きの指示です';

describe('子を始めた直後に送った指示も、最初の指示のあとに届く', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        { match: PARENT, steps: [[{ type: 'tool_use', id: 'toolu_start', name: sessionToolId('start_session'), input: { prompt: CHILD, worktree: false, name: CHILD_NAME } }]] },
        { match: CHILD, steps: [[{ type: 'text', text: '最初の指示に答えました' }], [{ type: 'text', text: '続きの指示に答えました' }]] },
      ],
    });
    // 子を始めた結果を受けたら、すぐ（子が起動を終える前に）続きの指示を送る
    let sent = false;
    app.api.intercept = (_prompt, results) => {
      if (sent && results.length > 0) return [{ type: 'text', text: '子に頼みました' }];
      const child = results.find((r) => r.includes('"permission_mode"'))?.match(/"session_id":\s*"([0-9a-f-]{36})"/)?.[1];
      if (!child) return null;
      sent = true;
      return [{ type: 'tool_use', id: 'toolu_send', name: sessionToolId('send_message'), input: { session_id: child, message: NEXT } }];
    };
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`first-prompt-order-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('親が子を始め、すぐ続きの指示を送る', async () => {
    await app.startSession(PARENT, { mode: 'manual' });
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', '子に頼みました').waitFor();
  });

  it('子には、最初の指示が先に届き、続きの指示はそのあとに届く', async () => {
    await app.byText('.session-list .session-row', CHILD_NAME).click();
    await app.byText('.claude-header .claude-title', CHILD_NAME).waitFor();
    await app.byText('.chat-list', NEXT).waitFor();
    await app.byText('.statusbar', 'Claude Code 待機中').waitFor();
    // 直す前は、続きの指示が、見直しの間合いで最初の指示を追い越して先に届くことがあった（子は、最初の指示の前に続きを始める）
    const order = await app.page.locator('.chat-list .chat-user.from-parent').allInnerTexts();
    expect(order.map((text) => (text.includes(CHILD) ? 'first' : text.includes(NEXT) ? 'next' : text))).toEqual(['first', 'next']);
    const firstCall = app.api.lastPrompts.findIndex((p) => p.includes(CHILD) || p.includes(NEXT));
    expect(app.api.lastPrompts[firstCall]).toContain(CHILD);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
