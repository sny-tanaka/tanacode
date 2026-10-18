import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedPipeInfo } from '../src/main/pty-host-protocol';
import { ControlError, StreamClient, testing } from '../src/main/stream/client';
import { disableRemoteControl, enableRemoteControl, endSession, generateTitle, rewindConversation, unsupported } from '../src/main/stream/internal';
import { LineLog } from '../src/main/stream/log';
import type { CanUseToolRequest, StreamMessage } from '../src/main/stream/protocol';
import { UNKNOWN_RAW_BYTES, type UnknownEvent } from '../src/shared/unknown-event';
import { ScriptedPipe } from './helpers/scripted-claude';

// stream-json の claude との行の読み書き（StreamClient）と、内部の要求（internal.ts）・送受信の控え（LineLog）。
// claude の代わりに、テストが行を出すパイプ（ScriptedPipe）を使う

type Got = { messages: [StreamMessage, boolean][]; permissions: [string, CanUseToolRequest][]; cancels: string[]; exits: [number, string][]; unknowns: UnknownEvent[] };

function setup(log: LineLog | null = null) {
  const pipe = new ScriptedPipe('p1', { tag: 's1', file: 'claude', args: [], cwd: '/', env: {}, retain: [], transient: [] });
  const got: Got = { messages: [], permissions: [], cancels: [], exits: [], unknowns: [] };
  const client = new StreamClient(
    pipe,
    {
      onMessage: (message, past) => got.messages.push([message, past]),
      onPermission: (id, request) => got.permissions.push([id, request]),
      onCancel: (id) => got.cancels.push(id),
      onExit: (code, stderr) => got.exits.push([code, stderr]),
      onUnknown: (event) => got.unknowns.push(event),
    },
    log,
  );
  return { pipe, client, got };
}

// アプリが送った制御の要求（最後のもの）
function lastRequest(pipe: ScriptedPipe): { request_id: string; request: Record<string, unknown> } {
  const message = pipe.messages.filter((m) => m.type === 'control_request').at(-1);
  if (!message) throw new Error('要求がありません');
  return message as { request_id: string; request: Record<string, unknown> };
}

