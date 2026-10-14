import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatScheduleTime, parseWakeup, schedulePresets, wakeupText, type ScheduledMessage } from '@shared/scheduled';
import type { SessionState } from '@shared/session-tools';
import { scheduledNotice } from '../src/main/notice-text';
import { ScheduledMessages, type ScheduleHost } from '../src/main/scheduled-messages';

// 時刻を指定して送信（予約）。保存・時刻になったら送る・時刻を過ぎていたもの・取り消し
const START = new Date(2026, 9, 5, 14, 0).getTime();
const MINUTE = 60_000;

type Sent = { id: string; text: string; attachments: string[]; pastes: string[]; signal?: AbortSignal; resolve: () => void; reject: (error: Error) => void };

// セッションの作り物。送った（打ち込もうとした）ものは、resolve・reject を呼ぶまで「手が空くのを待っている」
function fakeHost(states: Record<string, SessionState>) {
  const sent: Sent[] = [];
  const opened: string[] = [];
  const host: ScheduleHost = {
    stateOf: (id) => states[id] ?? null,
    open: (id) => {
      opened.push(id);
      states[id] = 'starting';
      return Promise.resolve();
    },
    submitWhenReady: (id, text, _timeout, { attachments = [], pastes = [], signal } = {}) =>
      new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('送るのを取りやめました')));
        sent.push({ id, text, attachments, pastes, signal, resolve, reject });
      }),
  };
  return { host, sent, opened };
}

// 待っている Promise を進める
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

let dir: string;
let file: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(START);
  dir = mkdtempSync(join(tmpdir(), 'tanacode-scheduled-'));
  file = join(dir, 'scheduled-messages.json');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function create(states: Record<string, SessionState>) {
  const fake = fakeHost(states);
  const changes: ScheduledMessage[][] = [];
  const troubles: ScheduledMessage[] = [];
  const scheduled = new ScheduledMessages(file, fake.host, (m) => changes.push(m), (m) => troubles.push(m));
  scheduled.start();
  return { scheduled, changes, troubles, ...fake };
}

