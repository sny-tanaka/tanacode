import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionMode } from '@shared/screen';
import { terminalToolId } from '@shared/terminal-tools';
import { McpBridge } from '../../src/main/mcp-bridge';
import { ShellTerminals } from '../../src/main/shell-terminals';
import { TERMINAL_GATE_REQUEST } from '../../src/main/terminal-bridge';
import { TerminalControl } from '../../src/main/terminal-control';
import { writeToolPermissionFiles } from '../../src/main/tool-permissions';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi, type Block } from './mock-api';

// 本物の claude をモックの API で動かし、ツールごとの許可（毎回確認・常に許可。src/main/tool-permissions.ts）が効くかを確かめる。
// アプリと同じ起動の引数（--mcp-config・--allowedTools・--settings の PreToolUse のフック）と環境変数（印のフォルダ）で起動する。
// 人のターミナルの MCP を使う（読むツールは既定で常に許可、打つツールは既定で毎回確認。打つツールはアプリ側でも確認した印を確かめる）
// - 毎回確認にした読むツールは、--allowedTools で許可済みでも確認が出る。bypassPermissions でも出る
// - 常に許可にした打つツールは、manual でも確認なしで打てる（アプリ側の印の確かめも通る）。plan のときは確認が出る
// - 印は呼び出しのたびに読むので、起動したあとに変えても、次の呼び出しから効く

const version = claudeVersion();

const call = (id: string, name: string, input: Record<string, unknown> = {}): Block[] => [{ type: 'tool_use', id, name: terminalToolId(name), input }];
const SHELL = 'shell-1';

// アプリの代わり。本物の TerminalControl に、ソケットで届いた呼び出しを渡す
class FakeApp {
  readonly shells = new ShellTerminals({ onData: () => {}, onExit: () => {} });
  readonly calls: string[] = [];
  sessionId = '';
  readonly dir = mkdtempSync(join(tmpdir(), 'tanacode-tool-permissions-cli-'));
  readonly socketPath = join(this.dir, 'terminal.sock');
  readonly permissionsDir = join(this.dir, 'tool-permissions');
  private readonly control = new TerminalControl({
    terminals: this.shells,
    sessions: { exists: (id) => id === this.sessionId, cwdOf: () => this.dir, parentOf: () => null, childrenOf: () => [] },
    enabled: () => true,
  });
  private readonly bridge = new McpBridge(this.socketPath, async (session, tool, args, signal) => {
    if (tool !== TERMINAL_GATE_REQUEST) this.calls.push(tool);
    return this.control.handle(session, tool, args, signal);
  });

  start(): Promise<void> {
    return this.bridge.start();
  }

  async openShell(cwd: string): Promise<void> {
    const { id } = this.shells.create(this.sessionId, cwd, 80, 24);
    expect(id).toBe(SHELL);
    this.shells.write(id, `PS1='$ '; echo ready\r`);
    await this.waitForText('ready');
  }

