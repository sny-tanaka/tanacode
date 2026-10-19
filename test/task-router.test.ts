import { describe, expect, it, vi } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import type { BashTaskTracker } from '../src/main/bash-task-tracker';
import { SubagentTracker } from '../src/main/subagent-tracker';
import { TaskRouter, taskNotificationOf } from '../src/main/task-router';
import type { WorkflowTracker } from '../src/main/workflow-tracker';

// 会話ログの行を、バックグラウンドで動くもの（ワークフロー・サブエージェント・Bash）を追う部品と画面に振り分ける（TaskRouter）と、
// 完了通知（<task-notification>）の読み取り（taskNotificationOf）。
// 行の形は、Claude Code 2.1.292 をモックの API で動かして取った会話ログ（test/cli/background.test.ts と同じ台本に、
// SendMessage での再開と、作業中に届いた完了通知を足したもの）に合わせた。パスは短くした

const SESSION_DIR = '/home/me/.claude/projects/-work-app/s1';
const WF_DIR = `${SESSION_DIR}/subagents/workflows/wf_1`;

const assistant = (blocks: unknown[]): TranscriptEntry => ({ type: 'assistant', uuid: 'a', message: { content: blocks as never } });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const result = (toolUseId: string, content: unknown, toolUseResult?: unknown, isError = false): TranscriptEntry => ({
  type: 'user',
  uuid: 'r',
  timestamp: '2026-10-07T13:51:06.639Z',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] as never },
  toolUseResult,
});
// API に送った要求の控え（2.1.302 の api-request-blob）。前の応答と結果が、API に送った形で入る（並べて呼んだツールの呼び出しと
// 結果は、それぞれ 1 通にまとまる）。toolUseResult は付かない
const blob = (role: 'user' | 'assistant', blocks: unknown[]): TranscriptEntry =>
  ({ type: 'api-request-blob', hash: '9be495a9220ff0a0', sessionId: 's1', message: { role, content: blocks } }) as TranscriptEntry;
const resultBlock = (toolUseId: string, content: unknown) => ({ type: 'tool_result', tool_use_id: toolUseId, content });

// 完了通知の本文（2.1.292 の形）
const AGENT_NOTICE = [
  '<task-notification>',
  '<task-id>acc4e89e2bbe86674</task-id>',
  '<tool-use-id>toolu_agent</tool-use-id>',
  '<output-file>/tmp/claude-0/-work-app/s1/tasks/acc4e89e2bbe86674.output</output-file>',
  '<status>completed</status>',
  '<summary>Agent "調べもの" finished</summary>',
  '<note>A task-notification fires each time this agent stops with no live background children of its own.</note>',
  '<result>サブエージェントの結果</result>',
  '<usage><subagent_tokens>120</subagent_tokens><tool_uses>2</tool_uses><duration_ms>1746</duration_ms></usage>',
  '</task-notification>',
].join('\n');
const BASH_NOTICE = [
  '<task-notification>',
  '<task-id>blktx4qxr</task-id>',
  '<tool-use-id>toolu_bg</tool-use-id>',
  '<output-file>/tmp/claude-0/-work-app/s1/tasks/blktx4qxr.output</output-file>',
  '<status>completed</status>',
  '<summary>Background command "裏で待つ" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\n');

function fakes() {
  const workflows = { add: vi.fn(), notified: vi.fn() };
  const subagents = { start: vi.fn(), resume: vi.fn(), finish: vi.fn(), notified: vi.fn() };
  const bashTasks = { start: vi.fn(), notified: vi.fn() };
  const router = new TaskRouter({
    workflows: workflows as unknown as WorkflowTracker,
    subagents: subagents as unknown as SubagentTracker,
    bashTasks: bashTasks as unknown as BashTaskTracker,
    sessionDir: () => SESSION_DIR,
  });
  return { router, workflows, subagents, bashTasks };
}

