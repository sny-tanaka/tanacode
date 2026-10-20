import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../src/shared/chat';
import { autoHandoffText, handoffText, parseCompactMessage, resumeText } from '../src/shared/optimized-compact';
import { CompactNotice, continuesWork, resumeContinued, turnStarterOf } from '../src/main/compact-notice';

// 最適化圧縮の流れの間の、人への完了の通知（main の CompactNotice）。流れの途中のターンの終わりでは鳴らさず、
// 流れが最後まで終わったときに 1 回だけ知らせる

const ID = 's1';
// アプリがターンの途中で止めたターンが、終わるところのセッション
let stopped: Set<string>;
let notice: CompactNotice;

beforeEach(() => {
  stopped = new Set();
  notice = new CompactNotice((id) => stopped.has(id));
});

describe('turnStarterOf', () => {
  // 会話ログから作る知らせと同じく、全文（囲みの中）と、囲みの属性から読んだ始まり方を持たせる
  const compact = (kind: 'handoff' | 'resume', text: string): ChatEvent => {
    const { body, trigger } = parseCompactMessage(text)!;
    return { type: 'notice', id: 'n1', text: '最適化圧縮', detail: body, compact: kind, trigger };
  };
  const RESUME = { lists: [], messages: [], tasks: [] };

  it('仕上げの頼みは handoff（手動も、自動も、ターンの途中で止めたものも）', () => {
    expect(turnStarterOf(compact('handoff', handoffText()))).toBe('handoff');
    expect(turnStarterOf(compact('handoff', autoHandoffText({ percent: 83, midTurn: false })))).toBe('handoff');
    expect(turnStarterOf(compact('handoff', autoHandoffText({ percent: 92, midTurn: true })))).toBe('handoff');
  });

  it('手動・ターンの終わりの自動の再開の文は resume（作業を続けたかは、そのあとのツールで分かる）。ターンの途中で止めた自動の再開の文は、作業の続きなので other', () => {
    expect(turnStarterOf(compact('resume', resumeText(RESUME)))).toBe('resume');
    expect(turnStarterOf(compact('resume', resumeText({ ...RESUME, auto: { percent: 83, midTurn: false } })))).toBe('resume');
    expect(turnStarterOf(compact('resume', resumeText({ ...RESUME, auto: { percent: 92, midTurn: true } })))).toBe('other');
    // 全文が無い再開の知らせは、報告して待つものとして扱う
    expect(turnStarterOf({ type: 'notice', id: 'n1', text: '最適化圧縮', compact: 'resume' })).toBe('resume');
  });

  it('再開の文のターンで、チェックリスト以外のツールを使ったら、作業を続けた。チェックリストのツールと ToolSearch だけなら、報告して待った', () => {
    const tool = (name: string): ChatEvent => ({ type: 'tool-use', id: name, name, target: '', input: '' });
    expect(continuesWork(tool('Bash'))).toBe(true);
    expect(continuesWork(tool('Edit'))).toBe(true);
    expect(continuesWork(tool('mcp__tanacode-sessions__get_session'))).toBe(true);
    expect(continuesWork(tool('mcp__tanacode-checklist__checklist_overview'))).toBe(false);
    expect(continuesWork(tool('mcp__tanacode-checklist__card_update'))).toBe(false);
    expect(continuesWork(tool('ToolSearch'))).toBe(false);
    expect(continuesWork({ type: 'assistant-text', id: 'a', text: '引き継ぎました' })).toBe(false);
    const resume = (auto?: { percent: number; midTurn: boolean }) => compact('resume', resumeText({ ...RESUME, ...(auto ? { auto } : {}) })) as Extract<ChatEvent, { type: 'notice' }>;
    const said: ChatEvent = { type: 'assistant-text', id: 'a', text: '引き継ぎました。答えを待っています' };
    expect(resumeContinued(resume(), [tool('ToolSearch'), tool('mcp__tanacode-checklist__checklist_overview'), said])).toBe(false);
    expect(resumeContinued(resume({ percent: 83, midTurn: false }), [tool('mcp__tanacode-checklist__checklist_overview'), tool('Bash')])).toBe(true);
    // 途中で止めた切り替えは、ツールを使わなくても作業の続き
    expect(resumeContinued(resume({ percent: 92, midTurn: true }), [said])).toBe(true);
  });

  it('人の発言・ほかの知らせ・ほかのセッションからの知らせは other', () => {
    expect(turnStarterOf({ type: 'user', id: 'u1', text: '税率を可変にして' })).toBe('other');
    expect(turnStarterOf({ type: 'notice', id: 'n1', text: 'バックグラウンドのタスクが終わりました' })).toBe('other');
    expect(turnStarterOf({ type: 'turn-start' })).toBe('other');
  });
});

