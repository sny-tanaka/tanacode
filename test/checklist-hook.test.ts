import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKLIST_REMINDER_TAG, checklistToolId } from '../src/shared/checklist-tools';
import { CHECKLIST_SESSION_ENV, CHECKLIST_SOCKET_ENV, checklistHookEnv, checklistHookEvent, checklistHookRequest } from '../src/main/checklist-bridge';
import { CHECKLIST_HOOK_COMMAND, checklistHooks, hookOutput, readTail, runHook, turnActivity } from '../src/main/checklist-hook';
import { McpBridge, textResult } from '../src/main/mcp-bridge';

// チェックリストを使い続けさせるフック（src/main/checklist-hook.ts）。会話ログからツールを数え、アプリに聞いて、Claude Code に返す。
// 何を渡すか・止めるかは test/checklist-reminder.test.ts、本物の Claude Code での動きは test/cli/checklist-hooks.test.ts

const prompt = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...extra });
const use = (...names: string[]) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'やります' }, ...names.map((name) => ({ type: 'tool_use', name }))] } });
const result = () => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' }] } });
const CARD_CHECK = checklistToolId('card_check');
// Stop のフックが止めた理由は、isMeta の user の行で残る（2.1.296）
const reminded = () => prompt(`Stop hook feedback:\n<${CHECKLIST_REMINDER_TAG}>\n…\n</${CHECKLIST_REMINDER_TAG}>`, { isMeta: true });

describe('会話ログからツールを数える', () => {
  it('このターン（最後の発言のあと）のツールと、そのうちチェックリストのツールを数える', () => {
    const log = [prompt('前の依頼'), use('Edit'), result(), prompt('今の依頼'), use('Read', 'Bash'), result(), use(CARD_CHECK), result(), use('Edit')].join('\n');
    expect(turnActivity(log)).toEqual({ turn: 3, checklist: 1, actions: 1 });
  });

  it('最後にチェックリストに触れてからの、何かを変えうるツールを、前のターンにさかのぼって数える。読むだけのツールは数えない', () => {
    const log = [prompt('a'), use('Edit'), use(CARD_CHECK), use('Write'), result(), prompt('b'), use('Bash', 'Read', 'Grep'), result(), prompt('c'), use('Edit', 'mcp__tanacode-browser__click', 'Glob')].join('\n');
    expect(turnActivity(log)).toEqual({ turn: 3, checklist: 0, actions: 4 });
  });

  it('ターンの終わりに知らせを受けたところも、チェックリストに触れたところとして数え直す', () => {
    const log = [prompt('a'), use('Edit', 'Edit', 'Edit'), reminded(), use('Read'), prompt('b'), use('Bash')].join('\n');
    expect(turnActivity(log)).toEqual({ turn: 1, checklist: 0, actions: 1 });
  });

  it('Claude Code が足した行（isMeta・圧縮の要約・会話ログだけの行）とサブエージェントの行は、発言にもツールにも数えない', () => {
    const log = [
      prompt('依頼'),
      use('Edit'),
      prompt('要約', { isCompactSummary: true }),
      prompt('メタ', { isMeta: true }),
      prompt('ログだけ', { isVisibleInTranscriptOnly: true }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '画像つきの発言' }] } }),
      use('Write'),
      '',
      '{ 壊れた行',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }),
      JSON.stringify({ type: 'system' }),
    ].join('\n');
    expect(turnActivity(log)).toEqual({ turn: 1, checklist: 0, actions: 2 });
    expect(turnActivity('')).toEqual({ turn: 0, checklist: 0, actions: 0 });
  });
});

describe('会話ログの終わりを読む', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-hook-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('小さければ全部、大きければ終わりの部分だけを読み、途中から始まる行は捨てる。読めなければ空', () => {
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, 'いちばん上の行\n2 行め\n3 行め\n');
    expect(readTail(file)).toBe('いちばん上の行\n2 行め\n3 行め\n');
    expect(readTail(file, 14)).toBe('3 行め\n');
    expect(readTail(join(dir, 'ありません.jsonl'))).toBe('');
  });
});