describe('TaskRouter', () => {
  it('Agent の起動をサブエージェントの追跡に渡し、結果の行で終わりを渡す。過去の行の起動は始めない', () => {
    const { router, subagents } = fakes();
    router.track(assistant([toolUse('toolu_agent', 'Agent', { description: '調べもの', prompt: '…', subagent_type: 'general-purpose', run_in_background: true })]), false);
    expect(subagents.start).toHaveBeenCalledWith('toolu_agent', SESSION_DIR, true, '調べもの');
    // 古い Claude Code の Task ツール。run_in_background は文字列で来ることもある。description が無ければ null
    router.track(assistant([toolUse('toolu_task', 'Task', { prompt: '…', run_in_background: 'true' })]), false);
    expect(subagents.start).toHaveBeenLastCalledWith('toolu_task', SESSION_DIR, true, null);
    router.track(assistant([toolUse('toolu_fg', 'Agent', { description: '前で', prompt: '…' })]), false);
    expect(subagents.start).toHaveBeenLastCalledWith('toolu_fg', SESSION_DIR, false, '前で');
    // 過去の行（前の起動の行）は始めない。結果だけ渡す
    router.track(assistant([toolUse('toolu_old', 'Agent', { description: '昔の', prompt: '…' })]), true);
    expect(subagents.start).toHaveBeenCalledTimes(3);

    const launched = { isAsync: true, status: 'async_launched', agentId: 'acc4e89e2bbe86674', description: '調べもの', resolvedModel: 'claude-opus-5-5' };
    router.track(result('toolu_agent', [{ type: 'text', text: 'Async agent launched successfully.' }], launched), false);
    expect(subagents.finish).toHaveBeenLastCalledWith('toolu_agent', launched, false, false);
    router.track(result('toolu_old', 'エラー', undefined, true), true);
    expect(subagents.finish).toHaveBeenLastCalledWith('toolu_old', undefined, true, true);
    // Agent でないツールの結果は渡さない
    router.track(result('toolu_other', 'ok'), false);
    expect(subagents.finish).toHaveBeenCalledTimes(2);
  });

  it('SendMessage で再開したエージェントを、結果の resumedAgentId で渡す（toolUseResult が無ければ本文の JSON から）', () => {
    const { router, subagents } = fakes();
    router.track(assistant([toolUse('toolu_send', 'SendMessage', { to: 'acdbba166eebcf247', summary: '続きを頼む', message: '続きをお願いします' })]), false);
    const resumed = { success: true, message: 'Resuming agent acdbba1', resumedAgentId: 'acdbba166eebcf247' };
    router.track(result('toolu_send', [{ type: 'text', text: JSON.stringify(resumed) }], resumed), false);
    expect(subagents.resume).toHaveBeenLastCalledWith('toolu_send', 'acdbba166eebcf247', SESSION_DIR, false);
    // toolUseResult が無い行（本文だけ）。過去の行
    router.track(assistant([toolUse('toolu_send2', 'SendMessage', { to: 'b2' })]), true);
    router.track(result('toolu_send2', [{ type: 'text', text: '{"success":true,"resumedAgentId":"b2"}' }]), true);
    expect(subagents.resume).toHaveBeenLastCalledWith('toolu_send2', 'b2', SESSION_DIR, true);
    // 本文が文字列の JSON
    router.track(assistant([toolUse('toolu_send3', 'SendMessage', { to: 'c3' })]), false);
    router.track(result('toolu_send3', '{"resumedAgentId":"c3"}'), false);
    expect(subagents.resume).toHaveBeenLastCalledWith('toolu_send3', 'c3', SESSION_DIR, false);
    // toolUseResult にだけ書かれている（本文は JSON でない）
    router.track(assistant([toolUse('toolu_send7', 'SendMessage', { to: 'g7' })]), false);
    router.track(result('toolu_send7', 'Resuming agent g7', { success: true, resumedAgentId: 'g7' }), false);
    expect(subagents.resume).toHaveBeenLastCalledWith('toolu_send7', 'g7', SESSION_DIR, false);
    // 再開でない結果（送っただけ・JSON でない・ID が空）は渡さない
    router.track(assistant([toolUse('toolu_send4', 'SendMessage', { to: 'd4' })]), false);
    router.track(result('toolu_send4', 'Message sent'), false);
    router.track(assistant([toolUse('toolu_send5', 'SendMessage', { to: 'e5' })]), false);
    router.track(result('toolu_send5', [{ type: 'text', text: '{"resumedAgentId":""}' }], { success: true }), false);
    router.track(assistant([toolUse('toolu_send6', 'SendMessage', { to: 'f6' })]), false);
    router.track(result('toolu_send6', { unexpected: true }), false);
    expect(subagents.resume).toHaveBeenCalledTimes(4);
  });

  it('バックグラウンドの Bash は、結果の行で起動を渡す（出力ファイルの案内の文と toolUseResult も）。前で動いた Bash は渡さない', () => {
    const { router, bashTasks } = fakes();
    const input = { command: 'echo bg-out && sleep 1 && echo bg-done', description: '裏で待つ', run_in_background: true };
    router.track(assistant([toolUse('toolu_bg', 'Bash', input)]), false);
    const text = 'Command running in background with ID: blktx4qxr. Output is being written to: /tmp/claude-0/-work-app/s1/tasks/blktx4qxr.output. You will be notified when it completes.';
    const toolUseResult = { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'blktx4qxr' };
    router.track(result('toolu_bg', text, toolUseResult), false);
    expect(bashTasks.start).toHaveBeenLastCalledWith('toolu_bg', input, toolUseResult, text, false);
    // 本文がブロックの配列（文字のブロックだけをつなぐ）・run_in_background が文字列・過去の行
    router.track(assistant([toolUse('toolu_bg2', 'Bash', { command: 'sleep 9', run_in_background: 'true' })]), true);
    router.track(result('toolu_bg2', [{ type: 'text', text: 'Output is being written to: /tmp/x.output' }, { type: 'image' }], { backgroundTaskId: 'b2' }), true);
    expect(bashTasks.start).toHaveBeenLastCalledWith('toolu_bg2', { command: 'sleep 9', run_in_background: 'true' }, { backgroundTaskId: 'b2' }, 'Output is being written to: /tmp/x.output\n', true);
    router.track(assistant([toolUse('toolu_fg', 'Bash', { command: 'ls' }), toolUse('toolu_noinput', 'Bash', undefined as never)]), false);
    router.track(result('toolu_fg', 'a.ts'), false);
    router.track(result('toolu_noinput', ''), false);
    expect(bashTasks.start).toHaveBeenCalledTimes(2);
  });

  it('ワークフローの起動の行を、スクリプトの中身と一緒に渡す', () => {
    const { router, workflows } = fakes();
    const script = "export const meta = { name: 'tanacode-check', description: '確認のワークフロー', phases: [{ title: '調べる' }] }";
    router.track(assistant([toolUse('toolu_wf', 'Workflow', { script })]), false);
    const launch = {
      status: 'async_launched',
      taskId: 'wb7qvqa8p',
      taskType: 'local_workflow',
      workflowName: 'tanacode-check',
      runId: 'wf_1',
      summary: '確認のワークフロー',
      transcriptDir: WF_DIR,
      scriptPath: `${SESSION_DIR}/workflows/scripts/tanacode-check-wf_1.js`,
    };
    router.track(result('toolu_wf', 'Workflow launched in background. Task ID: wb7qvqa8p', launch), false);
    expect(workflows.add).toHaveBeenCalledWith(
      {
        toolUseId: 'toolu_wf',
        runId: 'wf_1',
        taskId: 'wb7qvqa8p',
        name: 'tanacode-check',
        summary: '確認のワークフロー',
        transcriptDir: WF_DIR,
        scriptPath: `${SESSION_DIR}/workflows/scripts/tanacode-check-wf_1.js`,
        script,
        launchedAt: Date.parse('2026-10-07T13:51:06.639Z'),
      },
      false,
    );
    // 保存済みのスクリプト（scriptPath）で起動したもの・過去の行
    router.track(assistant([toolUse('toolu_wf2', 'Workflow', { scriptPath: launch.scriptPath, resumeFromRunId: 'wf_1' })]), true);
    router.track(result('toolu_wf2', '…', { ...launch, workflowName: undefined, summary: undefined, scriptPath: undefined }), true);
    expect(workflows.add).toHaveBeenLastCalledWith(expect.objectContaining({ toolUseId: 'toolu_wf2', name: 'wf_1', summary: '', script: null, scriptPath: null }), true);
  });

  it('完了通知を、ワークフロー・サブエージェント・Bash の追跡に渡す。どれのものか分からない通知は渡さない', () => {
    const { router, workflows, subagents, bashTasks } = fakes();
    router.track({ type: 'user', origin: { kind: 'task-notification' }, message: { content: AGENT_NOTICE } }, false);
    expect(workflows.notified).toHaveBeenLastCalledWith('toolu_agent', 'completed');
    expect(subagents.notified).toHaveBeenLastCalledWith('toolu_agent', 'completed', 'サブエージェントの結果', { durationMs: 1746, totalTokens: 120, toolUses: 2 });
    expect(bashTasks.notified).toHaveBeenLastCalledWith('toolu_agent', 'completed', null);
    router.track({ type: 'user', message: { content: '<task-notification>\n<summary>なにか</summary>\n</task-notification>' } }, false);
    expect(workflows.notified).toHaveBeenCalledTimes(1);
  });

  it('裏のサブエージェントは、起動の知らせのあとに同じ結果が API の要求の控えに書かれても、完了通知まで実行中のまま', () => {
    // 状態の移り変わりを見るため、サブエージェントの追跡だけは本物を使う
    const subagents = new SubagentTracker('/work/app', () => {});
    const { workflows, bashTasks } = fakes();
    const router = new TaskRouter({
      workflows: workflows as unknown as WorkflowTracker,
      subagents,
      bashTasks: bashTasks as unknown as BashTaskTracker,
      sessionDir: () => SESSION_DIR,
    });
    try {
      // 2.1.302 の会話ログの並び（2 つのツールを並べて呼んだ）: モデルが次の呼び出しを書いている間に前の呼び出しが動き、その結果の行が
      // 次の呼び出しの行より先に書かれる。行が API に送る 1 通ずつと合わないので、次の要求を送るときに、まとめて送った応答と結果を控えに書く
      const list = toolUse('toolu_list', 'mcp__tanacode-sessions__list_sessions', {});
      const agent = toolUse('toolu_agent', 'Agent', { description: '調べもの', prompt: '…', subagent_type: 'general-purpose', run_in_background: true });
      const launchedText = [{ type: 'text', text: 'Async agent launched successfully.' }];
      router.track(assistant([list]), false);
      router.track(result('toolu_list', '[]'), false);
      router.track(assistant([agent]), false);
      router.track(result('toolu_agent', launchedText, { isAsync: true, status: 'async_launched', agentId: 'acc4e89e2bbe86674', description: '調べもの' }), false);
      router.track(blob('assistant', [list, agent]), false);
      router.track(blob('user', [resultBlock('toolu_list', '[]'), resultBlock('toolu_agent', launchedText)]), false);
      expect(subagents.all()).toMatchObject([{ toolUseId: 'toolu_agent', agentId: 'acc4e89e2bbe86674', background: true, state: 'running', result: null }]);

      router.track({ type: 'user', origin: { kind: 'task-notification' }, message: { content: AGENT_NOTICE } }, false);
      expect(subagents.all()).toMatchObject([{ toolUseId: 'toolu_agent', state: 'done', result: 'サブエージェントの結果', toolCalls: 2, tokens: 120, durationMs: 1746 }]);
    } finally {
      subagents.dispose();
    }
  });

  it('API の要求の控えにだけあるツールの呼び出しと結果は、どの追跡にも渡さない', () => {
    const { router, workflows, subagents, bashTasks } = fakes();
    router.track(
      blob('assistant', [
        toolUse('toolu_agent', 'Agent', { description: '調べもの', prompt: '…', run_in_background: true }),
        toolUse('toolu_bg', 'Bash', { command: 'sleep 9', run_in_background: true }),
        toolUse('toolu_send', 'SendMessage', { to: 'b2', message: '続きをお願いします' }),
        toolUse('toolu_wf', 'Workflow', { script: 'return 1' }),
      ]),
      false,
    );
    router.track(
      blob('user', [
        resultBlock('toolu_agent', 'Async agent launched successfully.'),
        resultBlock('toolu_bg', 'Command running in background with ID: b1. Output is being written to: /tmp/b1.output'),
        resultBlock('toolu_send', '{"success":true,"resumedAgentId":"b2"}'),
        resultBlock('toolu_wf', 'Workflow launched in background. Task ID: wb7qvqa8p'),
      ]),
      false,
    );
    expect(subagents.start).not.toHaveBeenCalled();
    expect(subagents.finish).not.toHaveBeenCalled();
    expect(subagents.resume).not.toHaveBeenCalled();
    expect(bashTasks.start).not.toHaveBeenCalled();
    expect(workflows.add).not.toHaveBeenCalled();
  });
});

