import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wakeupText } from '@shared/scheduled';
import { parentMessageText, sessionEventText } from '@shared/session-tools';
import { INIT_RESPONSE, line, ScriptedApp, stream } from './helpers/scripted-claude';

// 発言を送る（submit）・起動が終わるのを待ってから送る（submitWhenReady）（SessionManager）。
// stream-json では、発言は user の行 1 つ（打ち込み・入力欄の読み取りは無い）

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => {
  vi.restoreAllMocks();
  app.dispose();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 添える画像。形式は中身の頭で決まるので、拡張子に合う頭を付ける（残りは何でもよい。base64 にして送る）
const HEADS: Record<string, Buffer> = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  gif: Buffer.from('GIF89a'),
  webp: Buffer.from('RIFF\0\0\0\0WEBPVP8 '),
};
const imageData = (name: string, kind = name.split('.').pop()!.toLowerCase()) => Buffer.concat([HEADS[kind] ?? Buffer.alloc(0), Buffer.from(name)]);
function image(name: string, kind?: string): string {
  const file = join(app.root, name);
  writeFileSync(file, imageData(name, kind));
  return file;
}
const imageBlock = (name: string, mediaType = 'image/png', kind?: string) => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data: imageData(name, kind).toString('base64') },
});
const infos = (id: string) => app.events(id).flatMap((e) => (e.type === 'info' ? [e.text] : []));
// 送ったが、まだ会話に出ていない発言（最後の queue のイベント）
const queue = (id: string) => {
  const last = [...app.events(id)].reverse().find((e) => e.type === 'queue');
  return last?.type === 'queue' ? last.prompts : [];
};

