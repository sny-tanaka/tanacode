import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fill, setLanguage, t } from '../src/shared/i18n';
import type { ChatEvent } from '../src/shared/chat';
import type { Checklist } from '../src/shared/checklist';
import { handoffText, IDLE_COMPACT_STATUS, parseCompactCancelled, parseCompactMessage, type AutoCompactTrigger, type CarriedTask, type CompactStatus } from '../src/shared/optimized-compact';
import { defaultPrompt, type CustomPrompts } from '../src/shared/prompts';
import type { SessionState } from '../src/shared/session-tools';
import { OptimizedCompact, type CompactHost } from '../src/main/optimized-compact';

// 最適化圧縮の流れ（main の OptimizedCompact）。仕上げ → /clear → 再開の文、と進むこと・怪しいときは会話を消さずに取りやめること

// 送る文は画面の言語で書く。英語の文を確かめるテストは、英語で流す（日本語の文は、下の 1 つで確かめる）
beforeAll(() => setLanguage('en'));
afterAll(() => setLanguage('ja'));

const ID = 's1';
// 自動で始める大きさは、AutoCompact から届く（ここでは 60）
const IDLE = { ...IDLE_COMPACT_STATUS, autoPercent: 60 };
const TIMINGS = { pollMs: 2, submitMs: 30, appearMs: 200, clearMs: 60, retryMs: 5, startMs: 30 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// SessionManager の代わり。打ち込まれた文を控え、台本（onSubmit）で会話を進める
class FakeHost implements CompactHost {
  state: SessionState | null = 'idle';
  events: ChatEvent[] = [{ type: 'user', id: 'u0', text: '税率を可変にして' }, { type: 'assistant-text', id: 'a0', text: 'はい' }, { type: 'turn-end' }];
  claudeSession = 'conv-1';
  checklistMcp: boolean | null = true;
  tasks: CarriedTask[] = [];
  submitted: string[] = [];
  // 打ち込みを断る理由（あれば、その回は失敗する）
  refuse: (text: string) => boolean = () => false;
  onSubmit: (text: string) => void = () => {};

  stateOf = () => this.state;
  conversation = async () => [...this.events];
  claudeSessionOf = () => this.claudeSession;
  hasChecklistMcp = () => this.checklistMcp;
  runningTasks = () => this.tasks;
  async submitWhenReady(_id: string, text: string): Promise<void> {
    if (this.refuse(text)) throw new Error('busy');
    this.submitted.push(text);
    this.onSubmit(text);
  }
}

let host: FakeHost;
let statuses: CompactStatus[];
let used: boolean;
let enabled: boolean;
let lists: Checklist[];
let compact: OptimizedCompact;
let finishes: { failure: string | null; auto: AutoCompactTrigger | null }[];

beforeEach(() => {
  host = new FakeHost();
  statuses = [];
  finishes = [];
  used = true;
  enabled = true;
  lists = [];
  compact = new OptimizedCompact({
    host,
    lists: () => lists,
    usedSince: () => used,
    enabled: () => enabled,
    onChange: (_id, status) => statuses.push(status),
    autoStatus: () => ({ percent: 60, paused: false }),
    onFinish: (_id, failure, auto) => finishes.push({ failure, auto }),
    timings: TIMINGS,
  });
});
afterEach(() => compact.dispose());

const handoff = (): ChatEvent => ({ type: 'notice', id: `h${host.events.length}`, text: '仕上げ', compact: 'handoff' });
// 送った文が、仕上げの頼み・再開の文か（囲みには、始まり方の属性が付く）
const isHandoff = (text: string) => parseCompactMessage(text)?.kind === 'handoff';
const isResume = (text: string) => parseCompactMessage(text)?.kind === 'resume';

// ふつうに進む台本。仕上げの頼みが会話に出て、ターンが終わる。/clear で新しい会話になる
function script(over: { afterHandoff?: () => void; onClear?: () => void } = {}): void {
  host.onSubmit = (text) => {
    if (isHandoff(text)) {
      host.events.push(handoff());
      host.state = 'working';
      setTimeout(
        over.afterHandoff ??
          (() => {
            host.events.push({ type: 'assistant-text', id: 'a1', text: '書きました' }, { type: 'turn-end' });
            host.state = 'idle';
          }),
        6,
      );
    } else if (text === '/clear') {
      (over.onClear ??
        (() => {
          host.claudeSession = 'conv-2';
          host.events.push({ type: 'reset' }, { type: 'user', id: 'c', text: '/clear', command: true }, { type: 'turn-end' });
        }))();
    }
  };
}

async function finished(): Promise<CompactStatus> {
  for (let i = 0; i < 500; i++) {
    const last = statuses[statuses.length - 1];
    if (last && last.phase === null) return last;
    await sleep(2);
  }
  throw new Error(`終わらない: ${JSON.stringify(statuses)}`);
}

const phases = () => statuses.map((s) => s.phase);

describe('流れ', () => {
  it('仕上げ → /clear → 再開の文、と進む。再開の文には、/clear の前の発言・リスト・裏で動いているタスクが入る', async () => {
    script();
    host.tasks = [{ kind: 'bash', label: 'npm run dev' }];
    lists = [{ id: 'l', name: 'いまの状態', description: '', kind: 'state', nextNumber: 2, cards: [{ id: 'c', number: 1, title: 'tax.ts の途中', body: '次はテスト', checked: false, createdBy: 'claude', createdAt: 1, updatedAt: 1, thread: [], readByClaude: 0, readByHuman: 0 }], createdBy: 'claude', createdAt: 0 }];
    expect(compact.start(ID)).toEqual({ ...IDLE, phase: 'finalizing' });
    expect(await finished()).toEqual(IDLE);
    expect(host.submitted).toHaveLength(3);
    expect(isHandoff(host.submitted[0])).toBe(true);
    expect(host.submitted[1]).toBe('/clear');
    expect(isResume(host.submitted[2])).toBe(true);
    expect(host.submitted[2]).toContain('<user-message>\n税率を可変にして\n</user-message>');
    expect(host.submitted[2]).toContain('## #1 tax.ts の途中\n次はテスト');
    expect(host.submitted[2]).toContain('- Bash: npm run dev');
    expect(phases()).toEqual(['finalizing', 'clearing', 'resuming', null]);
  });

  it('利用者が変えた文（メニューの「Claude に送る文…」）を、送るたびに読んで送る。既定に戻したら、次からは既定の文', async () => {
    let prompts: CustomPrompts = { handoff: 'リストを最新にして{trigger}', resume: '会話を消しました。報告して待って。' };
    compact.dispose();
    compact = new OptimizedCompact({ host, lists: () => lists, usedSince: () => used, enabled: () => enabled, prompts: () => prompts, onChange: (_id, status) => statuses.push(status), timings: TIMINGS });
    script();
    compact.start(ID);
    await finished();
    const manual = t('chat.compactPrompt.handoff.triggerManual');
    expect(parseCompactMessage(host.submitted[0])!.body).toBe(`リストを最新にして${manual}`);
    const resume = parseCompactMessage(host.submitted[2])!;
    expect(resume.body.startsWith(`会話を消しました。報告して待って。\n\n${t('chat.compactPrompt.resume.cardsHeading')}`)).toBe(true);
    expect(resume.body).toContain('<user-message>\n税率を可変にして\n</user-message>');

    prompts = {};
    host.submitted = [];
    statuses = [];
    host.claudeSession = 'conv-1';
    compact.start(ID);
    await finished();
    expect(host.submitted[0]).toBe(handoffText());
    expect(parseCompactMessage(host.submitted[2])!.body.startsWith(`${fill(defaultPrompt('resume'), { trigger: manual })}\n\n`)).toBe(true);
  });

  it('再開の文に、切り替える前の最後の応答を入れる（人が、それに短く答えるかもしれない）。途中で止めたときは、止めた場所に入るので入れない', async () => {
    script();
    host.events = [{ type: 'user', id: 'u0', text: '税率を可変にして' }, { type: 'assistant-text', id: 'a0', text: 'A 案と B 案があります。どちらにしますか？' }, { type: 'turn-end' }];
    compact.start(ID);
    await finished();
    expect(host.submitted[2]).toContain('# Your last reply before the reset');
    expect(host.submitted[2]).toContain('<your-last-reply>\nA 案と B 案があります。どちらにしますか？\n</your-last-reply>');
    // 仕上げの返事（「書きました」）ではない
    expect(host.submitted[2]).not.toContain('書きました');
    host.submitted = [];
    statuses = [];
    host.claudeSession = 'conv-1';
    host.events = [{ type: 'user', id: 'u0', text: '税率を可変にして' }, { type: 'assistant-text', id: 'a0', text: '手順 3 まで進めました' }, { type: 'turn-end' }];
    compact.start(ID, { percent: 91, midTurn: true });
    await finished();
    expect(host.submitted[2]).not.toContain('# Your last reply before the reset');
    expect(host.submitted[2]).toContain('Your last words before the stop:\n手順 3 まで進めました');
  });

  it('再開の文を送ったあと、そのターンが始まるまでは、流れの途中（送った直後の「待機」を、手が空いたと見せない）', async () => {
    script();
    const long = new OptimizedCompact({
      host,
      lists: () => lists,
      usedSince: () => used,
      enabled: () => enabled,
      onChange: (_id, status) => statuses.push(status),
      timings: { ...TIMINGS, startMs: 10_000 },
    });
    long.start(ID);
    for (let i = 0; i < 500 && host.submitted.length < 3; i++) await sleep(2);
    expect(host.submitted).toHaveLength(3);
    await sleep(30);
    // 再開の文は送ったが、まだターンが始まっていない
    expect(long.running(ID)).toBe(true);
    host.state = 'working';
    await finished();
    expect(long.running(ID)).toBe(false);
    long.dispose();
  });

  it('続けてもう一度切り替えても、前の会話の発言の原文を引き継ぐ（前の再開の文から取り出す）', async () => {
    script({
      onClear: () => {
        host.claudeSession = `conv-${host.submitted.length}`;
        host.events.push({ type: 'reset' }, { type: 'user', id: 'c', text: '/clear', command: true }, { type: 'turn-end' });
      },
    });
    // 再開の文は、会話ログでは知らせになる（全文は detail）
    const submit = host.onSubmit;
    host.onSubmit = (text) => {
      if (isResume(text)) host.events.push({ type: 'notice', id: 'r', text: '再開', compact: 'resume', detail: parseCompactMessage(text)!.body }, { type: 'turn-end' });
      else submit(text);
    };
    compact.start(ID);
    await finished();
    statuses = [];
    host.events.push({ type: 'user', id: 'u2', text: '次は README' }, { type: 'turn-end' });
    compact.start(ID);
    expect((await finished()).failure).toBeNull();
    const second = host.submitted.filter(isResume)[1];
    expect(second).toContain('<user-message>\n税率を可変にして\n</user-message>\n<user-message>\n次は README\n</user-message>');
    // 報告の言語は、ユーザーの発言とリストの言語。分からなければ、この文の言語（画面の言語）
    expect(second).toContain('If neither tells you, use the language of this message.');
  });

  it('送る文は、そのときの画面の言語で書く（日本語の画面なら、仕上げの頼みも再開の文も日本語）', async () => {
    setLanguage('ja');
    try {
      script();
      compact.start(ID);
      expect((await finished()).failure).toBeNull();
      expect(host.submitted[0]).toContain('tanacode は、この会話を圧縮する代わりに、これから消します（ユーザーが「最適化圧縮」のボタンを押しました）。');
      expect(host.submitted[2]).toContain('tanacode は、会話を圧縮する代わりに消しました（ユーザーが「最適化圧縮」のボタンを押しました）。');
    } finally {
      setLanguage('en');
    }
  });

  it('進んでいる間にもう一度押しても、二重には始めない', async () => {
    script();
    compact.start(ID);
    expect(compact.start(ID).phase).toBe('finalizing');
    await finished();
    expect(host.submitted.filter(isHandoff)).toHaveLength(1);
  });

  it('許可の確認・質問が出ているあいだは、人が答えるまで待って続ける', async () => {
    script({
      afterHandoff: () => {
        host.state = 'permission';
        setTimeout(() => {
          host.events.push({ type: 'turn-end' });
          host.state = 'idle';
        }, 80);
      },
    });
    compact.start(ID);
    await sleep(50);
    expect(host.submitted).toHaveLength(1);
    expect(compact.status(ID).phase).toBe('finalizing');
    expect((await finished()).failure).toBeNull();
    expect(host.submitted[1]).toBe('/clear');
  });

  it('裏でタスクが動いていて、待機に戻らない（完了待ち）ときも進める', async () => {
    script({
      afterHandoff: () => {
        host.events.push({ type: 'turn-end' });
        host.state = 'background';
      },
    });
    compact.start(ID);
    expect((await finished()).failure).toBeNull();
    expect(host.submitted).toHaveLength(3);
  });
});

describe('自動で始めた流れ', () => {
  it('ターンの終わり: 仕上げの頼みと再開の文に、自動であることが入る。再開のあとに続けるか待つかは「いまの状態」で決めさせる。終わったら知らせる', async () => {
    script();
    const auto = { percent: 83, midTurn: false };
    compact.start(ID, auto);
    expect((await finished()).failure).toBeNull();
    expect(host.submitted[0]).toContain('instead of compacting it (automatic; context 83% full).');
    expect(host.submitted[0]).toContain('This reset is automatic: the user did not press anything');
    expect(host.submitted[2]).toContain('(automatic; context 83% full). No summary was made.');
    expect(host.submitted[2]).toContain('- Then decide from the state list whether you are waiting for an answer from the user');
    expect(host.submitted[2]).not.toContain('Do not continue the work until the user tells you to.');
    expect(finishes).toEqual([{ failure: null, auto }]);
  });

  it('ターンの途中で止めた: 止めた場所（仕上げの頼みを送る前の会話から）を再開の文に入れ、続きを進めさせる', async () => {
    host.events = [
      { type: 'user', id: 'u0', text: '税率を可変にして' },
      { type: 'assistant-text', id: 'a0', text: 'テストを流します' },
      { type: 'tool-use', id: 't1', name: 'Bash', target: 'npm test', input: '' },
      { type: 'tool-result', id: 't1', isError: false },
      { type: 'turn-end' },
    ];
    script();
    compact.start(ID, { percent: 91, midTurn: true });
    expect((await finished()).failure).toBeNull();
    expect(host.submitted[0]).toContain('tanacode stopped your turn between tool calls');
    const resume = host.submitted[2];
    expect(resume).toContain('continue the work that was in progress from where it stopped (the state list, and "Where the turn was stopped" below)');
    expect(resume).toContain('Your last words before the stop:\nテストを流します\nYour last tool calls, oldest first:\n- Bash: npm test → finished');
    expect(resume).not.toContain('Do not continue the work until the user tells you to.');
  });

  it('ターンの途中で止めたのに取りやめたら、会話は消さずに、止めたところから続けるよう頼む（止めたままにしない）。続きのターンが始まるまでは流れの途中', async () => {
    script();
    const onSubmit = host.onSubmit;
    host.onSubmit = (text) => {
      onSubmit(text);
      // 続きのターンは、少し遅れて始まる
      if (parseCompactCancelled(text)) setTimeout(() => (host.state = 'working'), 6);
    };
    used = false;
    const auto = { percent: 91, midTurn: true };
    compact.start(ID, auto);
    const status = await finished();
    const stateAtEnd = host.state;
    expect(status.failure).toBe('not-used');
    expect(host.submitted).toHaveLength(2);
    expect(host.submitted).not.toContain('/clear');
    expect(parseCompactCancelled(host.submitted[1])?.body).toContain('Continue the work from where your turn was stopped');
    // 流れが終わったときには、もう続きのターンが始まっている（「待機」に見せて、親に「止まった」と知らせない）
    expect(stateAtEnd).toBe('working');
    expect(finishes).toEqual([{ failure: 'not-used', auto }]);
  });

  it('続けるよう頼むのは、アプリがターンの途中で止めたときだけ。人が中断した・発言した・利用枠で止まったとき、ターンの終わりの自動・手動では頼まない', async () => {
    const cases: { auto: AutoCompactTrigger | null; after?: () => void }[] = [
      { auto: { percent: 83, midTurn: false } },
      { auto: null },
      { auto: { percent: 91, midTurn: true }, after: () => host.events.push({ type: 'turn-end', interrupted: true }) },
      { auto: { percent: 91, midTurn: true }, after: () => host.events.push({ type: 'turn-end' }, { type: 'user', id: 'u9', text: 'やっぱり待って' }) },
      { auto: { percent: 91, midTurn: true }, after: () => host.events.push({ type: 'api-error', id: 'e', text: '利用枠', retrying: false, limit: { resetsAt: Date.now() + 3_600_000, window: 'five_hour' } }, { type: 'turn-end' }) },
    ];
    for (const { auto, after } of cases) {
      host.submitted = [];
      statuses = [];
      used = false;
      script(after ? { afterHandoff: () => { after(); host.state = 'idle'; } } : {});
      compact.start(ID, auto);
      expect((await finished()).failure).not.toBeNull();
      expect(host.submitted.filter((text) => parseCompactCancelled(text))).toEqual([]);
    }
  });

  it('仕上げのターンが API エラーで終わった（上限に当たったなど）ら、仕上げを飛ばして切り替え、再開の文にそう書く。チェックリストを使っていなくても取りやめない', async () => {
    used = false;
    script({
      afterHandoff: () => {
        host.events.push({ type: 'api-error', id: 'e', text: 'Prompt is too long', retrying: false }, { type: 'turn-end' });
        host.state = 'idle';
      },
    });
    compact.start(ID, { percent: 97, midTurn: true });
    expect((await finished()).failure).toBeNull();
    expect(host.submitted[1]).toBe('/clear');
    expect(host.submitted[2]).toContain('The wrap-up before this reset could not run');
  });

  it('仕上げのターンがプランの利用枠に当たって止まったら、飛ばさずに取りやめる（会話を消さない。手動も自動も）', async () => {
    for (const auto of [{ percent: 97, midTurn: true }, null]) {
      host.submitted = [];
      script({
        afterHandoff: () => {
          host.events.push({ type: 'api-error', id: 'e', text: '利用枠の上限に達したので、止まりました', retrying: false, limit: { resetsAt: Date.now() + 3_600_000, window: 'five_hour' } }, { type: 'turn-end' });
          host.state = 'idle';
        },
      });
      compact.start(ID, auto);
      expect((await finished()).failure).toBe('usage-limit');
      expect(host.submitted).toHaveLength(1);
    }
    expect(finishes.map((f) => f.failure)).toEqual(['usage-limit', 'usage-limit']);
  });

  it('再試行中の API エラー・立ち直った API エラーでは、飛ばさない', async () => {
    script({
      afterHandoff: () => {
        host.events.push({ type: 'api-error', id: 'e', text: 'Overloaded', retrying: true }, { type: 'api-error', id: 'e2', text: 'Overloaded', retrying: false }, { type: 'assistant-text', id: 'a1', text: '書きました' }, { type: 'turn-end' });
        host.state = 'idle';
      },
    });
    compact.start(ID, { percent: 85, midTurn: false });
    expect((await finished()).failure).toBeNull();
    expect(host.submitted[2]).not.toContain('could not run');
  });

  it('手動では、仕上げが API エラーで終わっても飛ばさない（会話を消さずに取りやめる）', async () => {
    used = false;
    script({
      afterHandoff: () => {
        host.events.push({ type: 'api-error', id: 'e', text: 'Prompt is too long', retrying: false }, { type: 'turn-end' });
        host.state = 'idle';
      },
    });
    compact.start(ID);
    expect((await finished()).failure).toBe('not-used');
    expect(host.submitted).not.toContain('/clear');
    expect(finishes).toEqual([{ failure: 'not-used', auto: null }]);
  });

  it('自動でも、取りやめるときは手動と同じ（会話を消さない）。理由と、自動だったことを知らせる', async () => {
    script();
    used = false;
    const auto = { percent: 83, midTurn: false };
    compact.start(ID, auto);
    expect((await finished()).failure).toBe('not-used');
    expect(host.submitted).not.toContain('/clear');
    expect(finishes).toEqual([{ failure: 'not-used', auto }]);
  });

  it('進んでいる途中かを答える。状態には、自動で始める大きさと、休んでいるかが入る', async () => {
    script();
    expect(compact.running(ID)).toBe(false);
    expect(compact.start(ID)).toMatchObject({ autoPercent: 60, autoPaused: false });
    expect(compact.running(ID)).toBe(true);
    await finished();
    expect(compact.running(ID)).toBe(false);
  });

  it('アプリがターンの途中で止めて始めた流れが進んでいるかを答える（止めたターンの終わりを、作業の完了として知らせないため）', async () => {
    script();
    expect(compact.stoppedMidTurn(ID)).toBe(false);
    // 手動・ターンの終わりの自動では、止めたターンは無い
    compact.start(ID);
    expect(compact.stoppedMidTurn(ID)).toBe(false);
    await finished();
    script();
    compact.start(ID, { percent: 85, midTurn: false });
    expect(compact.stoppedMidTurn(ID)).toBe(false);
    await finished();
    script();
    compact.start(ID, { percent: 91, midTurn: true });
    expect(compact.stoppedMidTurn(ID)).toBe(true);
    expect(compact.stoppedMidTurn('other')).toBe(false);
    await finished();
    expect(compact.stoppedMidTurn(ID)).toBe(false);
  });
});

describe('会話を消さずに取りやめる', () => {
  const cancelled = async (failure: string) => {
    expect((await finished()).failure).toBe(failure);
    expect(host.submitted).not.toContain('/clear');
    expect(host.submitted.some(isResume)).toBe(false);
  };

  it('仕上げを人が中断した', async () => {
    script({
      afterHandoff: () => {
        host.events.push({ type: 'turn-end', interrupted: true });
        host.state = 'idle';
      },
    });
    compact.start(ID);
    await cancelled('interrupted');
  });

  it('仕上げの頼みが会話から消えた（巻き戻した・/clear した）', async () => {
    script({
      afterHandoff: () => {
        host.events = host.events.filter((e) => !(e.type === 'notice' && e.compact));
        host.state = 'idle';
      },
    });
    compact.start(ID);
    await cancelled('interrupted');
  });

  it('仕上げの間に人が発言した（順番待ちの発言も）', async () => {
    script({ afterHandoff: () => host.events.push({ type: 'queue', prompts: [{ id: 'q1', text: 'ちょっと待って', pastes: [], images: 0, state: 'queued' }] }) });
    compact.start(ID);
    await cancelled('prompted');
    statuses = [];
    script({
      afterHandoff: () => {
        host.events.push({ type: 'turn-end' }, { type: 'user', id: 'u9', text: 'やっぱり続けて' });
        host.state = 'working';
      },
    });
    compact.start(ID);
    await cancelled('prompted');
  });

  it('Claude がチェックリストのツールを 1 回も使わなかった（何も引き継げない）', async () => {
    script();
    used = false;
    compact.start(ID);
    await cancelled('not-used');
  });

  it('仕上げの頼みを送れなかった・送っても会話に出なかった', async () => {
    host.refuse = isHandoff;
    compact.start(ID);
    await cancelled('busy');
    statuses = [];
    host.refuse = () => false;
    host.onSubmit = () => {};
    compact.start(ID);
    await cancelled('busy');
  });

  it('セッションが終了した', async () => {
    script({ afterHandoff: () => (host.state = 'exited') });
    compact.start(ID);
    await cancelled('exited');
  });

  it('取りやめた理由は、次に始めるまで残す', async () => {
    script();
    used = false;
    compact.start(ID);
    await finished();
    expect(compact.status(ID).failure).toBe('not-used');
    used = true;
    statuses = [];
    expect(compact.start(ID).failure).toBeNull();
    expect((await finished()).failure).toBeNull();
  });
});

describe('仕上げのあとに別のターンが挟まった', () => {
  // 仕上げのターンが終わったあと、タスクの完了の知らせで次のターンが始まり、それも終わる
  const followed = () => {
    host.events.push({ type: 'turn-end' }, { type: 'notice', id: `n${host.events.length}`, text: 'タスクが終わりました' }, { type: 'assistant-text', id: 'a2', text: '結果を見ました' }, { type: 'turn-end' });
    host.state = 'idle';
  };

  it('仕上げを 1 回だけやり直してから進める（リストが、そのターンの分だけ古くなるため）', async () => {
    let first = true;
    script({
      afterHandoff: () => {
        if (first) followed();
        else {
          host.events.push({ type: 'turn-end' });
          host.state = 'idle';
        }
        first = false;
      },
    });
    compact.start(ID);
    expect((await finished()).failure).toBeNull();
    expect(host.submitted.filter(isHandoff)).toHaveLength(2);
    expect(host.submitted.slice(2).map((t) => (isResume(t) ? 'resume' : t))).toEqual(['/clear', 'resume']);
  });

  it('やり直しても挟まれたら、会話を消さずに取りやめる', async () => {
    script({ afterHandoff: followed });
    compact.start(ID);
    expect((await finished()).failure).toBe('interleaved');
    expect(host.submitted.filter(isHandoff)).toHaveLength(2);
    expect(host.submitted).not.toContain('/clear');
  });

  it('/clear を打つ前にターンが始まって打てなかったときも、そのターンが終わってから仕上げをやり直す', async () => {
    script();
    let refused = false;
    host.refuse = (text) => {
      if (text !== '/clear' || refused) return false;
      refused = true;
      host.state = 'working';
      setTimeout(() => (host.state = 'idle'), 10);
      return true;
    };
    compact.start(ID);
    expect((await finished()).failure).toBeNull();
    expect(host.submitted.filter(isHandoff)).toHaveLength(2);
    expect(host.submitted.filter((t) => t === '/clear')).toHaveLength(1);
  });
});

describe('/clear のあと', () => {
  it('/clear を送っても新しい会話にならなければ、失敗として理由を出す（再開の文は送らない）', async () => {
    script({ onClear: () => {} });
    compact.start(ID);
    expect((await finished()).failure).toBe('not-cleared');
    expect(host.submitted.some(isResume)).toBe(false);
  });

  it('再開の文を送れないあいだ（入力欄に書きかけがある など）は、捨てずに待ち続け、空いたら送る。待っていることを知らせる', async () => {
    script();
    let blocked = true;
    host.refuse = (text) => isResume(text) && blocked;
    compact.start(ID);
    await sleep(150);
    expect(compact.status(ID).phase).toBe('waiting');
    expect(host.submitted.some(isResume)).toBe(false);
    blocked = false;
    expect((await finished()).failure).toBeNull();
    expect(host.submitted.filter(isResume)).toHaveLength(1);
    expect(phases()).toEqual(['finalizing', 'clearing', 'resuming', 'waiting', null]);
  });

  it('待っているあいだにセッションが終了したら、やめる', async () => {
    script();
    host.refuse = isResume;
    compact.start(ID);
    await sleep(120);
    host.state = 'exited';
    expect((await finished()).failure).toBe('exited');
  });
});

describe('途中でセッションが終わったとき', () => {
  it('仕上げの頼み・/clear を送れず、そのときセッションも終わっていたら、終了として取りやめる', async () => {
    script();
    host.refuse = (text) => {
      if (!isHandoff(text)) return false;
      host.state = 'exited';
      return true;
    };
    compact.start(ID);
    expect((await finished()).failure).toBe('exited');
    statuses = [];
    host.state = 'idle';
    host.refuse = (text) => {
      if (text !== '/clear') return false;
      host.state = 'exited';
      return true;
    };
    compact.start(ID);
    expect((await finished()).failure).toBe('exited');
  });

  it('/clear を打てず、手が空くのを待つあいだに終わった・新しい会話になるのを待つあいだに終わったら、終了として取りやめる', async () => {
    script();
    host.refuse = (text) => {
      if (text !== '/clear') return false;
      host.state = 'working';
      setTimeout(() => (host.state = 'exited'), 10);
      return true;
    };
    compact.start(ID);
    expect((await finished()).failure).toBe('exited');
    statuses = [];
    host.state = 'idle';
    host.refuse = () => false;
    script({ onClear: () => (host.state = 'exited') });
    compact.start(ID);
    expect((await finished()).failure).toBe('exited');
    expect(host.submitted.some(isResume)).toBe(false);
  });

  it('仕上げをやり直したあとも /clear を打てなければ、会話を消さずに取りやめる', async () => {
    script();
    host.refuse = (text) => text === '/clear';
    compact.start(ID);
    expect((await finished()).failure).toBe('interleaved');
    expect(host.submitted.filter(isHandoff)).toHaveLength(2);
  });
});

describe('仕上げのターンの見分け', () => {
  // 仕上げのターンの、仕上げの頼みのあとの出来事（最初の回だけ。2 回目からはふつうに終わる）
  const firstTurn = (events: ChatEvent[]) => {
    let first = true;
    script({
      afterHandoff: () => {
        host.events.push(...(first ? events : [{ type: 'turn-end' } as ChatEvent]));
        host.state = 'idle';
        first = false;
      },
    });
  };

  it('ターンの途中に届いた知らせは、別のターンに数えない', async () => {
    firstTurn([{ type: 'notice', id: 'n', text: 'タスクが終わりました' }, { type: 'assistant-text', id: 'a1', text: '書きました' }, { type: 'turn-end' }]);
    compact.start(ID);
    expect((await finished()).failure).toBeNull();
    expect(host.submitted.filter(isHandoff)).toHaveLength(1);
  });

  it('仕上げのターンが終わったあとのターンの始まりは、別のターンが挟まったとみなして、仕上げをやり直す', async () => {
    firstTurn([{ type: 'turn-end' }, { type: 'turn-start' }, { type: 'assistant-text', id: 'a2', text: '知らせを見ました' }, { type: 'turn-end' }]);
    compact.start(ID);
    expect((await finished()).failure).toBeNull();
    expect(host.submitted.filter(isHandoff)).toHaveLength(2);
  });

  it('仕上げのターンが終わったあとのツールの行も、別のターンが挟まったとみなす', async () => {
    firstTurn([{ type: 'turn-end' }, { type: 'tool-use', id: 't', name: 'Bash', target: 'ls', input: 'ls' }, { type: 'turn-end' }]);
    compact.start(ID);
    expect((await finished()).failure).toBeNull();
    expect(host.submitted.filter(isHandoff)).toHaveLength(2);
  });
});

describe('使えないとき', () => {
  it('「Claude にチェックリストを扱わせる」がオフなら、始めない。理由を返す', () => {
    enabled = false;
    expect(compact.start(ID)).toEqual({ ...IDLE, unavailable: 'checklist-off' });
    expect(host.submitted).toEqual([]);
    compact.refresh([ID]);
    expect(statuses).toEqual([{ ...IDLE, unavailable: 'checklist-off' }]);
  });

  it('このセッションの Claude Code にチェックリストの MCP が足されていなければ、始めない。引き継いだ claude（分からない）は始める', async () => {
    host.checklistMcp = false;
    expect(compact.start(ID).unavailable).toBe('no-checklist');
    expect(host.submitted).toEqual([]);
    host.checklistMcp = null;
    script();
    expect(compact.start(ID).unavailable).toBeNull();
    await finished();
  });
});
