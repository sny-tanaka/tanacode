import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents } from '@shared/chat';
import { transcriptPath } from '../../src/main/claude-session';
import { listCommands } from '../../src/main/commands';
import { menuNotice } from '../../src/main/notice-text';
import { parseStatusLine } from '../../src/main/statusline';
import { PROMPT, QUESTION, SETTINGS, checkAskInput, checkChat, checkPermission, checkPrompt, checkQuestion, checkStatusLine, checkTrust, stepsFor } from '../scenario';
import { CLAUDE_BIN, ClaudeRun, claudeVersion, menuOf } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude（TANACODE_CLAUDE_BIN、無ければ PATH の claude）を、モックの API で動かす（料金はかからない）。
// 基本の台本（test/scenario.ts）: 信頼の確認・入力欄・許可の確認・質問・hooks・チャット・statusLine・/ の候補。
// Claude Code の形が変わって、アプリの読み取りが通らなくなったら失敗する。
// TANACODE_RECORD=1 を付けると、途中の画面・会話ログなどを test/fixtures/claude-code/<版>/ に控えとして残す

// アプリが付ける引数（claudeArgs）が、今の claude にまだあるか
const FLAGS = ['--session-id', '--resume', '--remote-control', '--model', '--effort', '--permission-mode', '--settings'];

const version = claudeVersion();


describe(`Claude Code ${version}`, () => {
  it('アプリが付ける引数がある', () => {
    const help = execFileSync(CLAUDE_BIN, ['--help'], { encoding: 'utf8' });
    for (const flag of FLAGS) expect(help, flag).toContain(flag);
  });

  describe('モックの API で会話する', () => {
    let api: MockApi;
    let run: ClaudeRun;
    const events = () => run.entries.flatMap((e) => toChatEvents(e, run.cwd));
    // 選択メニューが出たとき: session-manager の知らせ（onAttention）・一覧の操作待ち・状態の文言。返すのは通知の本文
    const checkAttention = (kind: 'permission' | 'question', state: string): string => {
      const last = run.attentions.at(-1);
      expect(last?.kind === 'menu' && last.menu.kind).toBe(kind);
      expect(run.summary()?.attention).toBe(kind);
      expect(run.manager.liveSessions()).toEqual([{ title: expect.any(String), state }]);
      return last?.kind === 'menu' ? menuNotice(last.menu) : '';
    };

    beforeAll(async () => {
      api = new MockApi();
      run = new ClaudeRun(await api.start(), { settings: SETTINGS });
      api.conversations = [{ match: PROMPT, steps: stepsFor(run.cwd) }];
      run.start();
    });

    afterAll(async () => {
      if (process.env.TANACODE_RECORD) run?.record(join('test', 'fixtures', 'claude-code', version));
      await run?.stop();
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
      await run.send(PROMPT);
      const menu = await run.waitFor('Bash の許可', menuOf('permission'));
      run.capture('bash-permission');
      checkPermission(menu, 'mkdir checked');
      // session-manager は操作待ちを知らせ（アプリは通知を出す）、一覧の状態を変える
      expect(checkAttention('permission', '実行の許可待ち')).toContain('mkdir checked');
      await run.answer(menu.title, menu.options[0].id);
    });

    it('AskUserQuestion の質問がメニューとして読め、フックが入力を書く', async () => {
      const menu = await run.waitFor('質問', menuOf('question'));
      run.capture('question');
      checkQuestion(menu);
      checkAskInput(run.askInput());
      expect(checkAttention('question', '質問への回答待ち')).toBe(QUESTION.question);
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

    it('session-manager が配信したチャットのイベントでも、同じチャットになる', async () => {
      await run.waitFor('ターンの終わり', () => run.chatEvents.some((e) => e.type === 'turn-end'));
      checkChat(run.entries, run.chatEvents, run.cwd);
      // 起動・入力を受け付けられるようになった知らせが、会話より先に来る
      expect(run.chatEvents.slice(0, 2)).toEqual([{ type: 'process-start' }, { type: 'ready' }]);
      // 画面が持つチャット（snapshot）も同じ
      checkChat(run.entries, run.chat(), run.cwd);
    });

    it('作業が終わると、完了を知らせて待機中に戻る', async () => {
      await run.waitFor('完了の知らせ', () => run.turnsCompleted.length > 0);
      expect(run.turnsCompleted[0]).toMatchObject({ id: run.sessionId, title: PROMPT, backgroundTasks: 0 });
      await run.waitFor('待機中', () => run.manager.liveSessions()[0]?.state === '待機中');
      expect(run.summary()).toMatchObject({ running: true, attention: null, title: PROMPT });
      // 一覧のタイトルは、最初の発言から
      expect(run.sessions[0]?.title).toBe(PROMPT);
    });

    it('Claude が書いたファイルとコンテキストの使用量が読める', async () => {
      await run.waitFor('書いたファイル', () => run.knowledge?.files['hello.txt']);
      expect(run.knowledge).toEqual({ files: { 'hello.txt': 'edited' }, contextTokens: expect.any(Number) });
    });

    it('会話ログのスキルの一覧から、/ の候補を作れる', async () => {
      // 新しい会話には、まだスキルの一覧が無いので、同じフォルダの会話ログから借りる
      const commands = await listCommands(run.cwd, null);
      expect(commands.filter((c) => c.source === 'skill').length).toBeGreaterThan(0);
    });

    it('statusLine の JSON が読める', async () => {
      const text = await run.waitFor('statusLine', () => run.statusLineText());
      checkStatusLine(parseStatusLine(text, Date.now()), version, transcriptPath(run.cwd, run.claudeSessionId));
      // アプリと同じく StatusLineWatcher が読んで、session-manager から配信する
      await run.waitFor('statusLine の配信', () => run.statusLine);
      checkStatusLine(run.statusLine, version, transcriptPath(run.cwd, run.claudeSessionId));
      expect(run.manager.statusLine(run.sessionId!)).toEqual(run.statusLine);
    });
  });
});
