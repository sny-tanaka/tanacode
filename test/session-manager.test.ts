import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptPath } from '../src/main/claude-session';
import { INIT_RESPONSE, line, ScriptedApp, stream } from './helpers/scripted-claude';

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

  it('発言は user の行 1 つで送る。本文の制御文字を除き、画像は image のブロック、札は pasted_content に入れる', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const png = join(app.root, 'shot.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // 画像でないファイルと、読めないファイルは送らない
    const uuid = await app.send(id, 'こんにちは\x1b[Z‮です', [png, join(app.root, 'memo.txt'), join(app.root, 'missing.png')], ['長い\nログ']);
    expect(pipe.prompts).toEqual([
      {
        type: 'user',
        uuid,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') } },
            { type: 'text', text: 'こんにちは[Zです' },
          ],
        },
        pasted_content: ['長い\nログ'],
      },
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

  it('modeOf: 前の起動の claude が会話ログに書いたモードは使わない（今の起動では、別のモードを渡していることもある）', async () => {
    const { id, pipe } = app.create({ mode: 'manual' });
    await app.ready(id);
    app.say(id, { ...line.user('はじめ'), permissionMode: 'plan' }, line.text('はい'));
    await app.waitFor('会話ログのモード', () => app.manager.modeOf(id) === 'plan');
    app.finish(id);
    // そのあと人が切り替えた。次の起動は、前回分かっていたこのモードで始める
    pipe.emit(stream.status('acceptEdits'));
    await app.waitFor('今のモード', () => app.manager.modeOf(id) === 'acceptEdits');
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.manager.open(id);
    expect(app.pipe(id).arg('--resume')).toBe(pipe.arg('--session-id'));
    expect(app.pipe(id).arg('--permission-mode')).toBe('acceptEdits');
    await app.ready(id);
    await app.waitFor('会話ログの読み直し', () => app.events(id).some((e) => e.type === 'turn-end'));
    expect(app.manager.modeOf(id)).toBe('acceptEdits');
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
    // 子でないセッションは、動いていなければ切り替えない（次の起動は、前回分かっていたモード）
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

  it('形の違う設定ファイルがあれば（get_settings の errors）、理由をチャットに出して止める', async () => {
    app.answers.set('get_settings', { applied: {}, errors: [{ file: '/x/settings.json', path: 'permissions.allow', message: 'Expected array' }] });
    const { id, pipe } = app.create();
    await app.waitFor('止める', () => pipe.requests('end_session').length === 1);
    expect(app.events(id).filter((e) => e.type === 'info').map((e) => (e.type === 'info' ? e.text : ''))).toEqual([
      expect.stringContaining('permissions.allow'),
    ]);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(app.events(id).some((e) => e.type === 'ready')).toBe(false);
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

  it('configure: モデルを変えたら、動いている claude をそのモデルで起動し直す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    await app.manager.configure(id, { model: 'sonnet', effort: 'high', settingsFile: null });
    expect(pipe.exitedWith).toBe(0);
    expect(app.pipe(id).arg('--model')).toBe('sonnet');
    expect(app.pipe(id).arg('--effort')).toBe('high');
    expect(app.manager.summary(id)).toMatchObject({ model: 'sonnet', effort: 'high' });
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
});
