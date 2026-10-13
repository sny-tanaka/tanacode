import { beforeEach, describe, expect, it } from 'vitest';
import { CompactNotice } from '../src/main/compact-notice';

// 最適化圧縮の流れの間の、人への完了の通知（main の CompactNotice）。流れの途中のターンの終わりでは鳴らさず、
// 流れが最後まで終わったときに 1 回だけ知らせる

const ID = 's1';
const AT_TURN_END = { percent: 83, midTurn: false };
const MID_TURN = { percent: 92, midTurn: true };
let compacting: Set<string>;
let notice: CompactNotice;

beforeEach(() => {
  compacting = new Set();
  notice = new CompactNotice((id) => compacting.has(id));
});

describe('CompactNotice', () => {
  it('流れの外のターンの終わりは、ふつうの完了', () => {
    expect(notice.turnEnded(ID)).toBe('work');
    expect(notice.turnEnded(ID)).toBe('work');
  });

  it('手動: 仕上げのターンの終わり（このあと /clear）では出さず、再開のターンの終わりに、最適化の完了を 1 回だけ出す', () => {
    compacting.add(ID);
    expect(notice.turnEnded(ID)).toBeNull();
    // 再開の文のターンが始まると、流れは終わる
    compacting.delete(ID);
    expect(notice.finished(ID, null, null)).toBe(false);
    expect(notice.turnEnded(ID)).toBe('compact');
    // 次のターンからは、ふつうの完了
    expect(notice.turnEnded(ID)).toBe('work');
  });

  it('ターンの終わりの自動: 手動と同じく、再開のターンの終わりに最適化の完了を出す', () => {
    // 作業のターンの終わり（まだ流れは始まっていない）は、ふつうの完了
    expect(notice.turnEnded(ID)).toBe('work');
    compacting.add(ID);
    expect(notice.turnEnded(ID)).toBeNull();
    compacting.delete(ID);
    expect(notice.finished(ID, null, AT_TURN_END)).toBe(false);
    expect(notice.turnEnded(ID)).toBe('compact');
  });

  it('ターンの途中で止めた自動: 止めたターンと仕上げのターンでは出さず、続きのターンの終わりに、ふつうの完了を出す', () => {
    compacting.add(ID);
    expect(notice.turnEnded(ID)).toBeNull();
    expect(notice.turnEnded(ID)).toBeNull();
    compacting.delete(ID);
    expect(notice.finished(ID, null, MID_TURN)).toBe(false);
    expect(notice.turnEnded(ID)).toBe('work');
  });

  it('取りやめた・失敗した: 途中で出さなかった通知があれば、取りやめたことを知らせる。無ければ知らせない', () => {
    // 仕上げのターンは終わったのに、切り替えられなかった
    compacting.add(ID);
    expect(notice.turnEnded(ID)).toBeNull();
    compacting.delete(ID);
    expect(notice.finished(ID, 'not-used', null)).toBe(true);
    // 取りやめたあとのターンは、ふつうの完了（最適化の完了にはしない）
    expect(notice.turnEnded(ID)).toBe('work');
    // 仕上げの頼みを送れなかった（ターンは終わっていない）
    expect(notice.finished(ID, 'busy', AT_TURN_END)).toBe(false);
    // 仕上げの間に人が発言した（仕上げのターンは、流れが終わったあとに終わる）
    compacting.add(ID);
    compacting.delete(ID);
    expect(notice.finished(ID, 'prompted', null)).toBe(false);
    expect(notice.turnEnded(ID)).toBe('work');
  });

  it('出さなかった印は、1 回の流れで使い切る（次の流れの取りやめに持ち越さない）', () => {
    compacting.add(ID);
    expect(notice.turnEnded(ID)).toBeNull();
    compacting.delete(ID);
    expect(notice.finished(ID, null, null)).toBe(false);
    expect(notice.turnEnded(ID)).toBe('compact');
    expect(notice.finished(ID, 'busy', null)).toBe(false);
    // アプリが止めたターンが、流れに入らなかった（止めた直後に「自動」をオフにしたなど）ときも、次のターンで印を消す
    compacting.add(ID);
    expect(notice.turnEnded(ID)).toBeNull();
    compacting.delete(ID);
    expect(notice.turnEnded(ID)).toBe('work');
    expect(notice.finished(ID, 'busy', null)).toBe(false);
  });

  it('セッションごとに別々に数える。終了したセッションの印は捨てる', () => {
    compacting.add(ID);
    expect(notice.turnEnded(ID)).toBeNull();
    expect(notice.turnEnded('s2')).toBe('work');
    compacting.delete(ID);
    expect(notice.finished(ID, null, null)).toBe(false);
    expect(notice.turnEnded('s2')).toBe('work');
    notice.forget(ID);
    expect(notice.turnEnded(ID)).toBe('work');
    compacting.add(ID);
    expect(notice.turnEnded(ID)).toBeNull();
    notice.forget(ID);
    compacting.delete(ID);
    expect(notice.finished(ID, 'exited', null)).toBe(false);
  });
});
