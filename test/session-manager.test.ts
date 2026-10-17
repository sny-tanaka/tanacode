import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptPath } from '../src/main/claude-session';
import { INIT_RESPONSE, line, ScriptedApp, stream, type ScriptedPipe } from './helpers/scripted-claude';

// SessionManager を、本物の claude なしで動かして確かめる（claude の代わりに、テストが stream-json の行と会話ログを書く）。
// 本物の Claude Code での振る舞いは npm run test:cli が確かめる。ここでは、その上の SessionManager の分岐を確かめる

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

// チャットに出たターンの終わりの数（新しい会話では、読み直す会話ログが無いので、起動では出ない）
const turnEnds = (id: string) => app.events(id).filter((e) => e.type === 'turn-end').length;

describe('起動と送信', () => {
  it('新しい会話の ID と、アプリの statusLine の設定を付けて、セッションのフォルダで stream-json の claude を起動し、initialize を送る', async () => {
    const { id, pipe } = app.create();
    expect(pipe.request.cwd).toBe(app.cwd);
    expect(pipe.arg('--session-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(pipe.request.args).toContain('--settings');
    expect(pipe.request.args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']));
    expect(app.events(id).map((e) => e.type)).toContain('process-start');
    expect(app.manager.stateOf(id)).toBe('starting');
    await app.ready(id);
    // 裏のサブエージェント・ワークフローを中断で止めない（TUI の Esc と同じ）
    expect(pipe.requests('initialize').map((r) => r.request)).toEqual([{ subtype: 'initialize', perTaskStopAffordance: true }]);
    expect(app.manager.summary(id)).toMatchObject({ running: true, state: 'idle', attention: null, backgroundTasks: 0 });
    expect(app.events(id).filter((e) => e.type === 'ready')).toHaveLength(1);
  });

  it('initialize の返事が遅くても見放さずに待つ。決まった時間を過ぎたら、経過と標準エラーの末尾を進み具合（starting）で知らせる', async () => {
    app.answers.set('initialize', null);
    app.manager.slowStartMs = 100;
    const { id, pipe } = app.create();
    // 標準エラーは、常駐のホストが控えている末尾から読む
    app.host.hosted = [
      { kind: 'pipe', id: pipe.id, tag: id, pid: 1, startedAt: Date.now(), exitCode: null, lastSeq: 0, firstSeq: 1, retained: [], pending: [], ended: false, stderr: 'MCP server "slow": connecting\n' },
    ];
    await app.waitFor('起動が遅い', () => app.progress.get(id)?.stderr === 'MCP server "slow": connecting');
    expect(app.progress.get(id)).toMatchObject({ phase: 'starting', elapsed: expect.stringMatching(/^\d+s$/), tokens: null });
    expect(app.manager.progress(id)).toMatchObject({ phase: 'starting', stderr: 'MCP server "slow": connecting' });
    expect(app.manager.stateOf(id)).toBe('starting');
    // 遅れて答えが来たら、起動済みにして、知らせを消す
    pipe.respond(pipe.requests('initialize')[0].request_id, INIT_RESPONSE);
    await app.ready(id);
    expect(app.progress.get(id)).toBeNull();
    expect(app.manager.progress(id)).toBeNull();
    // 答えずに終わったら、知らせを消して終了を出す
    const other = app.create();
    await app.waitFor('起動が遅い', () => app.progress.get(other.id)?.phase === 'starting');
    other.pipe.exit(1, 'Error: MCP server failed');
    await app.waitFor('終了', () => app.manager.stateOf(other.id) === 'exited');
    expect(app.progress.get(other.id)).toBeNull();
  });

  it('発言は user の行 1 つで送る。本文の制御文字を除き、画像は image のブロック、札は pasted_content に入れる', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const png = join(app.root, 'shot.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // 画像でないファイルと、読めないファイルは送らない（チャットで知らせる）
    writeFileSync(join(app.root, 'memo.txt'), 'メモ');
    const uuid = await app.send(id, 'こんにちは\x1b[Z\u202Eです', [png, join(app.root, 'memo.txt'), join(app.root, 'missing.png')], ['長い\nログ']);
    expect(pipe.prompts).toEqual([
      {
        type: 'user',
        uuid,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') } },
            { type: 'text', text: 'こんにちは[Zです' },
          ],
        },
        pasted_content: ['長い\nログ'],
      },
    ]);
    expect(app.events(id).filter((e) => e.type === 'info').map((e) => (e.type === 'info' ? e.text : ''))).toEqual([
      expect.stringContaining('memo.txt, missing.png'),
    ]);
    // 画像が無ければ、本文はそのままの文字
    await app.send(id, 'ふつうの発言');
    expect(pipe.prompts[1].message.content).toBe('ふつうの発言');
  });
});

describe('会話ログからのチャット', () => {
  it('発言・応答が会話ログからチャットに出て、result でターンが終わり、作業の完了を 1 回知らせる', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.say(id, line.user('確認してください'), line.text('確認しました'));
    await app.waitFor('応答', () => app.events(id).some((e) => e.type === 'assistant-text'));
    expect(app.manager.stateOf(id)).toBe('working');
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    const events = app.events(id).filter((e) => e.type === 'user' || e.type === 'assistant-text');
    expect(events).toMatchObject([
      { type: 'user', text: '確認してください' },
      { type: 'assistant-text', text: '確認しました' },
    ]);
    await app.waitFor('完了の知らせ', () => app.turnsCompleted.length > 0);
    expect(app.turnsCompleted.map((s) => s.id)).toEqual([id]);
    expect(app.manager.stateOf(id)).toBe('idle');
  });

  it('今の claude の会話ログのターンの終わり（turn_duration）は使わない。ターンの終わりは result だけで決める', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('はい'));
    app.append(id, line.turnEnd());
    await app.waitFor('応答', () => app.events(id).some((e) => e.type === 'assistant-text'));
    await new Promise((r) => setTimeout(r, 200));
    expect(turnEnds(id)).toBe(0);
    expect(app.manager.stateOf(id)).toBe('working');
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
  });

  it('バックグラウンドの Bash が動いている間は、ターンが終わっても作業の完了を知らせない', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.say(
      id,
      line.user('サーバーを起動して'),
      line.toolUse('toolu_bg', 'Bash', { command: 'npm run dev', run_in_background: true }),
      line.toolResult('toolu_bg', 'Command running in background with ID: b1. Output is being written to: /nonexistent/b1.output', {
        toolUseResult: { backgroundTaskId: 'b1' },
      }),
      line.text('起動しました'),
    );
    await app.waitFor('バックグラウンドの数', () => app.manager.summary(id)?.backgroundTasks === 1);
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(app.turnsCompleted).toEqual([]);
    expect(app.manager.stateOf(id)).toBe('background');
  });

  it('claude が終わったら、チャットに終了を出し、一覧では動いていないセッションにする', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.exit(1);
    await app.waitFor('終了', () => app.events(id).some((e) => e.type === 'process-exit'));
    expect(app.events(id).find((e) => e.type === 'process-exit')).toMatchObject({ exitCode: 1 });
    await app.waitFor('一覧', () => app.manager.summary(id)?.running === false);
    expect(app.manager.summary(id)).toMatchObject({ state: 'exited', mode: null });
  });
});

