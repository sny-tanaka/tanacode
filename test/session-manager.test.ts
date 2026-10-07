import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bracketedPaste } from '@shared/prompt-keys';
import { transcriptPath } from '../src/main/claude-session';
import { fixtureScreen, line, ScriptedApp } from './helpers/scripted-claude';

// SessionManager を、本物の claude なしで動かして確かめる（claude の代わりに、テストが画面と会話ログを書く）。
// 本物の Claude Code での振る舞いは npm run test:cli が確かめる。ここでは、その上の SessionManager の分岐を確かめる

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

describe('起動と送信', () => {
  it('新しい会話の ID と、アプリの statusLine の設定を付けて、セッションのフォルダで claude を起動する', async () => {
    const { id, pty } = app.create();
    expect(pty.request.cwd).toBe(app.cwd);
    expect(pty.arg('--session-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(pty.request.args).toContain('--settings');
    expect(app.events(id).map((e) => e.type)).toContain('process-start');
    await app.ready(id);
    expect(app.manager.summary(id)).toMatchObject({ running: true, attention: null, backgroundTasks: 0 });
  });

  it('画像のパスは貼り付けで送り、本文の制御文字（ESC・双方向の制御文字）を除いてから Enter を送る', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    // ESC が残ると、続く [Z が Shift+Tab（権限モードの切り替え）として届く。ESC だけを除けば、ただの文字になる
    await app.manager.submit(id, 'こんにちは\x1b[Z\u202Eです', ['/tmp/a.png']);
    expect(pty.typed).toBe(`${bracketedPaste('/tmp/a.png')} こんにちは[Zです\r`);
  });
});

describe('会話ログからのチャット', () => {
  it('発言・応答・ターンの終わりがチャットに出て、作業の完了を 1 回知らせる', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('確認してください'), line.text('確認しました'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    const events = app.events(id).filter((e) => e.type === 'user' || e.type === 'assistant-text');
    expect(events).toMatchObject([
      { type: 'user', text: '確認してください' },
      { type: 'assistant-text', text: '確認しました' },
    ]);
    await app.waitFor('完了の知らせ', () => app.turnsCompleted.length > 0);
    expect(app.turnsCompleted.map((s) => s.id)).toEqual([id]);
  });

  it('バックグラウンドの Bash が動いている間は、ターンが終わっても作業の完了を知らせない', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(
      id,
      line.user('サーバーを起動して'),
      line.toolUse('toolu_bg', 'Bash', { command: 'npm run dev', run_in_background: true }),
      line.toolResult('toolu_bg', 'Command running in background with ID: b1. Output is being written to: /nonexistent/b1.output', {
        toolUseResult: { backgroundTaskId: 'b1' },
      }),
      line.text('起動しました'),
      line.turnEnd(),
    );
    await app.waitFor('バックグラウンドの数', () => app.manager.summary(id)?.backgroundTasks === 1);
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    await new Promise((r) => setTimeout(r, 300));
    expect(app.turnsCompleted).toEqual([]);
  });

  it('claude が終わったら、チャットに終了を出し、一覧では動いていないセッションにする', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.exit(1);
    await app.waitFor('終了', () => app.events(id).some((e) => e.type === 'process-exit'));
    expect(app.events(id).find((e) => e.type === 'process-exit')).toMatchObject({ exitCode: 1 });
    await app.waitFor('一覧', () => app.manager.summary(id)?.running === false);
  });
});

