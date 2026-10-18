import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatBatch } from '@shared/ipc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { line, ScriptedApp, stream } from './helpers/scripted-claude';

// 書いている途中の応答（stream_event）を、チャットの最後に少しずつ出す（SessionManager）。途中の文は main が組み立て、チャットの配信
// （ChatBatch の partial）に載せる。そのブロックが会話ログに出たら、会話ログの応答と同じ配信で外す（画面で同じ場所のまま入れ替わる）。
// stream-json の行は pipe.emit の中で読み終わるが、途中の文はまとめて送る（PARTIAL_INTERVAL_MS）ので、届くのを待って確かめる

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 途中の文を載せた配信
const partials = (id: string): ChatBatch[] => app.batches.filter((b) => b.sessionId === id && b.partial);
// 最後に届いた途中の文
const lastPartial = (id: string) => partials(id).at(-1)?.partial;
// 会話ログの応答の行（message.id と、その応答の中のブロックの位置）
const reply = (messageId: string, index: number, text: string, kind: 'text' | 'thinking' = 'text') => {
  const entry = line.text(text);
  const content = kind === 'text' ? [{ type: 'text', text }] : [{ type: 'thinking', thinking: text, signature: 'sig' }];
  return { ...entry, apiBlockIndex: index, message: { ...entry.message, id: messageId, content } };
};

async function started(): Promise<{ id: string; pipe: ReturnType<ScriptedApp['pipe']> }> {
  app.manager.turnEndWaitMs = 60_000;
  const { id, pipe } = app.create();
  await app.ready(id);
  await app.prompt(id, 'パンについて書いて');
  return { id, pipe };
}

