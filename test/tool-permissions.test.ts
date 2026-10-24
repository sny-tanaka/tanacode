import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import { checklistToolId } from '@shared/checklist-tools';
import { setLanguage, t } from '@shared/i18n';
import { mcpToolId } from '@shared/mcp-tools';
import { sessionToolId } from '@shared/session-tools';
import { terminalToolId } from '@shared/terminal-tools';
import { changedToolPermissions, defaultToolPermission, hiddenFromChild, PERMISSION_SERVERS, permissionToolDefaults, toolDefaultRule, toolPermissionsOf } from '@shared/tool-permissions';
import { walkthroughToolId } from '@shared/walkthrough-tools';
import { AppSettings } from '../src/main/app-settings';
import { runGate } from '../src/main/browser-gate';
import { McpBridge, textResult } from '../src/main/mcp-bridge';
import { runTerminalGate } from '../src/main/terminal-bridge';
import { alwaysAllowed, TOOL_PERMISSIONS_DIR_ENV, toolPermissionCommand, toolPermissionHooks, writeToolPermissionFiles } from '../src/main/tool-permissions';

// tanacode の MCP のツールごとの許可（毎回確認・常に許可）。既定・保存・印のファイル・フック

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-tool-permissions-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const ruleOf = (id: string) => {
  for (const { def } of PERMISSION_SERVERS) for (const tool of def.tools) if (mcpToolId(def.name, tool.name) === id) return { rule: toolDefaultRule(def, tool), permission: defaultToolPermission(def, tool) };
  throw new Error(id);
};

describe('既定', () => {
  it('5 つの MCP の、全部のツールに既定がある', () => {
    expect(PERMISSION_SERVERS.map((s) => s.def.labels)).toEqual(['browser', 'sessions', 'checklist', 'walkthrough', 'terminal']);
    expect(permissionToolDefaults().size).toBe(PERMISSION_SERVERS.reduce((n, s) => n + s.def.tools.length, 0));
  });

  it('既定: 毎回確認はターミナルに打つ・再起動・セッションを始める・開く（許す先の外）・JavaScript の実行（localhost 以外）・PR に載せるだけ。ほかは常に許可', () => {
    const asks = [...permissionToolDefaults()].filter(([, p]) => p === 'ask').map(([id]) => id).sort();
    expect(asks).toEqual([browserToolId('evaluate'), browserToolId('navigate'), sessionToolId('restart_app'), sessionToolId('start_session'), terminalToolId('type_in_terminal'), walkthroughToolId('post_walkthrough')].sort());
    expect(ruleOf(browserToolId('screenshot'))).toEqual({ rule: 'allowed', permission: 'allow' });
    expect(ruleOf(browserToolId('ask_user_to_act'))).toEqual({ rule: 'allowed', permission: 'allow' });
    expect(ruleOf(sessionToolId('send_message'))).toEqual({ rule: 'allowed', permission: 'allow' });
    expect(ruleOf(checklistToolId('card_add'))).toEqual({ rule: 'allowed', permission: 'allow' });
    expect(ruleOf(walkthroughToolId('show_code'))).toEqual({ rule: 'allowed', permission: 'allow' });
    expect(ruleOf(browserToolId('click'))).toEqual({ rule: 'act', permission: 'allow' });
    expect(ruleOf(sessionToolId('stop_session'))).toEqual({ rule: 'act', permission: 'allow' });
    expect(ruleOf(walkthroughToolId('post_walkthrough'))).toEqual({ rule: 'always', permission: 'ask' });
    expect(ruleOf(sessionToolId('start_session'))).toEqual({ rule: 'always', permission: 'ask' });
    expect(ruleOf(sessionToolId('restart_app'))).toEqual({ rule: 'always', permission: 'ask' });
    expect(ruleOf(terminalToolId('type_in_terminal'))).toEqual({ rule: 'always', permission: 'ask' });
    expect(ruleOf(browserToolId('navigate'))).toEqual({ rule: 'outside', permission: 'ask' });
    expect(ruleOf(browserToolId('evaluate'))).toEqual({ rule: 'remote', permission: 'ask' });
  });

  it('子セッションに出さないツールが分かる', () => {
    const [browser, sessions, , , terminal] = PERMISSION_SERVERS;
    const tool = (server: (typeof PERMISSION_SERVERS)[number], name: string) => server.def.tools.find((t) => t.name === name)!;
    expect(hiddenFromChild(sessions!, tool(sessions!, 'start_session'))).toBe(true);
    expect(hiddenFromChild(sessions!, tool(sessions!, 'schedule_wakeup'))).toBe(false);
    expect(hiddenFromChild(terminal!, tool(terminal!, 'type_in_terminal'))).toBe(true);
    expect(hiddenFromChild(browser!, tool(browser!, 'click'))).toBe(false);
  });

  it('保存の値は、知っているツールの ask・allow だけにする。既定と同じ値も持つ。印は既定から変えたものだけ', () => {
    const saved = toolPermissionsOf({ [browserToolId('click')]: 'ask', [browserToolId('screenshot')]: 'allow', 'mcp__other__x': 'allow', [browserToolId('scroll')]: 'yes' });
    expect(saved).toEqual({ [browserToolId('click')]: 'ask', [browserToolId('screenshot')]: 'allow' });
    expect(changedToolPermissions(saved)).toEqual({ [browserToolId('click')]: 'ask' });
    expect(toolPermissionsOf(null)).toEqual({});
    expect(toolPermissionsOf(['x'])).toEqual({});
  });

  it('アプリの設定に保存され、読み直せる（無ければ空）', () => {
    const file = join(root, 'settings.json');
    const settings = new AppSettings(file);
    expect(settings.toolPermissions()).toEqual({});
    settings.setToolPermissions({ [sessionToolId('start_session')]: 'allow', bad: 'allow' } as never);
    expect(new AppSettings(file).toolPermissions()).toEqual({ [sessionToolId('start_session')]: 'allow' });
    expect(JSON.parse(readFileSync(file, 'utf8')).toolPermissions).toEqual({ [sessionToolId('start_session')]: 'allow' });
  });
});

