import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '../src/shared/ipc';
import { IDLE_COMPACT_STATUS, midTurnPercent, type AutoCompactTrigger, type CompactStatus } from '../src/shared/optimized-compact';
import type { SessionState } from '../src/shared/session-tools';
import type { StatusLineInfo } from '../src/shared/statusline';
import { AppSettings } from '../src/main/app-settings';
import { AutoCompact, type AutoCompactHost } from '../src/main/auto-compact';
import { SUPPRESS_OUTPUT } from '../src/main/hook-output';
import { AUTO_COMPACT_STOP_COMMAND, StatusLineWatcher } from '../src/main/statusline';

// 最適化圧縮を自動で始める（main の AutoCompact）。いつ始めるか・ターンの途中で止めるファイル・続けて何度も起きないこと・
// Claude Code の自動の圧縮を止めるか

const ID = 's1';
// フックが何も決めないとき（アプリのフックの印だけを書く。hook-output.ts）
const NOTHING = `${SUPPRESS_OUTPUT}\n`;
let dir: string;
let watcher: StatusLineWatcher;
let state: SessionState | null;
let percent: number | null;
let summary: Partial<SessionSummary> | null;
let unavailable: CompactStatus['unavailable'];
let running: boolean;
let started: AutoCompactTrigger[];
let changes: string[];
let threshold: number;
let auto: AutoCompact;
let clock: number;
let interrupted: boolean;