describe('CompactNotice', () => {
  it('ふつうのターンの終わりは、作業の完了', () => {
    expect(notice.turnEnded(ID, 'other')).toBe('work');
    expect(notice.turnEnded(ID, 'other')).toBe('work');
  });

  it('手動: 仕上げのターンの終わり（このあと /clear）では出さず、再開のターンの終わりに、最適化の完了を 1 回だけ出す', () => {
    expect(notice.turnEnded(ID, 'handoff')).toBeNull();
    expect(notice.finished(ID, null)).toBe(false);
    expect(notice.turnEnded(ID, 'resume')).toBe('compact');
    // 次のターンからは、作業の完了
    expect(notice.turnEnded(ID, 'other')).toBe('work');
  });

  it('ターンの終わりの自動: 作業のターンの終わりは、流れが始まったあとに届いても、作業の完了として出す', () => {
    // 流れは、作業のターンが終わってすぐに始まる。会話ログのターンの終わりは、そのあとに届くことがある
    expect(notice.turnEnded(ID, 'other')).toBe('work');
    expect(notice.turnEnded(ID, 'handoff')).toBeNull();
    expect(notice.finished(ID, null)).toBe(false);
    expect(notice.turnEnded(ID, 'resume')).toBe('compact');
  });

  it('ターンの途中で止めた自動: 止めたターンと仕上げのターンでは出さず、続きのターンの終わりに、作業の完了を出す', () => {
    stopped.add(ID);
    expect(notice.turnEnded(ID, 'other')).toBeNull();
    expect(notice.turnEnded(ID, 'handoff')).toBeNull();
    // 再開の文のターンが始まると、流れは終わる。続きを進めさせる再開の文は other
    stopped.delete(ID);
    expect(notice.finished(ID, null)).toBe(false);
    expect(notice.turnEnded(ID, 'other')).toBe('work');
  });

  it('取りやめた・失敗した: 途中で出さなかった通知があれば、取りやめたことを知らせる。無ければ知らせない', () => {
    // 仕上げのターンは終わったのに、切り替えられなかった
    expect(notice.turnEnded(ID, 'handoff')).toBeNull();
    expect(notice.finished(ID, 'not-used')).toBe(true);
    // 取りやめたあとのターンは、作業の完了
    expect(notice.turnEnded(ID, 'other')).toBe('work');
    // 仕上げの頼みを送れなかった（ターンは終わっていない）
    expect(notice.finished(ID, 'busy')).toBe(false);
    // アプリが止めたターンは終わったのに、仕上げの頼みを送れなかった（作業が、止まったままになる）
    stopped.add(ID);
    expect(notice.turnEnded(ID, 'other')).toBeNull();
    stopped.delete(ID);
    expect(notice.finished(ID, 'busy')).toBe(true);
  });

  it('出さなかった印は、1 回の流れで使い切る（次の流れの取りやめに持ち越さない）', () => {
    expect(notice.turnEnded(ID, 'handoff')).toBeNull();
    expect(notice.finished(ID, null)).toBe(false);
    expect(notice.finished(ID, 'busy')).toBe(false);
    // 仕上げの間に人が発言して取りやめたあとに、仕上げのターンが終わった（流れは、もう終わっている）。次のターンの終わりで、印を消す
    expect(notice.finished(ID, 'prompted')).toBe(false);
    expect(notice.turnEnded(ID, 'handoff')).toBeNull();
    expect(notice.turnEnded(ID, 'other')).toBe('work');
    expect(notice.finished(ID, 'busy')).toBe(false);
  });

  it('セッションごとに別々に数える。終了したセッションの印は捨てる', () => {
    expect(notice.turnEnded(ID, 'handoff')).toBeNull();
    expect(notice.turnEnded('s2', 'other')).toBe('work');
    expect(notice.finished('s2', 'busy')).toBe(false);
    notice.forget(ID);
    expect(notice.finished(ID, 'exited')).toBe(false);
  });
});