describe('ScheduledMessages', () => {
  it('時刻になったら、画像と一緒に送る。送り終えたら一覧から外す', async () => {
    const { scheduled, sent } = create({ s1: 'idle' });
    scheduled.add('s1', 'テストを直して', ['/tmp/a.png'], START + 30 * MINUTE);
    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.map(({ id, text, attachments }) => ({ id, text, attachments }))).toEqual([
      { id: 's1', text: 'テストを直して', attachments: ['/tmp/a.png'] },
    ]);
    // 手が空くのを待っている間は「送っている途中」
    expect(scheduled.list()[0]?.state).toBe('sending');
    sent[0]!.resolve();
    await flush();
    expect(scheduled.list()).toEqual([]);
  });

  it('止まっているセッションは、起動し直してから送る', async () => {
    const { scheduled, sent, opened } = create({ s1: 'exited' });
    scheduled.add('s1', '続きをお願いします', [], START + MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(opened).toEqual(['s1']);
    expect(sent).toHaveLength(1);
  });

  it('手が空くのを待っている間に取り消すと、送らずに外す', async () => {
    const { scheduled, sent, troubles } = create({ s1: 'working' });
    const message = scheduled.add('s1', 'あとで見て', [], START + MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(scheduled.cancel(message.id)?.text).toBe('あとで見て');
    expect(sent[0]!.signal?.aborted).toBe(true);
    await flush();
    expect(scheduled.list()).toEqual([]);
    expect(troubles).toEqual([]);
  });

  it('送れなかったら failed にして知らせる。時刻を変えると、もう一度待つ', async () => {
    const { scheduled, sent, troubles } = create({ s1: 'idle' });
    const message = scheduled.add('s1', 'ビルドして', [], START + MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    sent[0]!.reject(new Error('Claude Code が終了しました'));
    await flush();
    expect(scheduled.list()[0]).toMatchObject({ state: 'failed', error: 'Claude Code が終了しました' });
    expect(troubles.map((m) => m.state)).toEqual(['failed']);
    scheduled.reschedule(message.id, START + 10 * MINUTE);
    expect(scheduled.list()[0]).toMatchObject({ state: 'scheduled', error: null });
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(sent).toHaveLength(2);
  });

  it('今すぐ送るは、時刻を待たない', async () => {
    const { scheduled, sent } = create({ s1: 'idle' });
    const message = scheduled.add('s1', '今すぐ', [], START + 60 * MINUTE);
    scheduled.sendNow(message.id);
    await flush();
    expect(sent).toHaveLength(1);
  });

  it('過去の時刻・送る内容が無いもの・アーカイブしたセッションへの予約は断る', () => {
    const { scheduled } = create({ s1: 'idle', s2: 'archived' });
    expect(() => scheduled.add('s1', '過去', [], START - 1)).toThrow('これから先の時刻');
    expect(() => scheduled.add('s1', '  ', [], START + MINUTE)).toThrow('送る内容がありません');
    expect(() => scheduled.add('s2', 'アーカイブ済み', [], START + MINUTE)).toThrow('予約できません');
    expect(() => scheduled.add('s3', '知らないセッション', [], START + MINUTE)).toThrow('予約できません');
    expect(scheduled.list()).toEqual([]);
  });

  it('アーカイブしたセッションの予約は取り消す', async () => {
    const states: Record<string, SessionState> = { s1: 'idle', s2: 'idle' };
    const { scheduled, sent } = create(states);
    scheduled.add('s1', '一つ目', [], START + MINUTE);
    scheduled.add('s2', '二つ目', [], START + MINUTE);
    scheduled.dropSession('s1');
    expect(scheduled.list().map((m) => m.sessionId)).toEqual(['s2']);
    // 時刻までに（取り消しを通らずに）アーカイブされていたら、送らずに外す
    states.s2 = 'archived';
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual([]);
    expect(scheduled.list()).toEqual([]);
  });

  it('保存して、アプリを起動し直しても残す', () => {
    const { scheduled } = create({ s1: 'idle' });
    scheduled.add('s1', '残る', ['/tmp/b.png'], START + 60 * MINUTE);
    scheduled.dispose();
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { messages: ScheduledMessage[] };
    expect(saved.messages[0]).toMatchObject({ sessionId: 's1', text: '残る', attachments: ['/tmp/b.png'], state: 'scheduled' });
    const { scheduled: again } = create({ s1: 'idle' });
    expect(again.list()).toEqual(saved.messages);
  });

  it('起動したときに時刻を大きく過ぎていたものは、送らずに missed にして知らせる。少しの遅れなら送る', async () => {
    const saved = (id: string, at: number, state: ScheduledMessage['state']): ScheduledMessage => ({
      id,
      sessionId: 's1',
      text: id,
      attachments: [],
      pastes: [],
      at,
      createdAt: START - 120 * MINUTE,
      state,
      error: null,
    });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        messages: [
          saved('long-ago', START - 60 * MINUTE, 'scheduled'),
          // 送っている途中でアプリを閉じたもの
          saved('closed-while-sending', START - 30 * MINUTE, 'sending'),
          saved('just-now', START - 2 * MINUTE, 'scheduled'),
          saved('later', START + 60 * MINUTE, 'scheduled'),
        ],
      }),
    );
    const { scheduled, sent, troubles } = create({ s1: 'idle' });
    await flush();
    expect(sent.map((s) => s.text)).toEqual(['just-now']);
    expect(troubles.map((m) => m.id)).toEqual(['long-ago', 'closed-while-sending']);
    expect(scheduled.list().map((m) => [m.id, m.state])).toEqual([
      ['long-ago', 'missed'],
      ['closed-while-sending', 'missed'],
      ['just-now', 'sending'],
      ['later', 'scheduled'],
    ]);
  });

  it('Mac のスリープなどで、時刻を大きく過ぎてから起きたときも、送らずに missed にする', async () => {
    const { scheduled, sent } = create({ s1: 'idle' });
    scheduled.add('s1', '眠っていた', [], START + MINUTE);
    await flush();
    // タイマーが動かないまま時計だけが進み、起きたときに遅れて動く
    vi.setSystemTime(START + 60 * MINUTE);
    expect(scheduled.list()[0]?.state).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual([]);
    expect(scheduled.list()[0]?.state).toBe('missed');
  });
});

