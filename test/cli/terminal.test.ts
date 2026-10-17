import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TERMINAL_TOOLS, terminalToolId } from '@shared/terminal-tools';
import type { PermissionMode } from '@shared/screen';
import { McpBridge, textResult } from '../../src/main/mcp-bridge';
import { ShellTerminals } from '../../src/main/shell-terminals';
import { TERMINAL_GATE_REQUEST } from '../../src/main/terminal-bridge';
import { TerminalControl } from '../../src/main/terminal-control';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi, type Block } from './mock-api';
import type { PendingPermission } from '@shared/questions';

// 本物の claude をモックの API で動かし、人のターミナルの MCP サーバー（中継）と、打つ前の確認のフックを確かめる。
// アプリと同じ起動の引数（--mcp-config・--allowedTools・--settings の PreToolUse のフック）で起動し、
// 中継（src/main/terminal-mcp.ts をビルドしたもの）が、アプリの代わりのソケットまでツールの呼び出しを運ぶか。
// アプリの側は本物（TerminalControl と、/bin/sh を開く ShellTerminals）で、フックが控えさせた確認済みの印を、呼び出しが使えるか（入力のハッシュが一致するか）も確かめる。
// - 読むツールは、許可の確認なしに届く
// - 打つツールは、「次から聞かない」で許可を残しても、次の呼び出しでまた確認が出る。bypassPermissions でも確認が出る
// - フックがアプリに聞けない（答えが返らない）ときも確認が出る。許しても、印が無いので何も打たずに断る

const version = claudeVersion();

const call = (id: string, name: string, input: Record<string, unknown> = {}): Block[] => [{ type: 'tool_use', id, name: terminalToolId(name), input }];
// 1 つ目に開いたシェル（ShellTerminals の通し番号。台本は先に書くので、id を決め打ちにする）
const SHELL = 'shell-1';

