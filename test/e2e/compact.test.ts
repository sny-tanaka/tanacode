import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// チャットのヘッダーの「圧縮」の最適化圧縮。▾ で切り替えて押すと、アプリが使い捨ての claude（-p の Haiku）に今のコンテキストの行を渡し、
// 返った印から作った指示を添えて、セッションの Claude Code に /compact を送るか。Haiku もセッションも、同じモックの API に届く

const PROMPT = '圧縮を試すために返事をしてください';
const REPLY = '返事をしました';

describe('最適化圧縮', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        { match: PROMPT, steps: [[{ type: 'text', text: REPLY }]] },
        // Haiku への頼み（optimizerPrompt）。1 番目の行（はじめの発言のやりとり）を残すと答える。
        // 頼みには発言の文も入るので、モックがこちらを選ぶよう、頼みのいちばん後ろに出てくる文字で選ぶ
        {
          match: '</item>',
          steps: [[{ type: 'tool_use', id: 'toolu_marks', name: 'StructuredOutput', input: { marks: [{ id: '1', mark: 'keep' }] } }], [{ type: 'text', text: 'done' }]],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`compact-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('▾ で最適化圧縮に切り替えて押すと、Haiku が選んだ指示を添えて /compact を送る', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', REPLY).waitFor();
    await app.page.click('.claude-header button[aria-label="圧縮のしかたを選ぶ"]');
    await app.page.click('.compact-menu [role="menuitemradio"]:has-text("最適化圧縮")');
    await app.page.click('.claude-header button[aria-label="最適化圧縮"]:not([disabled])');
    // Haiku には、指示の文（システムの文）と、今のコンテキストの行が渡る
    await app.waitUntil('Haiku に頼む', () => app.api.systems.some((s) => s.includes("You decide what a coding agent's context keeps")));
    expect(app.api.contexts.some((c) => c.includes(`label="${PROMPT}"`))).toBe(true);
    // セッションの要約の頼みに、Haiku の印から作った指示が入る
    await app.waitUntil('指示を添えた /compact', () =>
      app.api.lastPrompts.some((p) => p.includes(`Additional Instructions:\n「${PROMPT}」から始まるやりとりは詳しく残す。`)),
    );
    await app.byText('.chat-list', '会話を圧縮しました').waitFor();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