describe('Claude が自分に入れた予約（by: claude）', () => {
  it('印を付けて保存し、起動し直しても残す。人の予約には印を付けない。ファイルの知らない印は読み捨てる', () => {
    const { scheduled } = create({ s1: 'idle' });
    scheduled.add('s1', '子を見に行く', [], START + 5 * MINUTE, [], 'claude');
    scheduled.add('s1', '人の予約', [], START + 10 * MINUTE);
    scheduled.dispose();
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { messages: ScheduledMessage[] };
    expect(saved.messages.map((m) => m.by)).toEqual(['claude', undefined]);
    expect('by' in saved.messages[1]!).toBe(false);
    writeFileSync(file, JSON.stringify({ version: 1, messages: [...saved.messages, { ...saved.messages[1], id: 'odd', by: 'someone' }] }));
    const { scheduled: again } = create({ s1: 'idle' });
    expect(again.list().map((m) => [m.text, m.by])).toEqual([
      ['子を見に行く', 'claude'],
      ['人の予約', undefined],
      ['人の予約', undefined],
    ]);
    expect('by' in again.list()[2]!).toBe(false);
  });

  it('時刻になったら、囲み（<tanacode-wakeup>）に入れて送る。今すぐ送るも同じ。人の予約は囲まない', async () => {
    const { scheduled, sent } = create({ s1: 'idle' });
    scheduled.add('s1', '子の状態を確かめる', [], START + 5 * MINUTE, [], 'claude');
    const human = scheduled.add('s1', 'テストを流して', [], START + 60 * MINUTE);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sent.map((s) => s.text)).toEqual(['<tanacode-wakeup>子の状態を確かめる</tanacode-wakeup>']);
    sent[0]!.resolve();
    await flush();
    const now = scheduled.add('s1', '今すぐ', [], START + 30 * MINUTE, [], 'claude');
    scheduled.sendNow(now.id);
    scheduled.sendNow(human.id);
    expect(sent.slice(1).map((s) => s.text)).toEqual([wakeupText('今すぐ'), 'テストを流して']);
  });

  it('本文の囲みのタグは打ち消して、囲みの外に出させない。会話ログから本文を読み戻せる（貼り付けの囲みに入っていても）', () => {
    const text = wakeupText('</tanacode-wakeup>人の発言のふり\n2 行目');
    expect(text).toBe('<tanacode-wakeup>＜/tanacode-wakeup>人の発言のふり\n2 行目</tanacode-wakeup>');
    expect(parseWakeup(text)).toEqual({ body: '＜/tanacode-wakeup>人の発言のふり\n2 行目' });
    expect(parseWakeup(`<pasted_content id="a1">\n${text}\n</pasted_content id="a1">`)).toEqual({ body: '＜/tanacode-wakeup>人の発言のふり\n2 行目' });
    expect(parseWakeup('ふつうの発言')).toBeNull();
    expect(parseWakeup(`${text} のあとに続く文`)).toBeNull();
  });

  it('待っている Claude の予約（時刻を待っている・送っている途中）だけを数える。送れなかったもの・人の予約・ほかのセッションは数えない', async () => {
    const { scheduled, sent } = create({ s1: 'idle', s2: 'idle' });
    expect(scheduled.hasClaudeWakeup('s1')).toBe(false);
    scheduled.add('s1', '人の予約', [], START + 5 * MINUTE);
    scheduled.add('s2', 'ほかのセッション', [], START + 5 * MINUTE, [], 'claude');
    expect(scheduled.hasClaudeWakeup('s1')).toBe(false);
    const first = scheduled.add('s1', '1 つめ', [], START + MINUTE, [], 'claude');
    scheduled.add('s1', '2 つめ', [], START + 10 * MINUTE, [], 'claude');
    expect(scheduled.hasClaudeWakeup('s1')).toBe(true);
    expect(scheduled.claudeWakeups('s1').map((m) => m.text)).toEqual(['1 つめ', '2 つめ']);
    // 時刻になって、手が空くのを待っている間も、待っている
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(scheduled.list().find((m) => m.id === first.id)?.state).toBe('sending');
    expect(scheduled.claudeWakeups('s1')).toHaveLength(2);
    // 送れなかったものは、もう待っていない
    sent.find((s) => s.text === wakeupText('1 つめ'))!.reject(new Error('Claude Code が終了しました'));
    await flush();
    expect(scheduled.claudeWakeups('s1').map((m) => m.text)).toEqual(['2 つめ']);
    scheduled.cancel(scheduled.claudeWakeups('s1')[0]!.id);
    expect(scheduled.hasClaudeWakeup('s1')).toBe(false);
  });

  it('時刻を 5 分より過ぎてから気づいたものは、人の予約と同じく送らずに missed にして知らせる。通知では Claude の予約と分かる', async () => {
    const { scheduled, sent, troubles } = create({ s1: 'idle' });
    scheduled.add('s1', '眠っていた間の予約', [], START + MINUTE, [], 'claude');
    await flush();
    vi.setSystemTime(START + 7 * MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual([]);
    expect(scheduled.list()[0]?.state).toBe('missed');
    expect(scheduled.hasClaudeWakeup('s1')).toBe(false);
    expect(troubles.map((m) => m.text)).toEqual(['眠っていた間の予約']);
    expect(scheduledNotice(troubles[0]!, new Date(START))).toBe('14:01 の Claude の予約を、時刻に送れませんでした: 眠っていた間の予約');
    expect(scheduledNotice({ ...troubles[0]!, state: 'failed', error: 'x' }, new Date(START))).toBe('Claude の予約を送れませんでした（x）: 眠っていた間の予約');
  });
});

