import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_ASK_TOOL, BROWSER_TOOLS, browserToolId, isClaudeAllowedUrl, isLocalUrl } from '@shared/browser-tools';
import type { BrowserAsk } from '@shared/ipc';
import { BrowserAsks } from '../../src/main/browser-asks';
import { BROWSER_GATE_REQUEST } from '../../src/main/browser-bridge';
import { McpBridge as BrowserBridge, textResult, type ToolResult } from '../../src/main/mcp-bridge';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi, type Block } from './mock-api';
import type { PendingPermission } from '@shared/questions';

// 本物の claude をモックの API で動かし、アプリ内ブラウザの MCP サーバー（中継）を確かめる。
// アプリと同じ起動の引数（--mcp-config・--allowedTools・--settings の PreToolUse のフック）で起動し、
// 中継（src/main/browser-mcp.ts をビルドしたもの）が、アプリの代わりのソケット（BrowserBridge）までツールの呼び出しを運ぶか。
// - 読むだけのツールは、許可の確認なしに通る / ページを動かすツールは、許可の確認が出る
// - JavaScript の実行は、フックがアプリに今のページを聞いて決める。localhost のページは確認なし。
//   それ以外のページは、「次から聞かない」で許可を残しても、次の呼び出しでまた確認が出る。アプリに聞けないときも確認が出る
// - --resume で再開しても使える / アプリ（ソケット）が無い間は「起動していません」と返し、戻ればそのまま使える
// - ユーザーに操作を頼む（ask_user_to_act）は、許可の確認なしに届き、ユーザーが返事をするまで返らない。Esc の中断はアプリまで届く。
//   待ちが長いと Claude Code が呼び出しをバックグラウンドに移すが、返事をすれば結果が知らせで届き、Claude が続きを始める

const BROWSE = 'アプリ内ブラウザで確かめてください';
const AGAIN = '再開したあとも確かめてください';
const CLOSED = 'アプリを閉じている間に読んでください';
// 1×1 の PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const version = claudeVersion();

const call = (id: string, name: string, input: Record<string, unknown> = {}): Block[] => [{ type: 'tool_use', id, name: browserToolId(name), input }];

