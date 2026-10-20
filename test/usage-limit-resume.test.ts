import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '@shared/session-tools';
import { setLanguage } from '@shared/i18n';
import type { CustomPrompts } from '@shared/prompts';
import { parseUsageResume, USAGE_RESUME_TAG, usageResumeText } from '@shared/usage-limit';
import { ScheduledMessages } from '../src/main/scheduled-messages';
import { UsageLimitResume } from '../src/main/usage-limit-resume';

// 利用枠で止まったセッションに、枠が戻る時刻の少しあと（1 分後）に再開の予約を入れる。同じ時刻に戻る枠で止まったものは、親を先に、子は 1 分ずつずらす
const START = new Date(2026, 9, 19, 14, 0).getTime();
const MINUTE = 60_000;
const RESET = START + 3 * 60 * MINUTE;

let dir: string;
let enabled: boolean;
let terminal: Set<string>;
// 子 → 親
let parents: Record<string, string>;
let states: Record<string, SessionState>;
let scheduled: ScheduledMessages;
let resume: UsageLimitResume;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(START);
  dir = mkdtempSync(join(tmpdir(), 'tanacode-usage-limit-'));
  enabled = true;
  terminal = new Set();
  parents = {};
  states = { parent: 'idle', child1: 'idle', child2: 'idle', grandchild: 'idle', other: 'idle' };
  scheduled = new ScheduledMessages(
    join(dir, 'scheduled-messages.json'),
    {
      stateOf: (id) => states[id] ?? null,
      summary: () => ({}),
      open: () => Promise.resolve(),
      submitWhenReady: () => new Promise<void>(() => {}),
    },
    () => {},
  );
  resume = new UsageLimitResume({ scheduled: () => scheduled, enabled: () => enabled, parentOf: (id) => parents[id] ?? null, terminal: (id) => terminal.has(id) });
});

