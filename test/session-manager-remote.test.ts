import { afterEach, describe, expect, it } from 'vitest';
import { line, ScriptedApp, type ScriptedOptions } from './helpers/scripted-claude';

// Remote Control（スマホから続ける）の指定と、会話ログのつながりの行（SessionManager）。
// stream-json では、起動したあとに remote_control の要求でつなぐ（順番 5 で作る。今は指定を覚えるところまで）

let app: ScriptedApp;
const start = (options: ScriptedOptions = {}) => (app = new ScriptedApp(options));
afterEach(() => app.dispose());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 会話ログのつながりの行
const bridgeStatus = (url: string) => ({ ...line.turnEnd(), subtype: 'bridge_status', url });

const remoteEvents = (id: string) => app.events(id).filter((e) => e.type === 'remote-control');

describe('指定', () => {
  it('stream-json の claude には --remote-control を付けない（起動したあとに要求でつなぐ）。指定は一覧に出す', () => {
    start();
    const { id, pipe } = app.create({ remoteControl: true });
    expect(pipe.arg('--remote-control')).toBeNull();
    expect(pipe.request.args).not.toContain('--remote-control');
    expect(app.manager.summary(id)?.remoteControl).toBe(true);
    expect(app.manager.remoteAvailable()).toBe(true);
    const off = app.create({ remoteControl: false });
    expect(app.manager.summary(off.id)?.remoteControl).toBe(false);
    expect(app.manager.remoteConnectedOf(off.id)).toBe(false);
  });

  it('開発版（Remote Control を使えない）では、指定があっても使わず、切り替えも断る', async () => {
    start({ remoteControlAvailable: false });
    const { id } = app.create({ remoteControl: true });
    expect(app.manager.summary(id)?.remoteControl).toBe(false);
    expect(app.manager.remoteAvailable()).toBe(false);
    expect(await app.manager.setRemoteControl(id, true)).toContain('開発版では使えません');
  });

  it('知らないセッションは断る。止まっているセッションは指定だけ変える', async () => {
    start();
    expect(await app.manager.setRemoteControl('nope', true)).toBe('セッションが見つかりません');
    const { id, pipe } = app.create({ remoteControl: false });
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(await app.manager.setRemoteControl(id, true)).toBeNull();
    expect(app.manager.summary(id)?.remoteControl).toBe(true);
    // 動いていなければ、つながっていない
    expect(app.manager.remoteConnectedOf(id)).toBe(false);
    expect(app.manager.remoteConnectedOf('nope')).toBe(false);
  });
});

describe('会話ログのつながりの行', () => {
  it('つながったら URL をチャットに出し、つながっていることにする', async () => {
    start();
    const { id } = app.create({ remoteControl: true });
    await app.ready(id);
    app.append(id, bridgeStatus('https://claude.ai/code/session_abc'));
    await app.waitFor('つながり', () => remoteEvents(id).length > 0);
    expect(remoteEvents(id)).toEqual([{ type: 'remote-control', url: 'https://claude.ai/code/session_abc' }]);
    expect(app.manager.remoteConnectedOf(id)).toBe(true);
  });

  it('再開したときは、前に起動した claude のつながり（読み直した過去の行）を出さない', async () => {
    start();
    const { id } = app.create({ remoteControl: true });
    await app.ready(id);
    app.say(id, line.user('はじめ'), bridgeStatus('https://claude.ai/code/session_old'), line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    await app.manager.restart(id);
    // 起動し直したあとのイベント（読み直した過去の行から作ったもの）
    const since = () => app.manager.snapshot(id).events;
    await app.waitFor('読み直し', () => since().some((e) => e.type === 'turn-end'));
    await sleep(300);
    expect(since().some((e) => e.type === 'user')).toBe(true);
    expect(since().filter((e) => e.type === 'remote-control')).toEqual([]);
  });
});
