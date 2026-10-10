import { describe, expect, it } from 'vitest';
import {
  ASK_FILE_ENV,
  bridgeUrlOf,
  isHumanPrompt,
  isTranscriptEntry,
  promptDisplayText,
  toChatEvents,
  toolTarget,
  transcriptTitle,
  type ChatEvent,
  type TranscriptEntry,
} from '@shared/chat';
import { checklistEventText } from '@shared/checklist-tools';
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
    expect(events(system('something_new'))).toEqual([]);
  });

  it('ローカルのコマンド（会話の最初の /rename など）は発言として出し、出力の行はターンの終わりにする', () => {
    // 2.1.292 の /rename
    const command = '<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>控えの名前</command-args>';
    expect(events(system('local_command', { content: command, level: 'info' }))).toEqual([{ type: 'user', id: 's1', text: '/rename 控えの名前', at }]);
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
    // アプリが足したフック（AskUserQuestion の入力をファイルに書くもの）は出さない
    expect(events(attachment({ type: 'hook_success', hookEvent: 'PreToolUse', command: `cat > "$${ASK_FILE_ENV}"` }))).toEqual([]);
    // hooks でない attachment
    expect(events(attachment({ type: 'file', filename: `${CWD}/notes.txt` }))).toEqual([]);
    expect(events({ type: 'attachment' })).toEqual([]);
  });
});

describe('toChatEvents: 応答の行', () => {
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
    expect(events(interrupted)).toEqual([{ type: 'turn-end' }]);
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
    expect(events(user([{ type: 'text', text: '[Request interrupted by user]' }], { interruptedMessageId: 'msg_mock_3' }))).toEqual([{ type: 'turn-end' }]);
    expect(events(user('[Request interrupted by user]'))).toEqual([{ type: 'turn-end' }]);
    // 2.1.292 の /compact と /clear の記録
    expect(events(user('<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'))).toEqual([]);
    expect(events(user('<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>'))).toEqual([{ type: 'turn-end' }]);
    expect(events(user('<local-command-caveat>The command below was run directly in Claude Code…</local-command-caveat>'))).toEqual([{ type: 'turn-end' }]);
    expect(events(user('<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>'))).toEqual([{ type: 'user', id: 'u1', text: '/clear', at }]);
    expect(events(user('<command-name>/model</command-name><command-args> opus </command-args>'))).toEqual([{ type: 'user', id: 'u1', text: '/model opus', at }]);
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

describe('toChatEvents: uuid の無い行', () => {
  it('どの出来事も、ID を空にして出す', () => {
    const plain = (text: string) => events({ type: 'user', message: { content: text } })[0];
    expect(plain(parentMessageText('0f8c2a1e-0000-4000-8000-000000000001', '指示'))).toMatchObject({ type: 'user', id: '', parent: '0f8c2a1e-0000-4000-8000-000000000001' });
    expect(plain(sessionEventText(['1a2b'], '知らせ'))).toMatchObject({ type: 'notice', id: '' });
    expect(plain(checklistEventText([], '知らせ'))).toMatchObject({ type: 'notice', id: '' });
    expect(plain('<bash-input>ls</bash-input>')).toMatchObject({ type: 'shell', id: '' });
    expect(plain('<task-notification><summary>済み</summary></task-notification>')).toEqual({ type: 'notice', id: '', text: '済み' });
    expect(plain('<command-name>/clear</command-name>')).toEqual({ type: 'user', id: '', text: '/clear', at: undefined });
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
