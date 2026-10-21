import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、リンクを通したフォルダ（/tmp で始めたときのように、実体は別のパス）で始めたセッションでも、
// 会話ログを見つけてチャットに出せるかを確かめる。Claude Code は、リンクを解いた実体のパスの名前のフォルダに会話ログを書く

const PROMPT = 'リンクのフォルダで話します';
const REPLY = 'リンクのフォルダからの返事';

const version = claudeVersion();

describe(`Claude Code ${version} のリンクを通したフォルダ`, () => {
  let api: MockApi;
  let run: ClaudeRun;

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [{ match: PROMPT, steps: [[{ type: 'text', text: REPLY }]] }];
    run = new ClaudeRun(await api.start(), { linkedCwd: true });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('発言と返事がチャットに出る', async () => {
    await run.send(PROMPT);
    await run.waitUntil('返事', () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === REPLY), 30_000);
    expect(run.chatEvents.some((e) => e.type === 'user' && e.text === PROMPT)).toBe(true);
  });
});
