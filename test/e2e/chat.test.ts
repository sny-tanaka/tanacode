import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOOK_COMMAND, PROMPT, QUESTION, SETTINGS, stepsFor } from '../scenario';
import { E2EApp } from './app';

// 基本の台本（test/scenario.ts）を、アプリの画面から動かす。新しいセッションを始め、チャットに出るカードで
// フォルダの信頼・Bash の許可・質問・Write の許可に答えて、返事がチャットに出るまで。
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

  it('新しいセッションを始めると、フォルダの信頼の確認がカードで出る', async () => {
    // 許可の確認を出させる（Claude Code の既定のモードでは、確認なしで動くことがある）
    await app.startSession(PROMPT, { mode: 'manual' });
    const card = await app.menuCard('other');
    expect(await card.locator('.menu-title').textContent()).toContain('trust');
    await app.choose(card, /^Yes/);
  });

  it('最初の指示が届き、Bash の許可の確認に答えられる', async () => {
    const card = await app.menuCard('permission');
    expect(await card.textContent()).toContain('mkdir checked');
    await app.choose(card, /^Yes/);
  });

  it('AskUserQuestion の質問に、カードの選択肢で答えられる', async () => {
    const card = await app.menuCard('question');
    expect(await card.locator('.menu-title').textContent()).toBe(QUESTION.question);
    await app.choose(card, 'です・ます');
  });

  it('Write の許可の確認に答えると、ファイルが書かれる', async () => {
    const card = await app.menuCard('permission');
    expect(await card.textContent()).toContain('hello.txt');
    await app.choose(card, /^Yes/);
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

  it('ターミナルモードにすると、チャットの代わりに claude の画面がそのまま描かれ、打った文字が届く', async () => {
    await app.page.click('.claude-header [aria-label="ターミナルモード"]');
    const rows = app.page.locator('.claude .claude-screen .terminal-instance .xterm-rows');
    await rows.getByText('チェック完了', { exact: false }).waitFor();
    // チャットと入力欄は隠す
    expect(await app.page.locator('.chat-list-wrap').isVisible()).toBe(false);
    expect(await app.page.locator('.chat-input-wrap').isVisible()).toBe(false);
    // 打った文字は pty から claude に届き、claude の入力欄に出る。人と同じ速さで 1 文字ずつ打つ
    // （打っている途中の文字を、入力欄に残った文字としてチャットの入力欄に移さない）
    await app.page.locator('.claude-screen .terminal-instance .xterm-helper-textarea').focus();
    await app.page.keyboard.type('typed-from-xterm', { delay: 80 });
    await rows.getByText('typed-from-xterm', { exact: false }).waitFor();
    expect(await app.page.inputValue('.chat-input textarea')).toBe('');
    // 書きかけは消しておく（Ctrl+U）
    await app.page.keyboard.press('Control+U');
    await app.page.waitForFunction(
      () => !document.querySelector('.claude-screen .terminal-instance .xterm-rows')?.textContent?.includes('typed-from-xterm'),
    );
    expect(await app.page.inputValue('.chat-input textarea')).toBe('');
  });

  it('ターミナルモードで打ちかけたまま、エディタなどを触っても書きかけは画面に残る。チャットに戻すと、チャットの入力欄に移る', async () => {
    const rows = app.page.locator('.claude .claude-screen .terminal-instance .xterm-rows');
    await app.page.locator('.claude-screen .terminal-instance .xterm-helper-textarea').focus();
    await app.page.keyboard.type('left-in-xterm', { delay: 80 });
    await rows.getByText('left-in-xterm', { exact: false }).waitFor();
    // 画面の外（ヘッダー）を押してフォーカスを外しても、書きかけは移さない（見えていないチャットの入力欄に入れない）
    await app.page.click('.claude-header .claude-title');
    // 移さないことを確かめるので、移すまでの待ち（隠してから 0.5 秒）より長く待つ
    await app.page.waitForTimeout(1000);
    expect(await rows.textContent()).toContain('left-in-xterm');
    expect(await app.page.inputValue('.chat-input textarea')).toBe('');
    // チャットに戻すと、書きかけはチャットの入力欄に移り、Claude Code の入力欄は空になる（チャットから送ったとき、書きかけの後ろにつながらない）
    await app.page.click('.claude-header [aria-label="ターミナルモード"]');
    await app.page.locator('.chat-list-wrap').waitFor();
    await app.page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('.chat-input textarea')?.value === 'left-in-xterm');
    expect(await app.page.locator('.claude-screen').count()).toBe(0);
    await app.page.fill('.chat-input textarea', '');
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

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
