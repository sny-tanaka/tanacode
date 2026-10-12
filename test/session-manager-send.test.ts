import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bracketedPaste, promptKeyChunks, promptKeys } from '@shared/prompt-keys';
import { handoffText } from '@shared/optimized-compact';
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

  it('改行を含む本文は、行ごとの貼り付けとして送り、入力欄に文字が出てから Enter を送る', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.onWrite = (data) => {
      if (data.startsWith('\x1b[200~')) setTimeout(() => pty.output(promptWith('1 行目\n  2 行目')), 5);
    };
    await app.manager.submit(id, '1 行目\n2 行目');
    expect(pty.typed).toBe(`${bracketedPaste('1 行目')}\n${bracketedPaste('2 行目')}\r`);
  });

  it('/ で始まる複数行の本文は、丸ごと貼り付けとして送り、入力欄に貼り付けの目印が出てから Enter を送る', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.onWrite = (data) => {
      if (data.startsWith('\x1b[200~')) setTimeout(() => pty.output(promptWith('[Pasted text #1 +1 lines]')), 5);
    };
    await app.manager.submit(id, '/api の話です\n2 行目');
    expect(pty.typed).toBe(`${bracketedPaste('/api の話です\n2 行目')}\r`);
  });

  it('札（貼り付けた長い文）は、打った文のあとに、1 つずつ丸ごと貼り付けとして打つ。目印が入力欄に出てから次を打ち、最後に Enter を送る', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    const log = 'ログの 1 行目\n2 行目\n3 行目\n4 行目';
    const long = 'a'.repeat(900);
    // Claude Code の入力欄の代わり。丸ごとの貼り付けは目印になり、ほかはそのまま入る
    let draft = '';
    let marks = 0;
    const order: string[] = [];
    pty.onWrite = (data) => {
      order.push(`${data === '\r' ? 'Enter' : data.includes(log) ? '札 1' : data.includes(long) ? '札 2' : '文'} / 入力欄: ${app.manager.screen(id)?.draft ?? ''}`);
      if (data === '\r') return;
      draft += data.includes(log) || data.includes(long) ? `[Pasted text #${++marks}${data.includes(log) ? ' +3 lines' : ''}]` : data.replace(/\x1b\[20[01]~/g, '');
      const shown = draft;
      setTimeout(() => pty.output(promptWith(shown)), 30);
    };
    await app.manager.submit(id, 'このログを見てください。', [], false, [log, long]);
    // 打った文は今までどおり（1 行なら打鍵。promptKeys）、札は丸ごと 1 つの貼り付け
    expect(pty.typed).toBe(`このログを見てください。${bracketedPaste(log)}${bracketedPaste(long)}\r`);
    // 前に打ったものが入力欄に出てから、次を打っている
    expect(order).toEqual([
      '文 / 入力欄: ',
      '札 1 / 入力欄: このログを見てください。',
      '札 2 / 入力欄: このログを見てください。[Pasted text #1 +3 lines]',
      'Enter / 入力欄: このログを見てください。[Pasted text #1 +3 lines][Pasted text #2]',
    ]);
    // 打ち込んでいる途中の文字と目印は、チャットの入力欄に移さない
    expect(app.manager.screenForView(id)?.draft).toBe('');
  });

  it('長い文は、小さな分に分けて書き、前の分が入力欄に出てから次を書く（貼り付けの合図が、読む区切りで割れないように）', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    const text = Array.from({ length: 70 }, (_, i) => `${i + 1} 行目: 入力欄が高くなる発言です。`).join('\n');
    const chunks = promptKeyChunks(text);
    expect(chunks.length).toBeGreaterThan(3);
    // Claude Code の入力欄の代わり。打った文字の終わりのほうを、少し遅れて出す
    let typed = '';
    const seen: string[] = [];
    pty.onWrite = (data) => {
      // 書いた時点で、前の分までが入力欄に出ているか
      seen.push((app.manager.screen(id)?.draft ?? '').replace(/\s/g, '').slice(-12));
      if (data === '\r') return;
      typed += data.replace(/\x1b\[20[01]~/g, '');
      const shown = typed.replace(/\n/g, ' ').slice(-60);
      setTimeout(() => pty.output(promptWith(shown)), 40);
    };
    await app.manager.submit(id, text);
    expect(pty.writes).toEqual([...chunks.map((c) => c.keys), '\r']);
    const tails = chunks.map((c) => c.shown.replace(/\s/g, '').slice(-12));
    expect(seen).toEqual(['', ...tails]);
  });

  it('長い文を打っている途中に、確認のメニューが出たら、残りは書かず、Enter も送らない（guarded）', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    const text = Array.from({ length: 70 }, (_, i) => `${i + 1} 行目: 入力欄が高くなる発言です。`).join('\n');
    const chunks = promptKeyChunks(text);
    expect(chunks.length).toBeGreaterThan(3);
    // 2 つめの分を書いたところで、許可の確認が出る（裏のタスクの知らせで始まったターンが、許可を求めた）
    let typed = '';
    pty.onWrite = (data) => {
      typed += data.replace(/\x1b\[20[01]~/g, '');
      const shown = typed.replace(/\n/g, ' ').slice(-60);
      setTimeout(() => pty.output(pty.writes.length >= 2 ? fixtureScreen('bash-permission') : promptWith(shown)), 20);
    };
    await expect(app.manager.submit(id, text, [], true)).rejects.toThrow('質問や確認が出たため、送れませんでした');
    expect(pty.writes).toEqual(chunks.slice(0, 2).map((c) => c.keys));
  });

  it('打っている途中は、入力欄の文字を画面に知らせない（長い文が目印に置き換わって出ていても。チャットの入力欄に移すと、打っている途中の文字が消される）', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    const text = Array.from({ length: 70 }, (_, i) => `${i + 1} 行目: 入力欄が高くなる発言です。`).join('\n');
    // Claude Code は、長い入力の途中を目印に置き換えて出す（打った文字と比べても合わない）
    const shown = '1 行目: 入力欄が高くなる[...Truncated text #1 +21 lines...]る発言です。';
    pty.onWrite = (data) => {
      if (data !== '\r') setTimeout(() => pty.output(promptWith(shown)), 20);
    };
    const sending = app.manager.submit(id, text);
    await app.waitFor('入力欄', () => app.manager.screen(id)?.draft === shown);
    expect(app.manager.screenForView(id)?.draft).toBe('');
    expect(app.screens.get(id)?.draft).toBe('');
    await sending;
    expect(pty.typed).toBe(`${promptKeys(text)}\r`);
  });

  it('入力欄の文字を読めないとき（打った分が出ないまま時間切れ）は、残りを待たずに書いて、Enter を送る', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    const text = Array.from({ length: 70 }, (_, i) => `${i + 1} 行目: 入力欄が高くなる発言です。`).join('\n');
    const started = Date.now();
    await app.manager.submit(id, text);
    expect(pty.typed).toBe(`${promptKeys(text)}\r`);
    // 待つのは 1 回だけ（分ごとに時間切れを待たない）
    expect(Date.now() - started).toBeLessThan(4500);
  });

  it('打った文が無く、札だけでも送る。札の中の制御文字は除き、空の札は打たない', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.onWrite = (data) => {
      if (data.startsWith('\x1b[200~')) setTimeout(() => pty.output(promptWith('[Pasted text #1 +3 lines]')), 5);
    };
    await app.manager.submit(id, '', [], false, ['1\n2\x1b[201~\r\n3\n4', ' \n ']);
    expect(pty.typed).toBe(`${bracketedPaste('1\n2[201~\n3\n4')}\r`);
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

  it('待っている送信がいくつもあるときは、待ち始めた順に 1 つずつ送る（あとから送ったものが、先に届かない）', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    echo(pty);
    app.append(id, line.user('はじめ'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    // 手が空くのを見る間隔（200 ミリ秒）の中で、2 つめが先に見る順になるよう、ずらして待ち始める
    // （1 つめは 200・400 ミリ秒…、2 つめは 150 ミリ秒遅れて 350・550 ミリ秒… に見る）
    const first = app.manager.submitWhenReady(id, 'ひとつめ', 10_000);
    await sleep(150);
    const second = app.manager.submitWhenReady(id, 'ふたつめ', 10_000);
    // 1 つめが見た直後（200 ミリ秒）に、手が空く。次に見るのは 2 つめ（350 ミリ秒）
    await sleep(70);
    app.append(id, line.text('はい'), line.turnEnd());
    await app.waitFor('はじめの送信', () => pty.typed.endsWith('\r'));
    expect(pty.typed).toBe('ひとつめ\r');
    await first;
    // 1 つめのターンが終わってから、2 つめを送る
    await sleep(400);
    expect(pty.typed).toBe('ひとつめ\r');
    app.append(id, line.user('ひとつめ'), line.text('はい'), line.turnEnd());
    await second;
    expect(pty.typed).toBe('ひとつめ\rふたつめ\r');
  });

  it('先に待ち始めた送信が、待つのをやめたら（取りやめ・時間切れ）、次の送信が送られる', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    echo(pty);
    app.append(id, line.user('はじめ'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    const controller = new AbortController();
    const cancelled = app.manager.submitWhenReady(id, 'やめる', 10_000, { signal: controller.signal });
    const timedOut = app.manager.submitWhenReady(id, '間に合わない', 300);
    const last = app.manager.submitWhenReady(id, 'のこり', 10_000);
    controller.abort();
    await expect(cancelled).rejects.toThrow('送るのを取りやめました');
    await expect(timedOut).rejects.toThrow('Claude Code の手が空かないため、送れませんでした');
    app.append(id, line.text('はい'), line.turnEnd());
    await last;
    expect(pty.typed).toBe('のこり\r');
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

  it('札（貼り付けた長い文）も一緒に送る（予約したメッセージ）', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.onWrite = (data) => {
      if (data !== '\r') setTimeout(() => pty.output(promptWith(data.startsWith('\x1b[200~') ? 'これを見て[Pasted text #1 +3 lines]' : 'これを見て')), 5);
    };
    await app.manager.submitWhenReady(id, 'これを見て', 5000, { pastes: ['1\n2\n3\n4'] });
    expect(pty.typed).toBe(`これを見て${bracketedPaste('1\n2\n3\n4')}\r`);
  });
});

describe('中断で入力欄に戻った発言の札', () => {
  it('札（貼り付けた長い文）を添えた発言が、応答の前の Esc で入力欄に戻ったら、発言を取り消し、目印の中身（札）を画面への知らせに添える', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    const log = 'ログの 1 行目\n2 行目\n3 行目\n4 行目';
    // Claude Code が会話ログに残す形（文のあとに、貼り付けの囲み）
    app.append(id, line.user(`このログを見てください。\n\n<pasted_content id="c8a6">\n${log}\n</pasted_content id="c8a6">\n`));
    await app.waitFor('発言', () => app.events(id).some((e) => e.type === 'user' && e.pastes?.length === 1));
    const draft = 'このログを見てください。[Pasted text #2 +3 lines]';
    pty.output(promptWith(draft));
    await app.waitFor('取り消し', () => app.events(id).some((e) => e.type === 'replace'));
    // 入力欄に戻ったのを知らせる最初の知らせから、札の中身が付いている（チャットの入力欄は、最初に見た draft を移す）
    expect(app.screenUpdates(id).find((s) => s.draft === draft)?.draftPastes).toEqual([log]);
    expect(app.manager.screenForView(id)).toMatchObject({ draft, draftPastes: [log] });
    expect(app.manager.stateOf(id)).toBe('idle');
    // 人が続きを打ったら（入力欄が変わったら）、札の中身は添えない
    pty.output(promptWith(`${draft} 続き`));
    await app.waitFor('続き', () => app.screens.get(id)?.draft.endsWith('続き') === true);
    expect(app.screens.get(id)?.draftPastes).toBeUndefined();
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

describe('最適化圧縮の仕上げの頼み', () => {
  // 仕上げの頼みを打ち込んだあと、応答の前に中断されて、本文の途中の一部が入力欄に戻った（長い文は入力欄に収まらない）
  const PART = handoffText().split('\n').slice(2, 4).join('\n');
  async function pulledBack() {
    const { id, pty } = app.create();
    await app.ready(id);
    // Claude Code の入力欄の代わり。長い文は入力欄に収まらないので、打った文字の終わりのほうだけを出す。Enter で空に戻す
    let typed = '';
    pty.onWrite = (data) => {
      typed = data === '\r' ? '' : typed + data.replace(/\x1b\[20[01]~/g, '');
      const shown = typed.replace(/\n/g, ' ').slice(-60);
      setTimeout(() => pty.output(shown ? promptWith(shown) : fixtureScreen('prompt')), 5);
    };
    await app.manager.submit(id, handoffText());
    pty.writes.length = 0;
    return { id, pty };
  }

  it('打ってから時間がたっていても、入力欄に戻った本文の一部を、チャットの入力欄に移さない。withdrawCompactDraft で、空になるまで消す', async () => {
    const { id, pty } = await pulledBack();
    // 画面から読むと、折り返しで行が変わる
    pty.output(promptWith(PART.replace(/ /g, (m, i: number) => (i % 60 === 59 ? '\n' : m))));
    await app.waitFor('入力欄', () => !!app.manager.screen(id)?.draft);
    expect(app.manager.compactDraftShown(id)).toBe(true);
    expect(app.manager.screenForView(id)?.draft).toBe('');
    expect(app.screens.get(id)?.draft).toBe('');
    // 1 回消すと、隠れていた続きが出てくる。もう 1 回消すと空になる
    let cleared = 0;
    pty.onWrite = (data) => {
      if (!data.startsWith('\x15')) return;
      cleared += 1;
      setTimeout(() => pty.output(cleared === 1 ? promptWith(handoffText().split('\n')[5].slice(0, 100)) : fixtureScreen('prompt')), 5);
    };
    await app.manager.withdrawCompactDraft(id);
    expect(cleared).toBe(2);
    expect(app.manager.screen(id)?.draft).toBe('');
    expect(app.manager.compactDraftShown(id)).toBe(false);
  });

  it('貼り付けの目印だけ・囲みの頭から戻ったときも、同じく隠して消す', async () => {
    const { id, pty } = await pulledBack();
    pty.output(promptWith('[Pasted text #1 +7 lines]'));
    await app.waitFor('入力欄', () => !!app.manager.screen(id)?.draft);
    expect(app.manager.screenForView(id)?.draft).toBe('');
    pty.output(fixtureScreen('prompt'));
    await app.waitFor('空の入力欄', () => app.manager.screen(id)?.draft === '');
    pty.output(promptWith(`${handoffText().split('\n')[0]} tanacode is about to reset`));
    await app.waitFor('入力欄', () => app.manager.screen(id)?.draft.startsWith('<tanacode-handoff>') === true);
    expect(app.manager.screenForView(id)?.draft).toBe('');
    pty.onWrite = (data) => {
      if (data.startsWith('\x15')) setTimeout(() => pty.output(fixtureScreen('prompt')), 5);
    };
    await app.manager.withdrawCompactDraft(id);
    expect(pty.writes).toHaveLength(1);
  });

  it('人の書きかけ（打ち込んだ文に無い文字・短い文字）は、隠さず、消さない', async () => {
    const { id, pty } = await pulledBack();
    for (const draft of ['書きかけの発言', 'the']) {
      pty.output(fixtureScreen('prompt'));
      await app.waitFor('空の入力欄', () => app.manager.screen(id)?.draft === '');
      pty.output(promptWith(draft));
      await app.waitFor('入力欄', () => app.manager.screen(id)?.draft === draft);
      expect(app.manager.compactDraftShown(id)).toBe(false);
    }
    // 打った直後の 5 秒は、打ち込んだ文に含まれる文字を画面に知らせない（送ったばかりの文字を、入力欄に移さないため）。それより長くは隠さない
    expect(app.manager.screenForView(id)?.draft).toBe('');
    await app.manager.withdrawCompactDraft(id);
    expect(pty.writes).toEqual([]);
  });

  it('応答が始まったあとは、同じ文字が入力欄にあっても人の書きかけとして扱う（消さない）', async () => {
    const { id, pty } = await pulledBack();
    app.append(id, line.text('書きました'));
    pty.output(promptWith(PART.slice(0, 80)));
    await app.waitFor('入力欄', () => !!app.manager.screen(id)?.draft);
    await app.waitFor('応答', () => !app.manager.compactDraftShown(id));
    await app.manager.withdrawCompactDraft(id);
    expect(pty.writes).toEqual([]);
  });
});
