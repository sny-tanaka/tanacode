import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_TOOLS, parentMessageText, sessionEventText, sessionToolId } from '@shared/session-tools';
import { McpBridge, textResult } from '../../src/main/mcp-bridge';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion, menuOf } from './claude-run';
import { MockApi, type Block } from './mock-api';

// 本物の claude をモックの API で動かし、セッションの MCP サーバー（中継）を確かめる。
// アプリと同じ起動の引数（--mcp-config の timeout を含む・--allowedTools・--settings の PreToolUse のフック）で起動し、
// 中継（src/main/sessions-mcp.ts をビルドしたもの）が、アプリの代わりのソケットまでツールの呼び出しを運ぶか。
// - 読むだけのツールは、許可の確認なしに通る / 子に指示するツールは、許可の確認が出る
// - 子セッションの起動は、bypassPermissions でも許可の確認が出る（フックが ask を返す）
// - 親からの指示（囲み＋複数行の本文の貼り付け）は、会話ログから「親セッションからの指示」として読める。子の知らせは「Claude への知らせ」

const SESSIONS = 'ほかのセッションを扱ってください';
const BYPASS = 'バイパスのモードで扱ってください';
const PARENT = '11111111-0000-4000-8000-000000000001';
const CHILD = '22222222-0000-4000-8000-000000000002';

const version = claudeVersion();

const call = (id: string, name: string, input: Record<string, unknown> = {}): Block[] => [{ type: 'tool_use', id, name: sessionToolId(name), input }];
const say = (text: string): Block[] => [{ type: 'text', text }];