describe('submit', () => {
  it('本文が無く画像だけなら、画像のブロックだけを送る。種類は拡張子でなく中身の頭で決める', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.manager.submit(id, '', [image('a.png'), image('b.JPG'), image('c.webp'), image('d.gif'), image('pasted', 'png')]);
    expect(pipe.prompts.map((p) => p.message.content)).toEqual([
      [imageBlock('a.png'), imageBlock('b.JPG', 'image/jpeg'), imageBlock('c.webp', 'image/webp'), imageBlock('d.gif', 'image/gif'), imageBlock('pasted', 'image/png', 'png')],
    ]);
    expect(infos(id)).toEqual([]);
  });

  it('送れない画像（Claude に送れない形式・読めないファイル）は添えずに送り、黙らずにチャットで知らせる。画像しか無ければ何も送らない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    // HEIC は拡張子が画像でも送れない。名前だけ .png の、中身が違うファイルも送れない
    await app.manager.submit(id, 'これを見て', [image('a.png'), image('photo.heic'), image('fake.png', 'txt'), join(app.root, 'missing.png')]);
    expect(pipe.prompts.map((p) => p.message.content)).toEqual([[imageBlock('a.png'), { type: 'text', text: 'これを見て' }]]);
    expect(infos(id)).toEqual(['送れない画像があったため、添えずに送りました: photo.heic, fake.png, missing.png（送れるのは PNG・JPEG・GIF・WebP の、読めるファイルだけです）']);
    await app.manager.submit(id, '', [image('b.bmp', 'bmp')]);
    expect(pipe.prompts).toHaveLength(1);
    expect(infos(id)).toHaveLength(2);
    expect(queue(id)).toHaveLength(1);
  });

  it('同じセッションへの送信は、送った順に届ける（画像を読む間に、あとの発言が追い越さない）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await Promise.all([app.manager.submit(id, 'ひとつめ', [image('a.png')]), app.manager.submit(id, 'ふたつめ')]);
    expect(pipe.prompts.map((p) => p.message.content)).toEqual([[imageBlock('a.png'), { type: 'text', text: 'ひとつめ' }], 'ふたつめ']);
  });

  it('画像を読んでいる間に再起動が始まったら、止めている最中の claude に書かず、起動し直した claude が受け付けてから送る', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.exitOnEnd = false;
    const sent = app.manager.submit(id, '画像つき', [image('a.png')]);
    // 送り始めた（画像を読んでいる）ところで、再起動を始める
    await Promise.resolve();
    await Promise.resolve();
    const restarting = app.manager.restart(id);
    await app.waitFor('end_session', () => pipe.requests('end_session').length === 1);
    // 画像を読み終えても、止めている最中の claude には書かない（直す前は、ここで書いていた）
    await app.waitFor('止めている claude への送信', () => pipe.prompts.length > 0, 300).catch(() => {});
    expect(pipe.prompts).toEqual([]);
    pipe.exit(0);
    await restarting;
    const next = app.pipe(id);
    await app.ready(id);
    await sent;
    expect(next.prompts).toHaveLength(1);
    expect(JSON.stringify(next.prompts[0].message.content)).toContain('画像つき');
  });

  it('画像を読んでいる間にターミナルモードへの切り替えが始まったら、止めている最中の claude に書かず、送れなかったことを返す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.exitOnEnd = false;
    const sent = app.manager.submit(id, '画像つき', [image('a.png')]);
    const failed = expect(sent).rejects.toThrow('ターミナルモード');
    // 送り始めた（画像を読んでいる）ところで、切り替えを始める（手が空いているので受け付けられる）
    await Promise.resolve();
    await Promise.resolve();
    const switching = app.manager.setTerminalMode(id, true);
    await app.waitFor('end_session', () => pipe.requests('end_session').length === 1);
    // 画像を読み終えても、止めている最中の claude には書かない（直す前は、ここで書いて、発言が黙って消えていた）
    await app.waitFor('止めている claude への送信', () => pipe.prompts.length > 0, 300).catch(() => {});
    expect(pipe.prompts).toEqual([]);
    pipe.exit(0);
    await switching;
    await failed;
  });

  it('送る前に claude が終わったら、送らずに失敗する', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const sending = app.manager.submit(id, 'ひとつめ', [image('a.png')]);
    pipe.exit(0);
    await expect(sending).rejects.toThrow('Claude Code');
    expect(pipe.prompts).toEqual([]);
    // 終わったあとの送信も、黙って成功にしない（画面は預かりに戻す）
    await expect(app.manager.submit(id, 'ふたつめ')).rejects.toThrow('Claude Code が動いていません');
    expect(pipe.prompts).toEqual([]);
  });

  it('打った文が無く、札だけでも送る。札の中の制御文字は除き、空の札は送らない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.manager.submit(id, '', [], ['1\n2\x1b[201~\r\n3\n4', ' \n ']);
    expect(pipe.prompts).toMatchObject([{ message: { content: '' }, pasted_content: ['1\n2[201~\n3\n4'] }]);
    // 札が無ければ、pasted_content を付けない
    await app.manager.submit(id, 'ふつう');
    expect(pipe.prompts[1]).not.toHaveProperty('pasted_content');
  });

  it('作業中に送った発言は、priority を付けずに送る（Claude Code が今のターンに取り込む）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('考えています'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    await app.manager.submit(id, 'ついでにこれも');
    expect(pipe.prompts[0]).not.toHaveProperty('priority');
  });

  it('送ってから会話に出るまでは送信中としてチャットに知らせ、作業中にする。会話ログに同じ uuid の発言が出たら外す', async () => {
    const { id } = app.create();
    await app.ready(id);
    const uuid = await app.send(id, 'お願いします', [image('a.png')], ['長い文']);
    expect(queue(id)).toEqual([{ id: uuid, text: 'お願いします', pastes: ['長い文'], images: 1, state: 'sending' }]);
    expect(app.manager.stateOf(id)).toBe('working');
    app.append(id, { ...line.user('お願いします'), uuid });
    await app.waitFor('会話に出た', () => queue(id).length === 0);
    // スラッシュコマンドは発言として残らないものが多いので、送信中に出さない
    const before = app.events(id).filter((e) => e.type === 'queue').length;
    await app.manager.submit(id, '/compact');
    expect(app.events(id).filter((e) => e.type === 'queue')).toHaveLength(before);
  });

  it('会話に出た発言は、発言を出してから送信中から外す（先に外すと、一瞬どちらにも出ない）', async () => {
    const { id } = app.create();
    await app.ready(id);
    const uuid = await app.send(id, 'お願いします');
    app.append(id, { ...line.user('お願いします'), uuid });
    await app.waitFor('会話に出た', () => queue(id).length === 0);
    const kinds = app.events(id).flatMap((e) => (e.type === 'user' ? ['user'] : e.type === 'queue' ? [`queue:${e.prompts.length}`] : []));
    expect(kinds.slice(-2)).toEqual(['user', 'queue:0']);
  });

  it('親からの指示は、会話に出たときと同じく、囲みを外した本文と親の ID で送信中・順番待ちに出す', async () => {
    const parent = app.create();
    const { id, pipe } = app.create({ mode: 'manual' }, parent.id);
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('考えています'));
    await app.manager.submitWhenReady(id, parentMessageText(parent.id, 'テストも直して'), 1000);
    const uuid = pipe.prompts[0].uuid;
    pipe.emit(stream.lifecycle(uuid, 'queued'));
    await app.waitFor('順番待ち', () => queue(id)[0]?.state === 'queued');
    expect(queue(id)).toEqual([{ id: uuid, text: 'テストも直して', pastes: [], images: 0, state: 'queued', parent: parent.id }]);
  });

  it('人が書いた予約の送信（時刻になると、手が空くのを待たずに priority: later で渡す）は、作業中なら順番待ちに出す。Claude の予約は出さない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('考えています'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    // 予約（ScheduledMessages）は、人が書いたものはそのまま、Claude のものは囲みに入れて、submitWhenReady で渡す
    await app.manager.submitWhenReady(id, '予約していた発言', 1000);
    await app.manager.submitWhenReady(id, wakeupText('Claude の予約'), 1000);
    const [human] = pipe.prompts;
    pipe.emit(stream.lifecycle(human.uuid, 'queued'));
    await app.waitFor('順番待ち', () => queue(id)[0]?.state === 'queued');
    expect(queue(id)).toEqual([{ id: human.uuid, text: '予約していた発言', pastes: [], images: 0, state: 'queued' }]);
  });

  it('子セッションの知らせなど、発言でないものは送信中・順番待ちに出さない。会話に出るまでは作業中に数える', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.manager.submitWhenReady(id, sessionEventText(['abcdef12'], '子セッションの作業が終わりました'), 1000);
    expect(queue(id)).toEqual([]);
    expect(app.manager.stateOf(id)).toBe('working');
    const uuid = pipe.prompts[0].uuid;
    app.append(id, { ...line.user(sessionEventText(['abcdef12'], '子セッションの作業が終わりました')), uuid, origin: undefined });
    await app.waitFor('会話に出た', () => app.manager.stateOf(id) === 'idle');
    expect(app.events(id).some((e) => e.type === 'notice')).toBe(true);
  });
});

