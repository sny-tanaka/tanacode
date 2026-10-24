import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/shared/i18n';
import { allowedTerminalToolIds, readTypeInput, terminalToolId, typedPreview } from '../src/shared/terminal-tools';
import { claudeArgs } from '../src/main/claude-session';
import { McpBridge, textResult } from '../src/main/mcp-bridge';
import {
  readGateAnswer,
  runTerminalGate,
  TERMINAL_GATE_COMMAND,
  TERMINAL_GATE_REQUEST,
  TERMINAL_GATED_TOOL,
  terminalGateEnv,
  terminalGateOutput,
} from '../src/main/terminal-bridge';

// 人のターミナルの中継と、打つ前の確認のフック（terminal-bridge.ts・terminal-mcp.ts）。
// - 起動の引数: 親には 3 つのツールと確認のフック、子には読むツールだけ（確認のフックも足さない）
// - フック: アプリに打つものを確かめさせ、どの場合も ask を返す。アプリに聞けないときも ask で、打つものはフックの入力から出す
// （入口が、環境変数と引数から中継として動くかフックとして動くかは terminal-mcp-entry.test.ts）

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-terminal-mcp-'));
});
afterEach(() => {
  setLanguage('ja');
  rmSync(root, { recursive: true, force: true });
});

const launch = { command: '/Apps/tanacode Helper', script: '/Apps/out/main/terminal-mcp.js', socketPath: '/u/terminal.sock', version: '1.0.0' };
const base = { claudeSessionId: 'c1', resume: true, remoteControlName: null, model: null, effort: null, permissionMode: null };
type Hook = { matcher: string; hooks: { command: string }[] };
const decision = (output: string) =>
  (JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;

describe('起動の引数', () => {
  it('親には 3 つのツール（読む 2 つは許可済み）と、打つ前の確認のフックを足す', () => {
    const args = claudeArgs({ ...base, terminal: launch, sessionId: 's1' });
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };
    expect(config.mcpServers['tanacode-terminal'].args).toEqual([launch.script]);
    expect(config.mcpServers['tanacode-terminal'].env).toMatchObject({ TANACODE_TERMINAL_SOCKET: '/u/terminal.sock', TANACODE_TERMINAL_SESSION: 's1' });
    expect(config.mcpServers['tanacode-terminal'].env.TANACODE_TERMINAL_CHILD).toBeUndefined();
    expect(args[args.indexOf('--allowedTools') + 1].split(',')).toEqual([terminalToolId('list_terminals'), terminalToolId('read_terminal')]);
    expect(allowedTerminalToolIds()).not.toContain(terminalToolId('type_in_terminal'));
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]) as { hooks: { PreToolUse: Hook[] } };
    expect(settings.hooks.PreToolUse.filter((h) => h.matcher === `^${TERMINAL_GATED_TOOL}$`)).toEqual([
      { matcher: `^${terminalToolId('type_in_terminal')}$`, hooks: [{ type: 'command', command: TERMINAL_GATE_COMMAND, timeout: 10 }] },
    ]);
  });

  it('子には読むツールだけを見せ、確認のフックも足さない', () => {
    const args = claudeArgs({ ...base, terminal: { ...launch, child: true }, sessionId: 's2' });
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(config.mcpServers['tanacode-terminal'].env.TANACODE_TERMINAL_CHILD).toBe('1');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]) as { hooks: { PreToolUse: Hook[] } };
    expect(settings.hooks.PreToolUse.some((h) => h.matcher === `^${TERMINAL_GATED_TOOL}$`)).toBe(false);
  });

  it('確認のフックは、中継の入口を --gate 付きで動かす。使う環境変数は、起動する Claude Code に足す', () => {
    expect(TERMINAL_GATE_COMMAND).toBe('TANACODE_TERMINAL_GATE=1 ELECTRON_RUN_AS_NODE=1 "$TANACODE_TERMINAL_COMMAND" "$TANACODE_TERMINAL_SCRIPT" --gate');
    setLanguage('en');
    expect(terminalGateEnv(launch, 's1')).toEqual({
      TANACODE_TERMINAL_SOCKET: launch.socketPath,
      TANACODE_TERMINAL_SESSION: 's1',
      TANACODE_TERMINAL_COMMAND: launch.command,
      TANACODE_TERMINAL_SCRIPT: launch.script,
      TANACODE_LANGUAGE: 'en',
    });
  });
});

