import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent } from '@shared/chat';
import { showsCommandSuggestion } from '../../src/main/screen-parser';
import { ClaudeRun, claudeVersion, shown, sleep } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、アプリを起動し直して、動いている claude を引き継げるかを確かめる。
// アプリの終了では claude を止めず（pty ホストが持ったまま）、起動し直したアプリの SessionManager が adopt で引き継ぐ。
// 台本: バックグラウンドの Bash（前の claude）→ claude を止めて --resume → バックグラウンドの Bash（今の claude）→
// アプリを起動し直す → 引き継いだ claude で続ける → アプリを止めている間に /clear して発言 → もう一度起動し直す

const PROMPT = '引き継ぎの確認を始めます';
const AFTER_RESUME = '再開した claude で続けます';
const AFTER_ADOPT = '引き継いだあとの発言です';
const WHILE_CLOSED = 'アプリを止めている間の発言です';
// 今の claude のバックグラウンドの Bash が終わるまでの時間（アプリを起動し直す間も動いている）
const NEW_TASK_SECONDS = 4;

const version = claudeVersion();

describe(`Claude Code ${version} の引き継ぎ`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  const texts = (events: ChatEvent[]) => events.flatMap((e) => (e.type === 'user' || e.type === 'assistant-text' ? [`${e.type}: ${e.text}`] : []));
  const task = (toolUseId: string) => run.bashTasks.find((t) => t.toolUseId === toolUseId);
  // 最後にアプリを起動してから配信されたもの
  const sinceStart = () => run.chatBatches.slice(run.chatBatches.map((b) => b.events.some((e) => e.type === 'process-start')).lastIndexOf(true));

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [
      {
        match: PROMPT,
        steps: [
          [{ type: 'tool_use', id: 'toolu_old', name: 'Bash', input: { command: 'sleep 60 && echo old-done', description: '前の claude の作業', run_in_background: true } }],
          [{ type: 'text', text: '前の起動の返事' }],
          [
            {
              type: 'tool_use',
              id: 'toolu_new',
              name: 'Bash',
              input: { command: `sleep ${NEW_TASK_SECONDS} && echo new-done`, description: '今の claude の作業', run_in_background: true },
            },
          ],
          [{ type: 'text', text: '今の起動の返事' }],
          [{ type: 'text', text: '完了通知への返事' }],
          [{ type: 'text', text: '引き継いだあとの返事' }],
        ],
      },
      { match: WHILE_CLOSED, steps: [[{ type: 'text', text: '止めている間の返事' }], [{ type: 'text', text: '乗り換えたあとの返事' }]] },
    ];
    run = new ClaudeRun(await api.start());
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('前の claude で始めたバックグラウンドの作業は、claude を止めると止まる', async () => {
    await run.send(PROMPT);
    await run.waitFor('前の起動の返事', replied('前の起動の返事'));
    expect(task('toolu_old')?.state).toBe('running');
    run.stopClaude();
    expect(task('toolu_old')?.state).toBe('stopped');
    run.start({ resume: true });
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
    await run.send(AFTER_RESUME);
    await run.waitFor('今の起動の返事', replied('今の起動の返事'));
    expect(task('toolu_new')?.state).toBe('running');
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt');
  });

  it('アプリを起動し直すと、動いている claude を引き継ぎ、今も動いている作業を追い続ける', async () => {
    const sessionId = run.sessionId;
    await run.restartApp();
    expect(run.sessionId).toBe(sessionId);
    await run.waitFor('会話ログの読み直し', () => run.historyLoaded);
    // 起動し直さずに、claude の画面をそのまま受け取る
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
    // 引き継いだ claude が起動する前に書かれた行は過去のもの。前の claude の作業は止まったものとして読む
    expect(task('toolu_old')).toMatchObject({ state: 'stopped', startedAt: null });
    // 引き継いだ claude が起動したあとに書かれた行は、読み直しでも今動いているもの
    expect(task('toolu_new')).toMatchObject({ state: 'running' });
    expect(task('toolu_new')!.startedAt).not.toBeNull();
    expect(run.summary()).toMatchObject({ running: true, backgroundTasks: 1 });
    expect(run.manager.liveSessions()).toEqual([{ title: PROMPT, state: 'バックグラウンド 1件の完了待ち' }]);
    // 読み直した会話は過去のもの（live: false）。起動し直したのではないので、入力を受け付けられる知らせ（ready）がすぐ来る
    const batches = sinceStart();
    expect(batches.flatMap((b) => b.events).filter((e) => e.type === 'ready')).toHaveLength(1);
    expect(batches.some((b) => !b.live && b.events.some((e) => e.type === 'user' && e.text === AFTER_RESUME))).toBe(true);
    expect(texts(shown(run.chat()))).toEqual([
      `user: ${PROMPT}`,
      'assistant-text: 前の起動の返事',
      `user: ${AFTER_RESUME}`,
      'assistant-text: 今の起動の返事',
    ]);
  });

  it('引き継いだ claude の作業の完了と、そのあとの発言を読める', async () => {
    const done = await run.waitFor('今の claude の作業の完了', () => (task('toolu_new')?.state !== 'running' ? task('toolu_new') : null), (NEW_TASK_SECONDS + 10) * 1000);
    expect(done.state).toBe('completed');
    // 終了コードと出力は、出力ファイルから読む
    const read = await run.waitFor('終了コード', () => (task('toolu_new')?.exitCode !== null ? task('toolu_new') : null), 5000);
    expect(read).toMatchObject({ state: 'completed', exitCode: 0 });
    expect(read.output).toContain('new-done');
    // 完了通知を受けて Claude が続きを書く（今起きたこととして配信する）
    await run.waitFor('完了通知への返事', replied('完了通知への返事'));
    expect(sinceStart().some((b) => b.live && b.events.some((e) => e.type === 'notice'))).toBe(true);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt');
    await run.send(AFTER_ADOPT);
    await run.waitFor('引き継いだあとの返事', replied('引き継いだあとの返事'));
    await run.waitFor('待機中', () => run.manager.liveSessions()[0]?.state === '待機中');
  });

  it('アプリを止めている間に /clear で会話が変わっても、引き継いですぐ新しい会話ログに乗り換える', async () => {
    const before = run.claudeSessionId;
    const statusPath = () => {
      try {
        return (JSON.parse(run.statusLineText() ?? '') as { transcript_path?: string }).transcript_path ?? null;
      } catch {
        return null;
      }
    };
    await run.restartApp(async () => {
      // アプリを通さずに打つ。画面は pty ホストの仮想の端末で見る
      const shows = (text: string) => run.lines().some((l) => l.text.includes(text));
      run.typeWithoutApp('/clear');
      await until(() => showsCommandSuggestion(run.lines(), '/clear'));
      run.typeWithoutApp('\r');
      await until(() => !shows(AFTER_ADOPT));
      run.typeWithoutApp(WHILE_CLOSED);
      await until(() => shows(WHILE_CLOSED));
      run.typeWithoutApp('\r');
      await until(() => shows('止めている間の返事'));
      // statusLine には、アプリが止まっている間に新しい会話ログのパスが書かれている
      await until(() => !!statusPath() && statusPath() !== run.transcript());
    });
    // 次に statusLine が書かれるのを待たずに、残っている statusLine から今の会話ログを知って乗り換える
    await run.waitFor('新しい会話ログに乗り換える', () => run.claudeSessionId !== before, 3000);
    expect(run.transcript()).toBe(statusPath());
    expect(run.statusLine?.transcriptPath).toBe(statusPath());
    await run.waitFor('止めている間の発言', () => texts(shown(run.chat())).includes(`user: ${WHILE_CLOSED}`));
    expect(texts(shown(run.chat())).slice(0, 2)).toEqual(['user: /clear', `user: ${WHILE_CLOSED}`]);
    // 引き継いだあとも、新しい会話で続けられる
    // （Claude Code は、止めている間の返事を次の書き込みまで会話ログに書かないことがあるので、返事はここで確かめる）
    await run.send(AFTER_ADOPT);
    await run.waitFor('乗り換えたあとの返事', replied('乗り換えたあとの返事'));
    expect(texts(shown(run.chat()))).toEqual([
      'user: /clear',
      `user: ${WHILE_CLOSED}`,
      'assistant-text: 止めている間の返事',
      `user: ${AFTER_ADOPT}`,
      'assistant-text: 乗り換えたあとの返事',
    ]);
  });
});

// 条件が満たされるまで待つ（アプリを止めている間は画面の読み取りが無いので、仮想の端末の文字を見る）
async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('時間切れ');
    await sleep(50);
  }
}