  async waitForText(text: string): Promise<void> {
    const until = Date.now() + 10_000;
    for (;;) {
      await this.shells.flush(SHELL);
      if ((this.shells.tail(SHELL, 200) ?? []).join('\n').includes(text)) return;
      if (Date.now() > until) throw new Error(`ターミナルに「${text}」が出ません`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  close(): void {
    this.bridge.close();
    this.shells.killAll();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

async function launch(conversation: { match: string; steps: Block[][] }, mode: PermissionMode, permissions: Record<string, 'ask' | 'allow'>) {
  const script = await buildRelay('terminal-mcp');
  const app = new FakeApp();
  writeToolPermissionFiles(app.permissionsDir, permissions);
  await app.start();
  const api = new MockApi();
  api.conversations = [{ ...conversation, delayMs: 1000 }];
  const run = new ClaudeRun(await api.start(), { terminal: { command: process.execPath, script, socketPath: app.socketPath, version: 'test', permissionsDir: app.permissionsDir }, mode });
  await run.open();
  app.sessionId = run.sessionId!;
  await app.openShell(run.cwd);
  return { api, run, app };
}

const replied = (run: ClaudeRun, text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
const prompts = (run: ClaudeRun) => run.attentions.filter((a) => a.kind === 'menu' && a.menu.kind === 'permission');

describe(`Claude Code ${version} とツールごとの許可（manual）`, () => {
  const GO = 'ターミナルを読んで打ってください';
  const AGAIN = 'もう一度読んでください';
  let api: MockApi;
  let run: ClaudeRun;
  let app: FakeApp;

  beforeAll(async () => {
    ({ api, run, app } = await launch(
      {
        match: GO,
        steps: [
          call('toolu_list', 'list_terminals'),
          call('toolu_type', 'type_in_terminal', { id: SHELL, text: 'echo typed-without-asking' }),
          call('toolu_read', 'read_terminal', { id: SHELL, lines: 20 }),
          [{ type: 'text', text: '読みました' }],
          call('toolu_read2', 'read_terminal', { id: SHELL, lines: 20 }),
          [{ type: 'text', text: 'もう一度読みました' }],
        ],
      },
      'manual',
      { [terminalToolId('read_terminal')]: 'ask', [terminalToolId('type_in_terminal')]: 'allow' },
    ));
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    app?.close();
  });

  it('既定のままの読むツールは確認なし、常に許可にした打つツールも確認なしで打てる。毎回確認にした読むツールは確認が出る', async () => {
    await run.send(GO);
    const permission = await run.permission('毎回確認にした読むツールの確認');
    expect(permission.tool).toBe(terminalToolId('read_terminal'));
    // 確認が出るまでに、読むツールと打つツールは確認なしで届いて、打てている
    expect(app.calls).toEqual(['list_terminals', 'type_in_terminal']);
    await app.waitForText('typed-without-asking\n$');
    run.replyPermission(permission, { kind: 'allow' });
    await run.waitUntil('返事', replied(run, '読みました'));
    expect(app.calls).toEqual(['list_terminals', 'type_in_terminal', 'read_terminal']);
  });

  it('印を消すと、動いているセッションでも次の呼び出しから既定（確認なし）に戻る', async () => {
    writeToolPermissionFiles(app.permissionsDir, {});
    await run.waitUntil('入力欄', () => run.idle);
    const before = prompts(run).length;
    await run.send(AGAIN);
    await run.waitUntil('返事', replied(run, 'もう一度読みました'));
    expect(prompts(run)).toHaveLength(before);
    expect(app.calls.at(-1)).toBe('read_terminal');
  });
});

describe(`Claude Code ${version} とツールごとの許可（bypassPermissions）`, () => {
  const GO = '許可を聞かないモードで読んでください';
  let api: MockApi;
  let run: ClaudeRun;
  let app: FakeApp;

  beforeAll(async () => {
    ({ api, run, app } = await launch(
      { match: GO, steps: [call('toolu_read', 'read_terminal', { id: SHELL, lines: 20 }), [{ type: 'text', text: '読みました' }]] },
      'bypassPermissions',
      { [terminalToolId('read_terminal')]: 'ask' },
    ));
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    app?.close();
  });

  it('毎回確認にした読むツールは、bypassPermissions でも確認が出る', async () => {
    await run.send(GO);
    const permission = await run.permission('毎回確認にした読むツールの確認');
    expect(permission.tool).toBe(terminalToolId('read_terminal'));
    expect(app.calls).toEqual([]);
    run.replyPermission(permission, { kind: 'allow' });
    await run.waitUntil('返事', replied(run, '読みました'));
    expect(app.calls).toEqual(['read_terminal']);
  });
});

describe(`Claude Code ${version} とツールごとの許可（plan）`, () => {
  const GO = '計画のモードで打ってください';
  let api: MockApi;
  let run: ClaudeRun;
  let app: FakeApp;

  beforeAll(async () => {
    ({ api, run, app } = await launch(
      { match: GO, steps: [call('toolu_type', 'type_in_terminal', { id: SHELL, text: 'echo typed-in-plan' }), [{ type: 'text', text: '打ちました' }]] },
      'plan',
      { [terminalToolId('type_in_terminal')]: 'allow' },
    ));
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    app?.close();
  });

  it('plan のときは、常に許可にしたツールでも確認なしには打たない（既定のとおり確認が出る）', async () => {
    await run.send(GO);
    const permission = await run.permission('plan での打つ前の確認');
    expect(permission.tool).toBe(terminalToolId('type_in_terminal'));
    expect(app.calls).toEqual([]);
    run.replyPermission(permission, { kind: 'deny', message: '打たないでください' });
    await run.waitUntil('返事', replied(run, '打ちました'));
    expect(app.calls).toEqual([]);
  });
});
