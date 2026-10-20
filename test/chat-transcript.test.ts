import { CHECKLIST_REMINDER_TAG, CHECKLIST_UNCHANGED_MARK } from '../src/shared/checklist-tools';
import { CHECKLIST_HOOK_COMMAND } from '../src/main/checklist-hook';
import { describe, expect, it } from 'vitest';
import {
  ASK_FILE_ENV,
  QUESTION_HOOK_ENV,
  bridgeUrlOf,
  isHumanPrompt,
  isTranscriptEntry,
  promptDisplayText,
  toChatEvents,
  toolTarget,
  transcriptTitle,
  unsentView,
  type ChatEvent,
  type TranscriptEntry,
  splitPasted,
} from '@shared/chat';
import { checklistEventText } from '@shared/checklist-tools';
import { formatScheduleTime, wakeupText } from '@shared/scheduled';
import { usageLimitOf, usageResumeText } from '@shared/usage-limit';
import { parentMessageText, sessionEventText } from '@shared/session-tools';

// 会話ログの行をチャットの出来事に変える（toChatEvents）と、そのまわりの読み取り（shared/chat.ts）。
// 行の形は、Claude Code 2.1.292 の控え（test/fixtures/claude-code/2.1.292/transcript.jsonl）と、同じバージョンをモックの API で
// 動かして取った会話ログ（@ の添付・Edit・Write・作業中に送った発言・/compact・! のコマンド・/rename・中断・API エラー・hooks で
// 止めたツール・Stop の hooks・バックグラウンドの作業の完了通知）に合わせた。パスとログの時刻は短くした。
// 次のものはそれらの会話ログに出なかったので、src の読み取りに合わせて組み立てた: 再試行中の api_error・informational・
// bridge_status と bridge-session・pr-link・CI の自動修正とスケジュールタスクの知らせ・TodoWrite・TaskCreate・TaskUpdate・
// SendUserFile・作業中に送った発言の画像・アプリが足したフックの記録

const CWD = '/work/app';
const AT = '2026-10-07T13:55:18.780Z';
const at = Date.parse(AT);
const events = (entry: TranscriptEntry, sidechain = false, images?: Map<string, string>) =>
  toChatEvents(entry, CWD, sidechain, images && ((key, url) => images.set(key, url)));
const user = (content: unknown, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  type: 'user',
  uuid: 'u1',
  timestamp: AT,
  message: { content: content as never },
  ...extra,
});
const assistant = (content: unknown[], extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  type: 'assistant',
  uuid: 'a1',
  timestamp: AT,
  message: { model: 'claude-opus-5-5', content: content as never },
  ...extra,
});
const result = (toolUseId: string, content: unknown, toolUseResult?: unknown, isError?: boolean): TranscriptEntry =>
  user([{ tool_use_id: toolUseId, type: 'tool_result', content, ...(isError === undefined ? {} : { is_error: isError }) }], { toolUseResult });
const system = (subtype: string, extra: Record<string, unknown> = {}): TranscriptEntry => ({ type: 'system', subtype, uuid: 's1', timestamp: AT, ...extra });
const attachment = (a: Record<string, unknown>): TranscriptEntry => ({ type: 'attachment', uuid: 'at1', timestamp: AT, attachment: a });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const image = (mediaType?: string) => ({ type: 'image', source: { type: 'base64', ...(mediaType ? { media_type: mediaType } : {}), data: PNG } });

describe('toChatEvents: system の行', () => {
  it('ターンの終わり・圧縮の区切り・画面に出るだけのお知らせ', () => {
    expect(events(system('turn_duration', { durationMs: 877, messageCount: 23 }))).toEqual([{ type: 'turn-end' }]);
    // 2.1.292 の /compact の区切り
    expect(events(system('compact_boundary', { content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 120_400, postTokens: 1313 } }))).toEqual([
      { type: 'divider', id: 's1', text: '会話を圧縮しました（120k tokens から）' },
    ]);
    expect(events(system('compact_boundary', { compactMetadata: { trigger: 'auto', preTokens: 167_000 } }))).toEqual([
      { type: 'divider', id: 's1', text: '会話を自動で圧縮しました（167k tokens から）' },
    ]);
    expect(events(system('compact_boundary', { compactMetadata: { trigger: 'auto', preTokens: 0 } }))).toEqual([{ type: 'divider', id: 's1', text: '会話を自動で圧縮しました' }]);
    expect(events({ type: 'system', subtype: 'compact_boundary' })).toEqual([{ type: 'divider', id: '', text: '会話を圧縮しました' }]);
    expect(events(system('informational', { content: '  AGENTS.md を読み込みました\n' }))).toEqual([{ type: 'info', id: 's1', text: 'AGENTS.md を読み込みました' }]);
    expect(events({ type: 'system', subtype: 'informational', content: 'x' })).toEqual([{ type: 'info', id: '', text: 'x' }]);
    expect(events(system('informational', { content: '  ' }))).toEqual([]);
    expect(events(system('informational'))).toEqual([]);
    expect(events(system('bridge_status', { url: 'https://claude.ai/code/session_abc' }))).toEqual([{ type: 'remote-control', url: 'https://claude.ai/code/session_abc' }]);
    expect(events(system('bridge_status'))).toEqual([]);
    // 知らない system の行は、未知のイベントとして出す（toChatEvents: 未知のイベント）
    expect(events(system('something_new'))).toMatchObject([{ type: 'unknown-event', name: 'system/something_new' }]);
  });

  it('ローカルのコマンド（会話の最初の /rename など）は発言として出し、出力の行はターンの終わりにする', () => {
    // 2.1.292 の /rename
    const command = '<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>控えの名前</command-args>';
    expect(events(system('local_command', { content: command, level: 'info' }))).toEqual([{ type: 'user', id: 's1', text: '/rename 控えの名前', at, command: true }]);
    expect(events(system('local_command', { content: '<local-command-stdout>Session renamed to: 控えの名前</local-command-stdout>' }))).toEqual([{ type: 'turn-end' }]);
    // /clear の出力は空
    expect(events(system('local_command', { content: '<local-command-stdout></local-command-stdout>' }))).toEqual([{ type: 'turn-end' }]);
    expect(events(system('local_command'))).toEqual([{ type: 'turn-end' }]);
  });

  it('Stop の hooks の要約。止めた・失敗した・成功の順に結果を決め、アプリ内部の callback は出さない', () => {
    // 2.1.292 の Stop の hooks（何も出力しないもの）
    const summary = system('stop_hook_summary', {
      hookCount: 2,
      hookInfos: [{ command: 'cat > /dev/null', durationMs: 62 }, { command: 'callback' }, {}],
      hookErrors: [],
      preventedContinuation: false,
      stopReason: '',
      toolUseID: '9719fb97-660c-4a04-a015-3c178c3ee562',
    });
    expect(events(summary)).toEqual([
      {
        type: 'hook',
        id: 's1:0',
        run: {
          event: 'Stop',
          name: 'Stop',
          command: 'cat > /dev/null',
          outcome: 'success',
          exitCode: null,
          durationMs: 62,
          stdout: '',
          stderr: '',
          message: '',
          toolUseId: '9719fb97-660c-4a04-a015-3c178c3ee562',
        },
      },
    ]);
    const failed = events({ ...summary, hookInfos: [{ command: 'lint' }], hookErrors: ['lint が失敗しました', 2], toolUseID: undefined, stopReason: undefined, uuid: undefined });
    expect(failed).toEqual([
      { type: 'hook', id: ':0', run: expect.objectContaining({ outcome: 'error', durationMs: null, stderr: 'lint が失敗しました\n2', message: '', toolUseId: null }) },
    ]);
    const blocked = events({ ...summary, hookInfos: [{ command: 'check' }], hookErrors: ['x'], preventedContinuation: true, stopReason: 'テストが落ちています' });
    expect(blocked).toEqual([{ type: 'hook', id: 's1:0', run: expect.objectContaining({ outcome: 'blocked', message: 'テストが落ちています' }) }]);
    expect(events(system('stop_hook_summary'))).toEqual([]);
    // アプリが足したフック（チェックリストを使い続けさせるもの）は出さない。ユーザーのフックと並んでいれば、ユーザーのものだけを出す
    const withApp = events({ ...summary, hookInfos: [{ command: CHECKLIST_HOOK_COMMAND, durationMs: 40 }, { command: 'npm test', durationMs: 900 }] });
    expect(withApp).toEqual([{ type: 'hook', id: 's1:0', run: expect.objectContaining({ command: 'npm test', durationMs: 900 }) }]);
  });

  it('API エラーの再試行中の行は、回数を添えて出す（今の Claude Code は会話ログに残さない）', () => {
    expect(events(system('api_error', { error: { formatted: '529 Overloaded' }, retryAttempt: 1, maxRetries: 10 }))).toEqual([
      { type: 'api-error', id: 's1', text: 'API エラー: 529 Overloaded — 再試行中（1/10）', retrying: true },
    ]);
    expect(events(system('api_error', { error: { message: 'Overloaded' }, retryAttempt: 2 }))).toEqual([
      { type: 'api-error', id: 's1', text: 'API エラー: Overloaded', retrying: true },
    ]);
    expect(events({ type: 'system', subtype: 'api_error' })).toEqual([{ type: 'api-error', id: '', text: 'API エラー: 不明なエラー', retrying: true }]);
  });
});