const statusLine = (): StatusLineInfo | null =>
  percent === null ? null : { model: null, effort: null, version: null, context: { size: 200_000, usedPercent: percent, tokens: percent * 2000 }, rateLimits: null, costUsd: null, transcriptPath: null, updatedAt: 0 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-auto-compact-'));
  watcher = new StatusLineWatcher(dir, () => {});
  state = 'idle';
  percent = 10;
  summary = {};
  unavailable = null;
  running = false;
  started = [];
  changes = [];
  threshold = 80;
  clock = 1_000_000;
  interrupted = false;
  const host: AutoCompactHost = {
    summary: () => (summary ? ({ id: ID, archived: false, model: null, ...summary } as SessionSummary) : undefined),
    stateOf: () => state,
    statusLine,
    knowledge: () => ({ files: {}, contextTokens: null }),
    lastTurnInterrupted: () => interrupted,
  };
  auto = new AutoCompact({
    host,
    compact: {
      start: (_id, trigger) => {
        started.push(trigger);
        running = true;
        return IDLE_COMPACT_STATUS;
      },
      status: () => ({ ...IDLE_COMPACT_STATUS, unavailable }),
      running: () => running,
    },
    percent: () => threshold,
    stopFile: (id) => watcher.stopFileFor(id),
    stopHitFile: (id) => watcher.stopHitFileFor(id),
    onChange: (id) => changes.push(id),
    now: () => clock,
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// 1 ターン: 作業中になって、その割合で待機に戻る
function turn(at: number): void {
  state = 'working';
  percent = at;
  auto.check(ID);
  state = 'idle';
  auto.check(ID);
}
// 流れが終わった（成功か、取りやめ）
function finish(failure: Parameters<AutoCompact['finished']>[1], trigger: AutoCompactTrigger | null = started[started.length - 1] ?? null): void {
  running = false;
  auto.finished(ID, failure, trigger);
}
const stopFile = () => watcher.stopFileFor(ID);
const hitFile = () => watcher.stopHitFileFor(ID);
// ツールのあとのフックを、本物のコマンドで動かす
// input: フックの標準入力（Claude Code が渡す JSON）。Claude Code と同じく、パイプに書く。フックは、止めるファイルが無いときも
// 入力を最後まで読む（読まずに終わると、書き込みが EPIPE になる。Claude Code はそのフックを失敗として扱う。test/hook-output.test.ts）
const runHook = (input: Record<string, unknown> = { hook_event_name: 'PostToolUse', tool_name: 'Bash' }) =>
  execFileSync('sh', ['-c', AUTO_COMPACT_STOP_COMMAND], { env: { ...process.env, TANACODE_ASK_FILE: watcher.askFileFor(ID) }, encoding: 'utf8', input: JSON.stringify(input) });

describe('ターンの終わり', () => {
  it('待機に戻ったときに、設定の大きさを超えていたら始める（報告して待つ）。超えていなければ始めない', () => {
    turn(79);
    expect(started).toEqual([]);
    turn(83);
    expect(started).toEqual([{ percent: 83, midTurn: false }]);
  });

  it('最後の応答の使用量は、ターンの終わりより少し遅れて届く（statusLine）。10 秒までに届いた量で、超えていたら始める', () => {
    turn(20);
    // ターンが終わった時点では、まだ前の応答の量。3 秒後に、最後の応答の量が届く
    clock += 3000;
    percent = 85;
    auto.check(ID);
    expect(started).toEqual([{ percent: 85, midTurn: false }]);
  });

  it('ターンが終わってから時間がたって届いた量では、始めない（次のターンの終わりまで待つ）', () => {
    turn(20);
    clock += 11_000;
    percent = 85;
    auto.check(ID);
    expect(started).toEqual([]);
    turn(85);
    expect(started).toHaveLength(1);
  });

  it('アプリを起動した時点で超えていても、ターンが終わるまでは始めない', () => {
    percent = 95;
    auto.check(ID);
    auto.check(ID);
    expect(started).toEqual([]);
  });

  it('大きさの設定（40・60・80）で始める', () => {
    threshold = 40;
    turn(45);
    expect(started).toEqual([{ percent: 45, midTurn: false }]);
  });

  it('バックグラウンドのタスクの完了待ち（background）でも始める。許可の確認・質問の途中では始めない', () => {
    state = 'working';
    percent = 85;
    auto.check(ID);
    state = 'permission';
    auto.check(ID);
    expect(started).toEqual([]);
    state = 'background';
    auto.check(ID);
    expect(started).toHaveLength(1);
  });

  it('人が中断（Esc）して終わったターンでは、始めない（中断した人は、すぐ次の発言を打つ）。次のターンの終わりには始める', () => {
    interrupted = true;
    turn(85);
    clock += 3000;
    auto.check(ID);
    expect(started).toEqual([]);
    interrupted = false;
    turn(85);
    expect(started).toEqual([{ percent: 85, midTurn: false }]);
  });

  it('使用量が分からないあいだ（statusLine も会話ログの量も無い）は、始めない', () => {
    turn(null as unknown as number);
    expect(started).toEqual([]);
  });
});

describe('ターンの途中', () => {
  it('設定より 10 ポイント上（上限 90%）を超えたら、止めるファイルを書く。フックが、次のツールの切れ目で 1 回だけ中身を出す', () => {
    expect([midTurnPercent(40), midTurnPercent(60), midTurnPercent(80), midTurnPercent(85)]).toEqual([50, 70, 90, 90]);
    state = 'working';
    percent = 89;
    auto.check(ID);
    expect(existsSync(stopFile())).toBe(false);
    // ファイルが無ければ、フックは何も決めない（アプリのフックの印だけを書く）
    expect(runHook()).toBe(NOTHING);
    percent = 91;
    auto.check(ID);
    const stop = JSON.parse(readFileSync(stopFile(), 'utf8')) as { continue: boolean; stopReason: string };
    expect(stop.continue).toBe(false);
    expect(stop.stopReason).toContain('the context is 91% full');
    expect(JSON.parse(runHook())).toEqual(stop);
    // 2 回めは出さない（止めるのは 1 回だけ）。止めた印が残る
    expect(runHook()).toBe(NOTHING);
    expect(existsSync(stopFile())).toBe(false);
    expect(existsSync(hitFile())).toBe(true);
    // 止めたあと、割合が変わっても、書き直さない
    auto.check(ID);
    expect(existsSync(stopFile())).toBe(false);
  });

  it('フックが止めたターンが終わったら、続きを進める流れを始める。止めるファイルと印は片付ける', () => {
    state = 'working';
    percent = 92;
    auto.check(ID);
    runHook();
    state = 'idle';
    auto.check(ID);
    expect(started).toEqual([{ percent: 92, midTurn: true }]);
    expect(existsSync(stopFile()) || existsSync(hitFile())).toBe(false);
  });

  it('サブエージェントの中のツールの呼び出し（フックの入力に agent_id がある）では、止めない。本体の次のツールの切れ目で止める', () => {
    state = 'working';
    percent = 91;
    auto.check(ID);
    expect(runHook({ hook_event_name: 'PostToolUse', agent_id: 'aeefce232d4dcd1bd', agent_type: 'general-purpose', tool_name: 'Bash' })).toBe(NOTHING);
    expect(existsSync(stopFile())).toBe(true);
    expect(existsSync(hitFile())).toBe(false);
    expect(auto.stopping(ID)).toBe(false);
    // ツールの入力や結果に agent_id という文字があっても（JSON の中では " が \" になる）、本体のツールなら止める
    expect(JSON.parse(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { content: '{"agent_id":"x"}' } }))).toMatchObject({ continue: false });
    expect(existsSync(hitFile())).toBe(true);
  });

  it('フックが止めてから、流れが始まるまでは「止めている途中」（ほかのセッションからは、待機に戻っても作業中に見せる）', () => {
    expect(auto.stopping(ID)).toBe(false);
    state = 'working';
    percent = 91;
    auto.check(ID);
    // 止めるファイルを書いただけでは、まだ
    expect(auto.stopping(ID)).toBe(false);
    runHook();
    expect(auto.stopping(ID)).toBe(true);
    // ターンが終わって待機に戻っても、流れを始めるまでは続く
    state = 'idle';
    expect(auto.stopping(ID)).toBe(true);
    auto.check(ID);
    expect(started).toEqual([{ percent: 91, midTurn: true }]);
    expect(auto.stopping(ID)).toBe(false);
  });

  it('アプリが途中で止めたターンは、中断の印があっても、流れを始める（止めたままにしない）', () => {
    state = 'working';
    percent = 91;
    auto.check(ID);
    runHook();
    interrupted = true;
    state = 'idle';
    auto.check(ID);
    expect(started).toEqual([{ percent: 91, midTurn: true }]);
  });

  it('ツールの切れ目が来る前にターンが終わったら、ターンの終わりの切り替え（報告して待つ）にする', () => {
    state = 'working';
    percent = 92;
    auto.check(ID);
    state = 'idle';
    auto.check(ID);
    expect(started).toEqual([{ percent: 92, midTurn: false }]);
    expect(existsSync(stopFile())).toBe(false);
  });
});

describe('続けて何度も起きない', () => {
  it('流れが進んでいる間は、始めない。止めるファイルも書かない', () => {
    turn(85);
    expect(started).toHaveLength(1);
    // 仕上げのターン・再開のターン
    turn(95);
    state = 'working';
    auto.check(ID);
    expect(started).toHaveLength(1);
    expect(existsSync(stopFile())).toBe(false);
  });

  it('切り替えたあとは、割合が「設定より 10 ポイント下」を一度下回るまで、始めない', () => {
    turn(85);
    finish(null);
    // 切り替えた直後に、まだ超えている
    turn(82);
    turn(75);
    turn(88);
    expect(started).toHaveLength(1);
    turn(69);
    turn(81);
    expect(started).toHaveLength(2);
  });

  it('取りやめた・失敗したときは、次のターンの終わりにもう 1 回だけ試す。続けて 2 回だめなら休む。休んだことを知らせる', () => {
    turn(85);
    finish('not-used');
    expect(auto.status(ID)).toEqual({ percent: 80, paused: false });
    expect(started).toHaveLength(1);
    // すぐには始めない（次のターンの終わりまで）
    auto.check(ID);
    expect(started).toHaveLength(1);
    turn(86);
    expect(started).toHaveLength(2);
    finish('interrupted');
    expect(auto.status(ID).paused).toBe(true);
    expect(changes).toEqual([ID]);
    turn(95);
    turn(96);
    expect(started).toHaveLength(2);
    // 休んでいる間は、ターンの途中でも止めない
    state = 'working';
    auto.check(ID);
    expect(existsSync(stopFile())).toBe(false);
  });

  it('1 回取りやめたあとに成功したら、数え直す', () => {
    turn(85);
    finish('prompted');
    turn(85);
    finish(null);
    turn(50);
    turn(85);
    finish('busy');
    expect(auto.status(ID).paused).toBe(false);
  });

  it('休んでいても、手動で成功するか、トグルを入れ直すと戻る', () => {
    turn(85);
    finish('busy');
    turn(85);
    finish('busy');
    expect(auto.status(ID).paused).toBe(true);
    finish(null, null);
    expect(auto.status(ID).paused).toBe(false);
    expect(changes).toEqual([ID, ID]);
    turn(50);
    turn(85);
    finish('busy');
    turn(85);
    finish('busy');
    expect(auto.status(ID).paused).toBe(true);
    auto.toggled(ID);
    expect(auto.status(ID).paused).toBe(false);
    turn(85);
    expect(started).toHaveLength(5);
  });

  it('手動の流れが取りやめになっても、自動の失敗には数えない', () => {
    finish('interrupted', null);
    finish('interrupted', null);
    expect(auto.status(ID).paused).toBe(false);
  });
});

describe('使えないとき', () => {
  it('トグルがオフのセッションでは、始めない・止めない。書いてあった止めるファイルは片付ける', () => {
    state = 'working';
    percent = 95;
    auto.check(ID);
    expect(existsSync(stopFile())).toBe(true);
    summary = { autoCompact: false };
    auto.toggled(ID);
    expect(existsSync(stopFile())).toBe(false);
    state = 'idle';
    auto.check(ID);
    expect(started).toEqual([]);
    expect(auto.preCompact(ID)).toBe('');
  });

  it('「Claude にチェックリストを扱わせる」がオフ・チェックリストの MCP が無いセッションでは、始めない・止めない', () => {
    unavailable = 'checklist-off';
    turn(95);
    expect(started).toEqual([]);
    expect(auto.preCompact(ID)).toBe('');
    unavailable = 'no-checklist';
    turn(95);
    expect(started).toEqual([]);
  });

  it('ターミナルモードの間は、始めない・止めない（Claude Code の自動の圧縮を止めない）。書いてあった止めるファイルは片付ける', () => {
    // TUI では状態が terminal で、流れ（仕上げ・/clear・再開の文）を進められない。Claude Code の圧縮まで止めると、どちらの圧縮も起きない
    state = 'working';
    percent = 95;
    auto.check(ID);
    expect(existsSync(stopFile())).toBe(true);
    summary = { terminal: true };
    state = 'terminal';
    auto.check(ID);
    expect(existsSync(stopFile())).toBe(false);
    expect(auto.preCompact(ID)).toBe('');
    expect(started).toEqual([]);
  });

  it('アーカイブした・終了した・一覧から消したセッションは、何もしない（止めるファイルも片付ける）', () => {
    state = 'working';
    percent = 95;
    auto.check(ID);
    writeFileSync(hitFile(), '{}');
    state = 'exited';
    auto.check(ID);
    expect(existsSync(stopFile()) || existsSync(hitFile())).toBe(false);
    state = null;
    auto.check(ID);
    expect(started).toEqual([]);
  });
});

describe('Claude Code の自動の圧縮が先に始まろうとした（PreCompact）', () => {
  it('自動がオンで使えるセッションなら、止める理由を返す。作業中なら、次のツールの切れ目で止めて、同じ流れに入る', () => {
    state = 'working';
    percent = 70;
    auto.check(ID);
    expect(auto.preCompact(ID)).toContain('tanacode resets the conversation');
    // 割合が設定に届いていなくても、止める
    expect(existsSync(stopFile())).toBe(true);
    runHook();
    state = 'idle';
    auto.check(ID);
    expect(started).toEqual([{ percent: 70, midTurn: true }]);
  });

  it('ツールの切れ目が無いままターンが終わったら、ターンの終わりに始める', () => {
    state = 'working';
    percent = 70;
    auto.check(ID);
    auto.preCompact(ID);
    state = 'idle';
    auto.check(ID);
    expect(started).toEqual([{ percent: 70, midTurn: false }]);
  });

  it('流れの途中（仕上げのターン）なら、止めるだけ', () => {
    turn(85);
    expect(auto.preCompact(ID)).not.toBe('');
    expect(existsSync(stopFile())).toBe(false);
    expect(started).toHaveLength(1);
  });

  it('切り替えたばかりで、まだ割合が下がっていないときは止めない（止めても切り替えられない。切り替えを繰り返さない）', () => {
    turn(97);
    finish(null);
    // 再開のターンでも、まだ大きい
    state = 'working';
    auto.check(ID);
    expect(auto.preCompact(ID)).toBe('');
    state = 'idle';
    auto.check(ID);
    expect(started).toHaveLength(1);
    // 下がったあとは、また止める
    turn(50);
    state = 'working';
    auto.check(ID);
    expect(auto.preCompact(ID)).not.toBe('');
  });

  it('休んでいるセッションでは止めない（Claude Code の自動の圧縮に任せる。上限で詰まらないように）', () => {
    turn(85);
    finish('busy');
    turn(85);
    finish('busy');
    expect(auto.blocks(ID)).toBe(false);
    expect(auto.preCompact(ID)).toBe('');
  });

  it('止めるか（blocks。作業中の表示で圧縮中にしないために聞く）は、止めるとき（preCompact）と同じ決まりで答え、状態を変えない', () => {
    state = 'working';
    percent = 70;
    auto.check(ID);
    expect(auto.blocks(ID)).toBe(true);
    // 聞いただけでは、止めるファイルを書かず、流れにも入らない
    expect(existsSync(stopFile())).toBe(false);
    state = 'idle';
    auto.check(ID);
    expect(started).toEqual([]);
    // 流れの途中は止める。切り替えたばかりで、まだ割合が下がっていなければ止めない
    turn(97);
    expect(auto.blocks(ID)).toBe(true);
    finish(null);
    expect(auto.blocks(ID)).toBe(false);
    expect(auto.preCompact(ID)).toBe('');
    // トグルがオフなら止めない
    turn(50);
    expect(auto.blocks(ID)).toBe(true);
    summary = { autoCompact: false };
    expect(auto.blocks(ID)).toBe(false);
  });
});

describe('自動で始める大きさの設定', () => {
  it('アプリの設定（settings.json）に覚える。既定は 80%。選べる値（40・60・80）のほかは、既定に戻す', () => {
    const file = join(dir, 'settings.json');
    expect(new AppSettings(file).autoCompactPercent()).toBe(80);
    new AppSettings(file).setAutoCompactPercent(40);
    expect(new AppSettings(file).autoCompactPercent()).toBe(40);
    expect(JSON.parse(readFileSync(file, 'utf8')).autoCompactPercent).toBe(40);
    writeFileSync(file, JSON.stringify({ version: 1, autoCompactPercent: 55 }));
    expect(new AppSettings(file).autoCompactPercent()).toBe(80);
    writeFileSync(file, JSON.stringify({ version: 1, autoCompactPercent: '60' }));
    expect(new AppSettings(file).autoCompactPercent()).toBe(80);
  });
});