afterEach(() => {
  scheduled.dispose();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const stop = (resetsAt: number | null = RESET) => ({ resetsAt, window: 'five_hour' });
// 利用枠の再開の予約（セッション → 時刻）
const resumes = () => Object.fromEntries(scheduled.list().filter((m) => m.by === 'usage-limit').map((m) => [m.sessionId, m.at]));

describe('UsageLimitResume', () => {
  it('枠が戻る時刻の 1 分後に、続きを頼むメッセージ（囲みごと）を予約する。通知の中身は、予約の時刻と枠が戻る時刻', () => {
    resume.turnEnded('parent', stop());
    expect(scheduled.list()).toMatchObject([{ sessionId: 'parent', text: usageResumeText(), at: RESET + MINUTE, by: 'usage-limit', limitResetsAt: RESET, state: 'scheduled' }]);
    expect(resume.noticeOf('parent')).toEqual({ resumeAt: RESET + MINUTE, resetsAt: RESET });
    expect(resume.noticeOf('other')).toBeNull();
  });

  it('同じ時刻に戻る枠で止まったものは、親を先に、子は 1 分ずつずらす（子が先に止まっても、あとから止まった親を先にする）', () => {
    parents = { child1: 'parent', child2: 'parent', grandchild: 'child1' };
    resume.turnEnded('child1', stop());
    resume.turnEnded('grandchild', stop());
    resume.turnEnded('child2', stop());
    // 深さで並べる（孫は、あとから止まった子よりもあと）
    expect(resumes()).toEqual({ child1: RESET + MINUTE, child2: RESET + 2 * MINUTE, grandchild: RESET + 3 * MINUTE });
    resume.turnEnded('parent', stop());
    // 深さが同じなら、先に止まった方を先にする
    expect(resumes()).toEqual({ parent: RESET + MINUTE, child1: RESET + 2 * MINUTE, child2: RESET + 3 * MINUTE, grandchild: RESET + 4 * MINUTE });
    // 通知の中身は、そのときの予約の時刻
    expect(resume.noticeOf('parent')?.resumeAt).toBe(RESET + MINUTE);
    // 親子でないセッションも、一斉に動かないようにずらす
    resume.turnEnded('other', stop());
    expect(resumes().other).toBe(RESET + MINUTE * 2);
    expect(resumes().child1).toBe(RESET + 3 * MINUTE);
  });

  it('人が時刻を変えた予約は、並べ直さない。ほかの時刻に戻る枠の予約とも混ぜない', () => {
    parents = { child1: 'parent' };
    resume.turnEnded('child1', stop());
    const moved = scheduled.list()[0]!;
    scheduled.reschedule(moved.id, RESET + 30 * MINUTE);
    resume.turnEnded('parent', stop());
    expect(resumes()).toEqual({ child1: RESET + 30 * MINUTE, parent: RESET + MINUTE });
    resume.turnEnded('other', stop(RESET + 60 * MINUTE));
    expect(resumes().other).toBe(RESET + 61 * MINUTE);
    expect(resumes().parent).toBe(RESET + MINUTE);
  });

  it('止まり直したら、前の予約（送れなかったものも）を入れ直す。1 つのセッションに 1 つだけ', () => {
    resume.turnEnded('parent', stop());
    resume.turnEnded('parent', stop(RESET + 10 * MINUTE));
    expect(scheduled.list().map((m) => m.at)).toEqual([RESET + 11 * MINUTE]);
  });

  it('止まらずにターンが終わった（作業が進んだ）ら、待っている予約を取り消し、通知の中身も消す。残りは前に詰める', () => {
    resume.turnEnded('parent', stop());
    resume.turnEnded('child1', stop());
    resume.turnEnded('parent', null);
    expect(resumes()).toEqual({ child1: RESET + MINUTE });
    expect(resume.noticeOf('parent')).toBeNull();
  });

  it('予約しないとき: メニューでオフ・ターミナルモード・枠が戻る時刻が分からない・もう過ぎている。通知の中身には、分かれば枠が戻る時刻を入れる', () => {
    enabled = false;
    resume.turnEnded('parent', stop());
    expect(resume.noticeOf('parent')).toEqual({ resumeAt: null, resetsAt: RESET });
    enabled = true;
    terminal.add('child1');
    resume.turnEnded('child1', stop());
    resume.turnEnded('child2', stop(null));
    resume.turnEnded('other', stop(START - MINUTE));
    expect(resumes()).toEqual({});
    expect(resume.noticeOf('child2')).toEqual({ resumeAt: null, resetsAt: null });
    // アーカイブしたセッションは、予約を受け付けない
    states.grandchild = 'archived';
    resume.turnEnded('grandchild', stop());
    expect(resume.noticeOf('grandchild')).toEqual({ resumeAt: null, resetsAt: RESET });
  });

  it('メニューでオフにしたら、待っている予約をすべて取り消す（人の予約・Claude の予約は残す）。忘れたセッションの通知の中身は消す', () => {
    resume.turnEnded('parent', stop());
    resume.turnEnded('child1', stop());
    scheduled.add('parent', '人の予約', [], RESET);
    scheduled.add('parent', '子を見る', [], RESET, [], 'claude');
    resume.cancelAll();
    expect(scheduled.list().map((m) => m.text)).toEqual(['人の予約', '子を見る']);
    expect(resume.noticeOf('parent')).toEqual({ resumeAt: null, resetsAt: RESET });
    resume.forget('parent');
    expect(resume.noticeOf('parent')).toBeNull();
  });

  it('再開のメッセージは、人にも見える（予約の行・送ったあとの知らせ）ので画面の言語で書き、囲みで見分ける（どの言語で書いたものも読める）', () => {
    setLanguage('en');
    const en = usageResumeText();
    setLanguage('ja');
    const ja = usageResumeText();
    expect(ja).toContain('枠が戻りました');
    expect(ja).toContain('答えを待っていたなら、続けないでください');
    expect(en).toContain('it has reset now');
    expect(en).toContain('do not continue: tell the user briefly where things stand');
    for (const text of [ja, en]) {
      expect(text.startsWith(`<${USAGE_RESUME_TAG}>\n`)).toBe(true);
      expect(text.endsWith(`\n</${USAGE_RESUME_TAG}>`)).toBe(true);
      expect(parseUsageResume(text)?.body).toBe(text.split('\n').slice(1, -1).join('\n'));
    }
  });

  it('利用者が文を変えていれば、予約を入れるときの文（囲みごと）を本文にする。既定に戻したら、次の予約から既定の文', () => {
    let prompts: CustomPrompts = { usageResume: '枠が戻りました。止まったところを報告して、指示を待ってください。' };
    const custom = new UsageLimitResume({ scheduled: () => scheduled, enabled: () => true, parentOf: () => null, terminal: () => false, prompts: () => prompts });
    custom.turnEnded('parent', stop());
    const text = scheduled.list()[0].text;
    expect(text).toBe(`<${USAGE_RESUME_TAG}>\n枠が戻りました。止まったところを報告して、指示を待ってください。\n</${USAGE_RESUME_TAG}>`);
    expect(parseUsageResume(text)?.body).toBe('枠が戻りました。止まったところを報告して、指示を待ってください。');
    prompts = {};
    custom.turnEnded('parent', stop());
    expect(scheduled.list().map((m) => m.text)).toEqual([usageResumeText()]);
  });

  it('予約の置き場がまだ無ければ、何もしない', () => {
    const early = new UsageLimitResume({ scheduled: () => null, enabled: () => true, parentOf: () => null, terminal: () => false });
    early.turnEnded('parent', stop());
    early.turnEnded('parent', null);
    early.cancelAll();
    expect(early.noticeOf('parent')).toBeNull();
  });
});