describe('書いている途中の文', () => {
  it('届いた分をまとめて送り、会話ログに出たら、その応答と同じ配信で外す', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.messageStart('msg_a'));
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, 'パンは'));
    pipe.emit(stream.delta(0, '小麦から\n作ります'));
    await app.waitFor('途中の文', () => !!lastPartial(id)?.length);
    // 続けて届いた行は、まとめて 1 回で送る
    expect(partials(id)).toHaveLength(1);
    expect(lastPartial(id)).toEqual([{ id: 'msg_a:0', kind: 'text', text: 'パンは小麦から\n作ります' }]);
    pipe.emit(stream.delta(0, '。'));
    await app.waitFor('続き', () => lastPartial(id)?.[0]?.text === 'パンは小麦から\n作ります。');

    const answer = reply('msg_a', 0, 'パンは小麦から\n作ります。');
    app.say(id, answer);
    pipe.emit(stream.blockStop(0));
    await app.waitFor('会話ログの応答', () => app.events(id).some((e) => e.type === 'assistant-text'));
    const swapped = app.batches.find((b) => b.events.some((e) => e.type === 'assistant-text'))!;
    expect(swapped.partial).toEqual([]);
    // 途中の文は、チャットのイベント（会話ログから作るもの）には入らない
    expect(app.events(id).filter((e) => e.type === 'assistant-text')).toHaveLength(1);
    expect(app.manager.snapshot(id).partial).toEqual([]);
  });

  it('思考と文は、ブロックごとに出し、ブロックごとに外す。空の思考（署名だけ）・ツールの入力は出さない', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.messageStart('msg_a'));
    pipe.emit(stream.blockStart('thinking', null, 0));
    pipe.emit(stream.delta(0, '', 'thinking'));
    pipe.emit(stream.blockStop(0));
    pipe.emit(stream.blockStart('thinking', null, 1));
    pipe.emit(stream.delta(1, '材料を考える', 'thinking'));
    pipe.emit(stream.blockStop(1));
    pipe.emit(stream.blockStart('text', null, 2));
    pipe.emit(stream.delta(2, '小麦粉と'));
    await app.waitFor('途中の文', () => lastPartial(id)?.length === 2);
    expect(lastPartial(id)).toEqual([
      { id: 'msg_a:1', kind: 'thinking', text: '材料を考える' },
      { id: 'msg_a:2', kind: 'text', text: '小麦粉と' },
    ]);
    // 空の思考は会話ログに出てもイベントにならないが、ブロックの位置は数える
    app.say(id, reply('msg_a', 0, '', 'thinking'), reply('msg_a', 1, '材料を考える', 'thinking'));
    await app.waitFor('思考が会話ログに出る', () => app.events(id).some((e) => e.type === 'thinking'));
    const swapped = app.batches.find((b) => b.events.some((e) => e.type === 'thinking'))!;
    expect(swapped.partial).toEqual([{ id: 'msg_a:2', kind: 'text', text: '小麦粉と' }]);
    pipe.emit(stream.blockStart('tool_use', null, 3));
    pipe.emit(stream.delta(2, '水'));
    await app.waitFor('続き', () => lastPartial(id)?.[0]?.text === '小麦粉と水');
    expect(lastPartial(id)).toHaveLength(1);
  });

  it('会話ログの行に apiBlockIndex が無ければ、同じ応答の行の数で、どのブロックかを決める', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.messageStart('msg_a'));
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, 'ひとつめ'));
    pipe.emit(stream.blockStart('text', null, 1));
    pipe.emit(stream.delta(1, 'ふたつめ'));
    await app.waitFor('途中の文', () => lastPartial(id)?.length === 2);
    const { apiBlockIndex: _, ...first } = reply('msg_a', 0, 'ひとつめ');
    app.say(id, first);
    await app.waitFor('ひとつめが会話ログに出る', () => app.events(id).some((e) => e.type === 'assistant-text'));
    expect(lastPartial(id)).toEqual([{ id: 'msg_a:1', kind: 'text', text: 'ふたつめ' }]);
    const { apiBlockIndex: __, ...second } = reply('msg_a', 1, 'ふたつめ');
    app.say(id, second);
    await app.waitFor('ふたつめが会話ログに出る', () => app.events(id).filter((e) => e.type === 'assistant-text').length === 2);
    expect(lastPartial(id)).toEqual([]);
  });

  it('会話ログの応答が、書いている途中の行より先に読めても、二重に出さない', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.messageStart('msg_a'));
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, 'パン'));
    await app.waitFor('途中の文', () => !!lastPartial(id)?.length);
    app.say(id, reply('msg_a', 0, 'パンです'));
    await app.waitFor('会話ログの応答', () => app.events(id).some((e) => e.type === 'assistant-text'));
    // 会話ログのあとに届いた、同じブロックの続きの行
    pipe.emit(stream.delta(0, 'です'));
    await sleep(150);
    expect(lastPartial(id)).toEqual([]);
  });

  it('応答の始まり（message_start）を見ていない応答は出さない（起動し直して引き継いだときの、頭の欠けた文）', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, '途中から'));
    await sleep(150);
    expect(partials(id)).toEqual([]);
    pipe.emit(stream.messageStart('msg_b'));
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, '次の応答'));
    await app.waitFor('次の応答', () => !!lastPartial(id)?.length);
    expect(lastPartial(id)).toEqual([{ id: 'msg_b:0', kind: 'text', text: '次の応答' }]);
  });

  it('サブエージェントの行（parent_tool_use_id 付き）は出さない', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.messageStart('msg_sub', 'toolu_agent'));
    pipe.emit(stream.blockStart('text', 'toolu_agent', 0));
    pipe.emit(stream.delta(0, 'サブエージェントの文', 'text', 'toolu_agent'));
    await sleep(150);
    expect(partials(id)).toEqual([]);
  });

  it('書き終わらないまま次の応答が始まった（再試行で捨てられた）文は外す。書き終わって会話ログを待っている文は残す', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.messageStart('msg_a'));
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, '書き終えた文'));
    pipe.emit(stream.blockStop(0));
    pipe.emit(stream.blockStart('text', null, 1));
    pipe.emit(stream.delta(1, '書きかけ'));
    pipe.emit(stream.messageStart('msg_b'));
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, 'やり直し'));
    await app.waitFor('途中の文', () => lastPartial(id)?.length === 2);
    expect(lastPartial(id)?.map((b) => b.id)).toEqual(['msg_a:0', 'msg_b:0']);
  });

  it('会話ログに出ないまま残った文は、ターンの終わりと同じ配信で消す', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.messageStart('msg_a'));
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, '残る文'));
    await app.waitFor('途中の文', () => !!lastPartial(id)?.length);
    app.finish(id);
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    const ended = app.batches.find((b) => b.events.some((e) => e.type === 'turn-end'))!;
    expect(ended.partial).toEqual([]);
    expect(app.manager.snapshot(id).partial).toEqual([]);
  });

  it('スナップショット（画面の読み込み直し）にも、今の途中の文を入れる', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.messageStart('msg_a'));
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, '読み込み直しても'));
    // まとめて送る前でも、スナップショットには今のものが入る
    expect(app.manager.snapshot(id).partial).toEqual([{ id: 'msg_a:0', kind: 'text', text: '読み込み直しても' }]);
  });

  it('claude が終わったら（起動し直すときも）、書きかけの文を消す', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.messageStart('msg_a'));
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, '書きかけ'));
    await app.waitFor('途中の文', () => !!lastPartial(id)?.length);
    const before = app.batches.length;
    await app.manager.restart(id);
    // 起動の知らせまでに、空の途中の文が届いている
    const start = app.batches.findIndex((b, i) => i >= before && b.events.some((e) => e.type === 'process-start'));
    expect(app.batches.slice(before, start + 1).some((b) => b.partial?.length === 0)).toBe(true);
    expect(app.manager.snapshot(id).partial).toEqual([]);
  });
});

