import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../src/shared/chat';
import type { Checklist } from '../src/shared/checklist';
import { HANDOFF_TAG, RESUME_TAG, type CarriedTask, type CompactStatus } from '../src/shared/optimized-compact';
import type { SessionState } from '../src/shared/session-tools';
import { OptimizedCompact, type CompactHost } from '../src/main/optimized-compact';

// 最適化圧縮の流れ（main の OptimizedCompact）。仕上げ → /clear → 再開の文、と進むこと・怪しいときは会話を消さずに取りやめること

const ID = 's1';
const TIMINGS = { pollMs: 2, submitMs: 30, appearMs: 200, clearMs: 60, retryMs: 5, pulledBackMs: 30 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// SessionManager の代わり。打ち込まれた文を控え、台本（onSubmit）で会話を進める
class FakeHost implements CompactHost {
  state: SessionState | null = 'idle';
  events: ChatEvent[] = [{ type: 'user', id: 'u0', text: '税率を可変にして' }, { type: 'assistant-text', id: 'a0', text: 'はい' }, { type: 'turn-end' }];
  claudeSession = 'conv-1';
  checklistMcp: boolean | null = true;
  tasks: CarriedTask[] = [];
  submitted: string[] = [];
  withdrawn = 0;
  // 仕上げの頼みが、Claude Code の入力欄に出ている
  draftShown = false;
  // 打ち込みを断る理由（あれば、その回は失敗する）
  refuse: (text: string) => boolean = () => false;
  onSubmit: (text: string) => void = () => {};

  stateOf = () => this.state;
  conversation = async () => [...this.events];
  claudeSessionOf = () => this.claudeSession;
  hasChecklistMcp = () => this.checklistMcp;
  runningTasks = () => this.tasks;
  compactDraftShown = () => this.draftShown;
  async submitWhenReady(_id: string, text: string): Promise<void> {
    if (this.refuse(text)) throw new Error('busy');
    this.submitted.push(text);
    this.onSubmit(text);
  }
  async withdrawCompactDraft(): Promise<void> {
    this.withdrawn += 1;
  }
}

let host: FakeHost;
let statuses: CompactStatus[];
let used: boolean;
let enabled: boolean;
let lists: Checklist[];
let compact: OptimizedCompact;

beforeEach(() => {
  host = new FakeHost();
  statuses = [];
  used = true;
  enabled = true;
  lists = [];
  compact = new OptimizedCompact({
    host,
    lists: () => lists,
    usedSince: () => used,
    enabled: () => enabled,
    onChange: (_id, status) => statuses.push(status),
    timings: TIMINGS,
  });
});
afterEach(() => compact.dispose());

const handoff = (): ChatEvent => ({ type: 'notice', id: `h${host.events.length}`, text: '仕上げ', compact: 'handoff' });
const isHandoff = (text: string) => text.startsWith(`<${HANDOFF_TAG}>`);
const isResume = (text: string) => text.startsWith(`<${RESUME_TAG}>`);

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
    expect(compact.start(ID)).toEqual({ phase: 'finalizing', failure: null, unavailable: null });
    expect(await finished()).toEqual({ phase: null, failure: null, unavailable: null });
    expect(host.submitted).toHaveLength(3);
    expect(isHandoff(host.submitted[0])).toBe(true);
    expect(host.submitted[1]).toBe('/clear');
    expect(isResume(host.submitted[2])).toBe(true);
    expect(host.submitted[2]).toContain('<user-message>\n税率を可変にして\n</user-message>');
    expect(host.submitted[2]).toContain('## #1 tax.ts の途中\n次はテスト');
    expect(host.submitted[2]).toContain('- Bash: npm run dev');
    expect(phases()).toEqual(['finalizing', 'clearing', 'resuming', null]);
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
    expect(host.withdrawn).toBe(1);
  });

  it('応答の前に中断して、仕上げの頼みが入力欄に戻された（会話から消えた）。入力欄から消す', async () => {
    script({
      afterHandoff: () => {
        host.events = host.events.filter((e) => !(e.type === 'notice' && e.compact));
        host.state = 'idle';
      },
    });
    compact.start(ID);
    await cancelled('interrupted');
    expect(host.withdrawn).toBe(1);
  });

  it('会話ログに書かれる前に中断して、会話に出ないまま入力欄に戻された。入力欄から消す', async () => {
    host.onSubmit = () => setTimeout(() => (host.draftShown = true), 5);
    compact.start(ID);
    await cancelled('interrupted');
    expect(host.withdrawn).toBe(1);
  });

  it('送った直後に、入力欄に一瞬出ているだけなら、中断とみなさない', async () => {
    script();
    const submit = host.onSubmit;
    host.onSubmit = (text) => {
      if (isHandoff(text)) {
        host.draftShown = true;
        setTimeout(() => (host.draftShown = false), 10);
        // 会話に出るのは、入力欄から消えたあと
        setTimeout(() => submit(text), 15);
      } else submit(text);
    };
    compact.start(ID);
    expect((await finished()).failure).toBeNull();
  });

  it('仕上げの間に人が発言した（順番待ちの発言も）', async () => {
    script({ afterHandoff: () => host.events.push({ type: 'queue', prompts: ['ちょっと待って'] }) });
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

  it('仕上げの頼みを送れなかった・送っても会話に出なかった（入力欄に残っていれば消す）', async () => {
    host.refuse = isHandoff;
    compact.start(ID);
    await cancelled('busy');
    statuses = [];
    host.refuse = () => false;
    host.onSubmit = () => {};
    compact.start(ID);
    await cancelled('busy');
    expect(host.withdrawn).toBe(1);
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

describe('使えないとき', () => {
  it('「Claude にチェックリストを扱わせる」がオフなら、始めない。理由を返す', () => {
    enabled = false;
    expect(compact.start(ID)).toEqual({ phase: null, failure: null, unavailable: 'checklist-off' });
    expect(host.submitted).toEqual([]);
    compact.refresh([ID]);
    expect(statuses).toEqual([{ phase: null, failure: null, unavailable: 'checklist-off' }]);
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
