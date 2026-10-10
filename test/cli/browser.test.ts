import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_ASK_TOOL, BROWSER_TOOLS, browserToolId, isLocalUrl } from '@shared/browser-tools';
import type { BrowserAsk } from '@shared/ipc';
import { BrowserAsks } from '../../src/main/browser-asks';
import { BROWSER_GATE_REQUEST } from '../../src/main/browser-bridge';
import { McpBridge as BrowserBridge, textResult, type ToolResult } from '../../src/main/mcp-bridge';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion, menuOf } from './claude-run';
import { MockApi, type Block } from './mock-api';

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
    await run.waitFor('はじめのツールの結果', () => resultOf('toolu_shot'));
    for (const tool of BROWSER_TOOLS) expect([...api.tools], tool.name).toContain(browserToolId(tool.name));
  });

  it('読むだけのツールは、許可の確認なしにアプリまで届き、画像の結果が会話に入る', async () => {
    expect(calls[0]).toEqual({ session: run.sessionId, tool: 'screenshot', args: {} });
    expect(JSON.stringify(resultOf('toolu_shot'))).toContain(PNG);
    // チャットには、ツールの結果の画像として出る
    const shown = await run.waitFor('チャットのツールの結果', () =>
      run.chatEvents.find((e) => e.type === 'tool-result' && e.id === 'toolu_shot' && (e.images?.length ?? 0) > 0),
    );
    expect(shown).toMatchObject({ type: 'tool-result', isError: false });
  });

  it('ページを動かすツールは、許可の確認を通る', async () => {
    const menu = await run.waitFor('クリックの許可の確認', menuOf('permission'));
    expect(calls).toHaveLength(1);
    await run.answer(menu.title, menu.options[0].id);
    await run.waitFor('クリックの結果', () => resultOf('toolu_click'));
    expect(calls[1]).toEqual({ session: run.sessionId, tool: 'click', args: { selector: '#save' } });
  });

  it('localhost のページの JavaScript の実行は、許可の確認なしに通る', async () => {
    // 確認が出ていれば、答えないかぎりここで止まる
    await run.waitFor('localhost のページでの JavaScript の実行の結果', () => resultOf('toolu_eval_local'));
    expect(calls[2]).toMatchObject({ tool: 'evaluate', args: { expression: 'document.title' } });
    expect(gates[0]).toEqual({ session: run.sessionId, url: LOCAL });
    expect(JSON.stringify(resultOf('toolu_eval_local'))).toContain('evaluate をしました');
  });

  it('localhost 以外のページの JavaScript の実行は、「次から聞かない」を選んでも毎回確かめる', async () => {
    const menu = await run.waitFor('JavaScript の実行の許可の確認', menuOf('permission'));
    expect(calls).toHaveLength(3);
    expect(menu.context.join('\n')).toContain('document.cookie');
    const always = menu.options.find((o) => /don.t ask again/i.test(o.label));
    expect(always, '「次から聞かない」の選択肢').toBeDefined();
    await run.answer(menu.title, always!.id);
    await run.waitFor('返事', replied('確かめました'));
    expect(calls[3]).toMatchObject({ tool: 'evaluate', args: { expression: 'document.cookie' } });
    expect(gates[1]).toEqual({ session: run.sessionId, url: REMOTE });
    // 許可はプロジェクトの設定に残る（次の確認が出るのは、フックが確認を出させるため）
    expect(readFileSync(join(run.cwd, '.claude', 'settings.local.json'), 'utf8')).toContain(browserToolId('evaluate'));
  });

  it('--resume で再開しても使え、localhost 以外のページの JavaScript の実行はまた確かめる', async () => {
    run.stopClaude();
    run.start({ resume: true });
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
    await run.send(AGAIN);
    const menu = await run.waitFor('JavaScript の実行の許可の確認（2 回目）', menuOf('permission'));
    expect(menu.context.join('\n')).toContain('1 + 1');
    expect(calls).toHaveLength(4);
    await run.answer(menu.title, menu.options[0].id);
    await run.waitFor('再開後の返事', replied('再開後も確かめました'));
    expect(calls[4]).toMatchObject({ tool: 'evaluate', args: { expression: '1 + 1' } });
    expect(gates).toHaveLength(3);
  });

  it('アプリが無い間は「起動していません」と返し、戻ればそのまま使える。JavaScript の実行は、ページを確かめられないので確認が出る', async () => {
    bridge.close();
    await run.send(CLOSED);
    const menu = await run.waitFor('JavaScript の実行の許可の確認（アプリが無い間）', menuOf('permission'));
    expect(menu.context.join('\n')).toContain('2 + 2');
    await run.answer(menu.title, menu.options[0].id);
    await run.waitFor('閉じている間の JavaScript の実行の結果', () => resultOf('toolu_eval_closed'));
    expect(JSON.stringify(resultOf('toolu_eval_closed'))).toContain('tanacode is not running.');
    await run.waitFor('閉じている間の結果', () => resultOf('toolu_closed'));
    expect(JSON.stringify(resultOf('toolu_closed'))).toContain('tanacode is not running.');
    await bridge.start();
    await run.waitFor('返事', replied('閉じている間の確認をしました'));
    expect(JSON.stringify(resultOf('toolu_back'))).toContain('get_text をしました');
    expect(calls.map((c) => c.tool)).toEqual(['screenshot', 'click', 'evaluate', 'evaluate', 'evaluate', 'get_text']);
  });
});