describe('権限モードと起動し直し', () => {
  const MODE_TEXT = { manual: '⏸ manual mode on', acceptEdits: '⏵⏵ accept edits on', plan: '⏸ plan mode on', auto: '⏵⏵ auto mode on', bypassPermissions: '⏵⏵ bypass permissions on' };
  const CYCLE = ['manual', 'acceptEdits', 'plan', 'auto'] as const;

  it('setMode: 画面のモードが目的のものになるまで Shift+Tab を送り、アプリが決めたモードとして覚える', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    // claude の代わりに、Shift+Tab を受けたら次のモードを描く
    let current = 0;
    pty.onWrite = (data) => {
      if (data !== '\x1b[Z') return;
      current = (current + 1) % CYCLE.length;
      setTimeout(() => app.showMode(id, MODE_TEXT[CYCLE[current]]), 10);
    };
    // manual より強いモードにする（覚えていなければ、modeOf は画面の表示を信じず manual のまま）
    expect(await app.manager.setMode(id, 'auto')).toBe(true);
    expect(pty.writes.filter((w) => w === '\x1b[Z')).toHaveLength(3);
    expect(app.manager.modeOf(id)).toBe('auto');
  });

  it('modeOf: 画面の表示を強い向きに偽っても、アプリが決めたモードより強くしない。弱い向きなら画面に合わせる', async () => {
    const { id } = app.create({ mode: 'acceptEdits' });
    await app.ready(id);
    app.showMode(id, MODE_TEXT.bypassPermissions);
    await app.waitFor('画面のモード', () => app.screens.get(id)?.mode === 'bypassPermissions');
    expect(app.manager.modeOf(id)).toBe('acceptEdits');
    app.showMode(id, MODE_TEXT.manual);
    await app.waitFor('画面のモード', () => app.screens.get(id)?.mode === 'manual');
    expect(app.manager.modeOf(id)).toBe('manual');
  });

  it('restart: 動いている claude を止め、同じ会話を --resume で、画面に出ている権限モードのまま起動し直す', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    const conversation = pty.arg('--session-id');
    // 会話ログに発言があるときだけ --resume で続ける（無ければ同じ ID で始め直す）
    app.append(id, line.user('はじめ'), line.text('はい'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    app.showMode(id, MODE_TEXT.acceptEdits);
    await app.waitFor('画面のモード', () => app.screens.get(id)?.mode === 'acceptEdits');
    app.manager.restart(id);
    expect(pty.killed).toBe(true);
    const next = app.pty(id);
    expect(next).not.toBe(pty);
    expect(next.arg('--resume')).toBe(conversation);
    expect(next.arg('--permission-mode')).toBe('acceptEdits');
  });

  it('restart: bypassPermissions は引き継がない（起動し直したあとは既定のモード）', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.showMode(id, MODE_TEXT.bypassPermissions);
    await app.waitFor('画面のモード', () => app.screens.get(id)?.mode === 'bypassPermissions');
    app.manager.restart(id);
    expect(app.pty(id).arg('--permission-mode')).toBeNull();
  });

  it('restart: 子セッションは、画面の表示を偽っても、起動したときのモードより強いモードで起動し直さない', async () => {
    const parent = app.create();
    const child = app.create({ mode: 'manual' }, parent.id);
    await app.ready(child.id);
    app.showMode(child.id, MODE_TEXT.auto);
    await app.waitFor('画面のモード', () => app.screens.get(child.id)?.mode === 'auto');
    app.manager.restart(child.id);
    expect(app.pty(child.id).arg('--permission-mode')).toBe('manual');
  });
});