describe('印のファイル', () => {
  it('既定から変えたツールの印だけを置き、ほかの印は消す', () => {
    const dir = join(root, 'tool-permissions');
    writeToolPermissionFiles(dir, { [browserToolId('click')]: 'ask', [browserToolId('evaluate')]: 'allow', [browserToolId('get_text')]: 'allow' });
    expect(readdirSync(dir).sort()).toEqual([`${browserToolId('click')}.ask`, `${browserToolId('evaluate')}.allow`]);
    writeFileSync(join(dir, 'stale'), '');
    writeToolPermissionFiles(dir, { [browserToolId('click')]: 'allow' });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('フック', () => {
  // 起動する Claude Code と同じ形（環境変数で印のフォルダを渡す）で動かす
  const run = (command: string, input: Record<string, unknown>, dir: string | null) => {
    const out = execFileSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      input: JSON.stringify(input),
      env: { PATH: process.env.PATH ?? '', ...(dir === null ? {} : { [TOOL_PERMISSIONS_DIR_ENV]: dir }) },
    });
    return JSON.parse(out) as { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string }; suppressOutput: boolean };
  };
  const input = (tool: string, mode = 'default', toolInput: Record<string, unknown> = {}) => ({ session_id: 's', permission_mode: mode, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput });
  const decisionOf = (command: string, tool: string, dir: string | null, mode?: string) => run(command, input(tool, mode), dir).hookSpecificOutput?.permissionDecision ?? null;

  it('アプリに問い合わせる確認のフックのツール（開く・JavaScript の実行・ターミナルに打つ）を除く、全部のツールに 1 つずつ当たる', () => {
    const hooks = toolPermissionHooks();
    expect(hooks).toHaveLength(permissionToolDefaults().size - 3);
    expect(hooks.map((h) => h.matcher)).not.toContain(browserToolId('navigate'));
    expect(hooks.map((h) => h.matcher)).not.toContain(browserToolId('evaluate'));
    expect(hooks.map((h) => h.matcher)).not.toContain(terminalToolId('type_in_terminal'));
    expect(hooks.find((h) => h.matcher === sessionToolId('start_session'))?.hooks).toEqual([{ type: 'command', command: toolPermissionCommand(sessionToolId('start_session'), 'always'), timeout: 10 }]);
    // チャットのフックの一覧に出さない目印
    for (const hook of hooks) expect(hook.hooks[0].command).toContain('TANACODE_TOOL_PERMISSION=1');
  });

  it('既定で許可済みのツール: 毎回確認の印があれば ask（plan でも）。無ければ何も決めない', () => {
    const dir = join(root, 'p');
    const id = browserToolId('screenshot');
    const command = toolPermissionCommand(id, 'allowed');
    writeToolPermissionFiles(dir, {});
    expect(run(command, input(id), dir)).toEqual({ suppressOutput: true });
    writeToolPermissionFiles(dir, { [id]: 'ask' });
    expect(run(command, input(id), dir)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: t('main.hooks.toolAsk') },
      suppressOutput: true,
    });
    expect(decisionOf(command, id, dir, 'plan')).toBe('ask');
    expect(decisionOf(command, id, dir, 'bypassPermissions')).toBe('ask');
  });

  it('動かすツール: 既定は allow（manual でも）。plan のときは何も決めない。毎回確認の印があれば ask（plan でも）', () => {
    const dir = join(root, 'p');
    const id = browserToolId('click');
    const command = toolPermissionCommand(id, 'act');
    writeToolPermissionFiles(dir, {});
    expect(run(command, input(id, 'default'), dir).hookSpecificOutput).toMatchObject({ permissionDecision: 'allow', permissionDecisionReason: t('main.hooks.toolAllow') });
    expect(decisionOf(command, id, dir, 'plan')).toBeNull();
    expect(decisionOf(command, id, null)).toBe('allow');
    writeToolPermissionFiles(dir, { [id]: 'ask' });
    expect(decisionOf(command, id, dir)).toBe('ask');
    expect(decisionOf(command, id, dir, 'bypassPermissions')).toBe('ask');
    expect(decisionOf(command, id, dir, 'plan')).toBe('ask');
    writeToolPermissionFiles(dir, {});
    // 空白入りの plan も
    const out = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', input: '{"permission_mode": "plan","tool_name":"x"}', env: { PATH: process.env.PATH ?? '', [TOOL_PERMISSIONS_DIR_ENV]: dir } });
    expect(JSON.parse(out)).toEqual({ suppressOutput: true });
  });

  it('既定でいつも確認を出させるツール（セッションを始める・tanacode の再起動・PR に載せる）: 常に許可の印があれば allow。plan のとき・印が無いときは ask', () => {
    const dir = join(root, 'p');
    const reasons = { [sessionToolId('start_session')]: 'main.hooks.sessionsGate', [sessionToolId('restart_app')]: 'main.hooks.restartGate', [walkthroughToolId('post_walkthrough')]: 'main.hooks.postWalkthroughGate' } as const;
    for (const [id, reason] of Object.entries(reasons)) {
      const command = toolPermissionCommand(id, 'always');
      writeToolPermissionFiles(dir, {});
      expect(run(command, input(id), dir).hookSpecificOutput).toMatchObject({ permissionDecision: 'ask', permissionDecisionReason: t(reason) });
      writeToolPermissionFiles(dir, { [id]: 'allow' });
      expect(run(command, input(id), dir).hookSpecificOutput).toMatchObject({ permissionDecision: 'allow', permissionDecisionReason: t('main.hooks.toolAllow') });
      expect(decisionOf(command, id, dir, 'plan')).toBe('ask');
    }
  });

  it('印のフォルダの環境変数が無い・空なら、既定のまま。空白や引用符を含むフォルダでも読める', () => {
    const id = sessionToolId('start_session');
    const command = toolPermissionCommand(id, 'always');
    expect(decisionOf(command, id, null)).toBe('ask');
    expect(decisionOf(command, id, '')).toBe('ask');
    const dir = join(root, 'Application Support', "it's here");
    mkdirSync(dir, { recursive: true });
    writeToolPermissionFiles(dir, { [id]: 'allow' });
    expect(decisionOf(command, id, dir)).toBe('allow');
  });

  it('同じコマンドのまま、印を置く・消すと、次の呼び出しから切り替わる（動いているセッションにもすぐ効く）', () => {
    const dir = join(root, 'p');
    const id = checklistToolId('card_delete');
    const command = toolPermissionCommand(id, 'allowed');
    writeToolPermissionFiles(dir, { [id]: 'ask' });
    expect(decisionOf(command, id, dir)).toBe('ask');
    writeToolPermissionFiles(dir, { [id]: 'allow' });
    expect(decisionOf(command, id, dir)).toBeNull();
  });

  it('理由は、Claude Code を起動するときの言語で書く（英語でも JSON として読める）', () => {
    setLanguage('en');
    try {
      const dir = join(root, 'p');
      const id = browserToolId('get_text');
      writeToolPermissionFiles(dir, { [id]: 'ask' });
      expect(run(toolPermissionCommand(id, 'allowed'), input(id), dir).hookSpecificOutput?.permissionDecisionReason).toBe(t('main.hooks.toolAsk'));
    } finally {
      setLanguage('ja');
    }
  });
});

