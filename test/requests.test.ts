import { describe, expect, it } from 'vitest';
import { chatMessage, permissionOf, permissionResult, questionResult, REJECTED, rejectedWith } from '../src/main/requests';
import type { CanUseToolRequest } from '../src/main/stream/protocol';

// Claude Code が答えを待つ要求（can_use_tool）を、カードと親の道具で扱う形にし、答えを Claude Code への返事にする（requests.ts）

const bash = (over: Partial<CanUseToolRequest> = {}): CanUseToolRequest => ({
  subtype: 'can_use_tool',
  tool_name: 'Bash',
  input: { command: 'npm test' },
  tool_use_id: 'toolu_1',
  ...over,
});

describe('permissionOf', () => {
  it('見出しは title、無ければ display_name。「今後は聞かない」は候補の短い名前（ルール・フォルダ・モード）', () => {
    const request = bash({
      display_name: 'Bash',
      permission_suggestions: [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Read' }], behavior: 'allow', destination: 'localSettings' },
        { type: 'addDirectories', directories: ['/repo/out'], destination: 'session' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
      agent_id: 'agent-1',
    });
    expect(permissionOf('req-1', request)).toEqual({
      id: 'req-1',
      tool: 'Bash',
      title: 'Bash',
      description: null,
      input: { command: 'npm test' },
      reason: null,
      always: ['Bash(npm test:*)', 'Read', '/repo/out', 'acceptEdits'],
      plan: null,
      agent: 'agent-1',
    });
  });

  it('候補が無い・覚えさせない印（suppress_always_allow_rule）があるときは、「今後は聞かない」を出さない', () => {
    expect(permissionOf('req-1', bash()).always).toBeNull();
    const suppressed = bash({
      suppress_always_allow_rule: true,
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }],
    });
    expect(permissionOf('req-1', suppressed).always).toBeNull();
    // 返事でも足さない
    expect(permissionResult(suppressed, { kind: 'allow', always: true })).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
  });

  it('プランの承認（ExitPlanMode）は、渡された本文、無ければ入力の本文、それも無ければ空。ほかのツールでは null', () => {
    const plan = bash({ tool_name: 'ExitPlanMode', input: {} });
    expect(permissionOf('req-1', plan, '# ファイルの計画').plan).toBe('# ファイルの計画');
    expect(permissionOf('req-1', bash({ tool_name: 'ExitPlanMode', input: { plan: '# 入力の計画' } })).plan).toBe('# 入力の計画');
    expect(permissionOf('req-1', plan).plan).toBe('');
    expect(permissionOf('req-1', bash(), '# 関係ない').plan).toBeNull();
  });
});

describe('permissionResult', () => {
  it('許す（候補が無ければ、今後は聞かないでも許すだけ）・プラン以外の「承認して編集を自動で」は許すだけ', () => {
    expect(permissionResult(bash(), { kind: 'allow' })).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
    expect(permissionResult(bash(), { kind: 'allow', always: true })).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
    expect(permissionResult(bash(), { kind: 'accept-edits' })).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
  });

  it('理由を添えて断る（作業は続く）・止める（作業を止める）は、TUI で選んだときと同じ文を返す', () => {
    expect(permissionResult(bash(), { kind: 'deny', message: '別の方法で' })).toEqual({ behavior: 'deny', message: rejectedWith('別の方法で') });
    expect(rejectedWith('別の方法で')).toBe(`${REJECTED} To tell you how to proceed, the user said:\n別の方法で`);
    expect(permissionResult(bash(), { kind: 'stop' })).toEqual({ behavior: 'deny', message: REJECTED, interrupt: true });
  });
});

describe('questionResult', () => {
  const QUESTIONS = [{ question: 'どちら?', header: '', multiSelect: false, options: [{ label: 'A', description: '' }] }];
  const input = { questions: QUESTIONS };

  it('答えは入力の answers に、添え書きがあれば annotations に入れて許す', () => {
    expect(questionResult(input, QUESTIONS, { kind: 'answer', answers: { 'どちら?': 'A' } })).toEqual({ behavior: 'allow', updatedInput: { questions: QUESTIONS, answers: { 'どちら?': 'A' } } });
    expect(questionResult(input, QUESTIONS, { kind: 'answer', answers: { 'どちら?': 'A' }, annotations: { 'どちら?': { notes: 'メモ' } } })).toEqual({
      behavior: 'allow',
      updatedInput: { questions: QUESTIONS, answers: { 'どちら?': 'A' }, annotations: { 'どちら?': { notes: 'メモ' } } },
    });
  });

  it('「Chat about this」は質問について話す文で断り（作業は続く）、キャンセルは止める', () => {
    expect(questionResult(input, QUESTIONS, { kind: 'chat' })).toEqual({ behavior: 'deny', message: chatMessage(['どちら?']) });
    expect(chatMessage(['どちら?', 'いつ?'])).toContain('- "どちら?"\n  (No answer provided)\n- "いつ?"\n  (No answer provided)');
    expect(questionResult(input, QUESTIONS, { kind: 'cancel' })).toEqual({ behavior: 'deny', message: REJECTED, interrupt: true });
  });
});