describe('権限モードと起動し直し', () => {
  it('modeOf: initialize・system/init・status と、本体の発言の行の permissionMode で変わる。サブエージェントの行は使わない。知らない名前は manual', async () => {
    const { id, pipe } = app.create({ mode: 'acceptEdits' });
    expect(pipe.arg('--permission-mode')).toBe('acceptEdits');
    await app.ready(id);
    expect(app.manager.modeOf(id)).toBe('acceptEdits');
    expect(app.manager.summary(id)?.mode).toBe('acceptEdits');
    // Claude Code の名前（default）は、アプリの名前（manual）にする
    pipe.emit(stream.status('default'));
    await app.waitFor('status のモード', () => app.manager.modeOf(id) === 'manual');
    expect(app.manager.summary(id)?.mode).toBe('manual');
    pipe.emit(stream.init(app.claudeId(id), { permissionMode: 'plan' }));
    await app.waitFor('init のモード', () => app.manager.modeOf(id) === 'plan');
    app.append(id, { ...line.user('子を始めて'), permissionMode: 'auto' });
    await app.waitFor('会話ログのモード', () => app.manager.modeOf(id) === 'auto');
    // サブエージェントの行は、本体のモードではない（読んでいれば manual になる）
    app.append(id, { ...line.user('サブエージェントへの依頼'), isSidechain: true, permissionMode: 'default' }, line.text('目印'));
    await app.waitFor('目印', () => app.events(id).some((e) => e.type === 'assistant-text' && e.text === '目印'));
    expect(app.manager.modeOf(id)).toBe('auto');
    // 知らない名前は、許す操作の多さが分からないので manual
    app.append(id, { ...line.user('知らないモード'), permissionMode: 'dontAsk' });
    await app.waitFor('会話ログのモード', () => app.manager.modeOf(id) === 'manual');
  });

  it('modeOf: 会話ログを stream より遅れて読んでも、stream で知ったモードを、それより前に書かれた行のモードで戻さない', async () => {
    const { id, pipe } = app.create({ mode: 'plan' });
    await app.ready(id);
    // プランモードで送った発言の行。会話ログに書かれたのは、プランの承認より前
    const prompt = { ...line.user('プランを作って'), timestamp: new Date(Date.now() - 1000).toISOString(), permissionMode: 'plan' };
    // プランの承認（「承認して、編集を自動で進める」）で、Claude Code が acceptEdits にした（stream の status）。会話ログはまだ読んでいない
    // （新しい会話の会話ログは、最初の発言でできるので、追い始めるのが遅れることがある）
    pipe.emit(stream.status('acceptEdits'));
    await app.waitFor('status のモード', () => app.manager.modeOf(id) === 'acceptEdits');
    // あとから会話ログの行が届いても、承認より前に書かれた行のモードでは戻さない
    app.append(id, prompt, line.text('目印'));
    await app.waitFor('目印', () => app.events(id).some((e) => e.type === 'assistant-text' && e.text === '目印'));
    expect(app.manager.modeOf(id)).toBe('acceptEdits');
    // 承認よりあとに書かれた行のモードは使う
    app.append(id, { ...line.user('つづき'), permissionMode: 'default' });
    await app.waitFor('新しい行のモード', () => app.manager.modeOf(id) === 'manual');
  });

  it('最初のモード: 指定が無ければ auto。auto を使えないモデルなら、set_permission_mode で default（manual）にする', async () => {
    const first = app.create();
    expect(first.pipe.arg('--permission-mode')).toBe('auto');
    await app.ready(first.id);
    expect(app.manager.modeOf(first.id)).toBe('auto');
    expect(first.pipe.requests('set_permission_mode')).toEqual([]);

    app.answers.set('initialize', { ...INIT_RESPONSE, current_permission_mode: 'auto', models: [{ ...INIT_RESPONSE.models[0], supportsAutoMode: false }] });
    const restricted = app.create();
    await app.ready(restricted.id);
    expect(restricted.pipe.requests('set_permission_mode').map((r) => r.request)).toEqual([{ subtype: 'set_permission_mode', mode: 'default' }]);
    expect(app.manager.modeOf(restricted.id)).toBe('manual');
  });

  it('auto を使えるかは、既定のモデルでなく、選んだモデル（--model）で見る', async () => {
    const models = [
      { ...INIT_RESPONSE.models[0], supportsAutoMode: true },
      { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', supportedEffortLevels: [], supportsAutoMode: false },
    ];
    app.answers.set('initialize', { ...INIT_RESPONSE, current_permission_mode: 'auto', models });
    const haiku = app.create({ model: 'haiku' });
    await app.ready(haiku.id);
    expect(haiku.pipe.requests('set_permission_mode').map((r) => r.request)).toEqual([{ subtype: 'set_permission_mode', mode: 'default' }]);
    expect(app.manager.modeOf(haiku.id)).toBe('manual');
    // 既定のモデルが使えなくても、選んだモデルが使えるなら auto のまま
    app.answers.set('initialize', { ...INIT_RESPONSE, current_permission_mode: 'auto', models: [{ ...models[0], supportsAutoMode: false }, { ...models[1], supportsAutoMode: true }] });
    const chosen = app.create({ model: 'claude-haiku-5-5' });
    await app.ready(chosen.id);
    expect(chosen.pipe.requests('set_permission_mode')).toEqual([]);
    expect(app.manager.modeOf(chosen.id)).toBe('auto');
  });

  it('名前を知らないモデルの ID（Bedrock など）は、initialize の models の displayName で出す', async () => {
    const models = [INIT_RESPONSE.models[0], { value: 'arn:aws:bedrock:custom/abc', resolvedModel: 'arn:aws:bedrock:custom/abc', displayName: '社内の Opus', supportedEffortLevels: [] }];
    app.answers.set('initialize', { ...INIT_RESPONSE, models });
    const { id, pipe } = app.create({ model: 'arn:aws:bedrock:custom/abc' });
    await app.ready(id);
    pipe.emit(stream.init(app.claudeId(id), { model: 'arn:aws:bedrock:custom/abc' }));
    await app.waitFor('モデル', () => app.manager.statusLine(id)?.model?.id === 'arn:aws:bedrock:custom/abc');
    expect(app.manager.statusLine(id)?.model?.name).toBe('社内の Opus');
  });

  it('modeOf: 前の起動の claude が会話ログに書いたモードは使わない（開き直すときは、新しいセッションと同じ決まりのモードを渡す）', async () => {
    const { id, pipe } = app.create({ mode: 'manual' });
    await app.ready(id);
    app.say(id, { ...line.user('はじめ'), permissionMode: 'plan' }, line.text('はい'));
    await app.waitFor('会話ログのモード', () => app.manager.modeOf(id) === 'plan');
    app.finish(id);
    // そのあと人が切り替えた。止まったあとに開き直すときは、前回のモードでなく、新しいセッションと同じ決まり（設定の既定か auto）
    pipe.emit(stream.status('acceptEdits'));
    await app.waitFor('今のモード', () => app.manager.modeOf(id) === 'acceptEdits');
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.manager.open(id);
    expect(app.pipe(id).arg('--resume')).toBe(pipe.arg('--session-id'));
    expect(app.pipe(id).arg('--permission-mode')).toBe('auto');
    await app.ready(id);
    await app.waitFor('会話ログの読み直し', () => app.events(id).some((e) => e.type === 'turn-end'));
    expect(app.manager.modeOf(id)).toBe('auto');
    // 今の claude が書けば、それを使う
    app.append(id, { ...line.user('つづき'), permissionMode: 'auto' });
    await app.waitFor('会話ログのモード', () => app.manager.modeOf(id) === 'auto');
  });

  it('restart: 動いている claude を end_session で止め、同じ会話を --resume で、今の権限モードのまま起動し直す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const conversation = pipe.arg('--session-id');
    // 会話ログに発言があるときだけ --resume で続ける（無ければ同じ ID で始め直す）
    app.say(id, line.user('はじめ'), line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    pipe.emit(stream.status('acceptEdits'));
    await app.waitFor('今のモード', () => app.manager.modeOf(id) === 'acceptEdits');
    await app.manager.restart(id);
    expect(pipe.requests('end_session')).toHaveLength(1);
    expect(pipe.exitedWith).toBe(0);
    const next = app.pipe(id);
    expect(next).not.toBe(pipe);
    expect(next.arg('--resume')).toBe(conversation);
    expect(next.arg('--permission-mode')).toBe('acceptEdits');
  });

  it('restart: 止めている間は起動中にする（送った発言が、閉じかけの claude に入って消えないよう、画面が預かる）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    // end_session を受けても、すぐには終わらない
    pipe.exitOnEnd = false;
    const restarting = app.manager.restart(id);
    await app.waitFor('end_session', () => pipe.requests('end_session').length === 1);
    expect(app.manager.stateOf(id)).toBe('starting');
    expect(app.sessions.find((s) => s.id === id)?.state).toBe('starting');
    pipe.exit(0);
    await restarting;
    expect(app.pipe(id)).not.toBe(pipe);
    await app.ready(id);
    expect(app.manager.stateOf(id)).toBe('idle');
  });

  it('restart: 起動し直すまで、一覧に一度も「終了」を出さず、チャットに終了も出さない（画面が送信を一瞬止めない）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const before = app.sessionLists.length;
    await app.manager.restart(id);
    expect(pipe.exitedWith).toBe(0);
    const states = app.sessionLists.slice(before).map((list) => list.find((s) => s.id === id)?.state);
    expect(states).not.toContain('exited');
    expect(app.events(id).some((e) => e.type === 'process-exit')).toBe(false);
    await app.ready(id);
    expect(app.manager.stateOf(id)).toBe('idle');
  });

  it('restart: 止めている途中に送った発言は、閉じかけの claude に書かず、起動し直した claude に届ける', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.exitOnEnd = false;
    const restarting = app.manager.restart(id);
    await app.waitFor('end_session', () => pipe.requests('end_session').length === 1);
    const sent = app.manager.submit(id, '再起動のあとも');
    pipe.exit(0);
    await restarting;
    const next = app.pipe(id);
    await app.ready(id);
    await sent;
    expect(pipe.prompts).toEqual([]);
    expect(next.prompts.map((p) => p.message.content)).toEqual(['再起動のあとも']);
  });

  it('restart: 止めている途中に来た、起動を待って送るもの（親の指示・予約）も、起動し直した claude に届ける', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.exitOnEnd = false;
    const restarting = app.manager.restart(id);
    await app.waitFor('end_session', () => pipe.requests('end_session').length === 1);
    pipe.exit(0);
    await app.waitFor('止まった', () => pipe.exitedWith !== null);
    const sent = app.manager.submitWhenReady(id, '親からの指示', 5000);
    await restarting;
    await app.ready(id);
    await sent;
    expect(app.pipe(id).prompts.map((p) => p.message.content)).toEqual(['親からの指示']);
  });

  it('restart: 止めている途中にアーカイブしたら、途中に送った発言は、止めた claude を待ち続けずに失敗する', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.exitOnEnd = false;
    const restarting = app.manager.restart(id);
    await app.waitFor('end_session', () => pipe.requests('end_session').length === 1);
    const sent = app.manager.submit(id, '再起動のあとも');
    await app.manager.archive(id);
    pipe.exit(0);
    await restarting;
    await expect(sent).rejects.toThrow('Claude Code が終了しました');
    expect(pipe.prompts).toEqual([]);
    expect(app.host.pipes).toHaveLength(1);
  });

  it('restart: 受け付ける前の claude を止められなかったら、途中に送った発言は、受け付けるのを待ちきれずに失敗する（待ち続けない）', async () => {
    // initialize に答えない（起動の途中に再起動を押した）
    app.answers.set('initialize', null);
    const { id, pipe } = app.create();
    pipe.exitOnEnd = false;
    app.manager.stopStepMs = 20;
    app.manager.restartSendWaitMs = 50;
    const restarting = app.manager.restart(id);
    const sent = app.manager.submit(id, '再起動のあとも');
    await expect(restarting).rejects.toThrow('Claude Code を止められなかったため、起動し直せませんでした');
    await expect(sent).rejects.toThrow('Claude Code が受け付けられるようにならなかったため、送れませんでした');
    expect(pipe.prompts).toEqual([]);
  });

  it('restart: 受け付けるのを待つ間にアーカイブしたら、待ちきるのを待たずに失敗する', async () => {
    app.answers.set('initialize', null);
    const { id, pipe } = app.create();
    pipe.exitOnEnd = false;
    app.manager.stopStepMs = 20;
    const restarting = app.manager.restart(id);
    const sent = app.manager.submit(id, '再起動のあとも');
    await expect(restarting).rejects.toThrow('Claude Code を止められなかったため、起動し直せませんでした');
    await app.manager.archive(id);
    await expect(sent).rejects.toThrow('Claude Code が終了しました');
    expect(pipe.prompts).toEqual([]);
  });

  it('restart: 受け付ける前の claude を止められなかったが、待つ間に受け付けるようになったら、その claude に届ける', async () => {
    app.answers.set('initialize', null);
    const { id, pipe } = app.create();
    pipe.exitOnEnd = false;
    app.manager.stopStepMs = 20;
    const restarting = app.manager.restart(id);
    const sent = app.manager.submit(id, '再起動のあとも');
    await expect(restarting).rejects.toThrow('Claude Code を止められなかったため、起動し直せませんでした');
    pipe.respond(pipe.requests('initialize')[0].request_id, INIT_RESPONSE);
    await sent;
    expect(pipe.prompts.map((p) => p.message.content)).toEqual(['再起動のあとも']);
  });

  it('restart: 止められなかったら（終わりの知らせが来ない）、動いている claude をそのまま使えるように戻し、黙らずに理由を返す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.exitOnEnd = false;
    app.manager.stopStepMs = 20;
    await expect(app.manager.restart(id)).rejects.toThrow('Claude Code を止められなかったため、起動し直せませんでした');
    expect(pipe.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(app.host.pipes).toHaveLength(1);
    expect(app.manager.stateOf(id)).toBe('idle');
    await app.manager.submit(id, 'つづき');
    expect(pipe.prompts.map((p) => p.message.content)).toEqual(['つづき']);
  });

  it('restart: bypassPermissions は引き継がない（起動し直したあとは、設定の既定か auto）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.emit(stream.status('bypassPermissions'));
    await app.waitFor('今のモード', () => app.manager.modeOf(id) === 'bypassPermissions');
    await app.manager.restart(id);
    expect(app.pipe(id).arg('--permission-mode')).toBe('auto');
  });

  it('setMode: Claude Code が動いていない子は、次に起動するときのモードを変える。子でないセッションは変えない', async () => {
    const parent = app.create();
    const child = app.create({ mode: 'manual' }, parent.id);
    await app.ready(child.id);
    child.pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(child.id) === 'exited');
    expect(await app.manager.setMode(child.id, 'plan')).toBe(true);
    await app.manager.open(child.id);
    expect(app.pipe(child.id).arg('--permission-mode')).toBe('plan');
    // 子でないセッションは、動いていなければ切り替えない（次の起動は、新しいセッションと同じ決まりのモード）
    await app.ready(parent.id);
    parent.pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(parent.id) === 'exited');
    expect(await app.manager.setMode(parent.id, 'plan')).toBe(false);
    await app.manager.open(parent.id);
    expect(app.pipe(parent.id).arg('--permission-mode')).toBe('auto');
  });

  it('restart: 子セッションは、Claude Code が知らせたモードが強くても、起動したときのモードより強いモードで起動し直さない', async () => {
    const parent = app.create();
    const child = app.create({ mode: 'manual' }, parent.id);
    await app.ready(child.id);
    child.pipe.emit(stream.status('auto'));
    await app.waitFor('今のモード', () => app.manager.modeOf(child.id) === 'auto');
    await app.manager.restart(child.id);
    expect(app.pipe(child.id).arg('--permission-mode')).toBe('manual');
  });

  it('ユーザー・プロジェクトの設定ファイルに読めない項目があれば（get_settings の errors）、チャットに知らせて続ける（止めるのは、登録した設定ファイルのときだけ）', async () => {
    app.answers.set('get_settings', { applied: {}, errors: [{ file: '/x/settings.json', path: 'permissions.allow', message: 'Expected array' }] });
    const { id, pipe } = app.create();
    await app.waitFor('受け付け', () => app.events(id).some((e) => e.type === 'ready'));
    expect(app.events(id).filter((e) => e.type === 'info').map((e) => (e.type === 'info' ? e.text : ''))).toEqual([
      expect.stringMatching(/^設定ファイルに読めない項目があります。[\s\S]*\/x\/settings\.json: permissions\.allow: Expected array/),
    ]);
    expect(pipe.requests('end_session')).toEqual([]);
  });
});

