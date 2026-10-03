import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BROWSER_TOOLS,
  allowedBrowserToolIds,
  browserToolId,
  gatedBrowserToolIds,
  isClaudeAllowedUrl,
  isLocalUrl,
  normalizeHostPattern,
} from '../src/shared/browser-tools';
import { AppSettings } from '../src/main/app-settings';
import { BROWSER_GATE_REQUEST, BrowserBridge, browserGateEnv, browserMcpArgs, callBridge, textResult, type BrowserMcpLaunch } from '../src/main/browser-bridge';
import { BROWSER_GATE_COMMAND, gateOutput, readAnswer, runGate } from '../src/main/browser-gate';
import { respond, type RelayDeps } from '../src/main/browser-relay';
import { claudeArgs } from '../src/main/claude-session';
import { mergeSettings } from '../src/main/settings-files';
import { ownSettings } from '../src/main/statusline';

// アプリ内ブラウザの MCP。中継（MCP の JSON-RPC）・アプリとのソケット・Claude に許す先・起動の引数

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-browser-mcp-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('中継（MCP の JSON-RPC）', () => {
  const calls: [string, Record<string, unknown>][] = [];
  const deps: RelayDeps = {
    version: '9.9.9',
    call: async (tool, args) => {
      calls.push([tool, args]);
      return textResult(`${tool} をしました`);
    },
  };

  it('initialize: 求められた版で答え、ツールを持つことと使い方を伝える', async () => {
    const reply = await respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, deps);
    expect(reply).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'tanacode-browser', version: '9.9.9' } },
    });
    expect((reply?.result as { instructions: string }).instructions).toContain('信用できない');
    // 知らない版なら、知っているもので答える
    const other = await respond({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, deps);
    expect((other?.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
  });

  it('tools/list: すべてのツールを、名前・説明・入力の形とともに返す', async () => {
    const reply = await respond({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, deps);
    const tools = (reply?.result as { tools: { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(BROWSER_TOOLS.map((t) => t.name));
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
    expect(tools.find((t) => t.name === 'screenshot')?.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'click')?.annotations.readOnlyHint).toBe(false);
  });

  it('tools/call: アプリに渡す。知らないツールは渡さずにエラーの結果にする', async () => {
    calls.length = 0;
    const reply = await respond({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'click', arguments: { selector: '#a' } } }, deps);
    expect(reply).toEqual({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'click をしました' }] } });
    const unknown = await respond({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm', arguments: {} } }, deps);
    expect(unknown?.result).toMatchObject({ isError: true });
    expect(calls).toEqual([['click', { selector: '#a' }]]);
  });

  it('通知には答えず、知らないメソッドはエラーにする', async () => {
    expect(await respond({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeNull();
    expect(await respond({ jsonrpc: '2.0', id: 6, method: 'ping' }, deps)).toEqual({ jsonrpc: '2.0', id: 6, result: {} });
    expect(await respond({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, deps)).toMatchObject({ error: { code: -32601 } });
  });
});

describe('アプリとのソケット', () => {
  it('呼び出しをセッションごとにアプリへ運び、結果を返す。ソケットは自分だけが読み書きできる', async () => {
    const socketPath = join(root, 'browser.sock');
    const seen: string[] = [];
    const bridge = new BrowserBridge(socketPath, async (session, tool, args) => {
      seen.push(`${session}:${tool}:${JSON.stringify(args)}`);
      if (tool === 'boom') throw new Error('こわれた');
      return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
    });
    await bridge.start();
    try {
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const result = await callBridge(socketPath, { session: 's1', tool: 'screenshot', args: { fullPage: true } }, 5000);
      expect(result).toEqual({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
      // アプリ側の失敗は、エラーの結果として返す
      expect(await callBridge(socketPath, { session: 's1', tool: 'boom', args: {} }, 5000)).toEqual(textResult('こわれた', true));
      expect(seen).toEqual(['s1:screenshot:{"fullPage":true}', 's1:boom:{}']);
    } finally {
      bridge.close();
    }
  });

  it('アプリが起動していなければ、そう返す。前のアプリが残したソケットがあっても待ち受けられる', async () => {
    const socketPath = join(root, 'browser.sock');
    const closed = await callBridge(socketPath, { session: 's1', tool: 'get_text', args: {} }, 5000);
    expect(closed.isError).toBe(true);
    expect(closed.content[0]).toMatchObject({ text: expect.stringContaining('tanacode が起動していません') });
    // 落ちたアプリが残したソケット
    const old = new BrowserBridge(socketPath, async () => textResult('古い'));
    await old.start();
    old['server']?.close();
    const bridge = new BrowserBridge(socketPath, async () => textResult('新しい'));
    await bridge.start();
    try {
      expect(await callBridge(socketPath, { session: 's1', tool: 'get_text', args: {} }, 5000)).toEqual(textResult('新しい'));
    } finally {
      bridge.close();
    }
  });
});

describe('Claude に許す先', () => {
  it('既定は localhost・127.0.0.1・*.local の http(s) だけ', () => {
    for (const url of ['http://localhost:3000/', 'https://localhost/a', 'http://127.0.0.1:5173', 'http://myapp.local/', 'http://a.b.local:8080']) {
      expect(isClaudeAllowedUrl(url, []), url).toBe(true);
    }
    for (const url of ['https://example.com/', 'http://localhost.example.com/', 'http://127.0.0.2/', 'file:///etc/passwd', 'about:blank', 'http://local/', 'javascript:alert(1)', 'not a url']) {
      expect(isClaudeAllowedUrl(url, []), url).toBe(false);
    }
  });

  it('JavaScript の実行の確認を省くのは、この Mac の中のページだけ（*.local や足した先は含めない）', () => {
    for (const url of ['http://localhost:3000/', 'https://localhost/a', 'http://127.0.0.1:5173', 'http://[::1]:8080/', 'http://app.localhost:3000/']) {
      expect(isLocalUrl(url), url).toBe(true);
    }
    for (const url of [
      'http://myapp.local/',
      'http://192.168.0.10:8080/',
      'https://example.com/',
      'http://localhost.example.com/',
      'http://evil-localhost/',
      'http://127.0.0.1.example.com/',
      'http://127.0.0.2/',
      'file:///etc/passwd',
      'about:blank',
      '',
      'not a url',
    ]) {
      expect(isLocalUrl(url), url).toBe(false);
    }
  });

  it('足した先も許す。*. は下のホストだけ（そのものは含まない）', () => {
    expect(isClaudeAllowedUrl('https://staging.example.test/', ['*.example.test'])).toBe(true);
    expect(isClaudeAllowedUrl('https://example.test/', ['*.example.test'])).toBe(false);
    expect(isClaudeAllowedUrl('http://192.168.0.10:8080/', ['192.168.0.10'])).toBe(true);
    expect(isClaudeAllowedUrl('https://evil-example.test/', ['*.example.test'])).toBe(false);
  });

  it('足す先の書き方をそろえる。広すぎるもの・読めないものは断る', () => {
    expect(normalizeHostPattern(' Example.TEST ')).toBe('example.test');
    expect(normalizeHostPattern('https://app.example.test:8443/path')).toBe('app.example.test');
    expect(normalizeHostPattern('*.Example.test')).toBe('*.example.test');
    expect(normalizeHostPattern('192.168.0.10:3000')).toBe('192.168.0.10');
    for (const bad of ['', '*', '*.com', 'http://', 'a b']) expect(normalizeHostPattern(bad), bad).toBeNull();
  });

  it('アプリの設定に残る。無い設定はオン・許す先なし', () => {
    const file = join(root, 'settings.json');
    const settings = new AppSettings(file);
    expect(settings.browserControlEnabled()).toBe(true);
    expect(settings.browserHosts()).toEqual([]);
    settings.setBrowserControlEnabled(false);
    settings.setBrowserHosts(['example.test']);
    const again = new AppSettings(file);
    expect(again.browserControlEnabled()).toBe(false);
    expect(again.browserHosts()).toEqual(['example.test']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ browserControl: false, browserHosts: ['example.test'] });
  });
});

describe('起動の引数', () => {
  const launch: BrowserMcpLaunch = { command: '/Apps/tanacode Helper', script: '/Apps/app.asar/out/main/browser-mcp.js', socketPath: '/u/Application Support/tanacode/browser.sock', version: '1.0.0' };
  const base = { claudeSessionId: 'c1', resume: true, remoteControlName: null, model: null, effort: null, permissionMode: null };

  it('--mcp-config に中継を、--allowedTools に読むだけのツールを渡す。セッションは中継の env で', () => {
    const args = browserMcpArgs(launch, 's1');
    expect(args[0]).toBe('--mcp-config');
    const config = JSON.parse(args[1]) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    expect(config.mcpServers['tanacode-browser']).toEqual({
      type: 'stdio',
      command: launch.command,
      args: [launch.script],
      env: { ELECTRON_RUN_AS_NODE: '1', TANACODE_BROWSER_SOCKET: launch.socketPath, TANACODE_BROWSER_SESSION: 's1', TANACODE_VERSION: '1.0.0' },
    });
    expect(args.slice(2)).toEqual(['--allowedTools', allowedBrowserToolIds().join(',')]);
    expect(allowedBrowserToolIds()).toContain(browserToolId('screenshot'));
    expect(allowedBrowserToolIds()).not.toContain(browserToolId('click'));
    expect(allowedBrowserToolIds()).not.toContain(browserToolId('evaluate'));
  });

  type Hook = { matcher: string; hooks: { type: string; command: string; timeout?: number }[] };
  const gateHooks = (settings: { hooks?: { PreToolUse?: Hook[] } }) => (settings.hooks?.PreToolUse ?? []).filter((h) => h.hooks.some((x) => x.command === BROWSER_GATE_COMMAND));

  it('claudeArgs: 値をいくつも取る引数は --settings より前に置き、--settings の PreToolUse のフックで JavaScript の実行の確認を決める', () => {
    const args = claudeArgs({ ...base, browser: launch, sessionId: 's1' });
    expect(args.indexOf('--mcp-config')).toBeLessThan(args.indexOf('--settings'));
    expect(args.indexOf('--allowedTools')).toBeLessThan(args.indexOf('--settings'));
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]) as { permissions?: unknown; hooks?: { PreToolUse?: Hook[] } };
    expect(gateHooks(settings)).toEqual([{ matcher: browserToolId('evaluate'), hooks: [{ type: 'command', command: BROWSER_GATE_COMMAND, timeout: 10 }] }]);
    // permissions.ask では、ページによって変えられない。許可のルールも足さない
    expect(settings).not.toHaveProperty('permissions');
    expect(gatedBrowserToolIds()).toEqual([browserToolId('evaluate')]);
    // オフなら足さない
    const off = claudeArgs(base);
    expect(off).not.toContain('--mcp-config');
    expect(off).not.toContain('--allowedTools');
    expect(gateHooks(JSON.parse(off[off.indexOf('--settings') + 1]) as { hooks?: { PreToolUse?: Hook[] } })).toEqual([]);
  });

  it('フックは、起動する Claude Code の環境の変数（中継のコマンド・入口・ソケット・セッション）で中継の入口を --gate 付きで動かす', () => {
    expect(browserGateEnv(launch, 's1')).toEqual({
      TANACODE_BROWSER_SOCKET: launch.socketPath,
      TANACODE_BROWSER_SESSION: 's1',
      TANACODE_BROWSER_COMMAND: launch.command,
      TANACODE_BROWSER_SCRIPT: launch.script,
    });
    // パスに空白があっても分かれないよう、変数はクォートする。目印の変数は、チャットのフックの一覧に出さないためのもの
    expect(BROWSER_GATE_COMMAND).toBe('TANACODE_BROWSER_GATE=1 ELECTRON_RUN_AS_NODE=1 "$TANACODE_BROWSER_COMMAND" "$TANACODE_BROWSER_SCRIPT" --gate');
  });

  it('登録した設定ファイルと合わせるときは、登録した設定のフックと permissions はそのままに、確認のフックを足す', () => {
    const profile = {
      permissions: { allow: ['Bash(ls)'], ask: ['Bash(rm *)'], defaultMode: 'acceptEdits' },
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo mine' }] }] },
      env: { A: '1' },
    };
    const merged = mergeSettings(profile, ownSettings(null, true)) as { permissions: unknown; env: unknown; hooks: { PreToolUse: Hook[] } };
    expect(merged.permissions).toEqual(profile.permissions);
    expect(merged.env).toEqual({ A: '1' });
    expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe('echo mine');
    expect(gateHooks(merged)).toHaveLength(1);
    // ブラウザを足さないときは、確認のフックは入らない
    expect(gateHooks(mergeSettings(profile, ownSettings(null, false)) as { hooks: { PreToolUse: Hook[] } })).toEqual([]);
  });
});

describe('JavaScript の実行の確認のフック', () => {
  const decision = (output: string) => (JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;

  it('localhost のページなら確認なし（allow）、それ以外は確認を出させる（ask）。ページが分からないときも ask', () => {
    expect(decision(gateOutput({ local: true, url: 'http://localhost:3000/' }))).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    const remote = decision(gateOutput({ local: false, url: 'https://staging.example.test/' }));
    expect(remote.permissionDecision).toBe('ask');
    expect(remote.permissionDecisionReason).toContain('https://staging.example.test/');
    expect(decision(gateOutput({ local: false, url: '' })).permissionDecision).toBe('ask');
    expect(decision(gateOutput(null)).permissionDecision).toBe('ask');
  });

  it('アプリの答えを読む。エラーの返事・形の違う返事は null', () => {
    expect(readAnswer(textResult('{"local":true,"url":"http://localhost:3000/"}'))).toEqual({ local: true, url: 'http://localhost:3000/' });
    expect(readAnswer(textResult('{"local":true,"url":"http://localhost:3000/"}', true))).toBeNull();
    expect(readAnswer(textResult('{"local":"yes","url":1}'))).toBeNull();
    expect(readAnswer(textResult('知らないツールです'))).toBeNull();
    expect(readAnswer({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] })).toBeNull();
  });

  it('アプリ（ソケット）に今のページを聞いて答える。アプリが無い・答えが無いときは ask', async () => {
    const socketPath = join(root, 'gate.sock');
    const asked: { session: string; tool: string }[] = [];
    let page = 'http://localhost:3000/';
    const bridge = new BrowserBridge(socketPath, async (session, tool) => {
      asked.push({ session, tool });
      return textResult(JSON.stringify({ local: isLocalUrl(page), url: page }));
    });
    await bridge.start();
    try {
      expect(decision(await runGate(socketPath, 's1', 5000)).permissionDecision).toBe('allow');
      expect(asked).toEqual([{ session: 's1', tool: BROWSER_GATE_REQUEST }]);
      page = 'https://example.com/';
      expect(decision(await runGate(socketPath, 's1', 5000)).permissionDecision).toBe('ask');
    } finally {
      bridge.close();
    }
    // アプリを閉じている間
    expect(decision(await runGate(socketPath, 's1', 5000)).permissionDecision).toBe('ask');
  });

  it('アプリが答えられなかった（エラーの返事）ときも ask', async () => {
    const socketPath = join(root, 'gate-error.sock');
    const bridge = new BrowserBridge(socketPath, async () => textResult('このセッションは tanacode にありません', true));
    await bridge.start();
    try {
      expect(decision(await runGate(socketPath, 's1', 5000)).permissionDecision).toBe('ask');
    } finally {
      bridge.close();
    }
  });
});
