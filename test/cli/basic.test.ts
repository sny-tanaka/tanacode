import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents } from '@shared/chat';
import { listCommands } from '../../src/main/commands';
import { menuNotice } from '../../src/main/notice-text';
import { PROMPT, QUESTION, SETTINGS, checkChat, checkPermission, checkQuestion, stepsFor, unreadableStreamLines } from '../scenario';
import { CLAUDE_BIN, ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude（TANACODE_CLAUDE_BIN、無ければ PATH の claude）を、モックの API で動かす（料金はかからない）。
// 基本の台本（test/scenario.ts）: 起動・許可の確認・質問・hooks・チャット・ヘッダーの statusLine・/ の候補（stream-json）。
// Claude Code の形が変わって、アプリの読み取りが通らなくなったら失敗する。
// TANACODE_RECORD=1 を付けると、会話ログを test/fixtures/claude-code/<バージョン>/ に控えとして残す（statusLine は terminal-mode.test.ts が残す）

// アプリが付ける引数（claudeArgs）が、今の claude にまだあるか
const FLAGS = ['--session-id', '--resume', '--remote-control', '--model', '--effort', '--permission-mode', '--mcp-config', '--allowedTools', '--settings'];

const version = claudeVersion();


describe(`Claude Code ${version}`, () => {
  it('アプリが付ける引数がある', () => {
    // ヘルプはファイルに書かせて読む。パイプで受けると、ほかのテストと並んで重いときに、claude が書き終える前に終わって
    // 8192 バイトや 16384 バイトで切れる（2.1.296。同時に 16 個を動かして 400 回中 370 回あまり。ファイルなら 400 回とも切れない）
    const dir = mkdtempSync(join(tmpdir(), 'tanacode-cli-help-'));
    try {
      const file = join(dir, 'help.txt');
      const fd = openSync(file, 'w');
      try {
        spawnSync(CLAUDE_BIN, ['--help'], { stdio: ['ignore', fd, 'ignore'] });
      } finally {
        closeSync(fd);
      }
      const help = readFileSync(file, 'utf8');
      for (const flag of FLAGS) expect(help, flag).toContain(flag);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('モックの API で会話する', () => {
    let api: MockApi;
    let run: ClaudeRun;
    const events = () => run.entries.flatMap((e) => toChatEvents(e, run.cwd));
    // 質問・許可の確認を待っているとき: 一覧の操作待ちと状態の文言
    const checkWaiting = (kind: 'permission' | 'question', state: string): void => {
      expect(run.summary()?.attention).toBe(kind);
      expect(run.manager.liveSessions()).toEqual([{ title: expect.any(String), state }]);
    };
    // 操作待ちでないところから確認が出たときの、session-manager の知らせ（onAttention。アプリは通知を出す）。返すのは通知の本文
    const checkNotified = (kind: 'permission' | 'question'): string => {
      const last = run.attentions.at(-1);
      expect(last?.kind === 'menu' && last.menu.kind).toBe(kind);
      return last?.kind === 'menu' ? menuNotice(last.menu) : '';
    };

    beforeAll(async () => {
      api = new MockApi();
      run = new ClaudeRun(await api.start(), { settings: SETTINGS });
      api.conversations = [{ match: PROMPT, steps: stepsFor(run.cwd) }];
      run.start();
    });

    afterAll(async () => {
      // 控えを書けなくても、claude とモックの API は止める（残ると、ほかのテストやジョブまで動き続ける）
      try {
        if (process.env.TANACODE_RECORD) run?.record(join('test', 'fixtures', 'claude-code', version), ['transcript.jsonl', 'stream.jsonl']);
      } finally {
        await run?.stop();
        await api?.stop();
      }
    });

    it('信頼していないフォルダでも、確かめずに起動して受け付ける（stream-json。決めたこと）。権限モードは起動したもの', async () => {
      await run.untilState('起動', (state) => state === 'idle');
      expect(run.manager.modeOf(run.sessionId!)).toBe('manual');
    });

    it('Bash の許可の確認が、待っている要求として届く', async () => {
      await run.send(PROMPT);
      const permission = await run.permission('Bash の許可');
      checkPermission(permission, 'Bash', 'mkdir checked');
      // session-manager は操作待ちを知らせ（アプリは通知を出す）、一覧の状態を変える
      checkWaiting('permission', '実行の許可待ち');
      expect(checkNotified('permission')).toContain('mkdir checked');
      run.replyPermission(permission, { kind: 'allow' });
    });

    it('AskUserQuestion の質問が、待っている質問として届く', async () => {
      const question = await run.question('質問');
      checkQuestion(question);
      checkWaiting('question', '質問への回答待ち');
      run.replyQuestion(question, { kind: 'answer', answers: { [QUESTION.question]: 'です・ます' } });
    });

    it('Write の許可の確認が、待っている要求として届く', async () => {
      const permission = await run.permission('Write の許可');
      checkPermission(permission, 'Write', 'hello.txt');
      run.replyPermission(permission, { kind: 'allow' });
    });

    it('返事のあと手が空く', async () => {
      await run.waitUntil('返事', () => events().some((e) => e.type === 'assistant-text' && e.text === 'チェック完了'));
      await run.waitUntil('手が空く', () => run.idle);
      expect(readFileSync(join(run.cwd, 'hello.txt'), 'utf8')).toBe('こんにちは\n');
    });

    it('会話ログからチャットを組み立てられる', async () => {
      // ターンの終わりは stream の result から出る（-p の会話ログには turn_duration の行が無い）ので、ここでは求めない
      checkChat(run.entries, events(), run.cwd, { turnEnd: false });
    });

    it('session-manager が配信したチャットのイベントでも、同じチャットになる', async () => {
      await run.waitUntil('ターンの終わり', () => run.chatEvents.some((e) => e.type === 'turn-end'));
      checkChat(run.entries, run.chatEvents, run.cwd);
      // 起動・入力を受け付けられるようになった知らせが、会話より先に来る
      expect(run.chatEvents.slice(0, 2)).toEqual([{ type: 'process-start' }, { type: 'ready' }]);
      // 画面が持つチャット（snapshot）も同じ
      checkChat(run.entries, run.chat(), run.cwd);
    });

    it('作業が終わると、完了を知らせて待機中に戻る', async () => {
      await run.waitUntil('完了の知らせ', () => run.turnsCompleted.length > 0);
      expect(run.turnsCompleted[0]).toMatchObject({ id: run.sessionId, title: PROMPT, backgroundTasks: 0 });
      await run.waitUntil('待機中', () => run.manager.liveSessions()[0]?.state === '待機中');
      expect(run.summary()).toMatchObject({ running: true, attention: null, title: PROMPT });
      // 一覧のタイトルは、最初の発言から
      expect(run.sessions[0]?.title).toBe(PROMPT);
    });

    it('Claude が書いたファイルとコンテキストの使用量が読める', async () => {
      await run.waitUntil('書いたファイル', () => run.knowledge?.files['hello.txt']);
      expect(run.knowledge).toEqual({ files: { 'hello.txt': 'edited' }, contextTokens: expect.any(Number) });
    });

    it('会話ログのスキルの一覧から、/ の候補を作れる', async () => {
      // 新しい会話には、まだスキルの一覧が無いので、同じフォルダの会話ログから借りる
      const commands = await listCommands(run.cwd, null);
      expect(commands.filter((c) => c.source === 'skill').length).toBeGreaterThan(0);
    });

    it('ヘッダーの statusLine（モデル・バージョン・コンテキスト）は、stream-json から組み立てて配信する（チャットの間は statusLine のコマンドが動かない）', async () => {
      const info = await run.waitUntil('statusLine の配信', () => (run.statusLine?.context ? run.statusLine : null));
      expect(info.version).toBe(version);
      expect(info.model?.id).toMatch(/^claude-/);
      expect(info.context!.size).toBeGreaterThan(0);
      expect(run.manager.statusLine(run.sessionId!)).toEqual(run.statusLine);
      // statusLine のコマンドは動かない（ファイルは書かれない）
      expect(run.statusLineText()).toBeNull();
    });

    // 毎日の確認（claude-code-check.yml）で、Claude Code の更新による stream-json の形の変化に気づくため
    it('stream-json の行が、どれも読める（知らない種類・形の違う行が無い）', () => {
      expect(run.streamLines().length).toBeGreaterThan(0);
      expect(unreadableStreamLines(run.streamLines())).toEqual({ malformed: 0, unknown: {} });
    });
  });
});
