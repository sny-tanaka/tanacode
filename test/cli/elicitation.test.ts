import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi, type Block } from './mock-api';

// 本物の claude をモックの API で動かし、使う人が足した MCP サーバーの人への質問（MCP の elicitation。stream-json の
// control_request の elicitation）に、カードと同じ答え方（session-manager の replyElicitation）で返せるかを確かめる。
// MCP サーバーは test/cli/elicit-mcp-server.mjs（返事をそのままツールの結果にする）。返事の形（action と content）を本物の Claude Code が
// 受け付けて MCP サーバーまで届くか、URL の形の完了の知らせ（system/elicitation_complete）でカードが閉じるか、中断で取り下げられるか

const version = claudeVersion();
const SERVER = fileURLToPath(new URL('./elicit-mcp-server.mjs', import.meta.url));

// 発言の目印 → Claude（モック）が呼ぶ MCP のツール
const tool = (id: string, name: string): Block[] => [{ type: 'tool_use', id, name: `mcp__elicit__${name}`, input: {} }];
const SCRIPT: Record<string, Block[]> = {
  'ELICIT-FORM': tool('toolu_form', 'ask_form'),
  'ELICIT-DECLINE': tool('toolu_decline', 'ask_form'),
  'ELICIT-ABORT': tool('toolu_abort', 'ask_form'),
  'ELICIT-URL': tool('toolu_url', 'ask_url'),
};

function script(prompt: string, results: string[]): Block[] | null {
  const key = Object.keys(SCRIPT).find((k) => prompt.includes(k));
  if (key) return SCRIPT[key];
  if (results.length > 0) return [{ type: 'text', text: `受け取りました: ${results.join(' / ').slice(0, 300)}` }];
  return [{ type: 'text', text: 'はい' }];
}

