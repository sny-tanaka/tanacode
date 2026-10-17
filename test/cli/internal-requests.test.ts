import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StreamClient } from '../../src/main/stream/client';
import { disableRemoteControl, enableRemoteControl, endSession, generateTitle, rewindConversation, unsupported } from '../../src/main/stream/internal';
import { AI_TITLE, AI_TITLE_REPLY } from '../scenarios/input';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、アプリが使う Claude Code の内部の制御の要求（公開の Agent SDK の型に無いもの。
// src/main/stream/internal.ts）に、受け口があるかを確かめる（設計書 12・14 節）。バージョンで変わる・消えるおそれがいちばん大きいので、
// 毎日の確認（claude-code-check.yml）で、新しい Claude Code でも「Unsupported control request subtype」で断られないことを見る。
// Remote Control は claude.ai へのログインが要るので、つなげるかまでは見ない（モックの API では、理由つきで断られる）

const PROMPT = '内部の要求を確かめます';

describe(`Claude Code ${claudeVersion()} の内部の制御の要求`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const client = (): StreamClient => run.manager['runtimes'].get(run.sessionId!)!.process!.client!;
  // 受け口が無いときだけ失敗にする（Claude Code が理由を付けて断るのはかまわない）
  const answered = async <T>(request: () => Promise<T>): Promise<T | null> => {
    try {
      return await request();
    } catch (error) {
      expect(unsupported(error), String(error)).toBe(false);
      return null;
    }
  };

  beforeAll(async () => {
    api = new MockApi();
    api.plainReplies = [AI_TITLE_REPLY];
    api.conversations = [{ match: PROMPT, steps: [[{ type: 'text', text: '確かめました' }]] }];
    run = new ClaudeRun(await api.start());
    await run.open();
    await run.send(PROMPT);
    await run.waitUntil('返事', () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === '確かめました'), 30_000);
    await run.waitUntil('手が空く', () => run.idle, 30_000);
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('remote_control（つなぐ・切る）の受け口がある', async () => {
    await answered(() => enableRemoteControl(client(), 'tanacode-check'));
    await answered(() => disableRemoteControl(client()));
  });

  it('generate_session_title の受け口があり、タイトルを返す', async () => {
    expect(await answered(() => generateTitle(client(), PROMPT))).toBe(AI_TITLE);
  });

  it('rewind_conversation の受け口がある（知らない発言を指すと、巻き戻さずに理由を返す）', async () => {
    const result = await answered(() => rewindConversation(client(), '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001'));
    if (result) expect(result.rewound).toBe(false);
  });

  it('end_session の受け口があり、Claude Code が終わる', async () => {
    await answered(() => endSession(client()));
    await run.waitUntil('終了', () => run.chatEvents.at(-1)?.type === 'process-exit', 10_000);
  });
});
