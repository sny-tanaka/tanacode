import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedToolIds } from '../src/shared/mcp-tools';
import { rangeQuestionText, restartRequestText, stepQuestionText, type Walkthrough } from '../src/shared/walkthrough';
import { WALKTHROUGH_MCP, walkthroughOfTool, walkthroughTarget, walkthroughToolId } from '../src/shared/walkthrough-tools';
import { AppSettings } from '../src/main/app-settings';
import { claudeArgs } from '../src/main/claude-session';
import { textResult, type ToolResult } from '../src/main/mcp-bridge';
import { respond } from '../src/main/mcp-relay';
import { WalkthroughControl } from '../src/main/walkthrough-control';

// ウォークスルー（Claude がエディタでコードを示しながら説明し、人が「次へ」で進めて質問する）。
// MCP のツール（手順の確かめ・寄り道・今の場所）・画面からの操作・起動の引数・チャットの表示・質問の文

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-walkthrough-'));
  cwd = join(dir, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'tax.ts'), Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n');
  writeFileSync(join(cwd, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  writeFileSync(join(dir, 'outside.ts'), 'secret\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ME = '11111111-0000-4000-8000-000000000001';

function setup(enabled = true) {
  const changes: { sessionId: string; walkthrough: Walkthrough | null }[] = [];
  const control = new WalkthroughControl({
    cwdOf: (id) => (id === ME ? cwd : null),
    enabled: () => enabled,
    onChange: (sessionId, walkthrough) => changes.push({ sessionId, walkthrough }),
    clock: () => 1000,
  });
  return { control, changes };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

const step = (over: Record<string, unknown> = {}) => ({ path: 'src/tax.ts', start_line: 3, end_line: 5, title: '税率を読む', body: '設定から読みます。', ...over });

describe('MCP のツール', () => {
  it('start_walkthrough: 手順を確かめて始め、1 つ目を開いたことを返す。画面に知らせる', async () => {
    const { control, changes } = setup();
    const r = await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step({ path: join(cwd, 'src/tax.ts'), start_line: 10, end_line: undefined, title: '切り捨て' })] });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('1/2「税率を読む」（src/tax.ts:3-5）');
    const w = control.get(ME)!;
    // フォルダの中の絶対パスは相対パスに、end_line を省くと 1 行
    expect(w.steps[1]).toEqual({ path: 'src/tax.ts', startLine: 10, endLine: 10, title: '切り捨て', body: '設定から読みます。' });
    expect(w).toMatchObject({ title: '税率の変更', current: 0, aside: null, visited: [0], movedBy: 'claude', seq: 1, startedAt: 1000 });
    expect(changes).toHaveLength(1);
  });

  it('start_walkthrough: 直せないステップは、全部の理由をまとめて返し、始めない', async () => {
    const { control, changes } = setup();
    const r = await control.handle(ME, 'start_walkthrough', {
      title: '税率の変更',
      steps: [
        step(),
        step({ path: '../outside.ts' }),
        step({ path: join(dir, 'outside.ts') }),
        step({ start_line: 18, end_line: 25 }),
        step({ start_line: 5, end_line: 3 }),
        step({ path: 'src/none.ts' }),
        step({ path: 'src/logo.png', start_line: 1, end_line: 1 }),
        step({ body: '  ' }),
      ],
    });
    expect(r.isError).toBe(true);
    const message = text(r);
    expect(message).toContain('ステップ 2: ../outside.ts は、このセッションのフォルダ');
    expect(message).toContain('ステップ 3:');
    expect(message).toContain('ステップ 4: src/tax.ts は 20 行です（25 行目はありません）');
    expect(message).toContain('ステップ 5: src/tax.ts: end_line は start_line 以上');
    expect(message).toContain('ステップ 6: src/none.ts が見つかりません');
    expect(message).toContain('ステップ 7: src/logo.png は文字のファイルではない');
    expect(message).toContain('ステップ 8: body を渡してください');
    expect(message).not.toContain('ステップ 1:');
    expect(control.get(ME)).toBeNull();
    expect(changes).toEqual([]);
  });

  it('start_walkthrough: ステップが無い・多すぎるときは断る', async () => {
    const { control } = setup();
    expect(text(await control.handle(ME, 'start_walkthrough', { title: 't', steps: [] }))).toContain('1 つ以上');
    const many = Array.from({ length: 41 }, () => step());
    expect(text(await control.handle(ME, 'start_walkthrough', { title: 't', steps: many }))).toContain('40 個まで');
  });

  it('show_code: 寄り道として示し、人が戻ると元のステップに戻る。始めていなくても示せる', async () => {
    const { control } = setup();
    const alone = await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここです' });
    expect(text(alone)).toBe('人のエディタに src/tax.ts:7 を示しました（寄り道）。');
    expect(control.get(ME)).toMatchObject({ steps: [], aside: { path: 'src/tax.ts', startLine: 7, endLine: 7, title: '' } });

    await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step({ start_line: 12, end_line: undefined })] });
    control.go(ME, 1);
    const r = await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 15, end_line: 16, body: '呼び出し元です' });
    expect(text(r)).toContain('2/2 に戻ります');
    expect(control.get(ME)).toMatchObject({ current: 1, aside: { startLine: 15, endLine: 16 }, movedBy: 'claude' });
    control.go(ME, 1);
    expect(control.get(ME)).toMatchObject({ current: 1, aside: null, movedBy: 'human' });
  });

  it('walkthrough_status: 手順と、人が見ているステップ・見たステップを返す', async () => {
    const { control } = setup();
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain('ウォークスルーはありません');
    await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step({ start_line: 12, end_line: undefined, title: '切り捨て' }), step({ title: '呼び出し' })] });
    control.go(ME, 1);
    const status = text(await control.handle(ME, 'walkthrough_status', {}));
    expect(status).toContain('人は 2/3「切り捨て」を見ています。');
    expect(status).toContain('1. 税率を読む — src/tax.ts:3-5（見た）');
    expect(status).toContain('2. 切り捨て — src/tax.ts:12（今ここ）');
    expect(status).toContain('3. 呼び出し — src/tax.ts:3-5\n'.trimEnd());
    control.end(ME);
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain('ウォークスルーはありません');
  });

  it('メニューでオフ・知らないセッション・知らないツールは断る', async () => {
    expect(text(await setup(false).control.handle(ME, 'walkthrough_status', {}))).toContain('オフにしています');
    const { control } = setup();
    expect(text(await control.handle('other', 'walkthrough_status', {}))).toContain('tanacode にありません');
    expect((await control.handle(ME, 'rm_rf', {})).isError).toBe(true);
  });
});

