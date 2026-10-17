import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedPipeInfo } from '../src/main/pty-host-protocol';
import { ControlError, StreamClient, testing } from '../src/main/stream/client';
import { disableRemoteControl, enableRemoteControl, endSession, generateTitle, rewindConversation, unsupported } from '../src/main/stream/internal';
import { LineLog } from '../src/main/stream/log';
import type { CanUseToolRequest, StreamMessage } from '../src/main/stream/protocol';
import { ScriptedPipe } from './helpers/scripted-claude';

// stream-json の claude との行の読み書き（StreamClient）と、内部の要求（internal.ts）・送受信の控え（LineLog）。
// claude の代わりに、テストが行を出すパイプ（ScriptedPipe）を使う

type Got = { messages: [StreamMessage, boolean][]; permissions: [string, CanUseToolRequest][]; cancels: string[]; exits: [number, string][] };

function setup(log: LineLog | null = null) {
  const pipe = new ScriptedPipe('p1', { tag: 's1', file: 'claude', args: [], cwd: '/', env: {}, retain: [], transient: [] });
  const got: Got = { messages: [], permissions: [], cancels: [], exits: [] };
  const client = new StreamClient(
    pipe,
    {
      onMessage: (message, past) => got.messages.push([message, past]),
      onPermission: (id, request) => got.permissions.push([id, request]),
      onCancel: (id) => got.cancels.push(id),
      onExit: (code, stderr) => got.exits.push([code, stderr]),
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
    pipe.emit({ type: 'system', subtype: 'post_turn_summary' });
    pipe.emit('{壊れた');
    pipe.emit('[1,2]');
    pipe.emit({ no: 'type' });
    expect(got.messages.map(([m, past]) => [m.type, past])).toEqual([
      ['system', false],
      ['assistant', false],
    ]);
    expect([...client.unknown]).toEqual([
      ['brand_new', 2],
      ['system/post_turn_summary', 1],
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
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'system', subtype: 'api_retry' },
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
      { type: 'system', subtype: 'compact_boundary', compact_metadata: {} },
      { type: 'system', subtype: 'api_retry', attempt: 1 },
      { type: 'system', subtype: 'task_progress' },
      { type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', outcome: 'success' },
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
    // 控えのテスト（unreadableStreamLines）で、Claude Code の要求の種類・形の変化に気づけるよう数える
    expect([...client.unknown]).toEqual([
      ['control_request/hook_callback', 1],
      ['control_request/elicitation', 1],
    ]);
    expect(client.malformed).toBe(3);
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