describe(`Claude Code ${version} とセッションの MCP`, () => {
  let api: MockApi;
  let script: string;
  let bridge: McpBridge;
  let socketDir: string;
  let socketPath: string;
  // アプリに届いた呼び出し
  const calls: { session: string; tool: string; args: Record<string, unknown> }[] = [];
  const runs: ClaudeRun[] = [];

  const resultOf = (run: ClaudeRun, toolUseId: string): unknown => {
    for (const entry of run.entries) {
      const content = entry.type === 'user' ? (entry as { message?: { content?: unknown } }).message?.content : null;
      if (!Array.isArray(content)) continue;
      const hit = content.find((b: { type?: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
      if (hit) return hit;
    }
    return undefined;
  };
  const replied = (run: ClaudeRun, text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);

  beforeAll(async () => {
    script = await buildRelay('sessions-mcp');
    socketDir = mkdtempSync(join(tmpdir(), 'tanacode-sessions-'));
    socketPath = join(socketDir, 'sessions.sock');
    bridge = new McpBridge(socketPath, async (session, tool, args) => {
      calls.push({ session, tool, args });
      return textResult(JSON.stringify({ tool, note: `${tool} をしました` }));
    });
    await bridge.start();
    api = new MockApi();
    // 許可の確認が続けて出ても見分けられるよう、応答を少し遅らせる
    api.conversations = [
      {
        match: SESSIONS,
        delayMs: 1000,
        steps: [
          call('toolu_list', 'list_sessions'),
          call('toolu_send', 'send_message', { session_id: CHILD, message: 'テストも書いて' }),
          call('toolu_start', 'start_session', { prompt: '登録画面を作って', worktree: false }),
          say('扱いました'),
          say('親からの指示を受け取りました'),
          say('子の知らせを受け取りました'),
          say('人の発言に答えました'),
          say('あとから届いた親の指示に答えました'),
        ],
      },
      {
        match: BYPASS,
        delayMs: 1000,
        steps: [call('toolu_bp_send', 'send_message', { session_id: CHILD, message: '続けて' }), call('toolu_bp_start', 'start_session', { prompt: '別の作業', worktree: true }), say('バイパスで扱いました')],
      },
    ];
  });

  afterAll(async () => {
    for (const run of runs) await run.stop();
    await api?.stop();
    bridge?.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  const open = async (options: { mode?: 'bypassPermissions' } = {}) => {
    const run = new ClaudeRun(await api.start(), {
      sessions: { command: process.execPath, script, socketPath, version: 'test' },
      ...(options.mode ? { mode: options.mode, settings: { skipDangerousModePermissionPrompt: true } } : {}),
    });
    runs.push(run);
    await run.open();
    return run;
  };

  describe('ふつうの権限モード', () => {
    let run: ClaudeRun;
    beforeAll(async () => {
      run = await open();
    });

    it('ツールの一覧が Claude に渡り、読むだけのツールは許可の確認なしにアプリまで届く', async () => {
      await run.send(SESSIONS);
      await run.waitFor('一覧の結果', () => resultOf(run, 'toolu_list'));
      for (const tool of SESSION_TOOLS) expect([...api.tools], tool.name).toContain(sessionToolId(tool.name));
      expect(calls[0]).toEqual({ session: run.sessionId, tool: 'list_sessions', args: {} });
    });

    it('子への指示と子の起動は、許可の確認を通る', async () => {
      const send = await run.waitFor('指示の許可の確認', menuOf('permission'));
      expect(calls).toHaveLength(1);
      await run.answer(send.title, send.options[0].id);
      await run.waitFor('指示の結果', () => resultOf(run, 'toolu_send'));
      expect(calls[1]).toEqual({ session: run.sessionId, tool: 'send_message', args: { session_id: CHILD, message: 'テストも書いて' } });
      const start = await run.waitFor('起動の許可の確認', menuOf('permission'));
      await run.answer(start.title, start.options[0].id);
      await run.waitFor('返事', replied(run, '扱いました'));
      expect(calls[2]).toMatchObject({ tool: 'start_session', args: { prompt: '登録画面を作って', worktree: false } });
    });

    it('親からの指示（複数行）は、会話ログから親の ID と本文の発言として読める。順番待ちにも本文だけを出す', async () => {
      await run.manager.submit(run.sessionId!, parentMessageText(PARENT, '1 行目\n2 行目'));
      await run.waitFor('親からの指示の返事', replied(run, '親からの指示を受け取りました'));
      const prompt = run.chatEvents.find((e) => e.type === 'user' && e.parent === PARENT);
      expect(prompt).toMatchObject({ type: 'user', text: '1 行目\n2 行目', parent: PARENT });
      expect(run.queue.some((q) => q.includes('tanacode-parent-message'))).toBe(false);
    });

    it('子の知らせは「Claude への知らせ」として読め、Claude は続きを始める', async () => {
      await run.manager.submit(run.sessionId!, sessionEventText([CHILD], '子セッション「A」の作業が終わりました。'));
      await run.waitFor('知らせの返事', replied(run, '子の知らせを受け取りました'));
      expect(run.chatEvents.find((e) => e.type === 'notice' && e.sessions?.includes(CHILD))).toMatchObject({ text: '子セッション「A」の作業が終わりました。' });
    });

    it('作業中に頼んだ親の指示は、ターンが終わってから打つ（作業中に出た許可の確認に、打った文字が入らないように）', async () => {
      const id = run.sessionId!;
      await run.manager.submit(id, '人の発言です');
      const waiting = run.manager.submitWhenReady(id, parentMessageText(PARENT, 'あとから届いた指示'), 30_000);
      await waiting;
      await run.waitFor('親の指示の返事', replied(run, 'あとから届いた親の指示に答えました'));
      const index = (match: (e: (typeof run.chatEvents)[number]) => boolean) => run.chatEvents.findIndex(match);
      const human = index((e) => e.type === 'user' && e.text === '人の発言です');
      const parent = index((e) => e.type === 'user' && e.parent === PARENT && e.text === 'あとから届いた指示');
      const turnEnd = run.chatEvents.findIndex((e, i) => i > human && e.type === 'turn-end');
      expect(human).toBeGreaterThan(-1);
      expect(turnEnd).toBeGreaterThan(human);
      expect(parent).toBeGreaterThan(turnEnd);
    });

    it('子の権限モードの上限にする親のモードは、起動の引数で渡したもの', () => {
      expect(run.manager.modeOf(run.sessionId!)).toBe('manual');
    });
  });

  describe('bypassPermissions', () => {
    let run: ClaudeRun;
    beforeAll(async () => {
      run = await open({ mode: 'bypassPermissions' });
    });

    it('子への指示は確認なしに通るが、子の起動はフックが確認を出させる。確認には、子も利用枠を使うことが出る', async () => {
      const before = calls.length;
      await run.send(BYPASS);
      await run.waitFor('指示の結果', () => resultOf(run, 'toolu_bp_send'));
      expect(calls[before]).toMatchObject({ session: run.sessionId, tool: 'send_message' });
      const start = await run.waitFor('起動の許可の確認', menuOf('permission'));
      expect(calls).toHaveLength(before + 1);
      expect(`${start.title}\n${start.context.join('\n')}`).toContain('利用枠');
      await run.answer(start.title, start.options[0].id);
      await run.waitFor('返事', replied(run, 'バイパスで扱いました'));
      expect(calls[before + 1]).toMatchObject({ tool: 'start_session', args: { prompt: '別の作業', worktree: true } });
      expect(run.manager.modeOf(run.sessionId!)).toBe('bypassPermissions');
    });
  });
});