const permission = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1', description: 'list' };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe('StreamClient', () => {
  it('出力の行を型にして渡す。知らない種類と読めない行は捨てて数え、知らない種類は 1 回だけコンソールに残す', () => {
    const { pipe, client, got } = setup();
    client.start();
    pipe.emit({ type: 'system', subtype: 'init', session_id: 's', model: 'm', permissionMode: 'default' });
    pipe.emit({ type: 'assistant', message: { content: [] }, parent_tool_use_id: null, uuid: 'a1' });
    pipe.emit({ type: 'brand_new' });
    pipe.emit({ type: 'brand_new' });
    pipe.emit({ type: 'system', subtype: 'brand_new_notice' });
    pipe.emit('{壊れた');
    pipe.emit('[1,2]');
    pipe.emit({ no: 'type' });
    expect(got.messages.map(([m, past]) => [m.type, past])).toEqual([
      ['system', false],
      ['assistant', false],
    ]);
    expect([...client.unknown]).toEqual([
      ['brand_new', 2],
      ['system/brand_new_notice', 1],
    ]);
    expect(client.malformed).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('時間で出る行（keep_alive。30 秒ごと）は、使わないと分かっているので、知らない種類として数えずに捨てる（控えのテストが、テストの長さしだいで落ちないように）', () => {
    const { pipe, client, got } = setup();
    client.start();
    pipe.emit({ type: 'keep_alive' });
    pipe.emit({ type: 'keep_alive' });
    expect(got.messages).toEqual([]);
    expect([...client.unknown]).toEqual([]);
    expect(client.malformed).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('意図して捨てる種類（Remote Control の内部用・ほかの道で足りている・tanacode の起動のしかたでは出ない・別の機能向け・使い道がない）は、知らない種類として数えずに黙って捨て、未知のイベントにもしない', () => {
    const { pipe, client, got } = setup();
    client.start();
    pipe.emit({ type: 'system', subtype: 'task_summary', summary: 'テストを直している', session_id: 's', uuid: 'u1' });
    pipe.emit({ type: 'system', subtype: 'post_turn_summary', status_category: 'done', status_detail: '直した', needs_action: false, session_id: 's', uuid: 'u2' });
    // 形を確かめないので、使う項目が無くても数えない
    pipe.emit({ type: 'system', subtype: 'compact_boundary' });
    const subtypes = [
      ...['informational', 'local_command', 'task_progress', 'task_updated', 'background_tasks_changed', 'thinking_tokens', 'hook_progress', 'permission_denied'],
      ...['session_title_changed', 'code_change_published', 'worker_shutting_down', 'model_refusal_no_fallback'],
      ...['session_state_changed', 'plugin_install', 'mirror_error', 'control_request_progress', 'model_consent_fallback'],
      ...['cloud_session_delta', 'vcs_state_changed', 'file_attachments_missing', 'peer_message_hold', 'feedback_draft_queued', 'instruction_size_warning'],
      ...['ui_invalidate', 'ui_panes', 'ui_scroll', 'ui_focus', 'per_turn_effort_changed'],
    ];
    for (const subtype of subtypes) pipe.emit({ type: 'system', subtype, uuid: subtype });
    for (const type of ['prompt_suggestion', 'auth_status', 'transcript_mirror', 'active_goal', 'autocompact_state', 'tool_use_summary']) pipe.emit({ type, uuid: type });
    expect(got.messages).toEqual([]);
    expect(got.unknowns).toEqual([]);
    expect([...client.unknown]).toEqual([]);
    expect(client.malformed).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('知っている種類でも、使う項目の形が違う行は捨てて、読めない行として数える', () => {
    const { pipe, client, got } = setup();
    client.start();
    const bad = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', message: {} },
      { type: 'user', message: { content: 1 } },
      { type: 'result', subtype: 'success' },
      { type: 'conversation_reset' },
      { type: 'stream_event', event: {} },
      { type: 'tool_progress' },
      { type: 'rate_limit_event' },
      { type: 'command_lifecycle', command_uuid: 'u' },
      { type: 'system', subtype: 'task_started' },
      { type: 'system', subtype: 'task_notification', task_id: 't' },
      { type: 'system', subtype: 'bridge_state' },
      { type: 'system', subtype: 'status', permissionMode: 1 },
      { type: 'system', subtype: 'api_retry' },
      // / のコマンドの一覧が無い・名前や説明が文字列でない・別名が文字列の配列でない
      { type: 'system', subtype: 'commands_changed' },
      { type: 'system', subtype: 'commands_changed', commands: [{ description: 'x' }] },
      { type: 'system', subtype: 'commands_changed', commands: [{ name: 'deploy' }] },
      { type: 'system', subtype: 'commands_changed', commands: [{ name: 'deploy', description: 'x', aliases: 'd' }] },
      // 出力の欄が無い・文字列でない（何も出力しなかったかを決められない）
      { type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', outcome: 'success' },
      { type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', outcome: 'success', stdout: '', stderr: null },
    ];
    for (const line of bad) pipe.emit(line);
    expect(got.messages).toEqual([]);
    expect(client.malformed).toBe(bad.length);
  });

  it('使う種類の行を、どれも渡す', () => {
    const good = [
      { type: 'user', message: { content: 'x' }, parent_tool_use_id: null },
      { type: 'user', message: { content: [] }, parent_tool_use_id: null },
      { type: 'result', subtype: 'success', is_error: false },
      { type: 'conversation_reset', session_id: 's' },
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'tool_progress', tool_use_id: 't' },
      { type: 'rate_limit_event', rate_limit_info: {} },
      { type: 'command_lifecycle', command_uuid: 'u', state: 'queued' },
      { type: 'system', subtype: 'status' },
      { type: 'system', subtype: 'task_started', task_id: 't' },
      { type: 'system', subtype: 'task_notification', task_id: 't', status: 'stopped' },
      { type: 'system', subtype: 'bridge_state', state: 'connected' },
      { type: 'system', subtype: 'api_retry', attempt: 1 },
      { type: 'system', subtype: 'commands_changed', commands: [] },
      { type: 'system', subtype: 'commands_changed', commands: [{ name: 'deploy', description: 'x', argumentHint: '', aliases: ['d'] }] },
      { type: 'system', subtype: 'hook_started', hook_id: 'h1' },
      { type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', outcome: 'success', stdout: '', stderr: '' },
    ];
    for (const line of good) expect(testing.messageOf(line)).not.toBeNull();
    for (const line of good) expect(testing.messageOf(line)).not.toBe('unknown');
  });

  it('発言と制御の要求を 1 行ずつ書く。要求の返事を request_id で対応させ、success は中身を、error は理由を返す', async () => {
    const { pipe, client } = setup();
    client.start();
    client.send({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null, uuid: 'u1', pasted_content: ['長い'] });
    expect(pipe.messages[0]).toEqual({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null, uuid: 'u1', pasted_content: ['長い'] });
    const ok = client.request('get_settings');
    const okId = lastRequest(pipe).request_id;
    expect(lastRequest(pipe).request).toEqual({ subtype: 'get_settings' });
    const failed = client.request('set_model', { model: 'x' });
    const failedId = lastRequest(pipe).request_id;
    expect(failedId).not.toBe(okId);
    expect(okId).toMatch(/^tc-[0-9a-f]{6}-\d+$/);
    // 知らない返事・中身の無い success も受け止める
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'other' } });
    pipe.emit({ type: 'control_response', response: { subtype: 'error', request_id: failedId, error: 'bad model' } });
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: okId, response: { applied: { effort: 'high' } } } });
    expect(await ok).toEqual({ applied: { effort: 'high' } });
    await expect(failed).rejects.toMatchObject({ subtype: 'set_model', reason: 'bad model' });
    const empty = client.request('interrupt');
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: lastRequest(pipe).request_id } });
    expect(await empty).toEqual({});
    // 理由の無い error（形の違う返事として数えるが、待っている要求には渡す）
    const vague = client.request('x');
    pipe.emit({ type: 'control_response', response: { subtype: 'error', request_id: lastRequest(pipe).request_id } });
    await expect(vague).rejects.toMatchObject({ reason: 'error' });
    expect(client.malformed).toBe(1);
    // request_id の無い返事は捨てる
    pipe.emit({ type: 'control_response', response: {} });
  });

  it('返事が来なければ、時間切れで失敗する。claude が終わったら、待っている要求は失敗し、それ以降の要求はすぐ失敗する', async () => {
    vi.useFakeTimers();
    const { pipe, client, got } = setup();
    client.start();
    const slow = client.request('remote_control', {}, 60_000);
    vi.advanceTimersByTime(59_999);
    const waiting = client.request('get_usage');
    vi.advanceTimersByTime(1);
    await expect(slow).rejects.toMatchObject({ reason: 'timeout' });
    pipe.exit(1, 'stderr の末尾');
    await expect(waiting).rejects.toMatchObject({ reason: 'exited' });
    expect(got.exits).toEqual([[1, 'stderr の末尾']]);
    await expect(client.request('get_usage')).rejects.toBeInstanceOf(ControlError);
    pipe.exit(1);
    expect(got.exits).toHaveLength(1);
  });

  it('時間を区切らない要求（initialize）は、返事か claude の終了まで待つ', async () => {
    vi.useFakeTimers();
    const { pipe, client } = setup();
    client.start();
    const init = client.request('initialize', {}, null);
    const late = client.request('initialize', {}, null);
    vi.advanceTimersByTime(10 * 60_000);
    pipe.respond(String(pipe.requests('initialize')[0].request_id), { pid: 1 });
    await expect(init).resolves.toEqual({ pid: 1 });
    pipe.exit(1);
    await expect(late).rejects.toMatchObject({ reason: 'exited' });
  });

  it('can_use_tool を待っている要求にし、答えを control_response で返す。取り下げられたら知らせ、もう答えない', () => {
    const { pipe, client, got } = setup();
    client.start();
    pipe.emit({ type: 'control_request', request_id: 'r1', request: permission });
    pipe.emit({ type: 'control_request', request_id: 'r2', request: { ...permission, tool_use_id: 'toolu_2' } });
    // 同じ要求が 2 度届いても、1 度だけ知らせる
    pipe.emit({ type: 'control_request', request_id: 'r1', request: permission });
    expect(got.permissions.map(([id]) => id)).toEqual(['r1', 'r2']);
    expect(client.pendingPermissions().map(([id]) => id)).toEqual(['r1', 'r2']);
    expect(client.respond('r1', { behavior: 'allow', updatedInput: { command: 'ls' } })).toBe(true);
    expect(pipe.messages.at(-1)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } },
    });
    expect(client.respond('r1', { behavior: 'deny', message: 'x' })).toBe(false);
    pipe.emit({ type: 'control_cancel_request', request_id: 'r2' });
    pipe.emit({ type: 'control_cancel_request', request_id: 'r2' });
    expect(got.cancels).toEqual(['r2']);
    expect(client.respond('r2', { behavior: 'deny', message: 'x' })).toBe(false);
    expect(client.pendingPermissions()).toEqual([]);
  });

  it('使わない要求・形の違う can_use_tool には、必ず error で返す（返さないと Claude Code が待ち続ける）。request_id の無い要求は捨てる', () => {
    const { pipe, client, got } = setup();
    client.start();
    pipe.emit({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } });
    pipe.emit({ type: 'control_request', request_id: 'e1', request: { subtype: 'elicitation' } });
    pipe.emit({ type: 'control_request', request_id: 'b1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    pipe.emit({ type: 'control_request', request_id: 'n1' });
    pipe.emit({ type: 'control_request', request: { subtype: 'can_use_tool' } });
    expect(got.permissions).toEqual([]);
    expect(pipe.messages.map((m) => (m.response as { request_id: string; subtype: string; error: string }) ?? null)).toEqual([
      { subtype: 'error', request_id: 'h1', error: 'tanacode does not handle hook_callback requests.' },
      { subtype: 'error', request_id: 'e1', error: 'tanacode does not handle elicitation requests.' },
      { subtype: 'error', request_id: 'b1', error: 'tanacode does not handle can_use_tool requests.' },
      { subtype: 'error', request_id: 'n1', error: 'tanacode does not handle unknown requests.' },
    ]);
    // 控えのテスト（unreadableStreamLines）で、Claude Code の要求の種類・形の変化に気づけるよう、知らない要求は数える。
    // 意図して断る要求（アプリが登録したときだけ来る hook_callback など）は数えず、未知のイベントにもしない
    expect([...client.unknown]).toEqual([['control_request/elicitation', 1]]);
    expect(client.malformed).toBe(3);
    expect(got.unknowns.map((e) => e.name)).not.toContain('control_request/hook_callback');
  });

  it('形の違う返事・取り下げ（control_response・control_cancel_request）は、読めない行として数える。待っていない要求への返事は数えない', () => {
    const { pipe, client } = setup();
    client.start();
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'old', response: {} } });
    pipe.emit({ type: 'control_response', response: { subtype: 'error', request_id: 'old', error: 'x' } });
    pipe.emit({ type: 'control_cancel_request', request_id: 'old' });
    expect(client.malformed).toBe(0);
    pipe.emit({ type: 'control_response' });
    pipe.emit({ type: 'control_response', response: { subtype: 'partial', request_id: 'old' } });
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: 1, response: {} } });
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'old', response: 'x' } });
    pipe.emit({ type: 'control_response', response: { subtype: 'error', request_id: 'old', error: 1 } });
    pipe.emit({ type: 'control_cancel_request' });
    expect(client.malformed).toBe(6);
  });

  it('claude が終わったら、待っている要求を取り下げとして知らせてから、終わりを知らせる', () => {
    const { pipe, client, got } = setup();
    client.start();
    pipe.emit({ type: 'control_request', request_id: 'r1', request: permission });
    pipe.exit(0);
    expect(got.cancels).toEqual(['r1']);
    expect(got.exits).toEqual([[0, '']]);
  });

  it('引き継ぐ: 送り直しを頼み、前のアプリの頃の行は past として渡す。控えの頭より前の、種類ごとの最新の行も先に渡す。答えの無い要求を出し直す', () => {
    const { pipe, client, got } = setup();
    const info: HostedPipeInfo = {
      kind: 'pipe',
      id: 'p1',
      tag: 's1',
      pid: 1,
      startedAt: 0,
      exitCode: null,
      lastSeq: 7,
      firstSeq: 5,
      retained: [
        { seq: 2, line: JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', permissionMode: 'auto' }) },
        { seq: 3, line: '{壊れた' },
        { seq: 4, line: JSON.stringify({ type: 'keep_alive' }) },
        { seq: 6, line: JSON.stringify({ type: 'system', subtype: 'status', status: null }) },
      ],
      pending: [
        { seq: 5, line: JSON.stringify({ type: 'control_request', request_id: 'old', request: permission }) },
        { seq: 5, line: JSON.stringify({ type: 'control_request', request_id: 'hook', request: { subtype: 'hook_callback' } }) },
      ],
      ended: false,
      stderr: '',
    };
    client.adopt(info);
    expect(pipe.replays).toEqual([5]);
    expect(got.permissions.map(([id]) => id)).toEqual(['old']);
    // 送り直しの行（5〜7 番。過去）と、新しい行（8 番から）
    pipe.emit({ type: 'control_request', request_id: 'old', request: permission }, 5);
    pipe.emit({ type: 'system', subtype: 'status', status: null });
    pipe.emit({ type: 'control_request', request_id: 'answered', request: permission });
    // 前のアプリの要求への返事（同じ request_id でも受け取らない）
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'tc-x-1' } }, 7);
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'tc-x-1' } }, 8);
    pipe.emit({ type: 'assistant', message: {}, parent_tool_use_id: null, uuid: 'a1' });
    pipe.emit({ type: 'result', subtype: 'success', is_error: false });
    pipe.emit({ type: 'control_request', request_id: 'new', request: permission });
    // 前のアプリの頃の要求は、控えの未回答のもの（old）だけ。答え済み（answered）は出さない
    expect(got.permissions.map(([id]) => id)).toEqual(['old', 'new']);
    expect(got.messages.map(([m, past]) => `${m.type}${'subtype' in m ? `/${m.subtype}` : ''}:${past}`)).toEqual([
      'system/init:true',
      'system/status:true',
      'assistant:false',
      'result/success:false',
    ]);
  });
});

