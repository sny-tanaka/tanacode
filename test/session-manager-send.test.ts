import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bracketedPaste } from '@shared/prompt-keys';
import { parentMessageText } from '@shared/session-tools';
import { fixtureScreen, line, ScriptedApp, type ScriptedPty } from './helpers/scripted-claude';

// Claude Code の入力欄に打って送る（submit）・手が空くのを待ってから送る（submitWhenReady）・親からの指示を消す（SessionManager）

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

const PARENT = '11111111-0000-4000-8000-000000000001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 入力欄に draft が入っている画面
const promptWith = (draft: string) => `${fixtureScreen('prompt')}\x1b[37;3H${draft}`;

// Claude Code の入力欄の代わり。打った文字を入力欄に出し、Enter で空に戻す
function echo(pty: ScriptedPty): void {
  let draft = '';
  pty.onWrite = (data) => {
    if (data === '\r') draft = '';
    else draft += data.replace(/\x1b\[20[01]~/g, '');
    const shown = draft;
    setTimeout(() => pty.output(promptWith(shown)), 5);
  };
}

describe('submit', () => {
  it('本文が無く画像だけなら、画像のパスを貼り付けてから Enter を送る', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    await app.manager.submit(id, '', ['/tmp/a.png', '/tmp/b.png']);
    expect(pty.typed).toBe(`${bracketedPaste('/tmp/a.png')} ${bracketedPaste('/tmp/b.png')} \r`);
  });

  it('同じセッションへの送信は 1 つずつ順に打ち込み、混ざらない', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    echo(pty);
    await Promise.all([app.manager.submit(id, 'ひとつめ'), app.manager.submit(id, 'ふたつめ')]);
    expect(pty.typed).toBe('ひとつめ\rふたつめ\r');
  });

  it('claude が終わったら、順番待ちの送信は打たない', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    // 打った文字は入力欄に出ないので、1 つめは Enter を待っている
    const first = app.manager.submit(id, 'ひとつめ');
    const second = app.manager.submit(id, 'ふたつめ');
    await sleep(100);
    pty.exit(0);
    await first;
    await second;
    expect(pty.typed).toBe('ひとつめ');
  });

  it('改行を含む本文は貼り付けとして送り、入力欄に貼り付けの目印が出てから Enter を送る', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.onWrite = (data) => {
      if (data.startsWith('\x1b[200~')) setTimeout(() => pty.output(promptWith('[Pasted text #1 +1 lines]')), 5);
    };
    await app.manager.submit(id, '1 行目\n2 行目');
    expect(pty.typed).toBe(`${bracketedPaste('1 行目\n2 行目')}\r`);
  });

  it('guarded: 入力を受け付けられない状態（質問や確認が出ている）なら、打たずに失敗する', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.output(fixtureScreen('bash-permission'));
    await app.waitFor('許可の確認', () => app.manager.stateOf(id) === 'permission');
    await expect(app.manager.submit(id, '続けて', [], true)).rejects.toThrow('入力を受け付けられる状態ではなくなったため、送れませんでした');
    expect(pty.typed).toBe('');
    // 失敗しても、次の送信は打てる
    await app.manager.submit(id, '');
    expect(pty.typed).toBe('\r');
  });
});

