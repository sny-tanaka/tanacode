import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatScheduleTime, schedulePresets, type ScheduledMessage } from '@shared/scheduled';
import type { SessionState } from '@shared/session-tools';
import { scheduledNotice } from '../src/main/notice-text';
import { ScheduledMessages, type ScheduleHost } from '../src/main/scheduled-messages';

// 時刻を指定して送信（予約）。保存・時刻になったら送る・時刻を過ぎていたもの・取り消し
const START = new Date(2026, 9, 5, 14, 0).getTime();
const MINUTE = 60_000;

type Sent = { id: string; text: string; attachments: string[]; signal?: AbortSignal; resolve: () => void; reject: (error: Error) => void };

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
    submitWhenReady: (id, text, _timeout, { attachments = [], signal } = {}) =>
      new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('送るのを取りやめました')));
        sent.push({ id, text, attachments, signal, resolve, reject });
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
    // error の無い古い形は null にそろえる
    expect(create({ s1: 'idle' }).scheduled.list()).toEqual([{ ...good, error: null }]);
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
  });
});