describe('アプリに問い合わせる確認のフック', () => {
  it('alwaysAllowed は、常に許可の印があって plan でないときだけ true', () => {
    const dir = join(root, 'p');
    const id = browserToolId('evaluate');
    const hook = (mode: string) => JSON.stringify({ permission_mode: mode, tool_name: id });
    expect(alwaysAllowed(id, hook('default'), dir)).toBe(false);
    writeToolPermissionFiles(dir, { [id]: 'allow' });
    expect(alwaysAllowed(id, hook('default'), dir)).toBe(true);
    expect(alwaysAllowed(id, hook('plan'), dir)).toBe(false);
    expect(alwaysAllowed(id, 'not json', dir)).toBe(false);
    expect(alwaysAllowed(id, hook('default'), '')).toBe(false);
  });

  it('アプリ内ブラウザ: 常に許可なら、アプリに問い合わせて（確認した印を控えさせて）から allow を返す。plan では既定のまま', async () => {
    const dir = join(root, 'p');
    vi.stubEnv(TOOL_PERMISSIONS_DIR_ENV, dir);
    const socketPath = join(root, 'gate.sock');
    const asked: string[] = [];
    const bridge = new McpBridge(socketPath, async (_session, _tool, args) => {
      asked.push(args.tool as string);
      if (args.tool === browserToolId('navigate')) return textResult(JSON.stringify({ outside: 'https://example.com' }));
      return textResult(JSON.stringify({ local: false, url: 'https://example.com/' }));
    });
    await bridge.start();
    const decision = (output: string) => (JSON.parse(output) as { hookSpecificOutput?: { permissionDecision: string } }).hookSpecificOutput?.permissionDecision;
    const hook = (name: string, mode = 'default') => JSON.stringify({ permission_mode: mode, tool_name: browserToolId(name), tool_input: name === 'navigate' ? { url: 'https://example.com/' } : { expression: '1' } });
    try {
      expect(decision(await runGate(socketPath, 's1', 5000, hook('navigate')))).toBe('ask');
      expect(decision(await runGate(socketPath, 's1', 5000, hook('evaluate')))).toBe('ask');
      writeToolPermissionFiles(dir, { [browserToolId('navigate')]: 'allow', [browserToolId('evaluate')]: 'allow' });
      asked.length = 0;
      expect(decision(await runGate(socketPath, 's1', 5000, hook('navigate')))).toBe('allow');
      expect(decision(await runGate(socketPath, 's1', 5000, hook('evaluate')))).toBe('allow');
      expect(asked).toEqual([browserToolId('navigate'), browserToolId('evaluate')]);
      expect(decision(await runGate(socketPath, 's1', 5000, hook('navigate', 'plan')))).toBe('ask');
      expect(decision(await runGate(socketPath, 's1', 5000, hook('evaluate', 'plan')))).toBe('ask');
    } finally {
      bridge.close();
    }
  });

  it('ターミナル: 常に許可なら、アプリに問い合わせて（確認した印を控えさせて）から allow を返す。plan では ask', async () => {
    const dir = join(root, 'p');
    vi.stubEnv(TOOL_PERMISSIONS_DIR_ENV, dir);
    const socketPath = join(root, 'terminal.sock');
    let asked = 0;
    const bridge = new McpBridge(socketPath, async () => {
      asked++;
      return textResult(JSON.stringify({ tab: 'zsh 1', typed: 'ls ⏎' }));
    });
    await bridge.start();
    const decision = (output: string) => (JSON.parse(output) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
    const hook = (mode = 'default') => JSON.stringify({ permission_mode: mode, tool_name: terminalToolId('type_in_terminal'), tool_input: { text: 'ls', enter: true } });
    try {
      expect(decision(await runTerminalGate(socketPath, 's1', hook(), 5000))).toBe('ask');
      writeToolPermissionFiles(dir, { [terminalToolId('type_in_terminal')]: 'allow' });
      expect(decision(await runTerminalGate(socketPath, 's1', hook(), 5000))).toBe('allow');
      expect(asked).toBe(2);
      expect(decision(await runTerminalGate(socketPath, 's1', hook('plan'), 5000))).toBe('ask');
    } finally {
      bridge.close();
    }
  });
});