describe('taskNotificationOf', () => {
  it('待機中に届いた通知（発言の行）。使用量は本文の <usage> から読む', () => {
    expect(taskNotificationOf({ type: 'user', origin: { kind: 'task-notification' }, message: { content: AGENT_NOTICE } })).toEqual({
      text: AGENT_NOTICE,
      usage: { durationMs: 1746, totalTokens: 120, toolUses: 2 },
      toolUseId: 'toolu_agent',
      status: 'completed',
      result: 'サブエージェントの結果',
      exitCode: null,
    });
  });

  it('順番待ちの行（queue-operation の enqueue）も読む。dequeue や、ほかの順番待ちの発言は通知ではない', () => {
    expect(taskNotificationOf({ type: 'queue-operation', operation: 'enqueue', content: BASH_NOTICE } as TranscriptEntry)).toEqual({
      text: BASH_NOTICE,
      usage: null,
      toolUseId: 'toolu_bg',
      status: 'completed',
      result: null,
      exitCode: 0,
    });
    expect(taskNotificationOf({ type: 'queue-operation', operation: 'dequeue' } as TranscriptEntry)).toBeNull();
    expect(taskNotificationOf({ type: 'queue-operation', operation: 'enqueue', content: '追加の頼みです' } as TranscriptEntry)).toBeNull();
    expect(taskNotificationOf({ type: 'queue-operation', operation: 'remove', content: BASH_NOTICE } as TranscriptEntry)).toBeNull();
  });

  it('作業中に届いた通知（attachment の queued_command）は、attachment の usage を使う', () => {
    const notice = AGENT_NOTICE.replace('toolu_agent', 'toolu_fg');
    const entry = {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: notice,
        commandMode: 'task-notification',
        origin: { kind: 'task-notification', producer: 'session-task' },
        usage: { totalTokens: 120, toolUses: 1, durationMs: 196 },
      },
    } as TranscriptEntry;
    expect(taskNotificationOf(entry)).toMatchObject({ toolUseId: 'toolu_fg', status: 'completed', usage: { durationMs: 196, totalTokens: 120, toolUses: 1 } });
    // 数でない項目は null
    const odd = { ...entry, attachment: { ...entry.attachment, usage: { totalTokens: '120' } } } as TranscriptEntry;
    expect(taskNotificationOf(odd)?.usage).toEqual({ durationMs: null, totalTokens: null, toolUses: null });
    // 人の発言の差し込み・usage の無い通知
    expect(taskNotificationOf({ type: 'attachment', attachment: { type: 'queued_command', prompt: '追加の頼みです', commandMode: 'prompt', origin: { kind: 'human' } } })).toBeNull();
    const plain = { type: 'attachment', attachment: { type: 'queued_command', prompt: BASH_NOTICE } } as TranscriptEntry;
    expect(taskNotificationOf(plain)?.usage).toBeNull();
  });

  it('結果の文の中の <usage> は読まない。古い形の total_tokens も読む。数が無い項目は null', () => {
    const text = '<task-notification><tool-use-id>t</tool-use-id><status>failed</status><result>本文に <usage><duration_ms>1</duration_ms></usage> とある</result></task-notification>';
    expect(taskNotificationOf({ type: 'user', message: { content: text } })).toMatchObject({ status: 'failed', usage: null, result: '本文に <usage><duration_ms>1</duration_ms></usage> とある' });
    const old = '<task-notification><tool-use-id>t</tool-use-id><status>completed</status><usage><total_tokens>55</total_tokens></usage></task-notification>';
    expect(taskNotificationOf({ type: 'user', message: { content: old } })?.usage).toEqual({ durationMs: null, totalTokens: 55, toolUses: null });
  });

  it('通知でない行は null（ふつうの発言・ブロックの配列の発言・応答・ほかの attachment）', () => {
    expect(taskNotificationOf({ type: 'user', message: { content: 'ただの発言' } })).toBeNull();
    expect(taskNotificationOf({ type: 'user', message: { content: [{ type: 'text', text: AGENT_NOTICE }] } })).toBeNull();
    expect(taskNotificationOf({ type: 'assistant', message: { content: [{ type: 'text', text: AGENT_NOTICE }] } })).toBeNull();
    expect(taskNotificationOf({ type: 'attachment', attachment: { type: 'file', filename: '/a' } })).toBeNull();
  });
});
