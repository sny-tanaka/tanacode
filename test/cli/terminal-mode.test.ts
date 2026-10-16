import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、チャット（stream-json）とターミナルモード（TUI）を行き来できるかを確かめる（設計書 9 節）。
// 行き来はどちら向きも、今の claude を止めて、もう片方で --resume する。会話は続く

const PROMPT = 'ターミナルモードを試します';
const REPLY = 'ターミナルモードの前の返事';
const AFTER = 'チャットに戻ってからの発言です';
const AFTER_REPLY = 'チャットに戻ってからの返事';

describe(`Claude Code ${claudeVersion()} のターミナルモード`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const idle = (label: string) => run.untilState(label, (state) => state === 'idle', 30_000);

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [{ match: PROMPT, steps: [[{ type: 'text', text: REPLY }], [{ type: 'text', text: AFTER_REPLY }]] }];
    // 信頼していないフォルダでは、TUI が信頼を確かめる（チャットは確かめない。決めたこと）。人が画面で答えるところなので、ここでは信頼済みにする
    run = new ClaudeRun(await api.start(), { trusted: true });
    await run.open();
    await run.send(PROMPT);
    await run.waitUntil('返事', () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === REPLY), 30_000);
    await idle('待機中');
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('ターミナルモードにすると、TUI を --resume で起動し、前の会話を画面に描く', async () => {
    await run.manager.setTerminalMode(run.sessionId!, true);
    expect(run.manager.stateOf(run.sessionId!)).toBe('terminal');
    await run.waitUntil('TUI の画面に前の会話', () => run.ptyOutput.includes(REPLY), 30_000);
  });

  it('チャットに戻すと、stream-json を --resume で起動し、会話が続く', async () => {
    await run.manager.setTerminalMode(run.sessionId!, false);
    await idle('チャットで待機中');
    await run.send(AFTER);
    await run.waitUntil('戻ってからの返事', () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === AFTER_REPLY), 30_000);
    expect(api.lastPrompts.find((p) => p.includes(AFTER))).toBeDefined();
  });
});
