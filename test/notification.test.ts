import { expect, it } from 'vitest';
import type { Menu } from '@shared/screen';
import { menuNotice } from '../src/main/notice-text';
import { taskNotificationOf } from '../src/main/task-router';

// 通知の本文と、完了通知の読み取り

it('確認待ちの通知の本文: 許可は実行しようとしている内容、質問は質問文。読み取れなければ種類だけ', () => {
  const permission: Menu = { kind: 'permission', tabs: [], title: 'Bash command', context: ['確認のフォルダを作る', 'mkdir checked && echo tanacode-check'], options: [], multiSelect: false, hint: '' };
  expect(menuNotice(permission)).toBe('実行の許可: 確認のフォルダを作る mkdir checked && echo tanacode-check');
  expect(menuNotice({ ...permission, context: [] })).toBe('実行の許可を求めています');
  expect(menuNotice({ ...permission, kind: 'question', title: 'どちらにしますか？' })).toBe('どちらにしますか？');
});

it('待機中に届いた完了通知（発言の行）でも、本文の <usage> からサブエージェントの使用量を読む', () => {
  const text = [
    '<task-notification>',
    '<task-id>a1</task-id>',
    '<tool-use-id>toolu_agent</tool-use-id>',
    '<status>completed</status>',
    '<summary>Agent "調べもの" finished</summary>',
    '<result>結果の中の <usage><tool_uses>9</tool_uses></usage> は読まない</result>',
    '<usage><subagent_tokens>120</subagent_tokens><tool_uses>1</tool_uses><duration_ms>395</duration_ms></usage>',
    '</task-notification>',
  ].join('\n');
  const expected = {
    toolUseId: 'toolu_agent',
    status: 'completed',
    result: '結果の中の <usage><tool_uses>9</tool_uses></usage> は読まない',
    usage: { durationMs: 395, totalTokens: 120, toolUses: 1 },
  };
  expect(taskNotificationOf({ type: 'user', message: { content: text } })).toMatchObject(expected);
  expect(taskNotificationOf({ type: 'queue-operation', operation: 'enqueue', content: text } as never)).toMatchObject(expected);
  // 作業中に差し込まれた形（attachment）は、attachment の usage を使う
  const attachment = { type: 'attachment', attachment: { type: 'queued_command', prompt: text, usage: { durationMs: 400, totalTokens: 121, toolUses: 1 } } };
  expect(taskNotificationOf(attachment as never)?.usage).toEqual({ durationMs: 400, totalTokens: 121, toolUses: 1 });
});
