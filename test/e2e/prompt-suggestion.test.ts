import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// ターンの終わりに Claude Code が予想した次の発言（prompt_suggestion）を、入力欄の上のボタンで出す。
// 予想は、Claude Code がターンの終わりに API を呼んで作る（モックの API は、台本の suggestion を返す）。
// 応答が 2 つ未満の会話では作らない（2.1.314 の early_conversation）ので、ツールを 1 回呼んでから答える
const PROMPT = '次の返信の候補を確かめてください';
const ANSWER = '確かめました';
const SUGGESTION = 'テストも足してください';

describe('次の返信の候補', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      conversations: () => [
        {
          match: PROMPT,
          steps: [[{ type: 'tool_use', id: 'toolu_glob', name: 'Glob', input: { pattern: '*' } }], [{ type: 'text', text: ANSWER }]],
          suggestion: SUGGESTION,
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`prompt-suggestion-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('ターンが終わると入力欄の上に候補が出て、押すと入力欄に入る。打つと隠れる', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', ANSWER).waitFor();
    const button = app.page.locator('.chat-input .prompt-suggestion');
    await button.waitFor();
    expect(await button.textContent()).toContain(SUGGESTION);
    expect(app.api.suggestionRequests).toBe(1);
    await button.click();
    expect(await app.page.inputValue('.chat-input textarea')).toBe(SUGGESTION);
    // 入力欄に文があるときは出さない
    expect(await button.count()).toBe(0);
    await app.page.fill('.chat-input textarea', '');
    await button.waitFor();
  });
});