describe('一覧の操作', () => {
  it('rename: 付けた名前を一覧に出す。空にすると付けた名前を外す', async () => {
    const { id } = app.create();
    app.manager.rename(id, '  ログインの改修  ');
    expect(app.manager.summary(id)?.title).toBe('ログインの改修');
    app.manager.rename(id, ' ');
    expect(app.manager.summary(id)?.title).toBeNull();
  });

  it('archive: claude を止めてアーカイブし、子セッションも一緒にアーカイブする。remove は子を残す', async () => {
    const parent = app.create();
    const child = app.create({ mode: 'manual' }, parent.id);
    await app.manager.archive(parent.id);
    expect(parent.pipe.kills).toEqual(['SIGTERM']);
    expect(app.manager.stateOf(parent.id)).toBe('archived');
    expect(app.manager.stateOf(child.id)).toBe('archived');

    const other = app.create();
    const otherChild = app.create({ mode: 'manual' }, other.id);
    await app.manager.remove(other.id);
    expect(app.manager.summary(other.id)).toBeUndefined();
    expect(app.manager.stateOf(otherChild.id)).not.toBe('archived');
  });

  it('unarchive と open: アーカイブから戻し、開くと同じ会話を --resume で再開する', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    await app.manager.archive(id);
    app.manager.unarchive(id);
    expect(app.manager.summary(id)?.archived).toBe(false);
    await app.manager.open(id);
    expect(app.pipe(id)).not.toBe(pipe);
    expect(app.pipe(id).arg('--resume')).toBe(pipe.arg('--session-id'));
  });

  it('アーカイブで止めた claude の終わりが、開き直したあとに届いても、新しい起動の表示に流さない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    // 止める頼み（SIGTERM）では、すぐには終わらない
    pipe.exitOnEnd = false;
    await app.manager.archive(id);
    expect(pipe.kills).toEqual(['SIGTERM']);
    app.manager.unarchive(id);
    await app.manager.open(id);
    await app.ready(id);
    const before = app.manager.snapshot(id).events.length;
    pipe.exit(143);
    await new Promise((r) => setTimeout(r, 50));
    expect(app.manager.snapshot(id).events.slice(before).map((e) => e.type)).not.toContain('process-exit');
    expect(app.manager.stateOf(id)).toBe('idle');
  });

  const SONNET = { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'medium', 'high'], supportsAutoMode: true };
  const HAIKU = { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', supportedEffortLevels: [], supportsAutoMode: false };

  it('configure: モデル・エフォートを変えたら、動いている claude を起動し直さずに、その場で切り替える（set_model・apply_flag_settings）', async () => {
    app.answers.set('initialize', { ...INIT_RESPONSE, models: [...INIT_RESPONSE.models, SONNET] });
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.manager.configure(id, { model: 'sonnet', effort: 'high', settingsFile: null });
    expect(pipe.requests('set_model').map((r) => r.request)).toEqual([{ subtype: 'set_model', model: 'sonnet' }]);
    expect(pipe.requests('apply_flag_settings').map((r) => r.request)).toEqual([{ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }]);
    expect(pipe.requests('end_session')).toEqual([]);
    expect(app.host.pipes).toHaveLength(1);
    expect(app.manager.summary(id)).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(app.manager.statusLine(id)?.model).toEqual({ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' });
    // エフォートだけ変えたら、モデルは切り替えない
    await app.manager.configure(id, { model: 'sonnet', effort: 'low', settingsFile: null });
    expect(pipe.requests('set_model')).toHaveLength(1);
    expect(pipe.requests('apply_flag_settings').at(-1)?.request).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } });
    // ヘッダーのエフォートは、頼んだ値ではなく、Claude Code が実際に使うと答えた値（get_settings の applied）
    pipe.answers.set('get_settings', { applied: { effort: 'medium' } });
    await app.manager.configure(id, { model: 'sonnet', effort: 'high', settingsFile: null });
    expect(app.manager.statusLine(id)?.effort).toBe('medium');
    pipe.answers.set('get_settings', { applied: { effort: 'low' } });
    await app.manager.configure(id, { model: 'sonnet', effort: 'low', settingsFile: null });
    // そのモデルで選べないエフォートは断る（Claude Code は知らない値も受け付けてしまう。実測）
    await expect(app.manager.configure(id, { model: 'sonnet', effort: 'max', settingsFile: null })).rejects.toThrow('max');
    expect(app.manager.summary(id)).toMatchObject({ model: 'sonnet', effort: 'low' });
    // 画面の選択肢（その場で切り替えられるモデル）は initialize の models から
    expect(app.manager.modelsOf(id)?.map((m) => [m.value, m.efforts])).toEqual([
      ['default', ['low', 'medium', 'high']],
      ['sonnet', ['low', 'medium', 'high']],
    ]);
    // Claude Code が断ったら、理由を添えて失敗し、指定は変えない
    pipe.answers.set('set_model', new Error('Invalid model'));
    await expect(app.manager.configure(id, { model: null, effort: null, settingsFile: null })).rejects.toThrow('Invalid model');
    expect(app.manager.summary(id)?.model).toBe('sonnet');
    // 一覧に無いモデル（控えにある旧モデルなど）は、set_model せずに --model で起動し直す（set_model は知らない名前も受け付けてしまう。実測）
    pipe.answers.delete('set_model');
    await app.manager.configure(id, { model: 'claude-old-4', effort: 'low', settingsFile: null });
    expect(pipe.requests('set_model')).toHaveLength(2);
    expect(pipe.requests('end_session')).toHaveLength(1);
    expect(app.pipe(id).arg('--model')).toBe('claude-old-4');
    expect(app.manager.summary(id)).toMatchObject({ model: 'claude-old-4', effort: 'low' });
  });

  it('configure: モデルだけを変えて、今のエフォートを新しいモデルで選べなければ、エフォートの指定を外す', async () => {
    app.answers.set('initialize', { ...INIT_RESPONSE, models: [...INIT_RESPONSE.models, HAIKU] });
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.manager.configure(id, { model: null, effort: 'high', settingsFile: null });
    await app.manager.configure(id, { model: 'haiku', effort: 'high', settingsFile: null });
    expect(pipe.requests('set_model').map((r) => r.request)).toEqual([{ subtype: 'set_model', model: 'haiku' }]);
    expect(pipe.requests('apply_flag_settings').at(-1)?.request).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: null } });
    expect(app.manager.summary(id)).toMatchObject({ model: 'haiku', effort: null });
    // エフォートも一緒に頼んだ（今のものと違う）なら、選べなければ断る
    await expect(app.manager.configure(id, { model: null, effort: 'max', settingsFile: null })).rejects.toThrow('max');
  });

  it('configure: 切り替えたモデルで auto を使えなければ、manual に戻す（起動するときと同じ）', async () => {
    app.answers.set('initialize', { ...INIT_RESPONSE, current_permission_mode: 'auto', models: [...INIT_RESPONSE.models, HAIKU] });
    const { id, pipe } = app.create();
    await app.ready(id);
    expect(app.manager.modeOf(id)).toBe('auto');
    await app.manager.configure(id, { model: 'haiku', effort: null, settingsFile: null });
    expect(pipe.requests('set_permission_mode').map((r) => r.request)).toEqual([{ subtype: 'set_permission_mode', mode: 'default' }]);
    expect(app.manager.modeOf(id)).toBe('manual');
  });

  it('importSession: 既存の会話を取り込み、その会話を --resume で再開する', async () => {
    const claudeId = '33333333-0000-4000-8000-000000000003';
    // 取り込む会話ログ（別のところで動かしていた Claude Code が書いたもの）
    const file = transcriptPath(app.cwd, claudeId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...line.user('前の会話'), sessionId: claudeId, cwd: app.cwd }) + '\n');
    const id = app.manager.importSession(claudeId, app.cwd, '前の会話');
    expect(app.pipe(id).arg('--resume')).toBe(claudeId);
  });
});