describe('画面からの操作', () => {
  it('go: 範囲に収めて、見たステップを覚える。end: 終えて画面に知らせる', async () => {
    const { control, changes } = setup();
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step(), step(), step()] });
    control.go(ME, 9);
    expect(control.get(ME)).toMatchObject({ current: 2, visited: [0, 2], seq: 2 });
    control.go(ME, -1);
    expect(control.get(ME)).toMatchObject({ current: 0, visited: [0, 2], seq: 3 });
    control.end(ME);
    expect(control.get(ME)).toBeNull();
    expect(changes.at(-1)).toEqual({ sessionId: ME, walkthrough: null });
    expect(control.list()).toEqual([]);
  });
});

describe('中継・起動の引数・設定', () => {
  it('tools/list: 示すツールと読むツールに readOnlyHint を付ける（ファイルは書き換えない）', async () => {
    const deps = { server: WALKTHROUGH_MCP, version: '1', call: async () => textResult('ok') };
    const init = await respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, deps);
    expect(init?.result).toMatchObject({ serverInfo: { name: 'tanacode-walkthrough' } });
    expect((init?.result as { instructions: string }).instructions).toContain('start_walkthrough');
    const list = await respond({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps);
    const tools = (list?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it('起動の引数に足し、ツールはすべて許可済みにする', () => {
    const launch = { command: '/Apps/tanacode Helper', script: '/Apps/out/main/walkthrough-mcp.js', socketPath: '/u/walkthrough.sock', version: '1.0.0' };
    const checklist = { ...launch, script: '/Apps/out/main/checklist-mcp.js', socketPath: '/u/checklist.sock' };
    const args = claudeArgs({ claudeSessionId: 'c1', resume: false, remoteControlName: null, model: null, effort: null, permissionMode: null, checklist, walkthrough: launch, sessionId: 's1' });
    // --mcp-config と --allowedTools は 1 回ずつ
    expect(args.filter((a) => a === '--mcp-config')).toHaveLength(1);
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(Object.keys(config.mcpServers)).toEqual(['tanacode-checklist', 'tanacode-walkthrough']);
    expect(config.mcpServers['tanacode-walkthrough'].env).toMatchObject({ TANACODE_WALKTHROUGH_SOCKET: '/u/walkthrough.sock', TANACODE_WALKTHROUGH_SESSION: 's1' });
    const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
    expect(allowed).toEqual(expect.arrayContaining(allowedToolIds(WALKTHROUGH_MCP)));
    expect(allowedToolIds(WALKTHROUGH_MCP)).toHaveLength(WALKTHROUGH_MCP.tools.length);
    expect(allowed).toContain(walkthroughToolId('start_walkthrough'));
  });

  it('メニューのオン・オフは既定でオンで、保存される', () => {
    const file = join(dir, 'settings.json');
    expect(new AppSettings(file).walkthroughControlEnabled()).toBe(true);
    new AppSettings(file).setWalkthroughControlEnabled(false);
    expect(new AppSettings(file).walkthroughControlEnabled()).toBe(false);
  });
});

describe('チャットの表示と質問の文', () => {
  it('ツールの行の対象と、押したときに開くもの', () => {
    const start = walkthroughToolId('start_walkthrough');
    const show = walkthroughToolId('show_code');
    expect(walkthroughTarget(start, { title: '税率の変更', steps: [{}, {}] }, '/r')).toBe('税率の変更 · 2 ステップ');
    expect(walkthroughTarget(show, { path: '/r/src/tax.ts', start_line: 3, end_line: 5 }, '/r')).toBe('src/tax.ts:3-5');
    expect(walkthroughTarget(show, { path: 'src/tax.ts', start_line: 3 }, '/r')).toBe('src/tax.ts:3');
    expect(walkthroughTarget('Read', { file_path: '/r/a' }, '/r')).toBeNull();
    expect(walkthroughOfTool(start, '{}')).toEqual({ kind: 'walkthrough' });
    expect(walkthroughOfTool(show, JSON.stringify({ path: 'src/tax.ts', start_line: 3 }))).toEqual({ kind: 'code', path: 'src/tax.ts', line: 3 });
    expect(walkthroughOfTool(walkthroughToolId('walkthrough_status'), '{}')).toBeNull();
    expect(walkthroughOfTool(show, 'not json')).toBeNull();
  });

  it('質問の文に、見ている場所と選んだコードを添える', async () => {
    const { control } = setup();
    await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step({ start_line: 12, end_line: undefined, title: '切り捨て' })] });
    control.go(ME, 1);
    const w = control.get(ME)!;
    expect(stepQuestionText(w, ' なぜ？ ')).toBe('ウォークスルー「税率の変更」の 2/2「切り捨て」（src/tax.ts:12）について質問です。\n\nなぜ？');
    expect(stepQuestionText({ ...w, aside: { path: 'src/a.ts', startLine: 1, endLine: 2, title: '', body: '' } }, 'これは？')).toContain('寄り道で示した src/a.ts:1-2 について');
    expect(rangeQuestionText('src/a.ts', 4, 4, 'const x = 1;', 'なぜ 1？')).toBe('src/a.ts:4 について質問です。\n```\nconst x = 1;\n```\n\nなぜ 1？');
    // コードに ``` があれば、囲みを長くする
    expect(rangeQuestionText('a.md', 1, 3, '```js\nx\n```', '?')).toContain('````\n```js');
    expect(restartRequestText(w)).toContain('2/2 から先を start_walkthrough で示し直して');
  });
});