describe('再起動と、送ったがまだ会話に出ていない発言', () => {
  // Claude Code は end_session で終わるとき、順番待ちの発言を discarded、取り込んで動いていた発言を cancelled と知らせて捨てる
  // （2.1.303 で実測）。本物と同じく、end_session を受けたらこれを出す
  const discardOnEnd = (pipe: ReturnType<typeof app.pipe>, queued: string[], running: string[] = []) => {
    pipe.onSend = (sent) => {
      if ((JSON.parse(sent) as { request?: { subtype?: string } }).request?.subtype !== 'end_session') return;
      for (const uuid of running) pipe.emit(stream.lifecycle(uuid, 'cancelled'));
      for (const uuid of queued) pipe.emit(stream.lifecycle(uuid, 'discarded'));
    };
  };
  // 作業中にして、親の指示（priority: later）と、画像と札を添えた予約の発言を順番待ちにする
  const queueTwo = async () => {
    const parent = app.create();
    const { id, pipe } = app.create({ mode: 'manual' }, parent.id);
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('考えています'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    await app.manager.submitWhenReady(id, parentMessageText(parent.id, 'テストも直して'), 1000);
    await app.manager.submitWhenReady(id, '予約していた発言', 1000, { attachments: [image('a.png')], pastes: ['1\n2\n3\n4'] });
    const sent = pipe.prompts;
    for (const prompt of sent) pipe.emit(stream.lifecycle(prompt.uuid, 'queued'));
    await app.waitFor('順番待ち', () => queue(id).filter((p) => p.state === 'queued').length === 2);
    return { id, pipe, parent: parent.id, sent };
  };

  it('順番待ちの発言は、再起動で Claude Code が捨てても、起動し直した claude に同じ uuid・中身・priority で送り直す', async () => {
    const { id, pipe, parent, sent } = await queueTwo();
    discardOnEnd(pipe, sent.map((p) => p.uuid));
    await app.manager.restart(id);
    const next = app.pipe(id);
    expect(next).not.toBe(pipe);
    // 起動し直している間も、順番待ちに出したまま（直す前は、ここで消えて、二度と送られなかった）
    expect(queue(id).map((p) => p.text)).toEqual(['テストも直して', '予約していた発言']);
    await app.ready(id);
    await app.waitFor('送り直し', () => next.prompts.length === 2);
    expect(next.prompts).toEqual(sent);
    expect(next.prompts[0]).toMatchObject({ message: { content: parentMessageText(parent, 'テストも直して') }, priority: 'later' });
    expect(next.prompts[1]).toMatchObject({ message: { content: [imageBlock('a.png'), { type: 'text', text: '予約していた発言' }] }, pasted_content: ['1\n2\n3\n4'] });
    // 送り直したものも、会話に出たら順番待ちから外れる
    for (const prompt of next.prompts) app.append(id, { ...line.user('x'), uuid: prompt.uuid });
    await app.waitFor('会話に出た', () => queue(id).length === 0);
  });

  it('再起動の前にターンに取り込まれた発言（started）と、読み直した会話ログに出ていた発言は、送り直さない', async () => {
    const { id, pipe, sent } = await queueTwo();
    const [first, second] = sent;
    // ひとつめはターンに取り込まれ、会話ログに書かれた（アプリはまだ読んでいない）。ふたつめは順番待ちのまま捨てられた
    pipe.emit(stream.lifecycle(first.uuid, 'started'));
    discardOnEnd(pipe, [second.uuid], [first.uuid]);
    await app.manager.restart(id);
    const next = app.pipe(id);
    await app.ready(id);
    await app.waitFor('送り直し', () => next.prompts.length === 1);
    await sleep(200);
    expect(next.prompts.map((p) => p.uuid)).toEqual([second.uuid]);
  });

  it('順番待ちのまま捨てられた発言でも、起動し直した claude が読み直した会話ログに出ていれば、送り直さない', async () => {
    const { id, pipe, sent } = await queueTwo();
    const [first, second] = sent;
    discardOnEnd(pipe, [first.uuid, second.uuid]);
    // 止める直前に、ひとつめが会話ログに書かれた（止めた claude の会話ログの読み取りは、その行を読む前に終わる）
    const discard = pipe.onSend!;
    pipe.onSend = (line_) => {
      if (line_.includes('"end_session"')) app.append(id, { ...line.user('テストも直して'), uuid: first.uuid });
      discard(line_);
    };
    await app.manager.restart(id);
    const next = app.pipe(id);
    await app.ready(id);
    await app.waitFor('送り直し', () => next.prompts.length === 1);
    await sleep(200);
    expect(next.prompts.map((p) => p.uuid)).toEqual([second.uuid]);
  });

  it('再起動の途中に送った発言は、送り直す発言のあとに送る', async () => {
    const { id, pipe, sent } = await queueTwo();
    discardOnEnd(pipe, sent.map((p) => p.uuid));
    pipe.exitOnEnd = false;
    const restarting = app.manager.restart(id);
    await app.waitFor('end_session', () => pipe.requests('end_session').length === 1);
    const later = app.manager.submit(id, '再起動の途中に送った発言');
    pipe.exit(0);
    await restarting;
    const next = app.pipe(id);
    await app.ready(id);
    await later;
    await app.waitFor('送り直し', () => next.prompts.length === 3);
    expect(next.prompts.map((p) => p.uuid).slice(0, 2)).toEqual(sent.map((p) => p.uuid));
    expect(next.prompts[2].message.content).toBe('再起動の途中に送った発言');
  });

  it('起動し直せなかったら、送り直す発言を順番待ちから外す（動いていない claude の順番待ちを残さない）', async () => {
    const { id, pipe, sent } = await queueTwo();
    discardOnEnd(pipe, sent.map((p) => p.uuid));
    // 止めている間に、起動し直せなくする（会話ログのフォルダを読めないなど）
    vi.spyOn(app.manager as unknown as { start: () => void }, 'start').mockImplementation(() => {
      throw new Error('起動できません');
    });
    await expect(app.manager.restart(id)).rejects.toThrow('起動できません');
    expect(queue(id)).toEqual([]);
    expect(app.manager.stateOf(id)).toBe('exited');
  });
});

describe('submitWhenReady', () => {
  it('起動が終わるのを待ち（その間は起動中のまま）、終わったら、ターンが終わってから届く発言（priority: later）として送る', async () => {
    app.answers.set('initialize', null);
    const { id, pipe } = app.create();
    const sending = app.manager.submitWhenReady(id, 'つぎ', 10_000);
    await sleep(300);
    expect(pipe.prompts).toEqual([]);
    expect(app.manager.stateOf(id)).toBe('starting');
    pipe.respond(pipe.requests('initialize')[0].request_id, { ...INIT_RESPONSE, current_permission_mode: 'auto' });
    await sending;
    expect(pipe.prompts).toMatchObject([{ message: { content: 'つぎ' }, priority: 'later' }]);
  });

  it('作業中でも待たずに送る（Claude Code が順番待ちにして、今のターンには入れない。実測）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('考えています'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    await app.manager.submitWhenReady(id, '親からの指示', 1000);
    expect(pipe.prompts).toMatchObject([{ message: { content: '親からの指示' }, priority: 'later' }]);
  });

  it('待っている送信がいくつもあるときは、待ち始めた順に送る', async () => {
    app.answers.set('initialize', null);
    const { id, pipe } = app.create();
    const first = app.manager.submitWhenReady(id, 'ひとつめ', 10_000, { attachments: [image('a.png')] });
    await sleep(150);
    const second = app.manager.submitWhenReady(id, 'ふたつめ', 10_000);
    pipe.respond(pipe.requests('initialize')[0].request_id, INIT_RESPONSE);
    await Promise.all([first, second]);
    expect(pipe.prompts.map((p) => p.message.content)).toEqual([[imageBlock('a.png'), { type: 'text', text: 'ひとつめ' }], 'ふたつめ']);
  });

  it('取りやめ・時間切れは、送らずに失敗する。待つのをやめたら、作業中として数えていた分を戻す', async () => {
    app.answers.set('initialize', null);
    const { id, pipe } = app.create();
    const controller = new AbortController();
    const cancelled = app.manager.submitWhenReady(id, 'やめる', 10_000, { signal: controller.signal });
    const timedOut = app.manager.submitWhenReady(id, '間に合わない', 300);
    const last = app.manager.submitWhenReady(id, 'のこり', 10_000);
    controller.abort();
    await expect(cancelled).rejects.toThrow('送るのを取りやめました');
    await expect(timedOut).rejects.toThrow('Claude Code の手が空かないため、送れませんでした');
    pipe.respond(pipe.requests('initialize')[0].request_id, INIT_RESPONSE);
    await last;
    expect(pipe.prompts.map((p) => p.message.content)).toEqual(['のこり']);
    app.append(id, { ...line.user('のこり'), uuid: pipe.prompts[0].uuid });
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
  });

  it('動いていないセッションには送れない', async () => {
    await expect(app.manager.submitWhenReady('nope', 'x', 1000)).rejects.toThrow('Claude Code が動いていません');
    const { id, pipe } = app.create();
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await expect(app.manager.submitWhenReady(id, 'x', 1000)).rejects.toThrow('Claude Code が動いていません');
  });

  it('待っている間に claude が終わったら、送らずに失敗する', async () => {
    app.answers.set('initialize', null);
    const { id, pipe } = app.create();
    const sending = app.manager.submitWhenReady(id, 'つぎ', 10_000);
    await sleep(150);
    pipe.exit(0);
    await expect(sending).rejects.toThrow('Claude Code が終了しました');
    expect(pipe.prompts).toEqual([]);
  });

  it('画像と札（貼り付けた長い文）も一緒に送る（予約したメッセージ）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.manager.submitWhenReady(id, 'これを見て', 5000, { attachments: [image('a.png')], pastes: ['1\n2\n3\n4'] });
    expect(pipe.prompts).toMatchObject([{ message: { content: [imageBlock('a.png'), { type: 'text', text: 'これを見て' }] }, pasted_content: ['1\n2\n3\n4'], priority: 'later' }]);
  });
});
