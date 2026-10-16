import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INIT_RESPONSE, line, ScriptedApp } from './helpers/scripted-claude';

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

// 添える画像（中身は何でもよい。base64 にして送る）
function image(name: string): string {
  const file = join(app.root, name);
  writeFileSync(file, Buffer.from(name));
  return file;
}
const imageBlock = (name: string, mediaType = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(name).toString('base64') } });

describe('submit', () => {
  it('本文が無く画像だけなら、画像のブロックだけを送る。拡張子で種類を決める', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.manager.submit(id, '', [image('a.png'), image('b.JPG'), image('c.webp')]);
    expect(pipe.prompts.map((p) => p.message.content)).toEqual([[imageBlock('a.png'), imageBlock('b.JPG', 'image/jpeg'), imageBlock('c.webp', 'image/webp')]]);
  });

  it('同じセッションへの送信は、送った順に届ける（画像を読む間に、あとの発言が追い越さない）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await Promise.all([app.manager.submit(id, 'ひとつめ', [image('a.png')]), app.manager.submit(id, 'ふたつめ')]);
    expect(pipe.prompts.map((p) => p.message.content)).toEqual([[imageBlock('a.png'), { type: 'text', text: 'ひとつめ' }], 'ふたつめ']);
  });

  it('送る前に claude が終わったら、送らずに失敗する', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const sending = app.manager.submit(id, 'ひとつめ', [image('a.png')]);
    pipe.exit(0);
    await expect(sending).rejects.toThrow('Claude Code');
    expect(pipe.prompts).toEqual([]);
    await expect(app.manager.submit(id, 'ふたつめ')).resolves.toBeUndefined();
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
    const queue = () => {
      const last = [...app.events(id)].reverse().find((e) => e.type === 'queue');
      return last?.type === 'queue' ? last.prompts : [];
    };
    const uuid = await app.send(id, 'お願いします', [image('a.png')], ['長い文']);
    expect(queue()).toEqual([{ id: uuid, text: 'お願いします', pastes: ['長い文'], images: 1, state: 'sending' }]);
    expect(app.manager.stateOf(id)).toBe('working');
    app.append(id, { ...line.user('お願いします'), uuid });
    await app.waitFor('会話に出た', () => queue().length === 0);
    // スラッシュコマンドは発言として残らないものが多いので、送信中に出さない
    const before = app.events(id).filter((e) => e.type === 'queue').length;
    await app.manager.submit(id, '/compact');
    expect(app.events(id).filter((e) => e.type === 'queue')).toHaveLength(before);
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

describe('中断で入力欄に戻った文', () => {
  it('stream-json の中断では、発言は会話に残り、入力欄に戻らない（実測）。親からの指示・最適化圧縮の頼みを消すものは、何も送らない', async () => {
    const { id, pipe } = app.create({ mode: 'manual' }, null);
    await app.ready(id);
    const sent = pipe.sent.length;
    await app.manager.withdrawParentDraft(id);
    await app.manager.withdrawCompactDraft(id);
    expect(app.manager.compactDraftShown(id)).toBe(false);
    expect(pipe.sent).toHaveLength(sent);
  });
});