// 会話ログのツールの結果（tool_use の id → 中身の文）
function resultText(run: ClaudeRun, toolUseId: string): string | undefined {
  for (const entry of run.entries) {
    const content = entry.type === 'user' ? (entry as { message?: { content?: unknown } }).message?.content : null;
    if (!Array.isArray(content)) continue;
    const hit = content.find((b: { type?: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
    if (hit) return JSON.stringify(hit);
  }
  return undefined;
}

// アプリの代わり。本物の TerminalControl に、ソケットで届いた呼び出しを渡す。stallGate: フックの問い合わせに答えない（フックの待つ上限より長く待たせて、エラーを返す）
class FakeApp {
  readonly shells = new ShellTerminals({ onData: () => {}, onExit: () => {} });
  readonly calls: { tool: string; args: Record<string, unknown> }[] = [];
  readonly gates: Record<string, unknown>[] = [];
  stallGate = false;
  sessionId = '';
  private readonly dir = mkdtempSync(join(tmpdir(), 'tanacode-terminal-cli-'));
  readonly socketPath = join(this.dir, 'terminal.sock');
  private readonly control = new TerminalControl({
    terminals: this.shells,
    sessions: { exists: (id) => id === this.sessionId, cwdOf: () => this.dir, parentOf: () => null, childrenOf: () => [] },
    enabled: () => true,
  });
  private readonly bridge = new McpBridge(this.socketPath, async (session, tool, args, signal) => {
    if (tool === TERMINAL_GATE_REQUEST) {
      this.gates.push(args);
      if (this.stallGate) {
        await new Promise((resolve) => setTimeout(resolve, 7000));
        return textResult('stalled', true);
      }
    } else {
      this.calls.push({ tool, args });
    }
    return this.control.handle(session, tool, args, signal);
  });

  start(): Promise<void> {
    return this.bridge.start();
  }

  // 人がターミナルを開いて打った
  async openShell(cwd: string, typed: string): Promise<void> {
    const { id } = this.shells.create(this.sessionId, cwd, 80, 24);
    expect(id).toBe(SHELL);
    this.shells.write(id, `PS1='$ '; ${typed}\r`);
    await this.waitForText(id, typed.replace(/^echo /, ''));
  }

  async waitForText(id: string, text: string): Promise<void> {
    const until = Date.now() + 10_000;
    for (;;) {
      await this.shells.flush(id);
      if ((this.shells.tail(id, 200) ?? []).join('\n').includes(text)) return;
      if (Date.now() > until) throw new Error(`ターミナルに「${text}」が出ません`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async screenText(): Promise<string> {
    await this.shells.flush(SHELL);
    return (this.shells.tail(SHELL, 200) ?? []).join('\n');
  }

  close(): void {
    this.bridge.close();
    this.shells.killAll();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

async function launch(conversation: { match: string; steps: Block[][] }, mode: PermissionMode): Promise<{ api: MockApi; run: ClaudeRun; app: FakeApp }> {
  const script = await buildRelay('terminal-mcp');
  const app = new FakeApp();
  await app.start();
  const api = new MockApi();
  // 許可の確認が続けて出ても見分けられるよう、応答を少し遅らせる
  api.conversations = [{ ...conversation, delayMs: 1000 }];
  const run = new ClaudeRun(await api.start(), { terminal: { command: process.execPath, script, socketPath: app.socketPath, version: 'test' }, mode });
  await run.open();
  app.sessionId = run.sessionId!;
  return { api, run, app };
}

// 許可の確認の見出し・説明・理由・入力（打つ文字が、どれかにそのまま出る）
const textOf = (permission: PendingPermission) => [permission.title, permission.description, permission.reason, JSON.stringify(permission.input)].join('\n');

describe(`Claude Code ${version} と人のターミナルの MCP`, () => {
  const READ = 'ターミナルを読んでください';
  const TYPE = 'ターミナルで打ってください';
  const AGAIN = 'もう一度打ってください';
  const STALL = 'アプリが答えないときに打ってください';
  let api: MockApi;
  let run: ClaudeRun;
  let app: FakeApp;
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);

  beforeAll(async () => {
    ({ api, run, app } = await launch(
      {
        match: READ,
        steps: [
          call('toolu_list', 'list_terminals'),
          call('toolu_read', 'read_terminal', { id: SHELL, lines: 20 }),
          [{ type: 'text', text: '読みました' }],
          call('toolu_type', 'type_in_terminal', { id: SHELL, text: 'echo typed-by-claude' }),
          [{ type: 'text', text: '打ちました' }],
          call('toolu_again', 'type_in_terminal', { id: SHELL, text: 'echo typed-again' }),
          [{ type: 'text', text: 'もう一度打ちました' }],
          call('toolu_stall', 'type_in_terminal', { id: SHELL, text: 'echo never-typed' }),
          [{ type: 'text', text: '打てませんでした' }],
        ],
      },
      'manual',
    ));
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    app?.close();
  });

  it('ツールの一覧が Claude に渡る', async () => {
    await app.openShell(run.cwd, 'echo typed-by-human');
    await run.send(READ);
    await run.waitUntil('返事', replied('読みました'));
    for (const tool of TERMINAL_TOOLS) expect([...api.tools], tool.name).toContain(terminalToolId(tool.name));
  });

  it('読むツールは、許可の確認なしにアプリまで届き、人が打った出力を読める', () => {
    // 出たメニューは、はじめのフォルダの信頼の確認だけ
    expect(run.attentions.filter((a) => a.kind === 'menu' && a.menu.kind === 'permission')).toEqual([]);
    expect(app.calls.map((c) => c.tool)).toEqual(['list_terminals', 'read_terminal']);
    expect(resultText(run, 'toolu_list')).toContain(SHELL);
    expect(resultText(run, 'toolu_read')).toContain('typed-by-human');
  });

  it('打つツールは確認が出る。理由と入力に、打つ文字がそのまま出る。許すと、フックが控えさせた印で打てる', async () => {
    await run.waitUntil('入力欄', () => run.idle);
    await run.send(TYPE);
    const permission = await run.permission('打つ前の確認');
    expect(textOf(permission)).toContain('echo typed-by-claude');
    expect(app.gates).toEqual([{ id: SHELL, text: 'echo typed-by-claude' }]);
    // 確かめただけで、まだ打っていない
    expect(app.calls.map((c) => c.tool)).toEqual(['list_terminals', 'read_terminal']);
    // フックが確認させたツールには、Claude Code は「今後は聞かない」の候補を出さない（毎回確かめる）
    expect(permission.always ?? []).toEqual([]);
    run.replyPermission(permission, { kind: 'allow' });
    await run.waitUntil('返事', replied('打ちました'));
    expect(resultText(run, 'toolu_type')).toContain('typed-by-claude');
    await app.waitForText(SHELL, 'typed-by-claude\n$');
  });

  it('許したあとの次の呼び出しでも、また確認が出る', async () => {
    await run.waitUntil('入力欄', () => run.idle);
    await run.send(AGAIN);
    const permission = await run.permission('2 回目の打つ前の確認');
    expect(textOf(permission)).toContain('echo typed-again');
    run.replyPermission(permission, { kind: 'allow' });
    await run.waitUntil('返事', replied('もう一度打ちました'));
    expect(await app.screenText()).toContain('typed-again');
  });

  it('フックがアプリに聞けないときも確認が出る。許しても、確認済みの印が無いので、何も打たずに断る', async () => {
    app.stallGate = true;
    await run.waitUntil('入力欄', () => run.idle);
    await run.send(STALL);
    const permission = await run.permission('アプリが答えないときの確認', 30_000);
    expect(textOf(permission)).toContain('echo never-typed');
    run.replyPermission(permission, { kind: 'allow' });
    await run.waitUntil('返事', replied('打てませんでした'));
    expect(resultText(run, 'toolu_stall')).toContain('confirmation for this input was not found');
    expect(await app.screenText()).not.toContain('never-typed\n');
  });
});

describe(`Claude Code ${version} と人のターミナルの MCP（bypassPermissions）`, () => {
  const TYPE = '許可を聞かないモードで打ってください';
  let api: MockApi;
  let run: ClaudeRun;
  let app: FakeApp;

  beforeAll(async () => {
    ({ api, run, app } = await launch(
      { match: TYPE, steps: [call('toolu_bypass', 'type_in_terminal', { id: SHELL, text: 'echo typed-in-bypass' }), [{ type: 'text', text: '打ちました' }]] },
      'bypassPermissions',
    ));
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    app?.close();
  });

  it('権限モードが bypassPermissions でも、打つ前に確認が出る', async () => {
    await app.openShell(run.cwd, 'echo ready');
    await run.send(TYPE);
    const permission = await run.permission('打つ前の確認');
    expect(textOf(permission)).toContain('echo typed-in-bypass');
    run.replyPermission(permission, { kind: 'allow' });
    await run.waitUntil('返事', () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === '打ちました'));
    await app.waitForText(SHELL, 'typed-in-bypass\n$');
  });
});
