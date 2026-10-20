import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptTail } from '../src/main/transcript-tail';
import { removeLine } from './helpers/tombstone';

// 会話ログを開けない（stat のあとに消された）ときを作るため、open だけを差し替えられるようにする
const openFails = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) =>
      openFails.on ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) : actual.open(...args),
  };
});

// 会話ログの末尾読み（TranscriptTail）。親（parentUuid）の行より先に書かれた行を、親の後ろに並べ直す

type Row = { uuid: string; parentUuid: string | null; type: string; text?: string };
const row = (uuid: string, parentUuid: string | null, type = 'assistant', text?: string): Row => ({ uuid, parentUuid, type, ...(text ? { text } : {}) });
const line = (r: Row) => `${JSON.stringify(r)}\n`;

let dir: string;
let file: string;
let tail: TranscriptTail | null = null;
let read: { uuid: string; isHistory: boolean }[];
// 会話ログから消えたと知らされた行（知らせごと）
let removed: string[][];

// onMissingParent: 親の行がまだ届いていない行を読んだときに、その親がもう来ないかを答える（省くと、いつも待つ）
function start(onMissingParent?: (parent: string) => boolean): void {
  tail = new TranscriptTail(
    file,
    (entry, isHistory) => read.push({ uuid: (entry as Row).uuid, isHistory }),
    undefined,
    (uuids) => removed.push(uuids),
    onMissingParent,
  );
  tail.start();
}
const uuids = () => read.map((r) => r.uuid);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-tail-'));
  file = join(dir, 'session.jsonl');
  read = [];
  removed = [];
});

