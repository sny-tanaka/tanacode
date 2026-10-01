import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents } from '@shared/chat';
import type { Menu, ScreenInfo } from '@shared/screen';
import { transcriptPath } from '../../src/main/claude-session';
import { parseStatusLine } from '../../src/main/statusline';
import { PROMPT, checkAskInput, checkChat, checkPermission, checkPrompt, checkQuestion, checkStatusLine, checkTrust, stepsFor } from '../scenario';
import { CLAUDE_BIN, ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude（TANACODE_CLAUDE_BIN、無ければ PATH の claude）を、モックの API で動かす（料金はかからない）。
// Claude Code の画面・会話ログ・statusLine・フックの形が変わって、アプリの読み取りが通らなくなったら失敗する。
// TANACODE_RECORD=1 を付けると、途中の画面・会話ログなどを test/fixtures/claude-code/<版>/ に控えとして残す

// アプリが付ける引数（claudeArgs）が、今の claude にまだあるか
const FLAGS = ['--session-id', '--resume', '--remote-control', '--model', '--effort', '--permission-mode', '--settings'];

const version = claudeVersion();

// 選択メニューが出るのを待つ
const menuOf = (kind: Menu['kind']) => (info: ScreenInfo) => (info.state.kind === 'menu' && info.state.menu.kind === kind ? info.state.menu : null);

describe(`Claude Code ${version}`, () => {
  it('アプリが付ける引数がある', () => {
    const help = execFileSync(CLAUDE_BIN, ['--help'], { encoding: 'utf8' });
    for (const flag of FLAGS) expect(help, flag).toContain(flag);
  });

  describe('モックの API で会話する', () => {
    let api: MockApi;
    let run: ClaudeRun;
    const events = () => run.entries.flatMap((e) => toChatEvents(e, run.cwd));

    beforeAll(async () => {
      api = new MockApi();
      run = new ClaudeRun(await api.start());
      api.steps = stepsFor(run.cwd);
      run.start();
    });

    afterAll(async () => {
      if (process.env.TANACODE_RECORD) run?.record(join('test', 'fixtures', 'claude-code', version));
      run?.stop();
      await api?.stop();
    });

    it('フォルダの信頼の確認がメニューとして読める', async () => {
      const menu = await run.waitFor('信頼の確認', menuOf('other'));
      run.capture('trust');
      checkTrust(menu);
      await run.answer(menu.title, menu.options.find((o) => /^Yes/.test(o.label))!.id);
    });

    it('入力欄と、入力欄のまわりの表示が読める', async () => {
      await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
      run.capture('prompt');
      checkPrompt(run.screen.current);
    });

    it('Bash の許可の確認がメニューとして読める', async () => {
      run.type(PROMPT);
      // 打った文字が入力欄に入ってから送る
      await new Promise((resolve) => setTimeout(resolve, 300));
      run.type('\r');
      const menu = await run.waitFor('Bash の許可', menuOf('permission'));
      run.capture('bash-permission');
      checkPermission(menu, 'mkdir checked');
      await run.answer(menu.title, menu.options[0].id);
    });

    it('AskUserQuestion の質問がメニューとして読め、フックが入力を書く', async () => {
      const menu = await run.waitFor('質問', menuOf('question'));
      run.capture('question');
      checkQuestion(menu);
      checkAskInput(run.askInput());
      await run.answer(menu.title, menu.options[0].id);
    });

    it('Write の許可の確認がメニューとして読める', async () => {
      const menu = await run.waitFor('Write の許可', menuOf('permission'));
      run.capture('write-permission');
      checkPermission(menu, 'hello.txt');
      await run.answer(menu.title, menu.options[0].id);
    });

    it('返事のあと入力欄に戻る', async () => {
      await run.waitFor('返事', () => events().some((e) => e.type === 'assistant-text' && e.text === 'チェック完了'));
      await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt');
      expect(readFileSync(join(run.cwd, 'hello.txt'), 'utf8')).toBe('こんにちは\n');
    });

    it('会話ログからチャットを組み立てられる', async () => {
      await run.waitFor('ターンの終わり', () => events().some((e) => e.type === 'turn-end'));
      checkChat(run.entries, events(), run.cwd);
    });

    it('statusLine の JSON が読める', async () => {
      const text = await run.waitFor('statusLine', () => run.statusLineText());
      checkStatusLine(parseStatusLine(text, Date.now()), version, transcriptPath(run.cwd, run.claudeSessionId));
    });
  });
});
