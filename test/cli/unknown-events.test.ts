import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UnknownEvent } from '@shared/unknown-event';
import { unreadableStreamLines } from '../scenario';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、アプリの知らない行が、捨てられずに未知のイベントとしてチャットに届くかを確かめる。
// モックの API が、アプリの読まないブロック（サーバーのツールの server_tool_use と web_search_tool_result。本物の API が返す形）を
// 応答に混ぜると、Claude Code はそのまま会話ログに書く（2.1.302 で実測）。アプリは、それを未知のイベントにする

const PROMPT = '未知のイベントを確かめます';
const version = claudeVersion();

describe(`Claude Code ${version} の、アプリの知らない行`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const unknowns = (): UnknownEvent[] => run.chatEvents.filter((e): e is UnknownEvent => e.type === 'unknown-event');

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [
      {
        match: PROMPT,
        steps: [
          [
            { type: 'raw', block: { type: 'server_tool_use', id: 'srvtoolu_check', name: 'web_search', input: {} } },
            {
              type: 'raw',
              block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_check', content: [{ type: 'web_search_result', title: 'tanacode', url: 'https://example.com/', encrypted_content: 'x', page_age: null }] },
            },
            { type: 'text', text: '調べました' },
          ],
        ],
      },
    ];
    // この台本は、知らないブロックをわざと出させる（終わるときの、知らない種類の確かめで数えない）
    run = new ClaudeRun(await api.start(), { unknown: ['assistant/server_tool_use', 'assistant/web_search_tool_result'] });
    await run.open();
    await run.send(PROMPT);
    await run.waitUntil('返事', () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === '調べました'), 30_000);
    await run.waitUntil('手が空く', () => run.idle, 30_000);
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('会話ログに書かれた知らないブロックが、未知のイベントとしてチャットに届く。種類・会話ログから来たこと・バージョン・生の行が付く', () => {
    expect(unknowns().map((e) => [e.name, e.problem, e.source, e.version])).toEqual([
      ['assistant/server_tool_use', 'unknown', 'transcript', version],
      ['assistant/web_search_tool_result', 'unknown', 'transcript', version],
    ]);
    expect(JSON.parse(unknowns()[0].raw)).toMatchObject({ type: 'server_tool_use', id: 'srvtoolu_check' });
    // 画面が持つチャット（snapshot）にも入る
    expect(run.chat().filter((e) => e.type === 'unknown-event')).toHaveLength(2);
  });

  it('未知のイベントでターンは始まらず、ふつうに終わって待機中に戻る', async () => {
    expect(run.chatEvents.filter((e) => e.type === 'user')).toHaveLength(1);
    await run.waitUntil('ターンの終わり', () => run.chatEvents.some((e) => e.type === 'turn-end'));
    await run.waitUntil('待機中', () => run.manager.liveSessions()[0]?.state === '待機中');
  });

  it('stream-json の行は、どれも知っている（このやりとりでは、未知のイベントは会話ログからだけ）', () => {
    expect(unreadableStreamLines(run.streamLines())).toEqual({ malformed: 0, unknown: {} });
  });
});