describe('toChatEvents: Remote Control と PR', () => {
  it('ブリッジの行から、つながった URL・切れたこと（空の ID）を読む。形の違う ID は読まない', () => {
    expect(bridgeUrlOf({ type: 'bridge-session', bridgeSessionId: 'cse_01AbC' })).toBe('https://claude.ai/code/session_01AbC');
    expect(bridgeUrlOf({ type: 'bridge-session', bridgeSessionId: '' })).toBeNull();
    expect(bridgeUrlOf({ type: 'bridge-session', bridgeSessionId: 'other-id' })).toBeUndefined();
    expect(bridgeUrlOf({ type: 'bridge-session' })).toBeUndefined();
    expect(bridgeUrlOf({ type: 'user', bridgeSessionId: 'cse_x' })).toBeUndefined();
    expect(events({ type: 'bridge-session', bridgeSessionId: 'cse_01AbC' })).toEqual([{ type: 'remote-control', url: 'https://claude.ai/code/session_01AbC' }]);
    expect(events({ type: 'bridge-session', bridgeSessionId: '' })).toEqual([{ type: 'remote-control', url: null }]);
    expect(events({ type: 'bridge-session', bridgeSessionId: 'other-id' })).toEqual([]);
  });

  it('PR の行は、番号と URL があるときだけ出す。リポジトリが無ければ空', () => {
    expect(events({ type: 'pr-link', prNumber: 12, prUrl: 'https://github.com/o/r/pull/12', prRepository: 'o/r' })).toEqual([
      { type: 'pr-link', pr: { number: 12, url: 'https://github.com/o/r/pull/12', repository: 'o/r' } },
    ]);
    expect(events({ type: 'pr-link', prNumber: 12, prUrl: 'https://github.com/o/r/pull/12' })).toEqual([
      { type: 'pr-link', pr: { number: 12, url: 'https://github.com/o/r/pull/12', repository: '' } },
    ]);
    expect(events({ type: 'pr-link', prNumber: 12 })).toEqual([]);
    expect(events({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/12' })).toEqual([]);
  });
});

describe('toChatEvents: attachment の行', () => {
  it('作業中に送った発言（queued_command）は、ユーザーの発言として出す', () => {
    // 2.1.292 の、作業中に送って差し込まれた発言
    const queued = attachment({ type: 'queued_command', prompt: '追加の頼みです', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true });
    expect(events(queued)).toEqual([{ type: 'user', id: 'at1', text: '追加の頼みです', at }]);
    // ブロックの配列で、画像も付いたもの
    const images = new Map<string, string>();
    const withImage = attachment({ type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: [{ type: 'text', text: 'この画面' }, image('image/jpeg'), { type: 'text', text: '' }] });
    expect(events(withImage, false, images)).toEqual([{ type: 'user', id: 'at1', text: 'この画面', at, images: ['at1:q1'] }]);
    expect(images.get('at1:q1')).toBe(`data:image/jpeg;base64,${PNG}`);
    // 画像の受け手が無ければ、文字だけ
    expect(events(withImage)).toEqual([{ type: 'user', id: 'at1', text: 'この画面', at }]);
    // 画像だけ
    const onlyImage = attachment({ type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: [image()] });
    expect(events(onlyImage, false, images)).toEqual([{ type: 'user', id: 'at1', text: '', images: ['at1:q0'], at }]);
    expect(images.get('at1:q0')).toBe(`data:image/png;base64,${PNG}`);
    expect(events(attachment({ type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' } }))).toEqual([]);
  });

  it('作業中に届いた完了通知・別の Claude からの知らせ・発言でない差し込みは、発言として出さない。CI の自動修正の知らせは出す', () => {
    // 2.1.292 の、作業中に届いた完了通知
    const notice = attachment({
      type: 'queued_command',
      prompt: '<task-notification>\n<tool-use-id>toolu_fg</tool-use-id>\n<status>completed</status>\n<summary>Agent "前の調べもの" finished</summary>\n</task-notification>',
      commandMode: 'task-notification',
      origin: { kind: 'task-notification', producer: 'session-task' },
      usage: { totalTokens: 120, toolUses: 1, durationMs: 196 },
    });
    expect(events(notice)).toEqual([]);
    expect(events(attachment({ type: 'queued_command', commandMode: 'prompt', origin: { kind: 'peer' }, prompt: '<agent-message from="a1">報告</agent-message>' }))).toEqual([]);
    // サブエージェントの報告（SubagentHandback）は、ターンの途中の補足の行で見せる（注記があれば、報告の前に）
    const handback = { kind: 'peer', from: 'a1', senderTaskId: 'a1', name: 'Explore', body: '…', handback: true, handbackReportText: '調べました', handbackNote: '注意書き' };
    expect(events(attachment({ type: 'queued_command', commandMode: 'prompt', origin: handback, prompt: '<agent-message from="a1">…</agent-message>' }))).toEqual([
      { type: 'info', id: 'at1', text: 'サブエージェント「Explore」の報告', detail: '注意書き\n\n調べました' },
    ]);
    expect(events(attachment({ type: 'queued_command', commandMode: 'prompt', prompt: 'origin の無い発言' }))).toEqual([]);
    const ci = attachment({ type: 'queued_command', commandMode: 'prompt', prompt: '<ci-monitor-event>Auto-fix was just enabled for PR #7.</ci-monitor-event>' });
    expect(events(ci)).toEqual([{ type: 'notice', id: 'at1', text: 'CI の自動修正（PR #7）: 有効になりました', detail: 'Auto-fix was just enabled for PR #7.' }]);
  });

  it('hooks の記録（出力のあったもの）。止めた理由・Claude に渡した内容を読み、アプリが足したフックは出さない', () => {
    // 2.1.292 の PostToolUse の hooks の成功
    const success = attachment({
      type: 'hook_success',
      hookName: 'PostToolUse:Bash',
      toolUseID: 'toolu_bash',
      hookEvent: 'PostToolUse',
      content: 'tanacode-hook',
      stdout: 'tanacode-hook\n',
      stderr: '',
      exitCode: 0,
      command: 'echo tanacode-hook',
      durationMs: 23,
    });
    expect(events(success)).toEqual([
      {
        type: 'hook',
        id: 'at1',
        run: {
          event: 'PostToolUse',
          name: 'PostToolUse:Bash',
          command: 'echo tanacode-hook',
          outcome: 'success',
          exitCode: 0,
          durationMs: 23,
          stdout: 'tanacode-hook',
          stderr: '',
          message: '',
          toolUseId: 'toolu_bash',
        },
      },
    ]);
    // 2.1.292 の PostToolUse の hooks で止めた（exit 2）
    const blocked = attachment({
      type: 'hook_blocking_error',
      hookName: 'PostToolUse:Bash',
      toolUseID: 'toolu_post_blocked',
      hookEvent: 'PostToolUse',
      blockingError: { blockingError: '[if …; fi]: あとから止めました\n', command: 'if …; fi' },
    });
    expect(events(blocked)[0]).toMatchObject({ run: { outcome: 'blocked', command: 'if …; fi', message: '[if …; fi]: あとから止めました', exitCode: null, durationMs: null } });
    // Claude に情報を渡した（内容は配列）・失敗・知らない種類
    expect(events(attachment({ type: 'hook_additional_context', hookName: 'SessionStart', content: ['一行目', '二行目'] }))[0]).toMatchObject({
      run: { event: 'SessionStart', name: 'SessionStart', outcome: 'context', message: '一行目\n二行目', command: null, toolUseId: null },
    });
    expect(events(attachment({ type: 'hook_non_blocking_error', hookEvent: 'PreToolUse', stderr: 'x'.repeat(3001), message: '失敗' }))[0]).toMatchObject({
      run: { name: 'PreToolUse', outcome: 'error', message: '失敗', stderr: `${'x'.repeat(3000)}\n…（1 文字省略）` },
    });
    expect(events(attachment({ type: 'hook_error_during_execution', hookEvent: 'Stop' }))[0]).toMatchObject({ run: { outcome: 'error' } });
    expect(events(attachment({ type: 'hook_stopped_continuation', hookEvent: 'Stop', content: '止めました' }))[0]).toMatchObject({ run: { outcome: 'blocked', message: '止めました' } });
    expect(events({ type: 'attachment', attachment: { type: 'hook_something' } })).toEqual([
      { type: 'hook', id: '', run: expect.objectContaining({ event: 'hook', name: '', outcome: 'success' }) },
    ]);
    // ユーザーのフックが標準出力の JSON で suppressOutput を指定したものは出さない（Claude Code の画面でも出ない）。読めない JSON・ほかの出力は出す
    const quieted = (stdout: string) => events(attachment({ type: 'hook_success', hookName: 'PostToolUse:Bash', hookEvent: 'PostToolUse', toolUseID: 'toolu_bash', command: 'my-hook', stdout, stderr: '', exitCode: 0 }));
    expect(quieted('{"suppressOutput":true}\n')).toEqual([]);
    expect(quieted('{"suppressOutput": true, "hookSpecificOutput": {"hookEventName": "PostToolUse"}}')).toEqual([]);
    expect(quieted('{"suppressOutput":false}')).toHaveLength(1);
    expect(quieted('{"suppressOutput":true')).toHaveLength(1);
    expect(quieted('記録しました {"suppressOutput":true}')).toHaveLength(1);
    expect(quieted('[{"suppressOutput":true}]')).toHaveLength(1);
    // 前のバージョンのアプリが足したフック（AskUserQuestion の入力をファイルに書くもの・質問をアプリに渡して答えを待つもの）は出さない
    expect(events(attachment({ type: 'hook_success', hookEvent: 'PreToolUse', command: `cat > "$${ASK_FILE_ENV}"` }))).toEqual([]);
    expect(
      events(attachment({ type: 'hook_success', hookEvent: 'PermissionRequest', command: `${QUESTION_HOOK_ENV}=1 ELECTRON_RUN_AS_NODE=1 "$TANACODE_QUESTION_COMMAND" "$TANACODE_QUESTION_SCRIPT"` })),
    ).toEqual([]);
    // チェックリストを使い続けさせるフック。Claude に文を渡した記録（コマンドは載らないので、囲みで見分ける）・ターンの終わりを止めた記録（コマンドは blockingError に入る）。2.1.296
    const reminder = `<${CHECKLIST_REMINDER_TAG}>\n今のチェックリスト\n</${CHECKLIST_REMINDER_TAG}>`;
    expect(events(attachment({ type: 'hook_additional_context', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', content: [reminder] }))).toEqual([]);
    // 止めた記録は、フックの一覧には出さず、目印だけを残す（このあとの応答は、チェックリストを直した報告。ほかのセッションに結果を返すときに見分ける）
    expect(events(attachment({ type: 'hook_blocking_error', hookEvent: 'Stop', blockingError: { blockingError: '直して', command: CHECKLIST_HOOK_COMMAND } }))).toEqual([{ type: 'checklist-stop' }]);
    // ターンの終わりを、止めずに文を渡して続けさせた記録（2.1.302 からのアプリ。コマンドは載らないので、囲みで見分ける）も、目印だけを残す
    const stopReminder = `<${CHECKLIST_REMINDER_TAG}>Before you end this turn (2 tool calls, checklists not touched)</${CHECKLIST_REMINDER_TAG}>`;
    expect(events(attachment({ type: 'hook_additional_context', hookName: 'Stop', hookEvent: 'Stop', content: [stopReminder] }))).toEqual([{ type: 'checklist-stop' }]);
    // ユーザーの Stop のフックが文を渡したときは、フックの一覧に出す
    expect(events(attachment({ type: 'hook_additional_context', hookName: 'Stop', hookEvent: 'Stop', content: ['テストも流して'] }))[0]).toMatchObject({ type: 'hook', run: { outcome: 'context' } });
    // ユーザーの Stop のフックが止めたとき・Stop でないときは、目印にしない
    expect(events(attachment({ type: 'hook_blocking_error', hookEvent: 'Stop', blockingError: { blockingError: 'テストを流して', command: 'npm test' } }))[0]).toMatchObject({ type: 'hook', run: { outcome: 'blocked' } });
    expect(events(attachment({ type: 'hook_blocking_error', hookEvent: 'PostToolUse', blockingError: { blockingError: '直して', command: CHECKLIST_HOOK_COMMAND } }))).toEqual([]);
    // hooks でない attachment
    expect(events(attachment({ type: 'file', filename: `${CWD}/notes.txt` }))).toEqual([]);
    // 中身の無い attachment は、形の違う行として、未知のイベントにする
    expect(events({ type: 'attachment' })).toMatchObject([{ type: 'unknown-event', name: 'attachment', problem: 'malformed' }]);
  });
});

describe('toChatEvents: 応答の行', () => {
  it('ターンの終わりの知らせに「直すものは無い」と答えた目印は出さない。目印を含むだけの文章は出す', () => {
    expect(events(assistant([{ type: 'text', text: `\n${CHECKLIST_UNCHANGED_MARK}\n` }]))).toEqual([]);
    expect(events(assistant([{ type: 'text', text: `${CHECKLIST_UNCHANGED_MARK} と返しました` }]))).toHaveLength(1);
  });

  it('文章・思考・ツールの呼び出しを出す。空のものは出さない', () => {
    const entry = assistant([
      { type: 'text', text: 'コマンドを実行します。' },
      { type: 'text', text: '  ' },
      { type: 'thinking', thinking: '\nどのファイルから読むか考えています\n' },
      { type: 'thinking', thinking: '', signature: 'bW9jaw==' },
      { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'mkdir checked && echo tanacode-check', description: '確認のフォルダを作る' } },
      { type: 'tool_use', name: 'Bash', input: {} },
      { type: 'tool_use', id: 'toolu_x' },
      // 入力の無いツール
      { type: 'tool_use', id: 'toolu_noinput', name: 'TodoRead' },
    ]);
    expect(events(entry)).toEqual([
      { type: 'assistant-text', id: 'a1:0', text: 'コマンドを実行します。', at },
      { type: 'thinking', id: 'a1:2', text: 'どのファイルから読むか考えています' },
      {
        type: 'tool-use',
        id: 'toolu_bash',
        name: 'Bash',
        target: 'mkdir checked && echo tanacode-check',
        filePath: undefined,
        input: '# 確認のフォルダを作る\nmkdir checked && echo tanacode-check',
        todos: undefined,
        taskChange: undefined,
        description: '確認のフォルダを作る',
        sentFiles: undefined,
        at,
      },
      expect.objectContaining({ type: 'tool-use', id: 'toolu_noinput', name: 'TodoRead', target: '', input: '{}' }),
    ]);
    expect(events({ type: 'assistant', message: { content: 'ブロックでない' } })).toEqual([]);
  });

  it('ツールごとの入力の詳細（Agent はプロンプト、Workflow はスクリプト、Edit・Write は空、ほかは JSON。長いものは切る）', () => {
    const detail = (name: string, input: Record<string, unknown>) => (events(assistant([{ type: 'tool_use', id: 't', name, input }]))[0] as Extract<ChatEvent, { type: 'tool-use' }>);
    expect(detail('Agent', { description: '調べもの', prompt: 'サブエージェントの仕事です' })).toMatchObject({ input: 'サブエージェントの仕事です', target: '調べもの', description: '調べもの' });
    expect(detail('Task', { prompt: 7 }).input).toBe('');
    const script = "export const meta = { name: 'tanacode-check' }";
    expect(detail('Workflow', { script })).toMatchObject({ input: script, target: 'tanacode-check' });
    expect(detail('Workflow', { scriptPath: '/s.js', resumeFromRunId: 'wf_1' }).input).toBe(JSON.stringify({ scriptPath: '/s.js', resumeFromRunId: 'wf_1' }, null, 2));
    expect(detail('Edit', { file_path: `${CWD}/sub/code.txt`, old_string: '二行目', new_string: '2 行目' })).toMatchObject({ input: '', target: 'sub/code.txt', filePath: `${CWD}/sub/code.txt` });
    expect(detail('Write', { file_path: '/elsewhere/new.txt', content: 'あ\n' })).toMatchObject({ input: '', target: '/elsewhere/new.txt' });
    expect(detail('MultiEdit', { file_path: `${CWD}/a.ts`, edits: [] }).input).toBe('');
    expect(detail('Bash', { command: 'ls' }).input).toBe('ls');
    expect(detail('Bash', { description: '説明だけ' }).input).toBe('# 説明だけ');
    const long = detail('Grep', { pattern: 'x'.repeat(3100) }).input;
    expect(long.endsWith('\n…（省略）')).toBe(true);
    expect(long).toHaveLength(3000 + '\n…（省略）'.length);
    // 説明が空白だけなら付けない
    expect(detail('Bash', { command: 'ls', description: '  ' }).description).toBeUndefined();
  });

  it('ToDo（TodoWrite の一覧・TaskCreate・TaskUpdate）と、SendUserFile で送ったファイル', () => {
    const tool = (name: string, input: Record<string, unknown>) => events(assistant([{ type: 'tool_use', id: 't', name, input }]))[0] as Extract<ChatEvent, { type: 'tool-use' }>;
    const todos = [{ content: '読む', status: 'completed', activeForm: '読んでいます' }];
    expect(tool('TodoWrite', { todos }).todos).toEqual(todos);
    expect(tool('TodoWrite', { todos: 'なし' }).todos).toBeUndefined();
    expect(tool('TaskCreate', { subject: 'テストを書く', activeForm: 'テストを書いています' }).taskChange).toEqual({ kind: 'create', subject: 'テストを書く', activeForm: 'テストを書いています' });
    expect(tool('TaskCreate', { subject: '' }).taskChange).toBeUndefined();
    expect(tool('TaskUpdate', { taskId: '1', status: 'completed' }).taskChange).toEqual({ kind: 'update', taskId: '1', status: 'completed', subject: undefined, activeForm: undefined });
    expect(tool('TaskUpdate', { task_id: '2', subject: '名前', activeForm: 'x' }).taskChange).toEqual({ kind: 'update', taskId: '2', status: undefined, subject: '名前', activeForm: 'x' });
    expect(tool('TaskUpdate', { status: 'completed' }).taskChange).toBeUndefined();
    const sent = tool('SendUserFile', { files: ['./out/report.pdf', '/tmp/a.png', 3], caption: ' 結果です ' });
    expect(sent).toMatchObject({ target: 'report.pdf, a.png', sentFiles: { paths: [`${CWD}/out/report.pdf`, '/tmp/a.png'], caption: '結果です' } });
    expect(tool('SendUserFile', { files: [], caption: '  ' }).sentFiles).toEqual({ paths: [], caption: null });
    expect(tool('SendUserFile', {}).sentFiles).toEqual({ paths: [], caption: null });
  });

  it('API エラーの応答は api-error に、再開時に差し込まれる「No response requested.」は出さない', () => {
    // 2.1.292 の 400 の応答
    const error = assistant([{ type: 'text', text: 'API Error: 400 テストの不正なリクエストです' }], {
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 400 テストの不正なリクエストです' }] },
      isApiErrorMessage: true,
    });
    expect(events(error)).toEqual([{ type: 'api-error', id: 'a1', text: 'API Error: 400 テストの不正なリクエストです', retrying: false }]);
    expect(events({ type: 'assistant', isApiErrorMessage: true, message: { model: 'x', content: [{ type: 'image' }] } })).toEqual([
      { type: 'api-error', id: '', text: 'API エラー', retrying: false },
    ]);
    // 2.1.292 の、中断した会話を再開したときの埋め合わせ
    expect(events({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] }, isApiErrorMessage: false })).toEqual([]);
    expect(events({ type: 'assistant', message: { model: '<synthetic>', content: [] } })).toEqual([]);
  });

  it('チェックリスト・ウォークスルーのツールは、それぞれの見出しを対象にする', () => {
    const target = (name: string, input: Record<string, unknown>) => (events(assistant([{ type: 'tool_use', id: 't', name, input }]))[0] as Extract<ChatEvent, { type: 'tool-use' }>).target;
    expect(target('mcp__tanacode-checklist__card_get', { list: 'やること', number: 3 })).toBe('やること #3');
    expect(target('mcp__tanacode-walkthrough__show_code', { path: `${CWD}/src/tax.ts`, start_line: 12, end_line: 20 })).toBe('src/tax.ts:12-20');
  });
});

describe('toChatEvents: ツールの結果', () => {
  it('Bash の結果と、失敗したツールの結果を出す', () => {
    // 2.1.292 の Bash の結果
    expect(events(result('toolu_bash', 'tanacode-check', { stdout: 'tanacode-check', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, false))).toEqual([
      { type: 'tool-result', id: 'toolu_bash', isError: false, patch: undefined, output: 'tanacode-check', images: undefined, answers: undefined, createdTaskId: undefined, at },
    ]);
    // 2.1.292 の、exit 3 で失敗した Bash
    expect(events(result('toolu_fail', 'Exit code 3\ntanacode-fail', 'Error: Exit code 3\ntanacode-fail', true))[0]).toMatchObject({ isError: true, output: 'Exit code 3\ntanacode-fail' });
    // 空・長い結果
    expect(events(result('t', '   '))[0]).toMatchObject({ output: undefined });
    const long = (events(result('t', 'y'.repeat(3005)))[0] as Extract<ChatEvent, { type: 'tool-result' }>).output!;
    expect(long).toBe(`${'y'.repeat(3000)}\n…（5 文字省略）`);
    // 文字の無い文字のブロック
    expect(events(result('t', [{ type: 'text' }, { type: 'text', text: '本文' }]))[0]).toMatchObject({ output: '本文' });
    // 本文が文字でもブロックの配列でもない
    expect(events(result('t', { unexpected: true }))[0]).toMatchObject({ output: undefined });
  });

  it('Edit・Write は差分と変えた行の数・最初に変えた行を出し、結果の文は載せない', () => {
    // 2.1.292 の Edit の結果
    const edit = result('toolu_edit', 'The file /work/app/notes.txt has been updated successfully.', {
      filePath: `${CWD}/notes.txt`,
      oldString: 'three',
      newString: 'THREE\nthree-and-half',
      originalFile: 'one\ntwo\nthree\nfour\n',
      structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, lines: [' one', ' two', '-three', '+THREE', '+three-and-half', ' four'] }],
      userModified: false,
      replaceAll: false,
    });
    expect(events(edit)[0]).toMatchObject({
      type: 'tool-result',
      isError: false,
      added: 2,
      removed: 1,
      filePath: `${CWD}/notes.txt`,
      line: 3,
      output: undefined,
      patch: ['@@ -1,4 +1,5 @@', ' one', ' two', '-three', '+THREE', '+three-and-half', ' four'],
    });
    // 2.1.292 の Write（新しいファイル）の結果
    const write = result('toolu_write', 'File created successfully at: /work/app/new.txt', {
      type: 'create',
      filePath: `${CWD}/new.txt`,
      content: 'あ\nい\n',
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    });
    expect(events(write)[0]).toMatchObject({ added: 2, removed: 0, filePath: `${CWD}/new.txt`, line: 1, output: undefined, patch: ['+あ', '+い'] });
    // 変更の無い行だけの hunk は、hunk の始まりを最初の行にする
    const context = result('t', 'ok', { filePath: `${CWD}/a.ts`, structuredPatch: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: [' 同じ'] }] });
    expect(events(context)[0]).toMatchObject({ added: 0, removed: 0, line: 5 });
    // 長い差分は 300 行まで
    const big = result('t', 'ok', { type: 'create', filePath: `${CWD}/big.txt`, content: Array.from({ length: 305 }, (_, i) => `${i}`).join('\n') });
    const patch = (events(big)[0] as Extract<ChatEvent, { type: 'tool-result' }>).patch!;
    expect(patch).toHaveLength(301);
    expect(patch.at(-1)).toBe('…（5 行省略）');
    // 書けなかったとき（toolUseResult はエラーの文）は、結果の文を載せる
    const failed = events(result('t', 'File has not been read yet.', 'Error: File has not been read yet.', true))[0] as Extract<ChatEvent, { type: 'tool-result' }>;
    expect(failed).toMatchObject({ isError: true, output: 'File has not been read yet.' });
    expect(failed.filePath).toBeUndefined();
    // 差分の無い結果
    const plain = events(result('t', 'ok', { type: 'update', structuredPatch: [] }))[0] as Extract<ChatEvent, { type: 'tool-result' }>;
    expect([plain.patch, plain.added, plain.removed, plain.line, plain.output]).toEqual([undefined, undefined, undefined, undefined, 'ok']);
  });

  it('AskUserQuestion の答えと、TaskCreate で作った番号を出す', () => {
    // 2.1.292 の AskUserQuestion の結果
    const ask = result('toolu_ask', 'Your questions have been answered: "どちらの書き方にしますか？"="です・ます".', {
      questions: [
        { question: 'どちらの書き方にしますか？', header: '書き方', options: [{ label: 'です・ます', description: '丁寧な書き方' }], multiSelect: false },
        { question: '答えなかった質問', header: 7 },
        null,
      ],
      answers: { 'どちらの書き方にしますか？': 'です・ます' },
      annotations: {},
    });
    expect((events(ask)[0] as Extract<ChatEvent, { type: 'tool-result' }>).answers).toEqual([
      { header: '書き方', question: 'どちらの書き方にしますか？', answer: 'です・ます' },
      { header: '', question: '答えなかった質問', answer: '（回答なし）' },
      { header: '', question: '', answer: '（回答なし）' },
    ]);
    expect((events(result('t', 'x', { questions: [] }))[0] as Extract<ChatEvent, { type: 'tool-result' }>).answers).toBeUndefined();
    expect(events(result('t', 'Task #1 created', { task: { id: '1', subject: 'テストを書く' } }))[0]).toMatchObject({ createdTaskId: '1' });
    expect(events(result('t', 'error', { task: { id: '1' } }, true))[0]).toMatchObject({ createdTaskId: undefined });
    expect(events(result('t', 'ok', { task: 'x' }))[0]).toMatchObject({ createdTaskId: undefined });
  });

  it('バックグラウンドで起動したもの（Agent・Workflow）の結果の文は、Claude 向けなので載せない', () => {
    // 2.1.292 の Agent の起動の結果
    const launched = result('toolu_agent', [{ type: 'text', text: 'Async agent launched successfully.' }], { isAsync: true, status: 'async_launched', agentId: 'acc4e89e2bbe86674' });
    expect(events(launched)[0]).toMatchObject({ output: undefined });
  });

  it('画像の結果は、画像の受け手に渡して鍵を載せる。受け手が無ければ「[画像]」と書く', () => {
    const images = new Map<string, string>();
    const read = result('toolu_image', [image('image/png'), { type: 'text', text: '' }, { type: 'image', source: { type: 'url', url: 'https://x' } }]);
    expect(events(read, false, images)[0]).toMatchObject({ images: ['u1:r0-0'], output: undefined });
    expect(images.get('u1:r0-0')).toBe(`data:image/png;base64,${PNG}`);
    expect(events(read)[0]).toMatchObject({ images: undefined, output: '[画像]\n\n[画像]' });
  });

  it('PreToolUse の hooks で止めたツールは、結果の文から hooks の記録を作る', () => {
    // 2.1.292 の、PreToolUse の hooks で止めた Bash の結果
    const text = 'PreToolUse:Bash hook error: [if [ -n "$(grep tanacode-forbidden)" ]; then echo "禁止のコマンドです" >&2; exit 2; fi]: 禁止のコマンドです\n';
    const entry = result('toolu_blocked', text, `Error: ${text}`, true);
    expect(events(entry)).toEqual([
      expect.objectContaining({ type: 'tool-result', id: 'toolu_blocked', isError: true }),
      {
        type: 'hook',
        id: 'u1:hook',
        run: {
          event: 'PreToolUse',
          name: 'PreToolUse:Bash',
          command: 'if [ -n "$(grep tanacode-forbidden)" ]; then echo "禁止のコマンドです" >&2; exit 2; fi',
          outcome: 'blocked',
          exitCode: null,
          durationMs: null,
          stdout: '',
          stderr: '',
          message: '禁止のコマンドです',
          toolUseId: 'toolu_blocked',
        },
      },
    ]);
    // ツールの名前の無い形・uuid の無い行
    const plain = { ...result('t', 'Stop hook error: [x]: だめ', undefined, true), uuid: undefined };
    expect(events(plain)[1]).toMatchObject({ id: ':hook', run: { event: 'Stop', name: 'Stop', command: 'x', message: 'だめ' } });
    // 失敗でない結果・形の違う文は hooks にしない
    expect(events(result('t', text, undefined, false))).toHaveLength(1);
    expect(events(result('t', 'Exit code 1', undefined, true))).toHaveLength(1);
    expect(events(result('t', [{ type: 'image', source: { type: 'url' } }], undefined, true))).toHaveLength(1);
  });

  it('ツールの結果の行の文字のブロックは発言として出し、ツールの結果の行の画像は発言に付けない', () => {
    // 2.1.292 の、ツールの実行中に中断したときの行
    const interrupted = user([{ type: 'text', text: '[Request interrupted by user for tool use]' }], { interruptedMessageId: 'msg_mock_5' });
    expect(events(interrupted)).toEqual([{ type: 'turn-end', interrupted: true }]);
    const mixed = user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }, { type: 'text', text: '続けて' }, image()]);
    const images = new Map<string, string>();
    expect(events(mixed, false, images)).toEqual([
      expect.objectContaining({ type: 'tool-result', id: 't' }),
      { type: 'user', id: 'u1', text: '続けて', at },
    ]);
    expect(images.size).toBe(0);
    // tool_use_id の無い結果・空の文字は出さない
    expect(events(user([{ type: 'tool_result', content: 'x' }, { type: 'text', text: '' }]))).toEqual([]);
  });
});

describe('toChatEvents: 発言の行', () => {
  it('ふつうの発言・画像を添付した発言・画像だけの発言', () => {
    // 2.1.292 の発言
    expect(events(user('確認を始めてください', { origin: { kind: 'human' } }))).toEqual([{ type: 'user', id: 'u1', text: '確認を始めてください', at }]);
    const images = new Map<string, string>();
    expect(events(user([{ type: 'text', text: 'この画面を直して' }, image(), image()]), false, images)).toEqual([
      { type: 'user', id: 'u1', text: 'この画面を直して', at, images: ['u1:u1', 'u1:u2'] },
    ]);
    expect(events(user([image()]), false, images)).toEqual([{ type: 'user', id: 'u1', text: '', images: ['u1:u0'], at }]);
    expect(events({ type: 'user', message: { content: [image()] as never } }, false, images)).toEqual([{ type: 'user', id: '', text: '', images: [':u0'], at: undefined }]);
    // 発言の前にお知らせがある行でも、画像は発言に付ける
    expect(events(user([{ type: 'text', text: '<bash-stdout>x</bash-stdout>' }, { type: 'text', text: 'お願い' }, image()]), false, images)).toEqual([
      { type: 'shell-output', id: 'u1', output: 'x' },
      { type: 'user', id: 'u1', text: 'お願い', at, images: ['u1:u2'] },
    ]);
    // 時刻が読めない行
    expect(events(user('x', { timestamp: 'いつか' }))).toEqual([{ type: 'user', id: 'u1', text: 'x', at: undefined }]);
    expect(events({ type: 'user' })).toEqual([]);
  });

  it('メタの行・圧縮の要約・会話ログにだけ見える行は出さない。別の Claude からの知らせは、ターンの始まりだけを伝える', () => {
    // 2.1.292 の /compact のあとの要約と、/rename の知らせ
    expect(events(user('This session is being continued from a previous conversation…', { isCompactSummary: true, isVisibleInTranscriptOnly: true }))).toEqual([]);
    expect(events(user('<system-reminder>\nThe user named this session "控えの名前".\n</system-reminder>', { isMeta: true }))).toEqual([]);
    expect(events(user('ログにだけ', { isVisibleInTranscriptOnly: true }))).toEqual([]);
    const peer = user('<agent-message from="a1">報告です</agent-message>', { isMeta: true, origin: { kind: 'peer' } });
    expect(events(peer)).toEqual([{ type: 'turn-start' }]);
    // サブエージェントの会話ログでは、ターンの始まりにしない
    expect(events({ ...peer, isSidechain: true }, true)).toEqual([]);
    expect(events({ ...user('サブエージェントの発言'), isSidechain: true })).toEqual([]);
    expect(events({ ...user('サブエージェントの発言'), isSidechain: true }, true)).toEqual([{ type: 'user', id: 'u1', text: 'サブエージェントの発言', at }]);
  });

  it('中断・ローカルのコマンドの出力はターンの終わり。/compact は出さず、ほかのコマンドは名前と引数を発言にする', () => {
    // 2.1.292 の、応答を待つ間に中断したときの行
    expect(events(user([{ type: 'text', text: '[Request interrupted by user]' }], { interruptedMessageId: 'msg_mock_3' }))).toEqual([{ type: 'turn-end', interrupted: true }]);
    expect(events(user('[Request interrupted by user]'))).toEqual([{ type: 'turn-end', interrupted: true }]);
    // 2.1.292 の /compact と /clear の記録
    expect(events(user('<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'))).toEqual([]);
    expect(events(user('<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>'))).toEqual([{ type: 'turn-end' }]);
    expect(events(user('<local-command-caveat>The command below was run directly in Claude Code…</local-command-caveat>'))).toEqual([{ type: 'turn-end' }]);
    expect(events(user('<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>'))).toEqual([{ type: 'user', id: 'u1', text: '/clear', at, command: true }]);
    expect(events(user('<command-name>/model</command-name><command-args> opus </command-args>'))).toEqual([{ type: 'user', id: 'u1', text: '/model opus', at, command: true }]);
  });

  it('! のコマンドは、コマンドの行と出力の行に分けて出す（前の Claude Code の 1 行の形も読む）', () => {
    // 2.1.292 の ! のコマンド
    expect(events(user('<bash-input>echo tanacode-shell</bash-input>'))).toEqual([{ type: 'shell', id: 'u1', command: 'echo tanacode-shell', output: '' }]);
    expect(events(user('<bash-stdout>tanacode-shell</bash-stdout><bash-stderr></bash-stderr>'))).toEqual([{ type: 'shell-output', id: 'u1', output: 'tanacode-shell' }]);
    expect(events(user('<bash-stderr>エラー</bash-stderr>'))).toEqual([{ type: 'shell-output', id: 'u1', output: 'エラー' }]);
    expect(events(user('<bash-input> ls </bash-input><bash-stdout>a.ts\n</bash-stdout><bash-stderr>警告</bash-stderr>'))).toEqual([{ type: 'shell', id: 'u1', command: 'ls', output: 'a.ts\n警告' }]);
  });

  it('完了通知は、要約をお知らせにする（要約が無ければ決まった文）', () => {
    // 2.1.292 の、待機中に届いた完了通知
    const text = '<task-notification>\n<task-id>blktx4qxr</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command "裏で待つ" completed (exit code 0)</summary>\n</task-notification>';
    expect(events(user(text, { origin: { kind: 'task-notification' } }))).toEqual([{ type: 'notice', id: 'u1', text: 'Background command "裏で待つ" completed (exit code 0)' }]);
    expect(events(user('<task-notification><status>killed</status></task-notification>'))).toEqual([{ type: 'notice', id: 'u1', text: 'バックグラウンドのタスクが終わりました' }]);
  });

  it('親セッションからの指示・子セッションの知らせ・チェックリストの知らせを見分ける', () => {
    const parent = '0f8c2a1e-0000-4000-8000-000000000001';
    const child = '1a2b3c4d-0000-4000-8000-000000000002';
    expect(events(user(parentMessageText(parent, '<pasted_content id="1">\n一行目\n二行目\n</pasted_content id="1">')))).toEqual([
      { type: 'user', id: 'u1', text: '一行目\n二行目', at, parent },
    ]);
    expect(events(user(sessionEventText([child], '子のセッションの作業が終わりました')))).toEqual([
      { type: 'notice', id: 'u1', text: '子のセッションの作業が終わりました', sessions: [child] },
    ]);
    const cards = [{ listId: 'ab12', cardId: 'cd34' }];
    expect(events(user(checklistEventText(cards, '「やること」#1 に人が返信しました')))).toEqual([{ type: 'notice', id: 'u1', text: '「やること」#1 に人が返信しました', cards }]);
    // 長いものは、目印のタグごと貼り付けの囲みに入って会話ログに残る。囲みを外して見分ける
    const wrap = (text: string) => `\n\n<pasted_content id="7">\n${text}\n</pasted_content id="7">\n`;
    expect(events(user(wrap(parentMessageText(parent, '一行目\n二行目'))))).toEqual([{ type: 'user', id: 'u1', text: '一行目\n二行目', at, parent }]);
    expect(events(user(wrap(sessionEventText([child], '子のセッションの作業が終わりました'))))).toEqual([
      { type: 'notice', id: 'u1', text: '子のセッションの作業が終わりました', sessions: [child] },
    ]);
    expect(events(user(wrap(checklistEventText(cards, '「やること」#1 に人が返信しました'))))).toEqual([
      { type: 'notice', id: 'u1', text: '「やること」#1 に人が返信しました', cards },
    ]);
    expect(isHumanPrompt(wrap(sessionEventText([child], '知らせ')))).toBe(false);
    expect(isHumanPrompt(wrap(wakeupText('予約')))).toBe(false);
    expect(isHumanPrompt(wrap(parentMessageText(parent, '親からの指示')))).toBe(true);
    expect(transcriptTitle(user(wrap(parentMessageText(parent, '子への長い指示\n二行目'))))).toEqual({ title: '子への長い指示', priority: 1 });
  });

  // Claude Code は、順番待ちの発言をまとめて 1 つの発言の行にする。本文は送った順に改行 1 つでつなぎ、行の uuid は最後に送ったもの、
  // mergedSendUuids はそれより前に送ったもの（送った順）（2.1.303 で実測。3 通を 1 行にしたもの）
  it('順番待ちの発言をまとめた行（mergedSendUuids）は、送った発言ごとに分ける。親の指示は 1 つずつの発言、知らせは 1 つずつのお知らせ', () => {
    const parent = '0f8c2a1e-0000-4000-8000-000000000001';
    const child = '1a2b3c4d-0000-4000-8000-000000000002';
    const three = [parentMessageText(parent, '指示 A'), parentMessageText(parent, '指示 B\n2 行目'), parentMessageText(parent, '指示 C')].join('\n');
    // 直す前は、1 つの発言として読み、本文の途中に閉じタグと開きタグが文字で出ていた
    expect(events(user(three, { uuid: 'u3', mergedSendUuids: ['u1', 'u2'] }))).toEqual([
      { type: 'user', id: 'u1', text: '指示 A', at, parent },
      { type: 'user', id: 'u2', text: '指示 B\n2 行目', at, parent },
      { type: 'user', id: 'u3', text: '指示 C', at, parent },
    ]);
    // 親の指示と子の知らせ・予約が混ざっていても分ける
    const mixed = [sessionEventText([child], '子の作業が終わりました'), parentMessageText(parent, '次はこれ'), wakeupText('予約の本文')].join('\n');
    expect(events(user(mixed, { uuid: 'u3', mergedSendUuids: ['u1', 'u2'] }))).toEqual([
      { type: 'notice', id: 'u1', text: '子の作業が終わりました', sessions: [child] },
      { type: 'user', id: 'u2', text: '次はこれ', at, parent },
      { type: 'notice', id: 'u3', text: 'Claude の予約の時刻になりました', detail: '予約の本文' },
    ]);
    // 囲みの無い発言どうし（人が書いた予約）は分けられない。分けた最後の部分が、行の uuid
    expect(events(user(['人の予約 1', '人の予約 2', parentMessageText(parent, '指示')].join('\n'), { uuid: 'u3', mergedSendUuids: ['u1', 'u2'] }))).toEqual([
      { type: 'user', id: 'u1', text: '人の予約 1\n人の予約 2', at },
      { type: 'user', id: 'u3', text: '指示', at, parent },
    ]);
    // まとめた行でなければ分けない（1 つの発言の中の囲みのタグは、そのまま）
    expect(events(user(`前置き\n${parentMessageText(parent, '指示')}`))).toEqual([{ type: 'user', id: 'u1', text: `前置き\n${parentMessageText(parent, '指示')}`, at }]);
    // 一覧の名前は、はじめに送った発言から
    expect(transcriptTitle(user(three, { uuid: 'u3', mergedSendUuids: ['u1', 'u2'] }))).toEqual({ title: '指示 A', priority: 1 });
  });

  it('unsentView: 送信中・順番待ちには、会話に出たときと同じ形で出す。親の指示は囲みを外して親の ID を付け、知らせは出さない', () => {
    const parent = 'abcd1234-0000-0000-0000-000000000000';
    expect(unsentView('ログインを直して')).toEqual({ text: 'ログインを直して', pastes: [] });
    expect(unsentView(parentMessageText(parent, 'テストも直して'))).toEqual({ text: 'テストも直して', pastes: [], parent });
    expect(unsentView('見て\n\n<pasted_content id="1">\nログ\n</pasted_content id="1">\n')).toEqual({ text: '見て', pastes: ['ログ'] });
    expect(unsentView(sessionEventText(['abcdef12'], '子の作業が終わりました'))).toBeNull();
    expect(unsentView(wakeupText('予約の本文'))).toBeNull();
    expect(unsentView(checklistEventText([{ listId: 'ab12', cardId: 'cd34' }], '返信がありました'))).toBeNull();
  });

  it('プランの利用枠に当たって止まった行（2.1.296・2.1.302 の実物の形）は、枠が戻る時刻と当たった枠の付いた api-error にし、英語の文の代わりに戻る時刻を出す', () => {
    const resetsAt = 1_792_163_400_000;
    const info = { status: 'rejected', resetsAt: resetsAt / 1000, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false };
    const limited = (extra: Record<string, unknown>) =>
      assistant([{ type: 'text', text: "You've hit your session limit · resets 5am (Asia/Tokyo)" }], {
        message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 5am (Asia/Tokyo)" }] },
        isApiErrorMessage: true,
        apiError: 'usage_limit_reached',
        error: 'rate_limit',
        ...extra,
      });
    const time = formatScheduleTime(resetsAt);
    expect(events(limited({ apiErrorParams: { rate_limit_info: info }, quotaLimits: { ...info, unifiedRateLimitFallbackAvailable: false } }))).toEqual([
      { type: 'api-error', id: 'a1', text: `5 時間の利用枠の上限に達したので、止まりました（${time} に戻ります）`, retrying: false, limit: { resetsAt, window: 'five_hour' } },
    ]);
    // 週の枠（モデル別の週の枠も）・知らない枠・rate_limit_info が無く quotaLimits だけのもの
    expect(events(limited({ apiErrorParams: { rate_limit_info: { ...info, rateLimitType: 'seven_day_opus' } } }))[0]).toMatchObject({ text: `週の利用枠の上限に達したので、止まりました（${time} に戻ります）` });
    expect(events(limited({ quotaLimits: { ...info, rateLimitType: 'overage' } }))[0]).toMatchObject({ text: `利用枠の上限に達したので、止まりました（${time} に戻ります）`, limit: { resetsAt, window: 'overage' } });
    // 時刻の無いもの（2.1.289 は文だけ）は、Claude Code の文のまま。時刻が分からないことは limit に残す
    expect(events(limited({}))).toEqual([{ type: 'api-error', id: 'a1', text: "You've hit your session limit · resets 5am (Asia/Tokyo)", retrying: false, limit: { resetsAt: null, window: null } }]);
    // 利用枠でない API エラーには付けない
    expect(usageLimitOf({ isApiErrorMessage: true, apiError: 'overloaded' })).toBeNull();
    expect(usageLimitOf({ apiError: 'usage_limit_reached' })).toBeNull();
    expect(usageLimitOf({ isApiErrorMessage: true, apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: { resetsAt: 'soon', rateLimitType: '' } } })).toEqual({ resetsAt: null, window: null });
  });

  it('利用枠が戻ったのでアプリが送った再開のメッセージは、「利用枠が戻ったので、続きを頼みました」の知らせにし、開くと本文が読める。人の発言・一覧のタイトルにしない', () => {
    const body = usageResumeText().replace(/^<[^>]+>\n/, '').replace(/\n<\/[^>]+>$/, '');
    expect(events(user(usageResumeText()))).toEqual([{ type: 'notice', id: 'u1', text: '利用枠が戻ったので、続きを頼みました', detail: body }]);
    expect(events(user(`<pasted_content id="7">\n${usageResumeText()}\n</pasted_content id="7">`))[0]).toMatchObject({ type: 'notice', text: '利用枠が戻ったので、続きを頼みました' });
    expect(isHumanPrompt(usageResumeText())).toBe(false);
    expect(transcriptTitle(user(usageResumeText()))).toBeNull();
    expect(unsentView(usageResumeText())).toBeNull();
    expect(events(user(`${usageResumeText()} これは人の発言`))[0]).toMatchObject({ type: 'user' });
  });

  it('Claude が自分に入れた予約の知らせは「Claude の予約の時刻になりました」の知らせにし、開くと本文が読める。人の発言・一覧のタイトルにしない', () => {
    const notice = { type: 'notice', id: 'u1', text: 'Claude の予約の時刻になりました', detail: '子の状態を get_session で確かめる\n終わっていなければ、次の予約を入れる' };
    const body = '子の状態を get_session で確かめる\n終わっていなければ、次の予約を入れる';
    expect(events(user(wakeupText(body)))).toEqual([notice]);
    // 長いものは、全体が貼り付けの囲みに入ることがある。本文だけが囲みに入っていることもある
    expect(events(user(`<pasted_content id="7">\n${wakeupText(body)}\n</pasted_content id="7">`))).toEqual([notice]);
    expect(events(user(wakeupText(`<pasted_content id="8">\n${body}\n</pasted_content id="8">`)))).toEqual([notice]);
    expect(events({ type: 'user', message: { content: wakeupText('x') } })[0]).toMatchObject({ type: 'notice', id: '' });
    expect(isHumanPrompt(wakeupText('x'))).toBe(false);
    expect(transcriptTitle(user(wakeupText('x')))).toBeNull();
    // 囲みの外に文が続くもの（人が打った文）は、人の発言のまま
    expect(events(user(`${wakeupText('x')} これは人の発言`))[0]).toMatchObject({ type: 'user' });
  });

  it('打った文に添えた長い貼り付け（入力欄の札）は、発言の文と分けて pastes に入れる', () => {
    // Claude Code 2.1.296 が会話ログに残す形（札 2 つ。囲みの id は、同じ会話の中では同じ）
    const block = (text: string) => `<pasted_content id="c8a6">\n${text}\n</pasted_content id="c8a6">\n`;
    const log = 'ログの 1 行目\n2 行目\n3 行目\n4 行目';
    const long = 'a'.repeat(900);
    expect(events(user(`このログを見てください。\n\n${block(log)}\n\n${block(long)}`))).toEqual([
      { type: 'user', id: 'u1', text: 'このログを見てください。', pastes: [log, long], at },
    ]);
    expect(splitPasted(`文\n\n${block(log)}`)).toEqual({ text: '文', pastes: [log], whole: false });
    // 札だけを 2 つ送った発言
    expect(splitPasted(`\n\n${block(log)}\n\n${block(long)}`)).toEqual({ text: '', pastes: [log, long], whole: false });
    // 貼り付けの無い発言は、そのまま
    expect(splitPasted('ふつうの発言\n2 行目')).toEqual({ text: 'ふつうの発言\n2 行目', pastes: [], whole: false });
  });

  it('全体が 1 つの貼り付けだけの発言は、札にせず、文として出す（前のアプリが丸ごと貼り付けで送った、複数行の発言）', () => {
    const whole = '\n\n<pasted_content id="7">\n1 行目\n2 行目\n3 行目\n4 行目\n</pasted_content id="7">\n';
    // 中身はユーザーが打った文とは限らないので、印（pasted）を付ける
    expect(events(user(whole))).toEqual([{ type: 'user', id: 'u1', text: '1 行目\n2 行目\n3 行目\n4 行目', pasted: true, at }]);
    // 囲みのあとに文が続くなど、決まった形でないものは、囲みだけを外して全部を文にする
    expect(splitPasted('前\n\n<pasted_content id="7">\n中\n</pasted_content id="7">\nあと')).toEqual({ text: '前\n\n中\nあと', pastes: [], whole: false });
    expect(splitPasted('前 <pasted_content id="7"> 閉じていない')).toEqual({ text: '前  閉じていない', pastes: [], whole: false });
  });

  it('CI の自動修正の知らせ・スケジュールタスクの起動は、お知らせにして全文を添える', () => {
    const ci = (body: string) => events(user(`<ci-monitor-event>${body}</ci-monitor-event>`))[0];
    expect(ci('You are monitoring PR #16405.\n\nThe PR #16405 has 1 new review comment (quoted below).\n\n> 直してください')).toMatchObject({
      type: 'notice',
      text: 'CI の自動修正（PR #16405）: 新しいレビューコメント 1 件',
      detail: 'You are monitoring PR #16405.\n\nThe PR #16405 has 1 new review comment (quoted below).\n\n> 直してください',
    });
    expect(ci('You are monitoring PR #8.\n\nThe PR #8 has 3 new review comments.')).toMatchObject({ text: 'CI の自動修正（PR #8）: 新しいレビューコメント 3 件' });
    expect(ci('You are monitoring PR #8.\n\nThe PR #8 CI failed on main. See logs.')).toMatchObject({ text: 'CI の自動修正（PR #8）: CI failed on main.' });
    expect(ci('知らせ')).toMatchObject({ text: 'CI の自動修正: 知らせが届きました', detail: '知らせ' });
    expect(events(user('<scheduled-task name="朝の確認">\n毎朝の作業です\n</scheduled-task>'))).toEqual([{ type: 'notice', id: 'u1', text: 'スケジュールタスク「朝の確認」の実行', detail: '毎朝の作業です' }]);
    expect(events(user('<scheduled-task>中身</scheduled-task>'))).toEqual([{ type: 'notice', id: 'u1', text: 'スケジュールタスクの実行', detail: '中身' }]);
  });
});

describe('toChatEvents: 未知のイベント', () => {
  // 名前・わけ・ID・バージョン
  const brief = (entry: TranscriptEntry) => events(entry).map((e) => (e.type === 'unknown-event' ? [e.name, e.problem, e.id, e.version] : e.type));

  it('知らない種類の行・system の行・attachment・応答と発言のブロックを、未知のイベントとして出す。ID は行の uuid（ブロックは位置も）', () => {
    const v = { version: '2.1.302' };
    expect(brief({ type: 'brand-new', uuid: 'n1', ...v })).toEqual([['brand-new', 'unknown', 'unknown:n1', '2.1.302']]);
    expect(brief(system('brand_new_notice', { content: '新しい知らせ', ...v }))).toEqual([['system/brand_new_notice', 'unknown', 'unknown:s1', '2.1.302']]);
    expect(brief(attachment({ type: 'max_turns_reached', maxTurns: 3 }))).toEqual([['attachment/max_turns_reached', 'unknown', 'unknown:at1', undefined]]);
    expect(brief(assistant([{ type: 'text', text: '調べます' }, { type: 'server_tool_use', id: 'srv_1', name: 'web_search' }], v))).toEqual([
      'assistant-text',
      ['assistant/server_tool_use', 'unknown', 'unknown:a1:1', '2.1.302'],
    ]);
    expect(brief(user([{ type: 'text', text: '読んで' }, { type: 'document', source: { type: 'base64' } }]))).toEqual(['user', ['user/document', 'unknown', 'unknown:u1:1', undefined]]);
    // 生の行は、整形した行の全体（ブロックは、そのブロックだけ）
    const [line] = events({ type: 'brand-new', uuid: 'n1', value: 1 } as TranscriptEntry);
    expect(line).toMatchObject({ source: 'transcript', raw: JSON.stringify({ type: 'brand-new', uuid: 'n1', value: 1 }, null, 2) });
    const [, block] = events(assistant([{ type: 'text', text: 'x' }, { type: 'server_tool_use', id: 'srv_1' }]));
    expect(block).toMatchObject({ raw: JSON.stringify({ type: 'server_tool_use', id: 'srv_1' }, null, 2) });
  });

  it('形の違う行（種類の欄が無い・system の subtype が無い・ブロックの type が無い）は、形の違う行として出す。uuid が無ければ連番の ID', () => {
    expect(brief({ uuid: 'x1' })).toEqual([['', 'malformed', 'unknown:x1', undefined]]);
    expect(brief({ type: 'system', uuid: 'x2' })).toEqual([['system', 'malformed', 'unknown:x2', undefined]]);
    expect(brief(assistant([{ text: '型が無い' }]))).toEqual([['assistant/', 'malformed', 'unknown:a1:0', undefined]]);
    expect(brief({ type: 'brand-new' })).toEqual([['brand-new', 'unknown', expect.stringMatching(/^unknown:n\d+$/), undefined]]);
    expect(brief({ type: 'assistant', message: { content: [{ type: 'server_tool_use' }] } } as TranscriptEntry)).toEqual([
      ['assistant/server_tool_use', 'unknown', expect.stringMatching(/^unknown:n\d+$/), undefined],
    ]);
  });

  it('チャットの外で使う行と、意図して捨てる行（ふだんから会話ログに出る付帯情報・Claude への文脈など）は出さない', () => {
    const known: TranscriptEntry[] = [
      { type: 'mode', mode: 'normal' } as TranscriptEntry,
      { type: 'permission-mode', permissionMode: 'default' },
      { type: 'atis-latch' } as TranscriptEntry,
      { type: 'file-history-snapshot', messageId: 'm1' } as TranscriptEntry,
      { type: 'file-history-delta' } as TranscriptEntry,
      { type: 'last-prompt' } as TranscriptEntry,
      { type: 'api-request' } as TranscriptEntry,
      { type: 'api-request-blob' } as TranscriptEntry,
      { type: 'api-request-shape' } as TranscriptEntry,
      { type: 'queue-operation' } as TranscriptEntry,
      { type: 'worktree-state' } as TranscriptEntry,
      { type: 'agent-name' } as TranscriptEntry,
      { type: 'cost-state' } as TranscriptEntry,
      { type: 'summary' } as TranscriptEntry,
      { type: 'custom-title', customTitle: '名前' },
      { type: 'ai-title', aiTitle: '名前' },
      // 形の足りない、知っている種類の行（ほかの欄が無いので読まないだけ）
      { type: 'bridge-session' },
      { type: 'pr-link' },
      ...['environment', 'model', 'total_tokens_reminder', 'session_context', 'date', 'deferred_tools_record', 'skill_listing', 'prompt_snapshot', 'agent_listing_delta', 'remote_session_change', 'silent_turn_reminder', 'edited_text_file', 'file', 'task_status', 'plan_mode'].map((type) => attachment({ type })),
      // 作業中に届いた、発言でない差し込み・hooks の記録で出さないもの
      attachment({ type: 'queued_command', commandMode: 'prompt', prompt: '<task-notification>', origin: { kind: 'task-notification' } }),
      attachment({ type: 'hook_success', hookEvent: 'SessionStart', stdout: JSON.stringify({ suppressOutput: true }) }),
      ...['away_summary', 'permission_retry', 'scheduled_task_fire', 'rewind_stand_in', 'cloud_session_status', 'file_snapshot', 'model_refusal_no_fallback', 'model_consent_fallback', 'agents_killed'].map((subtype) => system(subtype)),
      system('bridge_status'),
      system('informational'),
      assistant([{ type: 'redacted_thinking', data: 'x' }, { type: 'thinking', thinking: '' }, { type: 'text', text: '' }, { type: 'tool_use' }]),
      user([{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }, { type: 'text', text: '' }]),
      // 呼び出しの ID の無いツールの結果（付けるカードが無い）
      user([{ type: 'tool_result', content: 'x' }]),
      // メタの行・圧縮の要約は、ブロックを見ない
      user([{ type: 'brand_new' }], { isMeta: true }),
      user([{ type: 'brand_new' }], { isCompactSummary: true }),
    ];
    expect(known.flatMap((entry) => events(entry)).filter((e) => e.type === 'unknown-event')).toEqual([]);
  });

  it('本体の会話ログのサブエージェントの行は出さない。サブエージェントの会話ログを読むときは出す', () => {
    const side = { type: 'brand-new', uuid: 'n1', isSidechain: true };
    expect(events(side)).toEqual([]);
    expect(events(side, true)).toMatchObject([{ type: 'unknown-event', name: 'brand-new' }]);
  });
});

describe('toChatEvents: uuid の無い行', () => {
  it('どの出来事も、ID を空にして出す', () => {
    const plain = (text: string) => events({ type: 'user', message: { content: text } })[0];
    expect(plain(parentMessageText('0f8c2a1e-0000-4000-8000-000000000001', '指示'))).toMatchObject({ type: 'user', id: '', parent: '0f8c2a1e-0000-4000-8000-000000000001' });
    expect(plain(sessionEventText(['1a2b'], '知らせ'))).toMatchObject({ type: 'notice', id: '' });
    expect(plain(checklistEventText([], '知らせ'))).toMatchObject({ type: 'notice', id: '' });
    expect(plain('<bash-input>ls</bash-input>')).toMatchObject({ type: 'shell', id: '' });
    expect(plain('<task-notification><summary>済み</summary></task-notification>')).toEqual({ type: 'notice', id: '', text: '済み' });
    expect(plain('<command-name>/clear</command-name>')).toEqual({ type: 'user', id: '', text: '/clear', at: undefined, command: true });
    expect(plain('発言')).toEqual({ type: 'user', id: '', text: '発言', at: undefined });
  });
});

describe('そのほかの読み取り', () => {
  it('順番待ちの発言が人の発言か（完了通知・CI の知らせ・子の知らせ・チェックリストの知らせは除く）', () => {
    expect(isHumanPrompt('追加の頼みです')).toBe(true);
    expect(isHumanPrompt(parentMessageText('0f8c2a1e-0000-4000-8000-000000000001', '指示'))).toBe(true);
    expect(isHumanPrompt('<task-notification><status>completed</status></task-notification>')).toBe(false);
    expect(isHumanPrompt('  <ci-monitor-event>x</ci-monitor-event>')).toBe(false);
    expect(isHumanPrompt(sessionEventText(['1a2b'], 'x'))).toBe(false);
    expect(isHumanPrompt(checklistEventText([], 'x'))).toBe(false);
  });

  it('順番待ちに出す文字は、親セッションの指示なら囲みを外す', () => {
    expect(promptDisplayText(parentMessageText('0f8c2a1e-0000-4000-8000-000000000001', '指示です'))).toBe('指示です');
    expect(promptDisplayText('そのまま')).toBe('そのまま');
  });

  it('一覧のタイトル: /rename の名前 > AI のタイトル > 最初の発言の 1 行目。コマンドや知らせはタイトルにしない', () => {
    // 2.1.292 の /rename
    expect(transcriptTitle({ type: 'custom-title', customTitle: '控えの名前' })).toEqual({ title: '控えの名前', priority: 3 });
    expect(transcriptTitle({ type: 'custom-title', customTitle: '' })).toBeNull();
    expect(transcriptTitle({ type: 'ai-title', aiTitle: 'AI が付けたタイトル' })).toEqual({ title: 'AI が付けたタイトル', priority: 2 });
    expect(transcriptTitle({ type: 'ai-title' })).toBeNull();
    expect(transcriptTitle(user('確認を始めてください\n二行目'))).toEqual({ title: '確認を始めてください', priority: 1 });
    expect(transcriptTitle(user('あ'.repeat(100)))).toEqual({ title: 'あ'.repeat(80), priority: 1 });
    expect(transcriptTitle(user(parentMessageText('0f8c2a1e-0000-4000-8000-000000000001', '<pasted_content>\n子への指示\n二行目\n</pasted_content>')))).toEqual({ title: '子への指示', priority: 1 });
    expect(transcriptTitle(user('<command-name>/clear</command-name>'))).toBeNull();
    expect(transcriptTitle(user('<local-command-stdout></local-command-stdout>'))).toBeNull();
    expect(transcriptTitle(user(sessionEventText(['1a2b'], 'x')))).toBeNull();
    expect(transcriptTitle(user(checklistEventText([], 'x')))).toBeNull();
    expect(transcriptTitle(user('   '))).toBeNull();
    expect(transcriptTitle(user('メタ', { isMeta: true }))).toBeNull();
    expect(transcriptTitle(user('サブ', { isSidechain: true }))).toBeNull();
    expect(transcriptTitle(user('要約', { isCompactSummary: true }))).toBeNull();
    expect(transcriptTitle(user([{ type: 'text', text: '配列' }]))).toBeNull();
    expect(transcriptTitle({ type: 'assistant' })).toBeNull();
  });

  it('会話ログの行かどうか（オブジェクトだけ）', () => {
    expect(isTranscriptEntry({ type: 'user' })).toBe(true);
    expect(isTranscriptEntry(null)).toBe(false);
    expect(isTranscriptEntry('x')).toBe(false);
  });

  it('ツールの対象: ファイルはフォルダからの相対、ほかはコマンド・説明・検索語など、無ければ最初の文字の値の 1 行目', () => {
    expect(toolTarget({ file_path: `${CWD}/src/a.ts` }, CWD)).toBe('src/a.ts');
    expect(toolTarget({ file_path: `${CWD}/src/a.ts` }, `${CWD}/`)).toBe('src/a.ts');
    expect(toolTarget({ notebook_path: '/other/b.ipynb' }, CWD)).toBe('/other/b.ipynb');
    expect(toolTarget({ path: `${CWD}/src` }, CWD)).toBe('src');
    expect(toolTarget({ script: 'const x = 1' }, CWD)).toBe('workflow');
    expect(toolTarget({ script: 'export const meta = { name: "名前" }' }, CWD)).toBe('名前');
    expect(toolTarget({ command: 'cd /tmp\nnpm test' }, CWD)).toBe('cd /tmp');
    expect(toolTarget({ description: '説明', prompt: 'p' }, CWD)).toBe('説明');
    expect(toolTarget({ pattern: 'TODO' }, CWD)).toBe('TODO');
    expect(toolTarget({ url: 'https://example.com' }, CWD)).toBe('https://example.com');
    expect(toolTarget({ query: '検索語' }, CWD)).toBe('検索語');
    expect(toolTarget({ prompt: 'プロンプト' }, CWD)).toBe('プロンプト');
    expect(toolTarget({ to: 'a1', summary: '続きを頼む' }, CWD)).toBe('続きを頼む');
    expect(toolTarget({ count: 3, other: '最初の文字\n二行目' }, CWD)).toBe('最初の文字');
    expect(toolTarget({ count: 3 }, CWD)).toBe('');
  });
});
