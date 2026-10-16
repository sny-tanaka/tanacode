import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answerText, questionReplyOf } from '@shared/questions';
import { McpBridge, textResult } from '../src/main/mcp-bridge';
import { PendingQuestions } from '../src/main/pending-questions';
import { chatMessage, questionHookOutput, QUESTION_WAIT_REQUEST, readHookInput, readReply, runQuestionHook } from '../src/main/question-hook';
import { QUESTION } from './scenario';
import { ASK_TABS } from './scenarios/questions';

// AskUserQuestion の質問のフック（question-hook.ts）と、アプリが待っている質問（pending-questions.ts）・答えの文（@shared/questions）

const INPUT = { questions: [QUESTION], metadata: { source: 'test' } };
const hookInput = (input: unknown, tool = 'AskUserQuestion') => JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input });

describe('フックの出力', () => {
  it('答えは allow と、入力に answers を足したもの（ほかの項目はそのまま返す）', () => {
    expect(JSON.parse(questionHookOutput(INPUT, { kind: 'answer', answers: { [QUESTION.question]: 'です・ます' } }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...INPUT, answers: { [QUESTION.question]: 'です・ます' } } } },
    });
  });

  it('Chat about this は、画面で選んだときと同じ文で断る。キャンセルは、作業を止めて断る。返事が無ければ何も出さない', () => {
    const chat = JSON.parse(questionHookOutput({ questions: ASK_TABS }, { kind: 'chat' })) as { hookSpecificOutput: { decision: Record<string, unknown> } };
    expect(chat.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: chatMessage(ASK_TABS.map((q) => q.question)) });
    // 画面で選んだときの文（Claude Code 2.1.296 の会話ログ。質問が 2 つ以上の形は test/cli/question-hook.test.ts が本物と比べる）
    expect(chatMessage([QUESTION.question])).toBe(
      'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nThe user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n- "どちらの書き方にしますか？"\n  (No answer provided)',
    );
    const cancel = JSON.parse(questionHookOutput(INPUT, { kind: 'cancel' })) as { hookSpecificOutput: { decision: Record<string, unknown> } };
    expect(cancel.hookSpecificOutput.decision).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(questionHookOutput(INPUT, null)).toBe('');
  });

  it('標準入力と、アプリの返事を読む。読めないものは null', () => {
    expect(readHookInput(hookInput(INPUT))).toEqual({ tool: 'AskUserQuestion', input: INPUT });
    expect(readHookInput('{')).toBeNull();
    expect(readHookInput(JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: [] }))).toBeNull();
    expect(readReply(textResult(JSON.stringify({ kind: 'answer', answers: { a: 'b', c: 1 } })))).toEqual({ kind: 'answer', answers: { a: 'b' } });
    expect(readReply(textResult(JSON.stringify({ kind: 'chat' })))).toEqual({ kind: 'chat' });
    expect(readReply(textResult(JSON.stringify({ kind: 'none' })))).toBeNull();
    expect(readReply(textResult('x'))).toBeNull();
    expect(readReply(textResult(JSON.stringify({ kind: 'chat' }), true))).toBeNull();
    expect(readReply({ content: [] })).toBeNull();
    expect(questionReplyOf({ kind: 'answer', answers: ['x'] })).toBeNull();
    expect(questionReplyOf(null)).toBeNull();
  });
});

describe('フックとアプリのやりとり（runQuestionHook）', () => {
  let dir: string | null = null;
  let bridge: McpBridge | null = null;
  afterEach(() => {
    bridge?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    bridge = null;
    dir = null;
  });
  const listen = async (handler: ConstructorParameters<typeof McpBridge>[1]) => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-question-test-'));
    bridge = new McpBridge(join(dir, 'question.sock'), handler);
    await bridge.start();
    return bridge.socketPath;
  };

  it('アプリに質問の入力を渡して返事を待ち、Claude Code に返す JSON にする', async () => {
    const calls: unknown[] = [];
    const socket = await listen(async (session, tool, args) => {
      calls.push({ session, tool, args });
      return textResult(JSON.stringify({ kind: 'answer', answers: { [QUESTION.question]: 'だ・である' } }));
    });
    const output = await runQuestionHook(socket, 's-1', 5000, hookInput(INPUT));
    expect(calls).toEqual([{ session: 's-1', tool: QUESTION_WAIT_REQUEST, args: { input: INPUT } }]);
    expect(JSON.parse(output)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow', updatedInput: { answers: { [QUESTION.question]: 'だ・である' } } } } });
  });

  it('アプリが待つのをやめた・アプリにつながらない・ほかのツールや形の違う入力では、何も出さない', async () => {
    const socket = await listen(async () => textResult(JSON.stringify({ kind: 'none' })));
    expect(await runQuestionHook(socket, 's-1', 5000, hookInput(INPUT))).toBe('');
    expect(await runQuestionHook(join(dir!, 'missing.sock'), 's-1', 5000, hookInput(INPUT))).toBe('');
    expect(await runQuestionHook(socket, 's-1', 5000, hookInput(INPUT, 'Bash'))).toBe('');
    expect(await runQuestionHook(socket, 's-1', 5000, hookInput({ questions: 'x' }))).toBe('');
  });
});

describe('待っている質問（PendingQuestions）', () => {
  it('来た順に持ち、いちばん前を返す。前を答えると、次が前になる。待つ前につながりが切れていたら、待たない', async () => {
    const changed: string[] = [];
    const pending = new PendingQuestions((id) => changed.push(id));
    const first = pending.wait('s', [QUESTION], new AbortController().signal);
    const second = pending.wait('s', ASK_TABS, new AbortController().signal);
    const firstId = pending.first('s')!.id;
    expect(pending.first('s')?.questions).toEqual([QUESTION]);
    expect(pending.reply('s', firstId, { kind: 'chat' })).toBe(true);
    expect(await first).toEqual({ kind: 'chat' });
    expect(pending.first('s')?.questions).toEqual(ASK_TABS);
    pending.releaseAll('s');
    expect(await second).toBeNull();
    expect(pending.first('s')).toBeNull();
    expect(changed).toEqual(['s', 's', 's', 's']);
    const aborted = new AbortController();
    aborted.abort();
    expect(await pending.wait('s', [QUESTION], aborted.signal)).toBeNull();
    expect(pending.first('s')).toBeNull();
    expect(pending.reply('s', 'nope', { kind: 'chat' })).toBe(false);
    expect(pending.answerOne('s', 'nope', QUESTION.question, 'x')).toBeNull();
  });
});

describe('答えの文（answerText）', () => {
  it('画面で答えたときと同じ形: 選んだ選択肢を選択肢の順に「, 」でつなぎ、自由記述は最後に足す。改行はそのまま', () => {
    const languages = ASK_TABS[1];
    expect(answerText(languages, ['Go', 'TypeScript'], 'Zig')).toBe('TypeScript, Go, Zig');
    expect(answerText(languages, [], '  1 行目\n2 行目  ')).toBe('1 行目\n2 行目');
    expect(answerText(QUESTION, ['です・ます'], '')).toBe('です・ます');
    expect(answerText(QUESTION, ['無い選択肢'], '')).toBe('');
  });
});
