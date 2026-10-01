import { expect, it } from 'vitest';
import type { ScreenLine } from '@shared/screen';
import { menuNotice } from '../src/main/notice-text';
import { parseMenu } from '../src/main/screen-parser';
import { taskNotificationOf } from '../src/main/task-router';

// 通知まわりの読み取り（Claude Code 2.1.283・2.1.286 で見た形）

const line = (text: string): ScreenLine => ({ text, full: text.length >= 120 });

it('許可の確認の補足から、コマンドを囲む点線を除き、通知の本文に実行するコマンドを出す', () => {
  const lines = [
    '● 確認のフォルダを作る',
    '  ⎿  $ mkdir checked && echo tanacode-check',
    '',
    '─'.repeat(120),
    ' Bash command',
    ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
    ' 確認のフォルダを作る',
    '╌'.repeat(120),
    ' mkdir checked && echo tanacode-check',
    '╌'.repeat(120),
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and always allow access to /tmp/work from this project',
    '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
    '   4. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].map(line);
  const menu = parseMenu(lines);
  expect(menu?.kind).toBe('permission');
  expect(menu!.context).toEqual([
    'Bash command',
    'Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
    '確認のフォルダを作る',
    'mkdir checked && echo tanacode-check',
  ]);
  expect(menuNotice(menu!)).toBe('実行の許可: Bash command 確認のフォルダを作る mkdir checked && echo tanacode-check');
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