describe('残った claude', () => {
  it('起動したら initialize の pid と起動したときの会話の ID を記録し、開き直す前に、残っていれば止める（ホストが止める間もなく落ちたとき）', async () => {
    const asked: unknown[] = [];
    app.manager.stopLeftover = async (claude) => {
      asked.push(claude);
      return true;
    };
    const { id, pipe } = app.create();
    await app.ready(id);
    const conversation = pipe.arg('--session-id');
    // ホストが落ちた（パイプの claude は残っているかもしれない）
    pipe.exit(-1);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.manager.open(id);
    expect(asked).toEqual([{ pid: INIT_RESPONSE.pid, conversation }]);
    // 止めてから起動する
    expect(app.host.pipes).toHaveLength(2);
  });
});

describe('待っている要求の知らせ', () => {
  it('許可の確認（can_use_tool）が来たら操作待ちを 1 回知らせ、状態を許可の確認にする。取り下げられたら戻す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('消して'), line.toolUse('toolu_1', 'Bash', { command: 'rm -rf build' }));
    pipe.emit({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_1', description: 'build を消す' },
    });
    await app.waitFor('操作待ち', () => app.attentions.length > 0);
    expect(app.attentions).toMatchObject([{ id, attention: { kind: 'menu', menu: { kind: 'permission' } } }]);
    expect(app.manager.stateOf(id)).toBe('permission');
    expect(app.manager.summary(id)?.attention).toBe('permission');
    // スマホなど、ほかで先に答えた
    pipe.emit({ type: 'control_cancel_request', request_id: 'req-1' });
    await app.waitFor('取り下げ', () => app.manager.stateOf(id) === 'working');
    expect(app.manager.summary(id)?.attention).toBeNull();
    expect(app.attentions).toHaveLength(1);
  });

  // Claude Code の要求（can_use_tool）を出す。返事はアプリが書いた control_response で見る
  const request = (pipe: ScriptedPipe, requestId: string, body: Record<string, unknown>) =>
    pipe.emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_use_id: `toolu_${requestId}`, ...body } });
  const answerTo = (pipe: ScriptedPipe, requestId: string) =>
    pipe.messages.flatMap((m) => {
      const response = (m as { type?: string; response?: { request_id?: string; response?: unknown } }).response;
      return m.type === 'control_response' && response?.request_id === requestId ? [response.response] : [];
    });
  const QUESTIONS = [{ question: 'どちらの方式?', header: '方式', multiSelect: false, options: [{ label: 'A 案', description: '速い' }, { label: 'B 案', description: '確実', preview: 'B の図' }] }];

  it('質問（AskUserQuestion）は、答えを待っている質問としてカードと親の道具に渡し、答えを入力の answers・annotations に入れて許す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, '方式を決めて');
    request(pipe, 'req-q', { tool_name: 'AskUserQuestion', input: { questions: QUESTIONS } });
    await app.waitFor('質問', () => app.manager.pendingQuestion(id) !== null);
    const question = app.manager.pendingQuestion(id)!;
    expect(question.questions).toEqual(QUESTIONS);
    expect(app.questionLog.at(-1)).toEqual({ id, question });
    expect(app.manager.stateOf(id)).toBe('question');
    // 質問は許可の確認ではない
    expect(app.manager.pendingPermission(id)).toBeNull();
    expect(app.manager.replyPermission(id, 'req-q', { kind: 'allow' })).toBe(false);
    const annotations = { 'どちらの方式?': { notes: '余白を広く', preview: 'B の図' } };
    expect(app.manager.replyQuestion(id, question.id, { kind: 'answer', answers: { 'どちらの方式?': 'B 案' }, annotations })).toBe(true);
    await app.waitFor('返事', () => answerTo(pipe, 'req-q').length === 1);
    expect(answerTo(pipe, 'req-q')).toEqual([{ behavior: 'allow', updatedInput: { questions: QUESTIONS, answers: { 'どちらの方式?': 'B 案' }, annotations } }]);
    await app.waitFor('質問が閉じる', () => app.manager.pendingQuestion(id) === null);
    expect(app.manager.stateOf(id)).toBe('working');
  });

  it('質問の「Chat about this」は、答えずに質問について話す文を返す（TUI で選んだときと同じ文）。キャンセルは断って作業を止める', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    request(pipe, 'req-chat', { tool_name: 'AskUserQuestion', input: { questions: QUESTIONS } });
    await app.waitFor('質問', () => app.manager.pendingQuestion(id) !== null);
    app.manager.replyQuestion(id, app.manager.pendingQuestion(id)!.id, { kind: 'chat' });
    await app.waitFor('返事', () => answerTo(pipe, 'req-chat').length === 1);
    expect(answerTo(pipe, 'req-chat')).toEqual([
      {
        behavior: 'deny',
        message: [
          "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:",
          'The user wants to clarify these questions.',
          '    This means they may have additional information, context or questions for you.',
          '    Take their response into account and then reformulate the questions if appropriate.',
          '    Start by asking them what they would like to clarify.',
          '',
          '    Questions asked:',
          '- "どちらの方式?"\n  (No answer provided)',
        ].join('\n'),
      },
    ]);
    request(pipe, 'req-cancel', { tool_name: 'AskUserQuestion', input: { questions: QUESTIONS } });
    await app.waitFor('次の質問', () => app.manager.pendingQuestion(id) !== null);
    app.manager.replyQuestion(id, app.manager.pendingQuestion(id)!.id, { kind: 'cancel' });
    await app.waitFor('返事', () => answerTo(pipe, 'req-cancel').length === 1);
    expect(answerTo(pipe, 'req-cancel')).toEqual([
      { behavior: 'deny', message: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).", interrupt: true },
    ]);
  });

  it('取り下げられた質問（ほかで答えた・中断）は、カードから消し、あとから答えても返さない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    request(pipe, 'req-q', { tool_name: 'AskUserQuestion', input: { questions: QUESTIONS } });
    await app.waitFor('質問', () => app.manager.pendingQuestion(id) !== null);
    const question = app.manager.pendingQuestion(id)!;
    pipe.emit({ type: 'control_cancel_request', request_id: 'req-q' });
    await app.waitFor('取り下げ', () => app.manager.pendingQuestion(id) === null);
    expect(app.questionLog.at(-1)).toEqual({ id, question: null });
    expect(app.manager.replyQuestion(id, question.id, { kind: 'answer', answers: { 'どちらの方式?': 'A 案' } })).toBe(false);
    expect(answerTo(pipe, 'req-q')).toEqual([]);
  });

  it('許可の確認は、ツールの入力・説明・理由・「今後は聞かない」の候補をカードに渡し、答えを Claude Code の返事にする', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];
    request(pipe, 'req-1', {
      tool_name: 'Bash',
      input: { command: 'npm test', description: 'テストを流す' },
      title: 'Bash を実行しますか?',
      description: 'テストを流す',
      decision_reason: 'Bash は毎回確かめる設定です',
      permission_suggestions: suggestions,
    });
    await app.waitFor('許可の確認', () => app.manager.pendingPermission(id) !== null);
    const permission = app.manager.pendingPermission(id)!;
    expect(permission).toEqual({
      id: 'req-1',
      tool: 'Bash',
      title: 'Bash を実行しますか?',
      description: 'テストを流す',
      input: { command: 'npm test', description: 'テストを流す' },
      reason: 'Bash は毎回確かめる設定です',
      always: ['「Bash(npm test:*)」・このフォルダ'],
      plan: null,
      agent: null,
      humanOnly: null,
    });
    expect(app.permissionLog.at(-1)).toEqual({ id, permission });
    // 知らない要求・質問の返事では答えない
    expect(app.manager.replyPermission(id, 'req-x', { kind: 'allow' })).toBe(false);
    expect(app.manager.replyPermission(id, 'req-1', { kind: 'allow', always: true })).toBe(true);
    expect(answerTo(pipe, 'req-1')).toEqual([{ behavior: 'allow', updatedInput: { command: 'npm test', description: 'テストを流す' }, updatedPermissions: suggestions }]);
    expect(app.manager.pendingPermission(id)).toBeNull();
    expect(app.permissionLog.at(-1)).toEqual({ id, permission: null });
    // 2 回は答えない
    expect(app.manager.replyPermission(id, 'req-1', { kind: 'allow' })).toBe(false);
    // 理由を添えて断る・止める
    request(pipe, 'req-2', { tool_name: 'Bash', input: { command: 'rm -rf build' } });
    await app.waitFor('次の確認', () => app.manager.pendingPermission(id)?.id === 'req-2');
    app.manager.replyPermission(id, 'req-2', { kind: 'deny', message: '別のフォルダに出して' });
    expect(answerTo(pipe, 'req-2')).toEqual([
      {
        behavior: 'deny',
        message:
          "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n別のフォルダに出して",
      },
    ]);
    request(pipe, 'req-3', { tool_name: 'Bash', input: { command: 'rm -rf ~' } });
    await app.waitFor('次の確認', () => app.manager.pendingPermission(id)?.id === 'req-3');
    app.manager.replyPermission(id, 'req-3', { kind: 'stop' });
    expect(answerTo(pipe, 'req-3')).toEqual([expect.objectContaining({ behavior: 'deny', interrupt: true })]);
  });

  it('プランの承認は、プランのファイル（会話ログの planFilePath）の本文をカードに渡す。読めなければ、Claude が ExitPlanMode に渡した本文', async () => {
    const { id, pipe } = app.create({ mode: 'plan' });
    await app.ready(id);
    // プランのフォルダ（<設定のフォルダ>/plans）の下のファイル
    const planFile = join(app.home, '.claude', 'plans', 'calm-plan.md');
    mkdirSync(dirname(planFile), { recursive: true });
    writeFileSync(planFile, '# ファイルの計画\n');
    app.append(id, line.user('計画して'), { ...line.turnEnd(), type: 'attachment', subtype: undefined, attachment: { type: 'plan_mode', planFilePath: planFile, planExists: true } });
    await app.waitFor('会話ログ', () => app.events(id).some((e) => e.type === 'user'));
    request(pipe, 'req-plan', { tool_name: 'ExitPlanMode', input: {} });
    await app.waitFor('プランの承認', () => app.manager.pendingPermission(id) !== null);
    expect(app.manager.pendingPermission(id)).toMatchObject({ tool: 'ExitPlanMode', input: {}, plan: '# ファイルの計画\n' });
    // 承認して編集を自動で進める（acceptEdits にする）
    app.manager.replyPermission(id, 'req-plan', { kind: 'accept-edits' });
    expect(answerTo(pipe, 'req-plan')).toEqual([{ behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }]);
    // ファイルが無ければ、Claude が ExitPlanMode に渡した本文（stream-json の assistant の行）
    rmSync(planFile);
    pipe.emit(stream.assistant({ ...line.toolUse('toolu_plan2', 'ExitPlanMode', { plan: '# 入力の計画' }) }, app.claudeId(id)));
    pipe.emit({ type: 'control_request', request_id: 'req-plan2', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: {}, tool_use_id: 'toolu_plan2' } });
    await app.waitFor('次のプランの承認', () => app.manager.pendingPermission(id)?.id === 'req-plan2');
    expect(app.manager.pendingPermission(id)?.plan).toBe('# 入力の計画');
  });

  it('プランのファイルは、プランのフォルダ（設定の plansDirectory も）の下の、リンクでない通常のファイルで、大きすぎないものだけ読む', async () => {
    app.answers.set('get_settings', { effective: { plansDirectory: 'docs/plans' }, sources: [], applied: { model: 'claude-opus-5-5', effort: null } });
    const { id, pipe } = app.create({ mode: 'plan' });
    await app.ready(id);
    // 会話ログのプランの場所を読み終えてから、プランの承認を出す
    const planFile = () => (app.manager as unknown as { runtimes: Map<string, { planFile: string | null }> }).runtimes.get(id)?.planFile;
    const planAt = async (file: string, n: number) => {
      app.append(id, { ...line.turnEnd(), type: 'attachment', subtype: undefined, attachment: { type: 'plan_mode', planFilePath: file, planExists: true } });
      await app.waitFor('プランの場所', () => planFile() === file);
      request(pipe, `req-${n}`, { tool_name: 'ExitPlanMode', input: {} });
    };
    const plan = (n: number) => app.waitFor(`プランの承認 ${n}`, () => app.manager.pendingPermission(id)?.id === `req-${n}`).then(() => app.manager.pendingPermission(id)?.plan);
    const answer = (n: number) => app.manager.replyPermission(id, `req-${n}`, { kind: 'stop' });
    // 設定の plansDirectory（プロジェクトのいちばん上からの相対）の下
    const own = join(app.cwd, 'docs', 'plans', 'a.md');
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, '# 設定のフォルダの計画\n');
    await planAt(own, 1);
    expect(await plan(1)).toBe('# 設定のフォルダの計画\n');
    answer(1);
    // プランのフォルダの外のファイルは読まない（本文を読めなかったことにする）
    const outside = join(app.root, 'secret.md');
    writeFileSync(outside, '# 外のファイル\n');
    await planAt(outside, 2);
    expect(await plan(2)).toBe('');
    answer(2);
    // プランのフォルダの中でも、外を指すリンクは読まない
    const link = join(app.home, '.claude', 'plans', 'link.md');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link);
    await planAt(link, 3);
    expect(await plan(3)).toBe('');
    answer(3);
    // 大きすぎるファイルは読まない
    const big = join(app.home, '.claude', 'plans', 'big.md');
    writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
    await planAt(big, 4);
    expect(await plan(4)).toBe('');
  });

  it('プランの本文を読めないうちに出たプランの承認は、プランのファイル・Claude の入力が分かったら、本文を読み直して出し直す', async () => {
    const { id, pipe } = app.create({ mode: 'plan' });
    await app.ready(id);
    request(pipe, 'req-plan', { tool_name: 'ExitPlanMode', input: {} });
    await app.waitFor('プランの承認', () => app.manager.pendingPermission(id) !== null);
    expect(app.manager.pendingPermission(id)?.plan).toBe('');
    const planFile = join(app.home, '.claude', 'plans', 'late.md');
    mkdirSync(dirname(planFile), { recursive: true });
    writeFileSync(planFile, '# あとから分かった計画\n');
    app.append(id, { ...line.turnEnd(), type: 'attachment', subtype: undefined, attachment: { type: 'plan_mode', planFilePath: planFile, planExists: true } });
    await app.waitFor('出し直す', () => app.permissionLog.at(-1)?.permission?.plan === '# あとから分かった計画\n');
    expect(app.manager.pendingPermission(id)?.plan).toBe('# あとから分かった計画\n');
  });

  it('読めない質問（AskUserQuestion の入力の形が違う）は、許可の確認として出さず、その場で断る', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    request(pipe, 'req-bad', { tool_name: 'AskUserQuestion', input: { questions: 'こわれた入力' } });
    await app.waitFor('断る', () => answerTo(pipe, 'req-bad').length === 1);
    expect(answerTo(pipe, 'req-bad')[0]).toMatchObject({ behavior: 'deny' });
    expect(app.manager.pendingPermission(id)).toBeNull();
    expect(app.manager.pendingQuestion(id)).toBeNull();
    expect(app.manager.stateOf(id)).not.toBe('permission');
  });

  it('質問は、許可の確認と同時に待っていても、許可の確認として出さない。許可の確認の答えでは答えられない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    request(pipe, 'req-q', { tool_name: 'AskUserQuestion', input: { questions: QUESTIONS } });
    await app.waitFor('質問', () => app.manager.pendingQuestion(id) !== null);
    expect(app.manager.pendingPermission(id)).toBeNull();
    expect(app.manager.replyPermission(id, 'req-q', { kind: 'allow' })).toBe(false);
    request(pipe, 'req-p', { tool_name: 'Bash', input: { command: 'make' } });
    await app.waitFor('許可の確認', () => app.manager.pendingPermission(id) !== null);
    expect(app.manager.pendingPermission(id)?.id).toBe('req-p');
  });
});