describe(`Claude Code ${version} とアプリ内ブラウザでの操作の依頼`, () => {
  const LOGIN = 'ログインを頼んでください';
  const AGAIN = 'もう一度頼んでください';
  const LATER = 'しばらくしてから返事をします';
  // 呼び出しをバックグラウンドに移すまでの時間（既定は 120 秒。試験では縮める）
  const BACKGROUND_MS = 6000;
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
          ask('toolu_ask_later'),
          [{ type: 'text', text: '返事を待ちます' }],
          [{ type: 'text', text: '返事が届きました' }],
        ],
      },
    ];
    run = new ClaudeRun(await api.start(), {
      env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: String(BACKGROUND_MS) },
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
    const first = await run.waitFor('頼み', () => asking());
    expect(first.message).toBe(MESSAGE);
    expect(run.screen.current.state.kind).not.toBe('menu');
    expect(resultOf('toolu_ask_done')).toBeUndefined();
    asks.answer(run.sessionId!, first.id, { done: true, reason: '' });
    await run.waitFor('返事', replied('続きを確かめました'));
    // 結果の文の " は、JSON にするとエスケープされる（\ の数は問わない）
    expect(JSON.stringify(resultOf('toolu_ask_done'))).toMatch(/The user pressed \\*"終わった\\*"\.\\nCurrent page: ダッシュボード\\nURL: http:\/\/localhost:3000\//);
    expect(asking()).toBeNull();
  });

  it('待っている間に Esc で中断すると、取り消しがアプリまで届き、帯を消す', async () => {
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt');
    await run.send(AGAIN);
    await run.waitFor('2 つ目の頼み', () => asking());
    run.type('\x1b');
    await run.waitFor('取り消し', () => asks.list().length === 0 && asking() === null);
    await run.waitFor('中断の結果', () => resultOf('toolu_ask_esc'));
    expect(resultOf('toolu_ask_esc')).toMatchObject({ is_error: true });
  });

  it('待ちが長いと Claude Code がバックグラウンドに移す。そのあとで返事をしても、知らせで Claude に届き、続きを始める', async () => {
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt');
    await run.send(LATER);
    const third = await run.waitFor('3 つ目の頼み', () => asking());
    await run.waitFor('バックグラウンドに移したという結果', () => resultOf('toolu_ask_later'), BACKGROUND_MS + 20_000);
    expect(JSON.stringify(resultOf('toolu_ask_later'))).toContain('moved to the background');
    await run.waitFor('ターンの終わり', replied('返事を待ちます'));
    // 移したあとも、アプリは待ち続けている
    expect(asks.list()).toEqual([{ sessionId: run.sessionId, ask: third }]);
    asks.answer(run.sessionId!, third.id, { done: false, reason: 'テスト用のアカウントがありません' });
    await run.waitFor('知らせのあとの返事', replied('返事が届きました'));
    const notified = run.entries.find(
      (e) => e.type === 'user' && /The user pressed \\*"できない\\*"\. Reason: テスト用のアカウントがありません/.test(JSON.stringify((e as { message?: unknown }).message)),
    );
    expect(notified, 'task-notification の発言').toBeDefined();
  });
});