afterEach(() => {
  openFails.on = false;
  tail?.stop();
  tail = null;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('TranscriptTail', () => {
  // 失敗を投げたままにすると、どこでも受け取られないエラーになる（void this.poll() で呼ぶため）
  it('stat のあとに会話ログを開けなくても、エラーにせず、次の機会に読み直す', async () => {
    openFails.on = true;
    start();
    appendFileSync(file, line(row('u1', null, 'user')));
    await new Promise((r) => setTimeout(r, 400));
    expect(uuids()).toEqual([]);
    openFails.on = false;
    await vi.waitFor(() => expect(uuids()).toEqual(['u1']));
  });

  it('同じ読み込みの中なら、親の行を先に出す', async () => {
    start();
    appendFileSync(file, line(row('a1', 'u1')) + line(row('u1', null, 'user')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1']));
  });

  // 新しい会話ログで、最初の応答の行（親は発言に続く最後の attachment の行）が発言の行より先に書かれ、
  // 別々の読み込みに分かれたとき。応答を先に出すと、あとから来た発言（親が null）を巻き戻しと取り違える
  it('親の行があとの読み込みで届いても、親を先に出し、子孫の行はその後ろに並べる', async () => {
    start();
    appendFileSync(file, line(row('a1', 'att2')) + line(row('a2', 'a1')));
    // 親が届くまでは出さない
    await new Promise((r) => setTimeout(r, 400));
    expect(uuids()).toEqual([]);
    appendFileSync(file, line(row('u1', null, 'user')) + line(row('att1', 'u1', 'attachment')) + line(row('att2', 'att1', 'attachment')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'att1', 'att2', 'a1', 'a2']));
  });

  it('親の行が来ないままなら、しばらく待ってから書かれた順に出す', async () => {
    start();
    appendFileSync(file, line(row('a1', 'missing')) + line(row('a2', 'a1')));
    await vi.waitFor(() => expect(uuids()).toEqual(['a1', 'a2']), { timeout: 3000 });
  });

  // 取り消された応答の行が、書かれたあと、読む前に消された（その行を親にする取り直しの行だけが届く）。
  // 直す前: 来ない親を 1 秒待ってから出したので、取り直した応答とターンの終わりが遅れ、その間、取り消された応答の書きかけの文が残った
  it('親がもう来ないと分かれば（onMissingParent が true）、待たずに出す。その親を待っていた行は先に、書かれた順に出す', async () => {
    const asked: string[] = [];
    let gone = false;
    start((parent) => (asked.push(parent), gone));
    // まだ分からないうちは待つ
    appendFileSync(file, line(row('a1', 'removed')));
    await vi.waitFor(() => expect(asked).toEqual(['removed']));
    expect(uuids()).toEqual([]);
    gone = true;
    appendFileSync(file, line(row('a2', 'removed')) + line(row('a3', 'a2')));
    // HOLD_MS（1 秒）より早く出る
    await vi.waitFor(() => expect(uuids()).toEqual(['a1', 'a2', 'a3']), { timeout: 600 });
    // 来ないと分かった親は、もう聞かない
    appendFileSync(file, line(row('a4', 'removed')));
    await vi.waitFor(() => expect(uuids()).toEqual(['a1', 'a2', 'a3', 'a4']), { timeout: 600 });
    expect(asked).toEqual(['removed', 'removed']);
  });

  it('親がもう来ないと分からなければ（onMissingParent が false）、これまでどおり待つ', async () => {
    const asked: string[] = [];
    start((parent) => (asked.push(parent), false));
    appendFileSync(file, line(row('a1', 'later')));
    await new Promise((r) => setTimeout(r, 400));
    expect(asked).toEqual(['later']);
    expect(uuids()).toEqual([]);
    appendFileSync(file, line(row('later', null, 'user')));
    await vi.waitFor(() => expect(uuids()).toEqual(['later', 'a1']));
  });

  it('親を待っている行と関係のない行は、待たずに出す', async () => {
    start();
    appendFileSync(file, line(row('s1', null, 'system')));
    await vi.waitFor(() => expect(uuids()).toEqual(['s1']));
    appendFileSync(file, line(row('a1', 'u1')) + line(row('s2', 's1', 'system')));
    await vi.waitFor(() => expect(uuids()).toEqual(['s1', 's2']));
    appendFileSync(file, line(row('u1', 's2', 'user')));
    await vi.waitFor(() => expect(uuids()).toEqual(['s1', 's2', 'u1', 'a1']));
  });

  // 再開したセッションの過去ログは、読み始めた時点で全部そろっているので待たない
  it('追跡を始めた時点で既にあった行は、親が無くても待たずに出す', async () => {
    writeFileSync(file, line(row('a1', 'old')) + line(row('a2', 'a1')));
    start();
    await vi.waitFor(() =>
      expect(read).toEqual([
        { uuid: 'a1', isHistory: true },
        { uuid: 'a2', isHistory: true },
      ]),
    );
    // 過去ログの行を親にする新しい行も、待たない
    appendFileSync(file, line(row('u1', 'a2', 'user')));
    await vi.waitFor(() => expect(uuids()).toEqual(['a1', 'a2', 'u1']));
  });
});

// Claude Code は、取り消した応答（tombstone）の行を、書いたあとで消す（removeLine を参照）。消したあとすぐ次の行を書き足すので、
// 大きさは前に読んだところより大きいまま。前の位置から読むと、消えた行の長さの分だけ、書き足された行の頭を読み落とす（#240）
describe('TranscriptTail: 書いたあとで消された行', () => {
  const malformed = row('a1', 'u1', 'assistant', '形の壊れた応答です。これは取り消されるはず');

  it('消された行を知らせ、消したあとに書き足された行を読み落とさない', async () => {
    start();
    appendFileSync(file, line(row('u1', null, 'user')) + line(malformed) + line(row('att1', 'a1', 'attachment')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1', 'att1']));
    // 消して、読まれる前に、消した行より長い行を書き足す
    removeLine(file, 'a1');
    appendFileSync(file, line(row('r1', 'u1', 'user', 'The previous response failed to produce a valid tool call.')) + line(row('a2', 'r1', 'assistant', '形を直して届いた返事')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1', 'att1', 'r1', 'a2']));
    expect(removed).toEqual([['a1']]);
  });

  // 書き直しの途中（切り詰めたところ）と見分けがつかないので、変わらないまましばらく（1 秒）たってから
  it('消されて短くなっただけ（あとに書き足されない）でも、しばらくして変わらなければ知らせる', async () => {
    start();
    appendFileSync(file, line(row('u1', null, 'user')) + line(malformed));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1']));
    removeLine(file, 'a1');
    await vi.waitFor(() => expect(removed).toEqual([['a1']]), { timeout: 3000 });
    // そのあとに書き足された行も読む
    appendFileSync(file, line(row('a2', 'u1')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1', 'a2']));
    expect(removed).toEqual([['a1']]);
  });

  it('書きかけを読んだ行が、書き終えてから消されても、その行は出さず、あとの行を読み落とさない', async () => {
    start();
    appendFileSync(file, line(row('u1', null, 'user')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1']));
    const text = line(malformed);
    appendFileSync(file, text.slice(0, 20));
    await new Promise((r) => setTimeout(r, 400));
    appendFileSync(file, text.slice(20));
    removeLine(file, 'a1');
    appendFileSync(file, line(row('a2', 'u1', 'assistant', '形を直して届いた返事')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a2']));
    expect(removed).toEqual([]);
  });

  it('親を待っている（まだ出していない）行が消されたら、出さずに捨て、知らせない', async () => {
    start();
    appendFileSync(file, line(row('u1', null, 'user')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1']));
    appendFileSync(file, line(row('a1', 'missing', 'assistant', '親の届かない応答')));
    await new Promise((r) => setTimeout(r, 400));
    removeLine(file, 'a1');
    appendFileSync(file, line(row('a2', 'u1', 'assistant', '形を直して届いた返事です')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a2']));
    // 親を待つ長さ（1 秒）を過ぎても出ない
    await new Promise((r) => setTimeout(r, 1200));
    expect(uuids()).toEqual(['u1', 'a2']);
    expect(removed).toEqual([]);
  });

  it('消された行を親にする行は、来ない親を待たずに出す', async () => {
    start();
    appendFileSync(file, line(row('u1', null, 'user')) + line(malformed));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1']));
    removeLine(file, 'a1');
    appendFileSync(file, line(row('att1', 'a1', 'attachment', '消えた応答を親にしたままの行')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1', 'att1']), { timeout: 500 });
  });

  // Claude Code は、消す行の頭で切り詰めてから、後ろの行を書き戻す（removeLine）。変更の通知は切り詰めた時点で届くので、その間を読むことがある
  it('切り詰めてから書き戻すまでの間を読んでも、書き戻された行は消えたことにせず、出し直さない', async () => {
    start();
    const before = line(row('u1', null, 'user'));
    const rest = line(row('att1', 'a1', 'attachment')) + line(row('att2', 'att1', 'attachment'));
    appendFileSync(file, before + line(malformed) + rest);
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1', 'att1', 'att2']));
    truncateSync(file, Buffer.byteLength(before));
    await new Promise((r) => setTimeout(r, 400));
    appendFileSync(file, rest + line(row('r1', 'att2', 'user', 'The previous response failed to produce a valid tool call.')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1', 'att1', 'att2', 'r1']));
    await new Promise((r) => setTimeout(r, 1200));
    expect(removed).toEqual([['a1']]);
    expect(uuids()).toEqual(['u1', 'a1', 'att1', 'att2', 'r1']);
  });

  // 消す行が末尾の近くに無ければ、全体を書き直す（空にしてから書く）
  it('全体を書き直す途中（空にしたところ）を読んでも、残った行は消えたことにせず、出し直さない', async () => {
    start();
    const u1 = line(row('u1', null, 'user'));
    const att1 = line(row('att1', 'a1', 'attachment'));
    appendFileSync(file, u1 + line(malformed) + att1);
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1', 'att1']));
    writeFileSync(file, '');
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(file, u1 + att1);
    await vi.waitFor(() => expect(removed).toEqual([['a1']]));
    await new Promise((r) => setTimeout(r, 1200));
    expect(removed).toEqual([['a1']]);
    expect(uuids()).toEqual(['u1', 'a1', 'att1']);
  });

  it('書き直しで、前の方の行がまとめて消えても、残った行は出し直さない', async () => {
    start();
    appendFileSync(file, line(row('u1', null, 'user')) + line(row('a1', 'u1')) + line(row('u2', 'a1', 'user')) + line(row('a2', 'u2')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1', 'u2', 'a2']));
    // 前の 2 行を消して書き直し（別のファイルに書いて置き換える）、新しい行を書き足す
    writeFileSync(`${file}.tmp`, line(row('u2', 'a1', 'user')) + line(row('a2', 'u2')) + line(row('u3', 'a2', 'user')));
    renameSync(`${file}.tmp`, file);
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1', 'u2', 'a2', 'u3']));
    expect(removed).toEqual([['u1', 'a1']]);
  });

  it('過去ログの行が消されても知らせる', async () => {
    writeFileSync(file, line(row('u1', null, 'user')) + line(malformed));
    start();
    await vi.waitFor(() => expect(read).toEqual([{ uuid: 'u1', isHistory: true }, { uuid: 'a1', isHistory: true }]));
    removeLine(file, 'a1');
    appendFileSync(file, line(row('a2', 'u1', 'assistant', '形を直して届いた返事です。長めに書きます')));
    await vi.waitFor(() => expect(read.at(-1)).toEqual({ uuid: 'a2', isHistory: false }));
    expect(removed).toEqual([['a1']]);
  });
});