describe('打つものの読み方と見せ方', () => {
  it('打つものにそろえる（Enter は既定で押す。key では押さない）', () => {
    expect(readTypeInput({ id: ' shell-1 ', text: 'ls' })).toEqual({ id: 'shell-1', newTab: false, text: 'ls', enter: true, key: null });
    expect(readTypeInput({ new_tab: true, key: 'up', enter: true })).toEqual({ id: null, newTab: true, text: null, enter: false, key: 'up' });
    expect(readTypeInput({ id: 3, text: 'ls' })).toBe('id must be a terminal ID from list_terminals.');
    expect(readTypeInput({ id: 'shell-1', text: 3 })).toBe('text must be a string.');
    expect(readTypeInput({ id: 'shell-1', text: 'x'.repeat(4001) })).toBe('text is too long (at most 4000 characters).');
  });

  it('確認には、打つ文字をそのまま（前後の空白も）見せ、Enter は ⏎、キーは名前で見せる', () => {
    const preview = (args: Record<string, unknown>) => typedPreview(readTypeInput(args) as Exclude<ReturnType<typeof readTypeInput>, string>);
    expect(preview({ id: 'a', text: ' git push ' })).toBe(' git push  ⏎');
    expect(preview({ id: 'a', text: 'git sta', enter: false })).toBe('git sta');
    expect(preview({ id: 'a', text: '' })).toBe('⏎');
    expect(['ctrl-c', 'ctrl-d', 'escape', 'tab', 'up', 'down'].map((key) => preview({ id: 'a', key }))).toEqual(['Ctrl+C', 'Ctrl+D', 'Esc', 'Tab', '↑', '↓']);
  });
});

describe('打つ前の確認のフック', () => {
  it('アプリの答えを読む。エラーの返事・形の違う返事は null', () => {
    expect(readGateAnswer(textResult('{"tab":"zsh 1","typed":"ls ⏎"}'))).toEqual({ tab: 'zsh 1', typed: 'ls ⏎' });
    expect(readGateAnswer(textResult('{"tab":"zsh 1","typed":"ls ⏎"}', true))).toBeNull();
    expect(readGateAnswer(textResult('{"tab":1}'))).toBeNull();
    expect(readGateAnswer(textResult('not json'))).toBeNull();
    expect(readGateAnswer({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] })).toBeNull();
  });

  it('どの場合も ask。理由に、タブの名前と打つものを入れる。アプリに確かめられないときは、フックの入力から打つものを出す', () => {
    const asked = decision(terminalGateOutput({ tab: 'zsh 1', typed: 'npm test ⏎' }, {}));
    expect(asked).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'ask' });
    expect(asked.permissionDecisionReason).toBe('tanacode は、Claude がターミナルに打つ前に、権限モードによらず毎回確認を求めます。「zsh 1」に打つもの: npm test ⏎');
    const unknown = decision(terminalGateOutput(null, { id: 'shell-1', text: 'npm test' }));
    expect(unknown.permissionDecision).toBe('ask');
    expect(unknown.permissionDecisionReason).toBe('tanacode にターミナルを確かめられなかったので、確認を求めています。打つもの: npm test ⏎');
    // 打てない入力（複数行など）は、受け取ったものをそのまま見せる
    expect(decision(terminalGateOutput(null, { id: 'shell-1', text: 'a\nb' })).permissionDecisionReason).toContain('打つもの: "a\\nb"');
    expect(decision(terminalGateOutput(null, {})).permissionDecisionReason).toContain('打つもの: ""');
    setLanguage('en');
    expect(decision(terminalGateOutput({ tab: 'zsh 1', typed: 'ls ⏎' }, {})).permissionDecisionReason).toBe(
      'tanacode asks every time before Claude types into a terminal, regardless of the permission mode. Typing into “zsh 1”: ls ⏎',
    );
  });

  it('アプリ（ソケット）に、フックの入力の tool_input を渡して確かめさせる。アプリが無い・断った・入力が読めないときも ask', async () => {
    const socketPath = join(root, 'terminal.sock');
    const asked: { session: string; tool: string; args: Record<string, unknown> }[] = [];
    let answer = textResult(JSON.stringify({ tab: 'zsh 1', typed: 'ls ⏎' }));
    const bridge = new McpBridge(socketPath, async (session, tool, args) => {
      asked.push({ session, tool, args });
      return answer;
    });
    await bridge.start();
    const hookInput = JSON.stringify({ session_id: 'claude-1', tool_name: TERMINAL_GATED_TOOL, tool_input: { id: 'shell-1', text: 'ls' } });
    try {
      expect(decision(await runTerminalGate(socketPath, 's1', hookInput, 5000)).permissionDecisionReason).toContain('「zsh 1」に打つもの: ls ⏎');
      expect(asked).toEqual([{ session: 's1', tool: TERMINAL_GATE_REQUEST, args: { id: 'shell-1', text: 'ls' } }]);
      answer = textResult('Child sessions cannot type into the user\'s terminal.', true);
      expect(decision(await runTerminalGate(socketPath, 's1', hookInput, 5000))).toMatchObject({
        permissionDecision: 'ask',
        permissionDecisionReason: 'tanacode にターミナルを確かめられなかったので、確認を求めています。打つもの: ls ⏎',
      });
      // 読めない入力は、アプリに聞かずに ask
      expect(decision(await runTerminalGate(socketPath, 's1', 'not json', 5000)).permissionDecision).toBe('ask');
      expect(asked).toHaveLength(2);
      // tool_input が無い・形が違う
      await runTerminalGate(socketPath, 's1', JSON.stringify({ tool_input: ['x'] }), 5000);
      expect(asked[2].args).toEqual({});
    } finally {
      bridge.close();
    }
    // アプリを閉じている間
    expect(decision(await runTerminalGate(socketPath, 's1', hookInput, 5000)).permissionDecision).toBe('ask');
  });
});