describe('submitWhenReady', () => {
  it('作業中は手が空くのを待ち、その間は作業中として扱う。ターンが終わったら送る', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    echo(pty);
    app.append(id, line.user('はじめ'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    const sending = app.manager.submitWhenReady(id, 'つぎ', 10_000);
    await sleep(400);
    expect(pty.typed).toBe('');
    app.append(id, line.text('はい'), line.turnEnd());
    await sending;
    expect(pty.typed).toBe('つぎ\r');
    // 送ってから会話ログに発言が出るまでも、作業中として扱う
    expect(app.manager.stateOf(id)).toBe('working');
  });

  it('直前に送ったもの（まだ会話ログに出ていない）があれば、それが発言として出るまで待ってから送る', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    echo(pty);
    await app.manager.submit(id, 'ひとつめ');
    const next = app.manager.submitWhenReady(id, 'ふたつめ', 10_000);
    await sleep(400);
    expect(pty.typed).toBe('ひとつめ\r');
    app.append(id, line.user('ひとつめ'), line.text('はい'), line.turnEnd());
    await next;
    expect(pty.typed).toBe('ひとつめ\rふたつめ\r');
  });

  it('動いていないセッションには送れない', async () => {
    await expect(app.manager.submitWhenReady('nope', 'x', 1000)).rejects.toThrow('Claude Code が動いていません');
    const { id, pty } = app.create();
    pty.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await expect(app.manager.submitWhenReady(id, 'x', 1000)).rejects.toThrow('Claude Code が動いていません');
  });

  it('待っている間に claude が終わったら・取りやめたら、打たずに失敗する', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    app.append(id, line.user('はじめ'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    const controller = new AbortController();
    const cancelled = app.manager.submitWhenReady(id, 'あとで', 10_000, { signal: controller.signal });
    const exited = app.manager.submitWhenReady(id, 'つぎ', 10_000);
    controller.abort();
    await expect(cancelled).rejects.toThrow('送るのを取りやめました');
    pty.exit(0);
    await expect(exited).rejects.toThrow('Claude Code が終了しました');
    expect(pty.typed).toBe('');
  });

  it('待ちきれなかったら、そのときの画面に合わせた理由で失敗する（質問や確認・書きかけ・作業中）', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.output(fixtureScreen('bash-permission'));
    await app.waitFor('許可の確認', () => app.manager.stateOf(id) === 'permission');
    await expect(app.manager.submitWhenReady(id, 'x', 100)).rejects.toThrow('質問や確認の答えを待っているため、送れませんでした');
    pty.output(fixtureScreen('draft'));
    await app.waitFor('書きかけ', () => app.manager.screen(id)?.state.kind === 'prompt' && !!app.manager.screen(id)?.draft);
    await expect(app.manager.submitWhenReady(id, 'x', 100)).rejects.toThrow('ターミナルの入力欄に書きかけの文字があるため、送れませんでした');
    pty.output(fixtureScreen('prompt'));
    app.append(id, line.user('はじめ'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working' && app.manager.screen(id)?.draft === '');
    await expect(app.manager.submitWhenReady(id, 'x', 100)).rejects.toThrow('Claude Code の手が空かないため、送れませんでした');
    expect(pty.typed).toBe('');
    // 待つのをやめたら、作業中として数えていた分を戻す
    app.append(id, line.text('はい'), line.turnEnd());
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
  });

  it('打った直後に質問や確認が出たら、Enter を送らずに失敗する（Enter がメニューの選択にならないように）', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.onWrite = (data) => {
      if (data.includes('続けて')) setTimeout(() => pty.output(fixtureScreen('bash-permission')), 5);
    };
    await expect(app.manager.submitWhenReady(id, '続けて', 5000)).rejects.toThrow('質問や確認が出たため、送れませんでした');
    expect(pty.writes).toEqual(['続けて']);
  });

  it('画像も一緒に送る', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    echo(pty);
    await app.manager.submitWhenReady(id, 'これを見て', 5000, { attachments: ['/tmp/a.png'] });
    expect(pty.typed).toBe(`${bracketedPaste('/tmp/a.png')} これを見て\r`);
  });
});

describe('親からの指示', () => {
  it('中断で入力欄に戻った親からの指示は、チャットの入力欄に移さない。withdrawParentDraft で入力欄から消す', async () => {
    const { id, pty } = app.create({ mode: 'manual' }, PARENT);
    await app.ready(id);
    const text = parentMessageText(PARENT, '続けてください');
    // 入力欄に戻るのは、少しあと（消すほうは、出るまで待つ）
    const withdrawing = app.manager.withdrawParentDraft(id);
    await sleep(150);
    pty.output(promptWith(text));
    await withdrawing;
    // 入力欄の行数 + 1 回、行を消すキーを送る
    expect(pty.writes).toEqual(['\x15\x15']);
    expect(app.manager.screen(id)?.draft).toBe(text);
    expect(app.manager.screenForView(id)?.draft).toBe('');
    expect(app.screens.get(id)?.draft).toBe('');
  });

  it('止まっているセッションでは何もしない', async () => {
    const { id, pty } = app.create();
    pty.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.manager.withdrawParentDraft(id);
    expect(pty.writes).toEqual([]);
  });
});