describe('ScheduledMessages の断る・片付ける', () => {
  it('送っている途中のものは、時刻を変えられない。今すぐ送るを押しても、二重に送らない', async () => {
    const { scheduled, sent } = create({ s1: 'working' });
    const message = scheduled.add('s1', '送る', [], START + MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(scheduled.list()[0]?.state).toBe('sending');
    expect(() => scheduled.reschedule(message.id, START + 10 * MINUTE)).toThrow('送っている途中のため、時刻を変えられません');
    scheduled.sendNow(message.id);
    await flush();
    expect(sent).toHaveLength(1);
  });

  it('過去の時刻・数でない時刻には変えられない。知らない予約は見つからない', () => {
    const { scheduled } = create({ s1: 'idle' });
    const message = scheduled.add('s1', '送る', [], START + MINUTE);
    expect(() => scheduled.reschedule(message.id, START - 1)).toThrow('これから先の時刻を指定してください');
    expect(() => scheduled.reschedule(message.id, Number.NaN)).toThrow('これから先の時刻を指定してください');
    expect(() => scheduled.add('s1', '送る', [], Number.POSITIVE_INFINITY)).toThrow('これから先の時刻を指定してください');
    expect(() => scheduled.reschedule('nope', START + MINUTE)).toThrow('予約が見つかりません');
    expect(() => scheduled.sendNow('nope')).toThrow('予約が見つかりません');
    expect(scheduled.cancel('nope')).toBeNull();
    expect(scheduled.list().map((m) => m.at)).toEqual([START + MINUTE]);
  });

  it('画像だけの予約もできる', () => {
    const { scheduled } = create({ s1: 'idle' });
    expect(scheduled.add('s1', '', ['/tmp/a.png'], START + MINUTE).attachments).toEqual(['/tmp/a.png']);
  });

  it('札（貼り付けた長い文）は、保存して、時刻になったら一緒に送る。札だけの予約もできる', async () => {
    const { scheduled, sent } = create({ s1: 'idle' });
    const log = 'ログの 1 行目\n2 行目\n3 行目\n4 行目';
    scheduled.add('s1', 'このログを見て', [], START + MINUTE, [log]);
    expect(scheduled.add('s1', '', [], START + 2 * MINUTE, [log]).pastes).toEqual([log]);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { messages: ScheduledMessage[] }).messages.map((m) => m.pastes)).toEqual([[log], [log]]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent.map(({ text, pastes }) => ({ text, pastes }))).toEqual([{ text: 'このログを見て', pastes: [log] }]);
    // 文も画像も札も無ければ、予約できない
    expect(() => scheduled.add('s1', ' ', [], START + 3 * MINUTE, [])).toThrow();
  });

  it('予約の無いセッションを閉じても、保存し直さない', () => {
    const { scheduled, changes } = create({ s1: 'idle', s2: 'idle' });
    scheduled.add('s1', '送る', [], START + MINUTE);
    const before = changes.length;
    scheduled.dropSession('s2');
    expect(changes).toHaveLength(before);
  });

  it('打ち込み始めたあとに取り消したものは、送られても一覧に戻さず、失敗にもしない', async () => {
    const states: Record<string, SessionState> = { s1: 'idle' };
    const done: (() => void)[] = [];
    const host: ScheduleHost = {
      stateOf: (id) => states[id] ?? null,
      open: async () => {},
      // 取り消し（signal）を見ない。打ち込み始めたあとは止められない
      submitWhenReady: () => new Promise<void>((resolve) => done.push(resolve)),
    };
    const troubles: ScheduledMessage[] = [];
    const scheduled = new ScheduledMessages(file, host, () => {}, (m) => troubles.push(m));
    scheduled.start();
    const message = scheduled.add('s1', '送る', [], START + MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(scheduled.cancel(message.id)?.text).toBe('送る');
    done[0]!();
    await flush();
    expect(scheduled.list()).toEqual([]);
    expect(troubles).toEqual([]);
  });

  it('送れなかった理由が Error でなくても、文字にして残す。止まっているセッションを起動できなければ、送れなかったことにする', async () => {
    const states: Record<string, SessionState> = { s1: 'idle', s2: 'exited' };
    const host: ScheduleHost = {
      stateOf: (id) => states[id] ?? null,
      open: async () => {
        throw new Error('起動できませんでした');
      },
      submitWhenReady: () => Promise.reject('手が空きません'),
    };
    const scheduled = new ScheduledMessages(file, host, () => {});
    scheduled.start();
    scheduled.add('s1', '一つ目', [], START + MINUTE);
    scheduled.add('s2', '二つ目', [], START + MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await flush();
    expect(scheduled.list().map((m) => [m.text, m.state, m.error])).toEqual([
      ['一つ目', 'failed', '手が空きません'],
      ['二つ目', 'failed', '起動できませんでした'],
    ]);
  });

  it('setTimeout で待てないほど先の予約（約 24.8 日より先）は、途中で起きて測り直す', async () => {
    const { scheduled, sent } = create({ s1: 'idle' });
    const DAY = 24 * 60 * MINUTE;
    scheduled.add('s1', 'ずっと先', [], START + 30 * DAY);
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
    expect(sent).toEqual([]);
    expect(scheduled.list()[0]?.state).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(30 * DAY - (2 ** 31 - 1));
    expect(sent.map((s) => s.text)).toEqual(['ずっと先']);
  });

  it('保存できなくても、画面には知らせる（予約はアプリが動いている間は残る）', () => {
    // 保存先のフォルダを作れない（ファイルの下）
    writeFileSync(join(dir, 'blocker'), '');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const changes: ScheduledMessage[][] = [];
    const scheduled = new ScheduledMessages(join(dir, 'blocker', 'scheduled.json'), fakeHost({ s1: 'idle' }).host, (m) => changes.push(m));
    scheduled.add('s1', '残らない', [], START + MINUTE);
    expect(errors).toHaveBeenCalledWith('予約したメッセージを保存できませんでした', expect.any(Error));
    expect(changes.at(-1)?.map((m) => m.text)).toEqual(['残らない']);
    errors.mockRestore();
    scheduled.dispose();
  });

  it('保存したファイルの、形の違うものは読み飛ばす（壊れたファイル・一覧でない・欠けた項目）', () => {
    const good = { id: 'm1', sessionId: 's1', text: '残る', attachments: [], at: START + MINUTE, createdAt: START, state: 'scheduled' };
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        messages: [good, { ...good, id: 'm2', attachments: [1] }, { ...good, id: 'm3', state: 'unknown' }, null, { ...good, id: 'm4', at: 'あした' }],
      }),
    );
    // error の無い古い形は null に、pastes（札）の無い古い形は空にそろえる
    expect(create({ s1: 'idle' }).scheduled.list()).toEqual([{ ...good, pastes: [], error: null }]);
    // 札は、文字のものだけを読む
    writeFileSync(file, JSON.stringify({ version: 1, messages: [{ ...good, pastes: ['ログ\n2 行目', 3] }, { ...good, id: 'm5', pastes: 'x' }] }));
    expect(create({ s1: 'idle' }).scheduled.list().map((m) => m.pastes)).toEqual([['ログ\n2 行目'], []]);
    writeFileSync(file, JSON.stringify({ version: 1, messages: 'x' }));
    expect(create({ s1: 'idle' }).scheduled.list()).toEqual([]);
    writeFileSync(file, '{壊れた');
    expect(create({ s1: 'idle' }).scheduled.list()).toEqual([]);
  });

  it('dispose のあとは、時刻になっても送らない', async () => {
    const { scheduled, sent } = create({ s1: 'idle' });
    scheduled.add('s1', '送らない', [], START + MINUTE);
    scheduled.dispose();
    // 待っているものが無くても、dispose は失敗しない
    scheduled.dispose();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual([]);
  });
});