describe('未知のイベント（onUnknown）', () => {
  // 名前・わけ・どこから・ID（生の行は別に確かめる）
  const brief = (events: UnknownEvent[]) => events.map((e) => [e.name, e.problem, e.source, e.id]);

  it('知らない種類・形の違う行・読めない行・使わない種類の要求を、数えるのと一緒に、未知のイベントとして知らせる。ID は行の uuid（要求は request_id）', () => {
    const { pipe, client, got } = setup();
    client.start();
    pipe.emit({ type: 'brand_new', uuid: 'u1' });
    pipe.emit({ type: 'system', subtype: 'brand_new_notice', uuid: 'u2', from: 'a', to: 'b' });
    pipe.emit({ type: 'system', subtype: 'init', session_id: 's', uuid: 'u3' });
    pipe.emit('{壊れた');
    pipe.emit('[1,2]');
    pipe.emit({ type: 'control_request', request_id: 'e1', request: { subtype: 'elicitation' } });
    pipe.emit({ type: 'control_request', request_id: 'b1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    pipe.emit({ type: 'control_request', request_id: 'n1' });
    pipe.emit({ type: 'control_request', request: { subtype: 'can_use_tool' } });
    pipe.emit({ type: 'control_response' });
    pipe.emit({ type: 'control_cancel_request' });
    expect(brief(got.unknowns)).toEqual([
      ['brand_new', 'unknown', 'stream', 'unknown:u1'],
      ['system/brand_new_notice', 'unknown', 'stream', 'unknown:u2'],
      ['system/init', 'malformed', 'stream', 'unknown:u3'],
      ['', 'unparsable', 'stream', expect.stringMatching(/^unknown:n\d+$/)],
      ['', 'malformed', 'stream', expect.stringMatching(/^unknown:n\d+$/)],
      ['control_request/elicitation', 'unknown', 'request', 'unknown:request:e1'],
      ['control_request/can_use_tool', 'malformed', 'request', 'unknown:request:b1'],
      ['control_request', 'malformed', 'request', 'unknown:request:n1'],
      ['control_request', 'malformed', 'request', expect.stringMatching(/^unknown:request:n\d+$/)],
      ['control_response', 'malformed', 'stream', expect.stringMatching(/^unknown:n\d+$/)],
      ['control_cancel_request', 'malformed', 'stream', expect.stringMatching(/^unknown:n\d+$/)],
    ]);
    // 生の行は、読めた行は整形した JSON、読めない行はその文字のまま。知らない要求に error で返す動きと、数はそのまま
    expect(got.unknowns[1].raw).toBe(JSON.stringify({ type: 'system', subtype: 'brand_new_notice', uuid: 'u2', from: 'a', to: 'b' }, null, 2));
    expect(got.unknowns[3].raw).toBe('{壊れた');
    expect(pipe.messages.filter((m) => m.type === 'control_response').map((m) => (m.response as { request_id: string }).request_id)).toEqual(['e1', 'b1', 'n1']);
    expect([...client.unknown]).toEqual([
      ['brand_new', 1],
      ['system/brand_new_notice', 1],
      ['control_request/elicitation', 1],
    ]);
    expect(client.malformed).toBe(8);
  });

  it('意図して捨てる種類・知っているが使わない種類・使う種類と、書いている途中の行（形が違っても）は、未知のイベントにしない', () => {
    const { pipe, client, got } = setup();
    client.start();
    pipe.emit({ type: 'keep_alive' });
    pipe.emit({ type: 'system', subtype: 'task_summary', summary: 's', uuid: 'u1' });
    pipe.emit({ type: 'system', subtype: 'post_turn_summary', uuid: 'u2' });
    pipe.emit({ type: 'system', subtype: 'thinking_tokens', uuid: 'u3' });
    pipe.emit({ type: 'system', subtype: 'informational', content: 'x', uuid: 'u4' });
    pipe.emit({ type: 'assistant', message: { content: [] }, parent_tool_use_id: null, uuid: 'a1' });
    pipe.emit({ type: 'stream_event', event: { type: 'message_start' } });
    pipe.emit({ type: 'stream_event', event: {} });
    pipe.emit({ type: 'control_request', request_id: 'p1', request: permission });
    expect(got.unknowns).toEqual([]);
    // 書いている途中の形の違う行は、数えるだけ
    expect(client.malformed).toBe(1);
  });

  it('長い行は、生の行を 64KB で切り、元のバイト数を添える', () => {
    const { pipe, client, got } = setup();
    client.start();
    pipe.emit({ type: 'brand_new', text: 'あ'.repeat(30_000) });
    pipe.emit({ type: 'brand_new', text: 'a'.repeat(100) });
    // 文字の数では上限に近くても、UTF-8 で上限に収まれば切らない
    pipe.emit({ type: 'brand_new', text: 'a'.repeat(30_000) });
    const [long, short, ascii] = got.unknowns;
    expect(ascii.truncated).toBeUndefined();
    expect(ascii.raw).toContain('a'.repeat(30_000));
    expect(new TextEncoder().encode(long.raw).length).toBeLessThanOrEqual(UNKNOWN_RAW_BYTES);
    expect(new TextEncoder().encode(long.raw).length).toBeGreaterThan(UNKNOWN_RAW_BYTES - 4);
    expect(long.raw).not.toContain('�');
    expect(long.truncated).toBe(new TextEncoder().encode(JSON.stringify({ type: 'brand_new', text: 'あ'.repeat(30_000) }, null, 2)).length);
    expect(short.truncated).toBeUndefined();
  });

  it('引き継いだとき、前のアプリの頃の行（送り直しの行・控えの頭より前の行・出し直した要求）は、未知のイベントにしない', () => {
    const { pipe, client, got } = setup();
    client.adopt({
      kind: 'pipe',
      id: 'p1',
      tag: 's1',
      pid: 1,
      startedAt: 0,
      exitCode: null,
      lastSeq: 9,
      firstSeq: 3,
      retained: [
        { seq: 1, line: '{壊れた' },
        { seq: 2, line: JSON.stringify({ type: 'brand_new' }) },
      ],
      pending: [
        { seq: 5, line: JSON.stringify({ type: 'control_request', request_id: 'device', request: { subtype: 'register_device_hooks' } }) },
        { seq: 5, line: JSON.stringify({ type: 'control_request', request: { subtype: 'can_use_tool' } }) },
      ],
      ended: false,
      stderr: '',
    });
    pipe.emit({ type: 'brand_new', uuid: 'old' }, 3);
    pipe.emit('{壊れた');
    pipe.emit({ type: 'control_request', request_id: 'old-request', request: { subtype: 'elicitation' } });
    pipe.emit({ type: 'control_response' });
    pipe.emit({ type: 'control_cancel_request' });
    pipe.emit({ type: 'system', subtype: 'init', session_id: 's' });
    pipe.emit({ type: 'keep_alive' });
    expect(got.unknowns).toEqual([]);
    // 前の行も数える（控えのテストと同じ数え方）
    expect(client.malformed).toBe(5);
    // 引き継いだあとの新しい行は出す
    pipe.emit({ type: 'brand_new', uuid: 'new' });
    expect(brief(got.unknowns)).toEqual([['brand_new', 'unknown', 'stream', 'unknown:new']]);
  });
});

describe('内部の要求（internal.ts）', () => {
  it('remote_control でつなぐ（名前・付け直すセッション）・切る。返事から URL とセッションの ID を読む', async () => {
    const { pipe, client } = setup();
    client.start();
    const on = enableRemoteControl(client, 'tanacode-work', 'cse_1');
    expect(lastRequest(pipe).request).toEqual({ subtype: 'remote_control', enabled: true, name: 'tanacode-work', reattach_session_id: 'cse_1' });
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: lastRequest(pipe).request_id, response: { session_url: 'https://x', bridge_session_id: 'cse_1' } } });
    expect(await on).toEqual({ sessionUrl: 'https://x', bridgeSessionId: 'cse_1' });
    const fresh = enableRemoteControl(client, 'tanacode-work');
    expect(lastRequest(pipe).request).toEqual({ subtype: 'remote_control', enabled: true, name: 'tanacode-work' });
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: lastRequest(pipe).request_id, response: {} } });
    expect(await fresh).toEqual({ sessionUrl: null, bridgeSessionId: null });
    const off = disableRemoteControl(client);
    expect(lastRequest(pipe).request).toEqual({ subtype: 'remote_control', enabled: false });
    pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: lastRequest(pipe).request_id } });
    await off;
  });

  it('rewind_conversation・end_session・generate_session_title の形', async () => {
    const { pipe, client } = setup();
    client.start();
    const answer = (response: Record<string, unknown>) =>
      pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: lastRequest(pipe).request_id, response } });
    const rewound = rewindConversation(client, 'u2', 'u5');
    expect(lastRequest(pipe).request).toEqual({ subtype: 'rewind_conversation', target_message_uuid: 'u2', last_seen_user_message_uuid: 'u5' });
    answer({ rewound: true, prefillText: '戻した発言' });
    expect(await rewound).toEqual({ rewound: true, prefillText: '戻した発言', reason: null, error: null });
    const stale = rewindConversation(client, 'u2', 'u1');
    answer({ rewound: false, prefillText: null, reason: 'stale_target', error: 'stale target' });
    expect(await stale).toEqual({ rewound: false, prefillText: null, reason: 'stale_target', error: 'stale target' });
    const missing = rewindConversation(client, 'x', 'y');
    answer({ error: 'target not found' });
    expect(await missing).toEqual({ rewound: false, prefillText: null, reason: null, error: 'target not found' });
    const ended = endSession(client);
    expect(lastRequest(pipe).request).toEqual({ subtype: 'end_session', reason: 'tanacode' });
    answer({});
    await ended;
    const title = generateTitle(client, '最初の発言');
    expect(lastRequest(pipe).request).toEqual({ subtype: 'generate_session_title', description: '最初の発言', persist: true });
    answer({ title: '  タイトル  ' });
    expect(await title).toBe('タイトル');
    const blank = generateTitle(client, 'x');
    answer({ title: ' ' });
    expect(await blank).toBeNull();
  });

  it('受け口が無い（Unsupported control request subtype）かを見分ける', async () => {
    const { pipe, client } = setup();
    client.start();
    const missing = generateTitle(client, 'x');
    pipe.emit({ type: 'control_response', response: { subtype: 'error', request_id: lastRequest(pipe).request_id, error: 'Unsupported control request subtype: generate_session_title' } });
    const error = await missing.catch((e: unknown) => e);
    expect(unsupported(error)).toBe(true);
    expect(unsupported(new ControlError('x', 'Remote Control is only available when using Claude via api.anthropic.com.'))).toBe(false);
    expect(unsupported(new Error('Unsupported control request subtype'))).toBe(false);
  });
});

