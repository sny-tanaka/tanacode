import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Activity } from '@shared/screen';
import { PRECOMPACT_REASON } from '../../src/main/auto-compact';
import { PRECOMPACT_HOOK_REQUEST } from '../../src/main/checklist-bridge';
import { McpBridge, textResult } from '../../src/main/mcp-bridge';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi, type Block } from './mock-api';

// 本物の claude をモックの API で動かし、作業中の表示の段階のうち、Claude Code の知らせ（system の行）から作るものを確かめる。
// - auto モードの判定（ツールを使ってよいか）を 4 秒より長く待つと、判定待ち（permission_check_status）になり、済むと戻る
// - Claude Code の自動の圧縮（コンテキストが埋まった）の間は、圧縮中になる
// - 自動の最適化圧縮がオンのセッションでは、アプリの圧縮の前のフック（PreCompact。src/main/checklist-hook.ts）が自動の圧縮を止める。
//   Claude Code はフックより先に圧縮中を知らせるが、止める圧縮は圧縮中にせず、失敗もチャットに出さない
// アプリの代わりのソケットの先で、圧縮の前のフックに「止める」か「止めない」を答える（AutoCompact の代わり）

const CHECK = '安全の確認を待つコマンドを動かしてください（CHECK-SAFETY）';
const FILL = 'コンテキストを埋める発言です';
const BLOCKED = 'アプリが自動の圧縮を止める発言です';
const COMPACTED = '自動の圧縮のあとの発言です';
const SUMMARY_REQUEST = 'Your task is to create a detailed summary';
const version = claudeVersion();
const say = (text: string): Block[] => [{ type: 'text', text }];

describe(`Claude Code ${version} の作業中の表示（判定待ち・圧縮中）`, () => {
  let api: MockApi;
  let bridge: McpBridge;
  let dir: string;
  let run: ClaudeRun;
  let baseUrl: string;
  // 圧縮の前のフックで、Claude Code の自動の圧縮を止めるか（AutoCompact.preCompact の代わり）
  let block = false;
  // アプリに届いた、圧縮の前のフックの問い合わせの数と、SessionManager が「止めるか」を聞いた数
  let precompactHooks = 0;
  let blockedAsks = 0;
  const said = (text: string) => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  const idleAfter = (text: string) => run.waitUntil(`「${text}」のあと手が空く`, () => run.idle && said(text), 60_000);
  const phasesSince = (from: number) => run.activities.slice(from).map((a: Activity | null) => a?.phase ?? null);
  const dividers = () => run.chatEvents.filter((e) => e.type === 'divider').length;
  const errors = () => run.chatEvents.filter((e) => e.type === 'api-error');

  beforeAll(async () => {
    const script = await buildRelay('checklist-mcp');
    dir = mkdtempSync(join(tmpdir(), 'tanacode-progress-'));
    // チェックリストのフック（発言のとき・ターンの終わり）には何も足さず、圧縮の前のフックには block のとおりに答える
    bridge = new McpBridge(join(dir, 'checklist.sock'), (_session, tool) => {
      if (tool !== PRECOMPACT_HOOK_REQUEST) return Promise.resolve(textResult(''));
      precompactHooks += 1;
      return Promise.resolve(textResult(block ? PRECOMPACT_REASON : ''));
    });
    await bridge.start();
    api = new MockApi();
    baseUrl = await api.start();
    // auto モードの判定（ツールの一覧の無い呼び出し。1 段目は <severity>N</severity> だけを答えさせる）を 5 秒待たせて、害が無いと答える
    api.plainReplies = [{ match: 'Respond with <severity>N</severity>', text: '<severity>0', delayMs: 5000 }];
    api.intercept = (prompt, results) => {
      // 要約の頼み。答えたら、コンテキストの量を小さく戻す（圧縮のあとも埋まったままにしない）
      if (prompt.includes(SUMMARY_REQUEST)) {
        api.inputTokens = 100;
        return say('<summary>要約です</summary>');
      }
      if (results.length > 0) return say('コマンドの結果を受け取りました');
      if (prompt.includes('CHECK-SAFETY')) return [{ type: 'tool_use', id: 'toolu_check', name: 'Bash', input: { command: `curl -s ${baseUrl}/ping`, description: 'モックのサーバーに聞く' } }];
      for (const text of [FILL, BLOCKED, COMPACTED]) if (prompt.includes(text)) return say(`${text}への返事`);
      return null;
    };
    run = new ClaudeRun(baseUrl, { mode: 'auto', checklist: { command: process.execPath, script, socketPath: bridge.socketPath, version: 'test' } });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    bridge?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('auto モードの判定を 4 秒より長く待つ間は判定待ちになり、判定が済むとツールの実行に戻る', async () => {
    const from = run.activities.length;
    await run.send(CHECK);
    await run.waitUntil('判定待ち', () => run.activities.at(-1)?.phase === 'checking', 30_000);
    await idleAfter('コマンドの結果を受け取りました');
    const phases = phasesSince(from);
    // 判定が済んだあとは、判定待ちではなくなる（ツールの実行・応答待ちを経て、ターンが終わる）
    expect(phases.slice(phases.lastIndexOf('checking') + 1).filter((p) => p !== null).length).toBeGreaterThan(0);
    expect(phases.at(-1)).toBeNull();
    // 判定が通って、コマンドが動いた
    expect(api.requests.some((r) => r.startsWith('GET /ping'))).toBe(true);
  });

  it('アプリの圧縮の前のフックが止める自動の圧縮は、圧縮中にせず、失敗もチャットに出さない', async () => {
    // コンテキストの上限はモデルによるので、はじめの応答のあとのヘッダーの量から求める
    const size = run.statusLine?.context?.size;
    expect(size, 'コンテキストの上限').toBeGreaterThan(0);
    api.inputTokens = Math.round(size! * 0.97);
    await run.send(FILL);
    await idleAfter(`${FILL}への返事`);
    block = true;
    run.manager.compactBlocked = () => {
      blockedAsks += 1;
      return true;
    };
    const from = run.activities.length;
    const before = dividers();
    await run.send(BLOCKED);
    await idleAfter(`${BLOCKED}への返事`);
    // Claude Code は自動の圧縮を始めようとして（compact_output_chars の付いた compacting）、フックが止めた
    expect(blockedAsks).toBeGreaterThan(0);
    expect(precompactHooks).toBeGreaterThan(0);
    expect(phasesSince(from)).not.toContain('compacting');
    expect(dividers()).toBe(before);
    expect(errors()).toEqual([]);
  });

  it('フックが止めない自動の圧縮の間は、圧縮中になる。終わると会話の区切りが出て、圧縮中ではなくなる', async () => {
    block = false;
    run.manager.compactBlocked = () => false;
    const from = run.activities.length;
    const before = dividers();
    const hooks = precompactHooks;
    await run.send(COMPACTED);
    await idleAfter(`${COMPACTED}への返事`);
    expect(precompactHooks).toBeGreaterThan(hooks);
    const phases = phasesSince(from);
    expect(phases).toContain('compacting');
    expect(phases.slice(phases.lastIndexOf('compacting') + 1).filter((p) => p !== null).length).toBeGreaterThan(0);
    expect(dividers()).toBe(before + 1);
    expect(errors()).toEqual([]);
  });
});