describe('予約の時刻の表示', () => {
  const now = new Date(2026, 9, 5, 14, 0);

  it('今日は時刻だけ、明日は「明日」、今年は日付と曜日、来年からは年も付ける', () => {
    expect(formatScheduleTime(new Date(2026, 9, 5, 15, 5).getTime(), now)).toBe('15:05');
    expect(formatScheduleTime(new Date(2026, 9, 6, 9, 0).getTime(), now)).toBe('明日 9:00');
    expect(formatScheduleTime(new Date(2026, 9, 4, 9, 0).getTime(), now)).toBe('昨日 9:00');
    expect(formatScheduleTime(new Date(2026, 9, 12, 9, 0).getTime(), now)).toBe('10/12（月）9:00');
    expect(formatScheduleTime(new Date(2027, 0, 4, 9, 30).getTime(), now)).toBe('2027/1/4（月）9:30');
  });

  it('選択肢は 30 分後・1 時間後・明日の朝 9 時・次の月曜の朝 9 時', () => {
    // 2026/10/5 は月曜。次の月曜は 1 週間後
    expect(schedulePresets(now).map((p) => [p.label, formatScheduleTime(p.at, now)])).toEqual([
      ['30 分後', '14:30'],
      ['1 時間後', '15:00'],
      ['明日の朝', '明日 9:00'],
      ['次の月曜の朝', '10/12（月）9:00'],
    ]);
    // 日曜なら、次の月曜は明日
    const sunday = new Date(2026, 9, 11, 20, 0);
    expect(formatScheduleTime(schedulePresets(sunday)[3]!.at, sunday)).toBe('明日 9:00');
  });

  it('通知の本文', () => {
    const message: ScheduledMessage = {
      id: 'm1',
      sessionId: 's1',
      text: '# テストを\n直して',
      attachments: [],
      pastes: [],
      at: new Date(2026, 9, 5, 9, 0).getTime(),
      createdAt: 0,
      state: 'missed',
      error: null,
    };
    expect(scheduledNotice(message, now)).toBe('9:00 に送る予約を、時刻に送れませんでした: テストを 直して');
    expect(scheduledNotice({ ...message, state: 'failed', error: 'Claude Code が終了しました' }, now)).toBe(
      '予約したメッセージを送れませんでした（Claude Code が終了しました）: テストを 直して',
    );
    expect(scheduledNotice({ ...message, text: '', attachments: ['/tmp/a.png'], state: 'failed', error: 'x' }, now)).toBe(
      '予約したメッセージを送れませんでした（x）: 画像 1 枚',
    );
    // 文が無く、札（貼り付けた長い文）だけなら、札の冒頭を出す
    expect(scheduledNotice({ ...message, text: '', pastes: ['ログの 1 行目\n2 行目'], state: 'failed', error: 'x' }, now)).toBe(
      '予約したメッセージを送れませんでした（x）: ログの 1 行目 2 行目',
    );
  });
});
