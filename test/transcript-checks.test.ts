import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import { checkTranscript, type NumberedEntry } from './transcript-checks';

// 本物の会話ログで確かめる決まり（test/transcript-checks.ts。npm run check:transcripts が、手元の会話ログに流す）。
// 行の形は、Claude Code 2.1.302 の会話ログ（裏のサブエージェントを起動して、API の要求の控えに結果の写しが書かれたもの）に合わせた

const CWD = '/work/app';
const numbered = (...entries: TranscriptEntry[]): NumberedEntry[] => entries.map((entry, i) => ({ entry, line: i + 1 }));

const AGENT_INPUT = { description: '調べもの', prompt: '…', subagent_type: 'general-purpose', run_in_background: true };
const launch = (uuid = 'u2'): TranscriptEntry => ({
  type: 'user',
  uuid,
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] as never },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1', description: '調べもの' },
});
const LINES: TranscriptEntry[] = [
  { type: 'user', uuid: 'u1', message: { content: '調べて' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: AGENT_INPUT }] } },
  launch(),
  // API の要求の控え。前の呼び出しと結果の写しが、toolUseResult なしで入る
  { type: 'api-request-blob', hash: 'h1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: AGENT_INPUT }] } } as TranscriptEntry,
  { type: 'api-request-blob', hash: 'h2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'Async agent launched successfully.' }] } } as TranscriptEntry,
  { type: 'assistant', uuid: 'a2', message: { id: 'm2', content: [{ type: 'text', text: '待ちます' }] } },
];
const NOTICE: TranscriptEntry = {
  type: 'user',
  uuid: 'u9',
  origin: { kind: 'task-notification' },
  message: { content: '<task-notification>\n<tool-use-id>toolu_agent</tool-use-id>\n<status>completed</status>\n<result>結果</result>\n</task-notification>' },
};

describe('checkTranscript', () => {
  it('ふつうの会話ログ（控えの行つき）では、決まりを破らない。控えの行のツールの写しは、意図して捨てる行として知らせる', () => {
    const check = checkTranscript(numbered(...LINES, NOTICE), { cwd: CWD, agentLog: false });
    expect(check).toMatchObject({ lines: 7, unknown: new Map(), duplicateResults: [], earlyFinish: [] });
    expect(check.toolBlocksOutside).toEqual(new Map([['api-request-blob', { count: 2, line: 4, ignored: true }]]));
  });

  it('会話の行として読まれた結果の写しで、裏のサブエージェントが完了の知らせより前に終わったら、決まりを破ったとして返す', () => {
    // 2.1.301 の控えの行を、会話の行と読み違えたときと同じ（toolUseResult の無い、同じ呼び出しの結果）
    const copy: TranscriptEntry = { type: 'user', uuid: 'u3', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'Async agent launched successfully.' }] } };
    const check = checkTranscript(numbered(...LINES, copy, NOTICE), { cwd: CWD, agentLog: false });
    expect(check.earlyFinish).toEqual([{ toolUseId: 'toolu_agent', kind: 'subagent', line: 7, state: 'done' }]);
    expect(check.duplicateResults).toEqual([{ toolUseId: 'toolu_agent', lines: [3, 7] }]);
  });

  it('同じ uuid の行の書き直しは、結果を 1 つと数える', () => {
    expect(checkTranscript(numbered(...LINES, launch(), NOTICE), { cwd: CWD, agentLog: false }).duplicateResults).toEqual([]);
  });

  it('知らない種類（行・ブロック）を数え、最初の行を添える。知らない行のツールの写しは、意図して捨てる行でないものとして知らせる', () => {
    const check = checkTranscript(
      numbered(
        { type: 'user', uuid: 'u1', message: { content: 'はじめ' } },
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'server_tool_use', id: 's1' }] } },
        { type: 'brand-new', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } } as TranscriptEntry,
        { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'server_tool_use', id: 's2' }] } },
      ),
      { cwd: CWD, agentLog: false },
    );
    expect(check.unknown).toEqual(
      new Map([
        ['assistant/server_tool_use', { count: 2, line: 2 }],
        ['brand-new', { count: 1, line: 3 }],
      ]),
    );
    expect(check.toolBlocksOutside).toEqual(new Map([['brand-new', { count: 1, line: 3, ignored: false }]]));
  });

  it('エージェントの会話ログ: サイドチェーンの行もチャットに組み立てて見る。裏のタスクの追跡には渡さない', () => {
    const side = (entry: TranscriptEntry): TranscriptEntry => ({ ...entry, isSidechain: true });
    const lines = numbered(...LINES.map(side), side({ type: 'system', subtype: 'brand_new', uuid: 's1' }));
    const check = checkTranscript(lines, { cwd: CWD, agentLog: true });
    expect([...check.unknown.keys()]).toEqual(['system/brand_new']);
    expect(check.earlyFinish).toEqual([]);
    // 本体の会話ログとして読むと、サイドチェーンの行はチャットに出さない
    expect(checkTranscript(lines, { cwd: CWD, agentLog: false }).unknown).toEqual(new Map());
  });
});