describe('Claude Code に返すもの', () => {
  it('Stop はターンの終わりを止めて理由を渡し、ほかは文をコンテキストに足す', () => {
    expect(JSON.parse(hookOutput('Stop', '直して'))).toEqual({ decision: 'block', reason: '直して' });
    expect(JSON.parse(hookOutput('UserPromptSubmit', '今の状態'))).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '今の状態' } });
  });

  it('設定には、人の発言・ターンの終わり・圧縮のあとの 3 つを足す。コマンドには、チャットに出さないための目印を付ける', () => {
    const hooks = [{ type: 'command', command: CHECKLIST_HOOK_COMMAND, timeout: 10 }];
    expect(checklistHooks()).toEqual({ UserPromptSubmit: [{ hooks }], Stop: [{ hooks }], SessionStart: [{ matcher: 'compact', hooks }] });
    expect(CHECKLIST_HOOK_COMMAND).toBe('TANACODE_CHECKLIST_HOOK=1 ELECTRON_RUN_AS_NODE=1 "$TANACODE_CHECKLIST_COMMAND" "$TANACODE_CHECKLIST_SCRIPT" --hook');
  });

  it('フックが使う環境変数と、アプリへの呼び出しの名前', () => {
    const launch = { command: '/Apps/tanacode Helper', script: '/Apps/out/main/checklist-mcp.js', socketPath: '/u/checklist.sock', version: '1.0.0' };
    expect(checklistHookEnv(launch, 's1')).toEqual({
      [CHECKLIST_SOCKET_ENV]: '/u/checklist.sock',
      [CHECKLIST_SESSION_ENV]: 's1',
      TANACODE_CHECKLIST_COMMAND: '/Apps/tanacode Helper',
      TANACODE_CHECKLIST_SCRIPT: '/Apps/out/main/checklist-mcp.js',
    });
    for (const event of ['prompt', 'stop', 'compact'] as const) expect(checklistHookEvent(checklistHookRequest(event))).toBe(event);
    expect(checklistHookEvent('hook:other')).toBeNull();
    expect(checklistHookEvent('card_add')).toBeNull();
  });
});

describe('フックの本体', () => {
  let dir: string;
  let bridge: McpBridge;
  let calls: { session: string; tool: string; args: Record<string, unknown> }[];
  let answer: () => ReturnType<typeof textResult>;
  let socket: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-hook-'));
    calls = [];
    answer = () => textResult('今のチェックリスト');
    bridge = new McpBridge(join(dir, 'c.sock'), async (session, tool, args) => {
      calls.push({ session, tool, args });
      return answer();
    });
    await bridge.start();
    socket = bridge.socketPath;
  });
  afterEach(() => {
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const transcript = (...lines: string[]) => {
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, lines.join('\n'));
    return file;
  };
  const run = (input: Record<string, unknown>) => runHook(JSON.stringify(input), socket, 'S1', 2000);

  it('人の発言と圧縮のあとは、アプリが返した文をコンテキストに足す', async () => {
    expect(JSON.parse(await run({ hook_event_name: 'UserPromptSubmit' }))).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '今のチェックリスト' } });
    expect(JSON.parse(await run({ hook_event_name: 'SessionStart' }))).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '今のチェックリスト' } });
    expect(calls).toEqual([
      { session: 'S1', tool: 'hook:prompt', args: { turn: 0, checklist: 0, actions: 0 } },
      { session: 'S1', tool: 'hook:compact', args: { turn: 0, checklist: 0, actions: 0 } },
    ]);
  });

  it('ターンの終わりは、会話ログから数えたツールをアプリに渡し、返ってきた文で止める', async () => {
    const transcript_path = transcript(prompt('依頼'), use('Edit', 'Bash'), result());
    expect(JSON.parse(await run({ hook_event_name: 'Stop', transcript_path }))).toEqual({ decision: 'block', reason: '今のチェックリスト' });
    expect(calls).toEqual([{ session: 'S1', tool: 'hook:stop', args: { turn: 2, checklist: 0, actions: 2 } }]);
  });

  it('止めたあとの続き・チェックリストに触れたターン・ツールを使っていないターンは、アプリに聞かずに通す', async () => {
    const worked = transcript(prompt('依頼'), use('Edit'));
    expect(await run({ hook_event_name: 'Stop', transcript_path: worked, stop_hook_active: true })).toBe('');
    expect(await run({ hook_event_name: 'Stop', transcript_path: transcript(prompt('依頼'), use('Edit', CARD_CHECK)) })).toBe('');
    expect(await run({ hook_event_name: 'Stop', transcript_path: transcript(prompt('質問')) })).toBe('');
    expect(await run({ hook_event_name: 'Stop' })).toBe('');
    expect(calls).toEqual([]);
  });

  it('アプリが何も返さない・エラーを返す・文でないものを返す・つながらないときは、何も出さない', async () => {
    answer = () => textResult('');
    expect(await run({ hook_event_name: 'UserPromptSubmit' })).toBe('');
    answer = () => textResult('失敗しました', true);
    expect(await run({ hook_event_name: 'UserPromptSubmit' })).toBe('');
    answer = () => ({ content: [{ type: 'image', data: '', mimeType: 'image/png' }] });
    expect(await run({ hook_event_name: 'UserPromptSubmit' })).toBe('');
    answer = () => ({ content: [] });
    expect(await run({ hook_event_name: 'UserPromptSubmit' })).toBe('');
    socket = join(dir, 'ありません.sock');
    expect(await run({ hook_event_name: 'UserPromptSubmit' })).toBe('');
  });

  it('知らないイベント・読めない入力は、何も出さない', async () => {
    expect(await run({ hook_event_name: 'PreToolUse' })).toBe('');
    expect(await run({})).toBe('');
    expect(await runHook('{ 壊れた入力', socket, 'S1', 2000)).toBe('');
    expect(calls).toEqual([]);
  });
});
