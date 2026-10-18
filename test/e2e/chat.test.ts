import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOOK_COMMAND, PROMPT, QUESTION, SETTINGS, stepsFor } from '../scenario';
import { BACKGROUND, E2EApp } from './app';

// 基本の台本（test/scenario.ts）を、アプリの画面から動かす。信頼していないフォルダで新しいセッションを始め、チャットに出るカードで
// Bash の許可・質問・Write の許可に答えて、返事がチャットに出るまで。
// 答えが Claude まで届いたかは、モックの API が受け取ったツールの結果で確かめる
describe('チャットから Claude Code を動かす', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({ conversations: (work) => [{ match: PROMPT, steps: stepsFor(work) }], claudeSettings: SETTINGS });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`chat-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('信頼していないフォルダでも、フォルダの信頼は確かめずに始まる。最初の指示が届き、Bash の許可の確認に答えられる', async () => {
    // 許可の確認を出させる（Claude Code の既定のモードでは、確認なしで動くことがある）
    await app.startSession(PROMPT, { mode: 'manual' });
    // チャット（stream-json）はフォルダの信頼を確かめない（決めたこと）。最初に出るカードは Bash の許可の確認
    const card = await app.menuCard('permission');
    expect(await card.textContent()).toContain('mkdir checked');
    await app.choose(card, /^許可する/);
  });

  it('AskUserQuestion の質問に、カードの選択肢で答えられる（カードは、Claude Code が答えを待つ要求（can_use_tool）の質問から描く。画面は読まない）', async () => {
    const card = await app.menuCard('question');
    expect(await card.locator('.menu-title').textContent()).toBe(QUESTION.question);
    // 「この質問について話す」は、フックが受け取った質問のカード（QuestionCard）にだけ出る（画面から読んだカードは「Chat about this」）
    await card.getByText('この質問について話す（Chat about this）').waitFor();
    await app.choose(card, 'です・ます');
  });

  it('Write の許可の確認に答えると、ファイルが書かれる', async () => {
    const card = await app.menuCard('permission');
    expect(await card.textContent()).toContain('hello.txt');
    await app.choose(card, /^許可する/);
    await app.byText('.chat-list', 'チェック完了').waitFor();
    expect(readFileSync(join(app.work, 'hello.txt'), 'utf8')).toBe('こんにちは\n');
  });

  it('答えとコマンドの結果が Claude まで届いている', () => {
    expect(app.api.toolResults.some((r) => r.includes('tanacode-check'))).toBe(true);
    expect(app.api.toolResults.some((r) => r.includes('です・ます'))).toBe(true);
  });

  it('チャットに、発言・ツール・フック・返事が並び、ツールのまとまりを開ける', async () => {
    const chat = app.page.locator('.chat-list');
    for (const text of [PROMPT, 'コマンドを実行します。', 'チェック完了']) await chat.getByText(text).first().waitFor();
    // 質問への回答は、カードとしてチャットに残る
    await chat.getByText('→ です・ます').waitFor();
    // ツールはまとまりに畳まれている。開くと、Bash のカード（説明と、あとに動いたフック）と Write のカードが出る
    const heads = chat.locator('.tool-group-head');
    expect(await heads.count()).toBe(2);
    for (const head of await heads.all()) await head.click();
    await app.byText('.tool-card .tool-target', '確認のフォルダを作る').waitFor();
    await app.byText('.hook-run .hook-command', HOOK_COMMAND).waitFor();
    await app.byText('.tool-card .tool-target', 'hello.txt').waitFor();
    await app.byText('.tool-card .diff-add', '+1').waitFor();
  });

  it('一覧の行に、最初の発言がタイトルとして出る。権限モードは選んだもの', async () => {
    await app.byText('.session-list .session-row', PROMPT).waitFor();
    expect(await app.page.inputValue('.chat-options select[title^="権限モード"]')).toBe('manual');
    expect(await app.page.locator('.claude-header .claude-title').textContent()).toBe(PROMPT);
  });

  it('ターミナルで、シェルのコマンドを動かせる', async () => {
    await app.page.click('.activity-bar [aria-label="ターミナル"]');
    const shell = app.page.locator('.terminal-panel .terminal-host:not([hidden]) .terminal-instance:not([hidden])');
    await shell.locator('.xterm-rows').waitFor();
    await shell.locator('.xterm-helper-textarea').focus();
    await app.page.keyboard.type('echo e2e-$((40+2))');
    await app.page.keyboard.press('Enter');
    await shell.locator('.xterm-rows').getByText('e2e-42', { exact: false }).waitFor();
  });

  it('アプリの知らない行（サーバーのツールのブロック）は、灰色の 1 行の「未知のイベント」で出て、開くと生の行が読め、コピーできる', async () => {
    // Claude Code は、応答の中のサーバーのツールのブロックを、そのまま会話ログに書く（2.1.302 で実測）
    const prompt = '知らないブロックを返してください';
    app.api.intercept = (last) =>
      last.includes(prompt)
        ? [
            { type: 'raw', block: { type: 'server_tool_use', id: 'srvtoolu_e2e', name: 'web_search', input: {} } },
            { type: 'text', text: 'サーバーのツールを使いました' },
          ]
        : null;
    await app.send(prompt);
    const chat = app.page.locator('.chat-list');
    await chat.getByText('サーバーのツールを使いました').waitFor();
    const row = app.byText('details.chat-unknown', 'assistant/server_tool_use');
    expect(await row.locator('summary').textContent()).toBe('未知のイベント: assistant/server_tool_use');
    await row.locator('summary').click();
    expect(await row.locator('.chat-unknown-meta').textContent()).toMatch(/^会話ログの行Claude Code \d+\.\d+\.\d+$/);
    expect(JSON.parse((await row.locator('.chat-unknown-raw').textContent())!)).toMatchObject({ type: 'server_tool_use', id: 'srvtoolu_e2e' });
    // 手元の Mac（裏で起動）では、人のクリップボードを書き換えないよう、写す先を差し替える。CI では本物のクリップボードに写して読み直す
    if (BACKGROUND) {
      await app.page.evaluate(() => {
        const page = window as { copied?: string };
        Object.defineProperty(navigator.clipboard, 'writeText', {
          value: (text: string) => {
            page.copied = text;
            return Promise.resolve();
          },
        });
      });
    }
    await row.getByRole('button', { name: '生の行をコピー' }).click();
    await row.getByRole('button', { name: 'コピーしました' }).waitFor();
    const copied = BACKGROUND ? await app.page.evaluate(() => (window as { copied?: string }).copied ?? '') : await app.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(JSON.parse(copied)).toMatchObject({ type: 'server_tool_use', id: 'srvtoolu_e2e' });
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