describe(`Claude Code ${version} の、MCP サーバーの質問とカード`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  let log: string;
  let done: string;
  const turnEnds = () => run.chatEvents.filter((e) => e.type === 'turn-end');
  const finished = async (before: number) => {
    await run.waitUntil('ターンの終わり', () => turnEnds().length > before);
    await run.untilState('待機中', (state) => state === 'idle');
    return turnEnds().at(-1)!;
  };
  // MCP サーバーが書いた控え（受け取ったもの・返事）
  const logged = (): Record<string, unknown>[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  // MCP サーバーが受け取った返事を、ツールの結果にしたもの（Claude に届いたもの）
  const resultFor = (text: string) => api.toolResults.find((r) => r.includes('ELICIT-RESULT') && r.includes(text));

  beforeAll(async () => {
    api = new MockApi();
    api.intercept = script;
    run = new ClaudeRun(await api.start(), {
      // プロジェクトの MCP サーバーとして足し（使う人が .mcp.json に書いたのと同じ）、ツールは確認なしで使わせる
      files: { '.mcp.json': '{}' },
      settings: { enableAllProjectMcpServers: true, permissions: { allow: ['mcp__elicit'] } },
    });
    log = join(run.root, 'elicit.log');
    done = join(run.root, 'elicit.done');
    writeFileSync(join(run.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { elicit: { command: process.execPath, args: [SERVER], env: { ELICIT_LOG: log, ELICIT_DONE: done } } } }));
    await run.open();
    // MCP サーバーがつながり、ツールの一覧を渡すまで待つ（つながる前に呼ぶと、ツールが無い）
    await run.waitUntil('MCP サーバーがつながる', () => logged().some((e) => e.method === 'tools/list'), 30_000);
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('Claude Code は、フォームと URL の形の質問に答えられると MCP サーバーに伝える', () => {
    const init = logged().find((e) => e.method === 'initialize') as { capabilities?: { elicitation?: Record<string, unknown> } } | undefined;
    expect(init?.capabilities?.elicitation).toEqual({ form: {}, url: {} });
  });

  it('フォームの形: どのサーバーからの質問かと項目がカードに出て、送った中身が MCP サーバーに届く', async () => {
    const before = turnEnds().length;
    await run.send('ELICIT-FORM');
    const elicitation = await run.elicitation('フォームの質問');
    expect(elicitation).toMatchObject({ server: 'elicit', message: 'どこに出しますか？', mode: 'form', unsupported: [], opened: false });
    // 項目は MCP サーバーが書いた順
    expect(elicitation.fields.map((f) => [f.key, f.type, f.required])).toEqual([
      ['target', 'select', true],
      ['replicas', 'number', false],
      ['note', 'text', false],
      ['notify', 'boolean', false],
      ['regions', 'multi', false],
    ]);
    expect(run.manager.stateOf(run.sessionId!)).toBe('question');
    expect(run.summary()?.attention).toBe('question');
    expect(run.attentions.at(-1)?.menu.title).toBe('MCP サーバー「elicit」からの質問: どこに出しますか？');
    const content = { target: 'prod', replicas: 3, note: 'メモ', notify: true, regions: ['jp', 'us'] };
    run.replyElicitation(elicitation, { kind: 'accept', content });
    await finished(before);
    expect(resultFor('accept')).toContain(JSON.stringify({ action: 'accept', content }));
    expect(run.manager.pendingElicitation(run.sessionId!)).toBeNull();
  });

  it('フォームの形: 断ると decline が MCP サーバーに届き、作業は続く', async () => {
    const before = turnEnds().length;
    await run.send('ELICIT-DECLINE');
    const elicitation = await run.elicitation('フォームの質問');
    run.replyElicitation(elicitation, { kind: 'decline' });
    const end = await finished(before);
    expect(end).not.toHaveProperty('interrupted');
    expect(resultFor('decline')).toContain(JSON.stringify({ action: 'decline' }));
  });

  it('URL の形: ページを開くと accept が届き、完了を待つカードになる。MCP サーバーの完了の知らせで閉じる', async () => {
    const before = turnEnds().length;
    await run.send('ELICIT-URL');
    const elicitation = await run.elicitation('URL の質問');
    expect(elicitation).toMatchObject({ server: 'elicit', message: 'ログインしてください', mode: 'url', url: 'https://login.example.com/authorize?state=tanacode-test', openable: true });
    run.replyElicitation(elicitation, { kind: 'open' });
    expect(run.openedUrls).toEqual(['https://login.example.com/authorize?state=tanacode-test']);
    // MCP サーバーは同意を受け取り、人がページで終えるのを待っている
    await run.waitUntil('MCP サーバーに同意が届く', () => logged().some((e) => e.elicited === 'url'));
    expect(logged().find((e) => e.elicited === 'url')?.reply).toMatchObject({ result: { action: 'accept' } });
    expect(run.manager.pendingElicitation(run.sessionId!)).toMatchObject({ id: `opened:${elicitation.id}`, opened: true });
    expect(run.manager.stateOf(run.sessionId!)).toBe('working');
    // 人がページで終えた（MCP サーバーが完了を知らせる）
    writeFileSync(done, '');
    await run.waitUntil('完了待ちのカードが閉じる', () => run.manager.pendingElicitation(run.sessionId!) === null);
    await finished(before);
    expect(run.streamLines().some((l) => l.includes('"subtype":"elicitation_complete"') && l.includes('el-tanacode-test'))).toBe(true);
  });

  it('答える前に作業を止めると、Claude Code が質問を取り下げ（control_cancel_request）、カードが消える', async () => {
    const before = turnEnds().length;
    await run.send('ELICIT-ABORT');
    const elicitation = await run.elicitation('フォームの質問');
    run.manager.interrupt(run.sessionId!);
    await run.waitUntil('取り下げ', () => run.manager.pendingElicitation(run.sessionId!) === null);
    expect(run.streamLines().some((l) => l.includes('"control_cancel_request"') && l.includes(elicitation.id))).toBe(true);
    expect(await finished(before)).toMatchObject({ interrupted: true });
    expect(run.manager.replyElicitation(run.sessionId!, elicitation.id, { kind: 'decline' })).toBe(false);
  });

  it('読めない行・知らない種類の行は出ていない', () => {
    const client = run.manager['runtimes'].get(run.sessionId!)!.process!.client!;
    expect(client.malformed).toBe(0);
    expect([...client.unknown]).toEqual([]);
  });
});
