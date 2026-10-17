import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、チャット（stream-json）とターミナルモード（TUI）を行き来できるかを確かめる（設計書 9 節）。
// 行き来はどちら向きも、今の claude を止めて、もう片方で --resume する。会話は続く。
// ターミナルモードの中身（TUI）は Claude Code そのものなので、画面は読まない・キーは押さない（決めたこと）。確かめるのは切り替えだけ

const PROMPT = 'ターミナルモードを試します';
const REPLY = 'ターミナルモードの前の返事';
const AFTER = 'チャットに戻ってからの発言です';
const AFTER_REPLY = 'チャットに戻ってからの返事';

describe(`Claude Code ${claudeVersion()} のターミナルモード`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  let transcript: string;
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
    transcript = run.transcript();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('ターミナルモードにすると、同じ会話を --resume して TUI を起動する。TUI は起動を終える（アプリの statusLine を動かす）', async () => {
    const from = Date.now();
    await run.manager.setTerminalMode(run.sessionId!, true);
    expect(run.manager.stateOf(run.sessionId!)).toBe('terminal');
    const args = run.tuiArgs.at(-1)!;
    expect(args[args.indexOf('--resume') + 1]).toBe(run.claudeSessionId);
    await run.waitUntil('TUI の statusLine', () => (run.statusLine?.updatedAt ?? 0) >= from, 30_000);
    expect(run.manager.stateOf(run.sessionId!)).toBe('terminal');
  });

  it('チャットに戻すと、stream-json を --resume で起動し、会話が続く', async () => {
    await run.manager.setTerminalMode(run.sessionId!, false);
    await idle('チャットで待機中');
    await run.send(AFTER);
    await run.waitUntil('戻ってからの返事', () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === AFTER_REPLY), 30_000);
    expect(api.lastPrompts.find((p) => p.includes(AFTER))).toBeDefined();
    // 同じ会話ログに続いている
    expect(run.transcript()).toBe(transcript);
    const log = readFileSync(transcript, 'utf8');
    expect(log).toContain(REPLY);
    expect(log).toContain(AFTER_REPLY);
  });
});