describe('断られた応答の取り直し（system/model_refusal_fallback）', () => {
  it('取り消された応答の書いている途中の文は、取り直しの知らせで外す（取り直した応答を書き終えるのを待たない）', async () => {
    const { id, pipe } = await started();
    pipe.emit(stream.messageStart('msg_r'));
    pipe.emit(stream.blockStart('text', null, 0));
    pipe.emit(stream.delta(0, '断られる文'));
    pipe.emit(stream.blockStop(0));
    const refused = reply('msg_r', 0, '断られる文');
    pipe.emit(stream.assistant(refused));
    await app.waitFor('途中の文', () => lastPartial(id)?.[0]?.text === '断られる文');
    pipe.emit({ type: 'system', subtype: 'model_refusal_fallback', retracted_message_uuids: [refused.uuid], original_model: 'claude-opus-5-5', fallback_model: 'claude-opus-4-8', uuid: 'f1' });
    await app.waitFor('外れる', () => lastPartial(id)?.length === 0);
    // お知らせは会話ログの行から出すので、stream の行では出さない
    expect(app.events(id).some((e) => e.type === 'info')).toBe(false);
  });

  it('本物の Claude Code 2.1.302 の行（test/fixtures/claude-code-events/2.1.302/refusal-fallback）を流すと、取り消された書きかけが外れ、チャットには取り直しの知らせと答えが出る', async () => {
    app.manager.turnEndWaitMs = 60_000;
    const { id, pipe } = app.create();
    await app.ready(id);
    const dir = join(__dirname, 'fixtures', 'claude-code-events', '2.1.302', 'refusal-fallback');
    const lines = (file: string) =>
      readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    // 起動の行（init・initialize の返事）は、録ったときの会話と設定のものなので流さない
    const streamed = lines('stream.jsonl').filter((v) => v.type !== 'control_response' && !(v.type === 'system' && v.subtype === 'init'));
    const fallback = streamed.findIndex((v) => v.subtype === 'model_refusal_fallback');
    const refusedIds = new Set(streamed.slice(0, fallback).flatMap((v) => (v.type === 'assistant' ? [(v.message as { id: string }).id] : [])));
    expect([...refusedIds]).toEqual(['msg_1', 'msg_2']);
    for (const line of streamed.slice(0, fallback)) pipe.emit(line);
    await app.waitFor('2 回目の書きかけ', () => !!lastPartial(id)?.some((p) => p.id === 'msg_2:0'));
    pipe.emit(streamed[fallback]);
    // 取り消された 2 回目の応答（msg_2）は外れ、会話ログを待っている 1 回目の応答（msg_1。同じモデルで取り直すので残る）は残る
    await app.waitFor('取り消された書きかけが外れる', () => !lastPartial(id)?.some((p) => p.id === 'msg_2:0'));
    expect(lastPartial(id)?.map((p) => p.id)).toEqual(['msg_1:0']);

    app.append(id, ...lines('transcript.jsonl'));
    for (const line of streamed.slice(fallback + 1)) pipe.emit(line);
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    const shown = app.events(id).flatMap((e) => (e.type === 'assistant-text' || e.type === 'info' ? [`${e.type}:${e.text}`] : []));
    expect(shown).toEqual([
      'assistant-text:書きかけの文です。これは取り消されるはず',
      "info:Opus 5.5's safeguards stopped the response above · continuing once with that noted",
      'info:Opus 5.5 が応答を断ったので、Opus 4.8 で取り直しました',
      'assistant-text:答えです。',
    ]);
    expect(app.manager.snapshot(id).partial).toEqual([]);
  });
});