// 会話ログのツールの結果（tool_use の id → 中身）
function toolResult(run: ClaudeRun, toolUseId: string): unknown {
  for (const entry of run.entries) {
    const content = entry.type === 'user' ? (entry as { message?: { content?: unknown } }).message?.content : null;
    if (!Array.isArray(content)) continue;
    const hit = content.find((b: { type?: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
    if (hit) return hit;
  }
  return undefined;
}

// 許可の確認の見出し・説明・理由・入力（開く先や実行する式が、どれかにそのまま出る）
const textOf = (permission: PendingPermission) => [permission.title, permission.description, permission.reason, JSON.stringify(permission.input)].join('\n');

describe(`Claude Code ${version} とアプリ内ブラウザの MCP`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  let bridge: BrowserBridge;
  let socketDir: string;
  // アプリに届いた呼び出し
  const calls: { session: string; tool: string; args: Record<string, unknown> }[] = [];
  // フックが今のページを聞いてきた回数と、そのとき答えたページ。呼び出しの順に、このページを答える（足りなければ最後のもの）
  const gates: { session: string; url: string }[] = [];
  const LOCAL = 'http://localhost:3000/';
  const REMOTE = 'https://staging.example.test/';
  const pages = [LOCAL, REMOTE, REMOTE];
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  const resultOf = (toolUseId: string) => toolResult(run, toolUseId);

  beforeAll(async () => {
    const script = await buildRelay();
    socketDir = mkdtempSync(join(tmpdir(), 'tanacode-browser-'));
    const socketPath = join(socketDir, 'browser.sock');
    bridge = new BrowserBridge(socketPath, async (session, tool, args): Promise<ToolResult> => {
      if (tool === BROWSER_GATE_REQUEST) {
        const url = pages[Math.min(gates.length, pages.length - 1)];
        gates.push({ session, url });
        return textResult(JSON.stringify({ local: isLocalUrl(url), url }));
      }
      calls.push({ session, tool, args });
      if (tool === 'screenshot') return { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] };
      return textResult(`${tool} をしました`);
    });
    await bridge.start();
    api = new MockApi();
    // --resume のあとも同じ会話の続き（台本は会話のはじめの発言で選ぶ）。許可の確認が続けて出ても見分けられるよう、応答を少し遅らせる
    api.conversations = [
      {
        match: BROWSE,
        delayMs: 1500,
        steps: [
          call('toolu_shot', 'screenshot'),
          call('toolu_click', 'click', { selector: '#save' }),
          call('toolu_eval_local', 'evaluate', { expression: 'document.title' }),
          call('toolu_eval_remote', 'evaluate', { expression: 'document.cookie' }),
          [{ type: 'text', text: '確かめました' }],
          call('toolu_eval_again', 'evaluate', { expression: '1 + 1' }),
          [{ type: 'text', text: '再開後も確かめました' }],
          call('toolu_eval_closed', 'evaluate', { expression: '2 + 2' }),
          call('toolu_closed', 'get_text'),
          call('toolu_back', 'get_text'),
          [{ type: 'text', text: '閉じている間の確認をしました' }],
        ],
      },
    ];
    run = new ClaudeRun(await api.start(), { browser: { command: process.execPath, script, socketPath, version: 'test' } });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    bridge?.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  it('ツールの一覧が Claude に渡る', async () => {
    await run.send(BROWSE);
    await run.waitUntil('はじめのツールの結果', () => resultOf('toolu_shot'));
    for (const tool of BROWSER_TOOLS) expect([...api.tools], tool.name).toContain(browserToolId(tool.name));
  });

  it('読むだけのツールは、許可の確認なしにアプリまで届き、画像の結果が会話に入る', async () => {
    expect(calls[0]).toEqual({ session: run.sessionId, tool: 'screenshot', args: {} });
    expect(JSON.stringify(resultOf('toolu_shot'))).toContain(PNG);
    // チャットには、ツールの結果の画像として出る
    const shown = await run.waitUntil('チャットのツールの結果', () =>
      run.chatEvents.find((e) => e.type === 'tool-result' && e.id === 'toolu_shot' && (e.images?.length ?? 0) > 0),
    );
    expect(shown).toMatchObject({ type: 'tool-result', isError: false });
  });

  it('ページを動かすツールは、許可の確認を通る', async () => {
    const menu = await run.permission('クリックの許可の確認');
    expect(calls).toHaveLength(1);
    run.replyPermission(menu, { kind: 'allow' });
    await run.waitUntil('クリックの結果', () => resultOf('toolu_click'));
    expect(calls[1]).toEqual({ session: run.sessionId, tool: 'click', args: { selector: '#save' } });
  });

  it('localhost のページの JavaScript の実行は、許可の確認なしに通る', async () => {
    // 確認が出ていれば、答えないかぎりここで止まる
    await run.waitUntil('localhost のページでの JavaScript の実行の結果', () => resultOf('toolu_eval_local'));
    expect(calls[2]).toMatchObject({ tool: 'evaluate', args: { expression: 'document.title' } });
    expect(gates[0]).toEqual({ session: run.sessionId, url: LOCAL });
    expect(JSON.stringify(resultOf('toolu_eval_local'))).toContain('evaluate をしました');
  });

  it('localhost 以外のページの JavaScript の実行は、毎回確かめる（フックが確認させるので、「今後は聞かない」の候補は出ない）', async () => {
    const menu = await run.permission('JavaScript の実行の許可の確認');
    expect(calls).toHaveLength(3);
    expect(textOf(menu)).toContain('document.cookie');
    expect(menu.always ?? []).toEqual([]);
    // フックが書いた理由（アプリが答えたページ）は、確認の理由（decision_reason）にそのまま入り、親のセッションにも届く。
    // なのでアプリは、許していない先のページはオリジンだけを答える（browser-control.test.ts）
    expect(menu.reason).toContain(REMOTE);
    run.replyPermission(menu, { kind: 'allow' });
    await run.waitUntil('返事', replied('確かめました'));
    expect(calls[3]).toMatchObject({ tool: 'evaluate', args: { expression: 'document.cookie' } });
    expect(gates[1]).toEqual({ session: run.sessionId, url: REMOTE });
  });

  it('--resume で再開しても使え、localhost 以外のページの JavaScript の実行はまた確かめる', async () => {
    run.stopClaude();
    run.start({ resume: true });
    await run.waitUntil('入力欄', () => run.idle);
    await run.send(AGAIN);
    const menu = await run.permission('JavaScript の実行の許可の確認（2 回目）');
    expect(textOf(menu)).toContain('1 + 1');
    expect(calls).toHaveLength(4);
    run.replyPermission(menu, { kind: 'allow' });
    await run.waitUntil('再開後の返事', replied('再開後も確かめました'));
    expect(calls[4]).toMatchObject({ tool: 'evaluate', args: { expression: '1 + 1' } });
    expect(gates).toHaveLength(3);
  });

  it('アプリが無い間は「起動していません」と返し、戻ればそのまま使える。JavaScript の実行は、ページを確かめられないので確認が出る', async () => {
    bridge.close();
    await run.send(CLOSED);
    const menu = await run.permission('JavaScript の実行の許可の確認（アプリが無い間）');
    expect(textOf(menu)).toContain('2 + 2');
    run.replyPermission(menu, { kind: 'allow' });
    await run.waitUntil('閉じている間の JavaScript の実行の結果', () => resultOf('toolu_eval_closed'));
    expect(JSON.stringify(resultOf('toolu_eval_closed'))).toContain('tanacode is not running.');
    await run.waitUntil('閉じている間の結果', () => resultOf('toolu_closed'));
    expect(JSON.stringify(resultOf('toolu_closed'))).toContain('tanacode is not running.');
    await bridge.start();
    await run.waitUntil('返事', replied('閉じている間の確認をしました'));
    expect(JSON.stringify(resultOf('toolu_back'))).toContain('get_text をしました');
    expect(calls.map((c) => c.tool)).toEqual(['screenshot', 'click', 'evaluate', 'evaluate', 'evaluate', 'get_text']);
  });
});

describe(`Claude Code ${version} とアプリ内ブラウザでの操作の依頼`, () => {
  const LOGIN = 'ログインを頼んでください';
  const AGAIN = 'もう一度頼んでください';
  const MESSAGE = 'テスト用のアカウントでログインしてください';
  let api: MockApi;
  let run: ClaudeRun;
  let bridge: BrowserBridge;
  let socketDir: string;
  // アプリと同じく、頼んでいるものを BrowserAsks で持つ。changes: 頼んだ・終わった（null）の知らせ
  const changes: (BrowserAsk | null)[] = [];
  const asks = new BrowserAsks((_session, ask) => changes.push(ask));
  const asking = () => changes.at(-1) ?? null;
  const ask = (id: string): Block[] => call(id, BROWSER_ASK_TOOL, { message: MESSAGE });
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  const resultOf = (toolUseId: string) => toolResult(run, toolUseId);

  beforeAll(async () => {
    const script = await buildRelay();
    socketDir = mkdtempSync(join(tmpdir(), 'tanacode-browser-ask-'));
    const socketPath = join(socketDir, 'browser.sock');
    bridge = new BrowserBridge(socketPath, (session, tool, args, signal) =>
      tool === BROWSER_ASK_TOOL
        ? asks.wait(session, args.message, () => ['Current page: ダッシュボード', 'URL: http://localhost:3000/'], signal)
        : Promise.resolve(textResult(`${tool} をしました`)),
    );
    await bridge.start();
    api = new MockApi();
    api.conversations = [
      {
        match: LOGIN,
        steps: [
          ask('toolu_ask_done'),
          [{ type: 'text', text: '続きを確かめました' }],
          ask('toolu_ask_esc'),
        ],
      },
    ];
    // 長く待つ呼び出しを Claude Code がバックグラウンドに移す働き（CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS）は、TUI だけのもの。
    // チャット（stream-json）では、人が答えるまでターンの中で待つ（実測）
    run = new ClaudeRun(await api.start(), {
      browser: { command: process.execPath, script, socketPath, version: 'test' },
    });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    bridge?.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  it('許可の確認なしにアプリまで届き、ユーザーが「終わった」を押すまで返らない。押したら、そのことと今のページが Claude に届く', async () => {
    await run.send(LOGIN);
    const first = await run.waitUntil('頼み', () => asking());
    expect(first.message).toBe(MESSAGE);
    expect(run.manager.pendingPermission(run.sessionId!)).toBeNull();
    expect(resultOf('toolu_ask_done')).toBeUndefined();
    asks.answer(run.sessionId!, first.id, { done: true, reason: '' });
    await run.waitUntil('返事', replied('続きを確かめました'));
    // 結果の文の " は、JSON にするとエスケープされる（\ の数は問わない）
    expect(JSON.stringify(resultOf('toolu_ask_done'))).toMatch(/The user pressed \\*"終わった\\*"\.\\nCurrent page: ダッシュボード\\nURL: http:\/\/localhost:3000\//);
    expect(asking()).toBeNull();
  });

  it('待っている間に中断すると、取り消しがアプリまで届き、帯を消す', async () => {
    await run.waitUntil('入力欄', () => run.idle);
    await run.send(AGAIN);
    await run.waitUntil('2 つ目の頼み', () => asking());
    run.manager.interrupt(run.sessionId!);
    await run.waitUntil('取り消し', () => asks.list().length === 0 && asking() === null);
    await run.waitUntil('中断の結果', () => resultOf('toolu_ask_esc'));
    expect(resultOf('toolu_ask_esc')).toMatchObject({ is_error: true });
  });
});

// 許す先の外を開く確認。アプリの代わりのソケットが、開く確認のフック（browser-gate.ts）に、許す先の外ならオリジンを答える
// （人に確認した印を控えて、navigate で使い切るところは、アプリの browser-control が持つ。test/browser-control.test.ts・test/e2e/browser-outside.test.ts）
describe.each([
  { mode: 'bypassPermissions' as const, title: 'bypassPermissions でも' },
  { mode: 'manual' as const, title: '「次から聞かない」で navigate を許したあとでも' },
])(`Claude Code ${version} とアプリ内ブラウザで、許す先の外を開く: $title確認が出る`, ({ mode }) => {
  const OPEN = '許す先の外を開いてください';
  const LOCAL = 'http://localhost:3000/';
  const LOCAL_AGAIN = 'http://localhost:3000/b';
  const OUTSIDE = 'https://example.com/path?q=1';
  const OTHER = 'https://example.org/';
  let api: MockApi;
  let run: ClaudeRun;
  let bridge: BrowserBridge;
  let socketDir: string;
  // アプリに届いた呼び出し（と、その呼び出しの ID）と、フックが聞いてきたもの
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const callIds: (string | undefined)[] = [];
  const gates: Record<string, unknown>[] = [];
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  const resultOf = (toolUseId: string) => toolResult(run, toolUseId);
  const opened = () => calls.map((c) => c.args.url);

  beforeAll(async () => {
    const script = await buildRelay();
    socketDir = mkdtempSync(join(tmpdir(), 'tanacode-browser-outside-'));
    const socketPath = join(socketDir, 'browser.sock');
    bridge = new BrowserBridge(socketPath, async (_session, tool, args, _signal, toolUseId): Promise<ToolResult> => {
      if (tool === BROWSER_GATE_REQUEST) {
        gates.push(args);
        const url = String((args.input as { url?: unknown } | undefined)?.url ?? '');
        return textResult(JSON.stringify({ outside: isClaudeAllowedUrl(url, []) ? null : new URL(url).origin }));
      }
      calls.push({ tool, args });
      callIds.push(toolUseId);
      return textResult(`${tool} をしました`);
    });
    await bridge.start();
    api = new MockApi();
    api.conversations = [
      {
        match: OPEN,
        delayMs: 1500,
        steps: [
          call('toolu_local', 'navigate', { url: LOCAL }),
          call('toolu_outside', 'navigate', { url: OUTSIDE }),
          call('toolu_other', 'navigate', { url: OTHER, newTab: true }),
          call('toolu_local_again', 'navigate', { url: LOCAL_AGAIN }),
          [{ type: 'text', text: '開き終えました' }],
        ],
      },
    ];
    run = new ClaudeRun(await api.start(), { mode, browser: { command: process.execPath, script, socketPath, version: 'test' } });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    bridge?.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  it('許す先は、今までどおり開く（manual では、ふつうの許可の確認が出る。「次から聞かない」で許す）', async () => {
    await run.send(OPEN);
    if (mode === 'manual') {
      const menu = await run.permission('localhost を開く許可の確認');
      expect(menu.always?.length ?? 0, '「今後は聞かない」の候補').toBeGreaterThan(0);
      run.replyPermission(menu, { kind: 'allow', always: true });
    }
    await run.waitUntil('localhost を開いた結果', () => resultOf('toolu_local'));
    expect(calls).toEqual([{ tool: 'navigate', args: { url: LOCAL } }]);
    // フックは、ツールの名前と入力と、呼び出しの ID（tool_use_id）をアプリに渡す。中継も、同じ ID（tools/call の _meta）を渡す
    expect(gates[0]).toEqual({ tool: browserToolId('navigate'), input: { url: LOCAL }, toolUseId: 'toolu_local' });
    expect(callIds).toEqual(['toolu_local']);
  });

  it('許す先の外は、開くたびに確認が出る。確認には開く先のオリジンが出る', async () => {
    const first = await run.permission('許す先の外を開く確認');
    expect(textOf(first)).toContain('https://example.com');
    expect(calls).toHaveLength(1);
    run.replyPermission(first, { kind: 'allow' });
    await run.waitUntil('許す先の外を開いた結果', () => resultOf('toolu_outside'));
    // 2 つ目の外の先も、また確認が出る
    const second = await run.permission('2 つ目の許す先の外を開く確認');
    expect(textOf(second)).toContain('https://example.org');
    expect(calls).toHaveLength(2);
    run.replyPermission(second, { kind: 'allow' });
    await run.waitUntil('2 つ目の許す先の外を開いた結果', () => resultOf('toolu_other'));
  });

  it('外を開いたあとも、許す先は確認なしで開く', async () => {
    await run.waitUntil('返事', replied('開き終えました'));
    expect(opened()).toEqual([LOCAL, OUTSIDE, OTHER, LOCAL_AGAIN]);
    expect(gates.map((g) => (g.input as { url: string }).url)).toEqual([LOCAL, OUTSIDE, OTHER, LOCAL_AGAIN]);
    if (mode === 'manual') expect(readFileSync(join(run.cwd, '.claude', 'settings.local.json'), 'utf8')).toContain(browserToolId('navigate'));
  });
});