describe('発言の取り消しと順番待ち', () => {
  it('応答の前の Esc で発言が入力欄に戻ったら、チャットから発言を取り消し、ターンを終える', async () => {
    const { id } = app.create();
    await app.ready(id);
    // 控え（interrupt-draft）の入力欄に戻っている発言と同じ文
    app.append(id, line.user('応答の前に中断します'));
    await app.waitFor('発言', () => app.events(id).some((e) => e.type === 'user'));
    expect(app.manager.stateOf(id)).toBe('working');
    app.pty(id).output(fixtureScreen('interrupt-draft'));
    await app.waitFor('取り消し', () => app.events(id).some((e) => e.type === 'replace'));
    const replace = [...app.events(id)].reverse().find((e) => e.type === 'replace');
    expect(replace?.type === 'replace' && replace.events.some((e) => e.type === 'user')).toBe(false);
    expect(app.events(id).at(-1)?.type).toBe('turn-end');
    expect(app.manager.stateOf(id)).toBe('idle');
  });

  it('作業中に送った発言は、受け取られるまで順番待ちに出す（足す・外す・まとめて外す）', async () => {
    const { id } = app.create();
    await app.ready(id);
    const queue = () => {
      const last = [...app.events(id)].reverse().find((e) => e.type === 'queue');
      return last?.type === 'queue' ? last.prompts : [];
    };
    const op = (operation: string, content?: string) => ({ ...line.turnEnd(), type: 'queue-operation', subtype: undefined, operation, content });
    app.append(id, op('enqueue', 'あとで A'), op('enqueue', 'あとで B'));
    await app.waitFor('順番待ち', () => queue().length === 2);
    expect(queue()).toEqual(['あとで A', 'あとで B']);
    app.append(id, op('remove', 'あとで A'));
    await app.waitFor('外す', () => queue().length === 1);
    expect(queue()).toEqual(['あとで B']);
    app.append(id, op('enqueue', 'あとで C'), op('popAll'));
    await app.waitFor('まとめて外す', () => queue().length === 0);
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
    expect(parent.pty.killed).toBe(true);
    expect(app.manager.stateOf(parent.id)).toBe('archived');
    expect(app.manager.stateOf(child.id)).toBe('archived');

    const other = app.create();
    const otherChild = app.create({ mode: 'manual' }, other.id);
    await app.manager.remove(other.id);
    expect(app.manager.summary(other.id)).toBeUndefined();
    expect(app.manager.stateOf(otherChild.id)).not.toBe('archived');
  });

  it('unarchive と open: アーカイブから戻し、開くと同じ会話を --resume で再開する', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    app.append(id, line.user('はじめ'), line.text('はい'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    await app.manager.archive(id);
    app.manager.unarchive(id);
    expect(app.manager.summary(id)?.archived).toBe(false);
    await app.manager.open(id);
    expect(app.pty(id)).not.toBe(pty);
    expect(app.pty(id).arg('--resume')).toBe(pty.arg('--session-id'));
  });

  it('configure: モデルを変えたら、動いている claude をそのモデルで起動し直す', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    app.append(id, line.user('はじめ'), line.text('はい'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    app.manager.configure(id, { model: 'sonnet', effort: 'high', settingsFile: null });
    expect(pty.killed).toBe(true);
    expect(app.pty(id).arg('--model')).toBe('sonnet');
    expect(app.pty(id).arg('--effort')).toBe('high');
    expect(app.manager.summary(id)).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('importSession: 既存の会話を取り込み、その会話を --resume で再開する', async () => {
    const claudeId = '33333333-0000-4000-8000-000000000003';
    // 取り込む会話ログ（別のところで動かしていた Claude Code が書いたもの）
    const file = transcriptPath(app.cwd, claudeId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...line.user('前の会話'), sessionId: claudeId, cwd: app.cwd }) + '\n');
    const id = app.manager.importSession(claudeId, app.cwd, '前の会話');
    expect(app.pty(id).arg('--resume')).toBe(claudeId);
  });
});

describe('画面の知らせ', () => {
  it('許可の確認が出たら操作待ちを 1 回知らせ、状態を許可の確認にする', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.pty(id).output(fixtureScreen('bash-permission'));
    await app.waitFor('操作待ち', () => app.attentions.length > 0);
    expect(app.attentions).toMatchObject([{ id, attention: { kind: 'menu', menu: { kind: 'permission' } } }]);
    expect(app.manager.stateOf(id)).toBe('permission');
    expect(app.manager.summary(id)?.attention).toBe('permission');
  });

  it('入力欄もメニューも無い画面が続いたら、操作できない画面として知らせる', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.pty(id).output('\x1b[H\x1b[2J何かの画面');
    await app.waitFor('操作できない画面', () => app.attentions.length > 0, 3000);
    expect(app.attentions).toEqual([{ id, attention: { kind: 'unsupported' } }]);
    expect(app.manager.stateOf(id)).toBe('waiting');
  });
});