describe('LineLog（送受信の控え）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-line-log-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('時刻・向き・行を本人だけが読めるファイルに書き、上限を超えたら .1 に回す。消すと両方消える。書いている途中の行は控えない', () => {
    const path = join(dir, 'logs', 's1.log');
    const log = new LineLog(path, 200);
    const { pipe, client } = setup(log);
    client.start();
    pipe.emit({ type: 'stream_event', event: { type: 'message_start' } });
    pipe.emit({ type: 'system', subtype: 'status' });
    client.send({ type: 'user', message: { role: 'user', content: 'x'.repeat(150) }, parent_tool_use_id: null, uuid: 'u' });
    // 2 行で上限を超えたので、.1 に回した
    expect(existsSync(path)).toBe(false);
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'logs')).mode & 0o777).toBe(0o700);
    const rotated = readFileSync(`${path}.1`, 'utf8');
    expect(rotated).toMatch(/^\S+ < \{"type":"system","subtype":"status"\}\n\S+ > \{"type":"user"/);
    expect(rotated).not.toContain('stream_event');
    pipe.emit({ type: 'system', subtype: 'status', n: 2 });
    expect(readFileSync(path, 'utf8')).toContain('"n":2');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    log.remove();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it('前からあったファイルも本人だけが読めるようにする。長い行は頭だけを書く。閉じたあとに届いた行は書かない（開き直さない）', () => {
    const path = join(dir, 's2.log');
    writeFileSync(path, '', { mode: 0o644 });
    const log = new LineLog(path);
    log.write('<', 'x'.repeat(100 * 1024));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, 'utf8');
    expect(text.length).toBeLessThan(70 * 1024);
    expect(text).toContain('（102400 文字。以下は略）');
    log.close();
    log.write('>', '閉じたあと');
    expect(readFileSync(path, 'utf8')).not.toContain('閉じたあと');
  });

  it('書けなくても、やりとりは続ける。detach で閉じる', () => {
    const log = new LineLog(join(dir, 'file-not-dir'), 100);
    rmSync(dir, { recursive: true, force: true });
    // 親のフォルダの代わりにファイルを置いて、書けなくする
    const blocked = new LineLog('/dev/null/s1.log', 100);
    const { pipe, client } = setup(blocked);
    client.start();
    expect(() => pipe.emit({ type: 'system', subtype: 'status' })).not.toThrow();
    client.detach();
    expect(pipe.detached).toBe(true);
    log.close();
  });
});
