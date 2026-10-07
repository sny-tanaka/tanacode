import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRun } from '@shared/subagent';
import { SubagentTracker } from '../src/main/subagent-tracker';

// Agent ツールで起動したサブエージェントの追跡（SubagentTracker）。
// ファイルと行の形は、Claude Code 2.1.292 をモックの API で動かして取ったもの（<セッション>/subagents/agent-<id>.meta.json と
// agent-<id>.jsonl、Agent・SendMessage の結果の toolUseResult）に合わせた。2.1.292 では Agent はいつもバックグラウンドで動き
// （run_in_background: false でも async_launched）、meta.json に model は無い。前で動いて結果を返す形（totalToolUseCount など）と、
// meta.json の model は、その会話ログに出なかったので、src の読み取りに合わせて組み立てた

const CWD = '/work/app';
const AGENT_ID = 'acc4e89e2bbe86674';
let root: string;
let sessionDir: string;
let subagentsDir: string;
let runs: SubagentRun[][];
let tracker: SubagentTracker;
const latest = () => runs.at(-1) ?? [];
const run = (toolUseId: string) => tracker.all().find((r) => r.toolUseId === toolUseId);

const meta = (agentId: string, data: Record<string, unknown>) => writeFileSync(join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify(data));
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const toolUseLine = (id: string, name: string, input: Record<string, unknown>) =>
  line({ parentUuid: 'p', isSidechain: true, agentId: AGENT_ID, message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] }, type: 'assistant', uuid: `u_${id}` });
const log = (agentId: string) => join(subagentsDir, `agent-${agentId}.jsonl`);
// 会話ログの頭（2.1.292 の形。attachment と、仕事の発言）
const HEAD =
  line({ parentUuid: null, isSidechain: true, agentId: AGENT_ID, attachment: { type: 'session_context', context: {} }, type: 'attachment', uuid: 'h1' }) +
  line({ parentUuid: null, isSidechain: true, agentId: AGENT_ID, type: 'user', message: { role: 'user', content: 'サブエージェントの仕事です' }, uuid: 'h2' });
// 起動の結果（2.1.292 の Agent の toolUseResult）
const LAUNCHED = {
  isAsync: true,
  status: 'async_launched',
  agentId: AGENT_ID,
  description: '調べもの',
  resolvedModel: 'claude-opus-5-5',
  prompt: 'サブエージェントの仕事です',
  outputFile: `/tmp/claude-0/-work-app/s1/tasks/${AGENT_ID}.output`,
  canReadOutputFile: true,
};
const poll = () => (tracker as unknown as { poll: () => Promise<void> }).poll();
const timer = () => (tracker as unknown as { timer: NodeJS.Timeout | null }).timer;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-subagent-'));
  sessionDir = join(root, 's1');
  subagentsDir = join(sessionDir, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  runs = [];
  tracker = new SubagentTracker(CWD, (next) => runs.push(next));
});

afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('SubagentTracker', () => {
  it('起動すると実行中として知らせ、meta.json の toolUseId で会話ログを見つけて、ツールの回数と直近 5 つを読む', async () => {
    tracker.start('toolu_agent', sessionDir, true, '調べもの');
    expect(latest()).toEqual([
      expect.objectContaining({ toolUseId: 'toolu_agent', agentId: null, description: '調べもの', background: true, state: 'running', model: null, toolCalls: 0, recent: [] }),
    ]);
    expect(timer()).not.toBeNull();
    // 同じ ID をもう一度始めても増えない
    tracker.start('toolu_agent', sessionDir, true, '調べもの');
    expect(runs).toHaveLength(1);
    // まだ meta.json が無い
    await poll();
    expect(run('toolu_agent')?.agentId).toBeNull();
    // ほかのエージェント・読めない meta.json・meta.json でないファイルしか無い
    meta('other', { agentType: 'general-purpose', description: '別', toolUseId: 'toolu_other' });
    writeFileSync(join(subagentsDir, 'agent-broken.meta.json'), '{');
    writeFileSync(join(subagentsDir, 'notes.txt'), '');
    await poll();
    expect(run('toolu_agent')?.agentId).toBeNull();

    meta(AGENT_ID, { agentType: 'general-purpose', description: '調べもの', toolUseId: 'toolu_agent', spawnDepth: 1, requestShape: 'background', requestNonInteractive: true });
    // まだ会話ログが無い
    await poll();
    expect(run('toolu_agent')).toMatchObject({ agentId: AGENT_ID, toolCalls: 0, model: null });

    writeFileSync(
      log(AGENT_ID),
      HEAD +
        toolUseLine('t1', 'Bash', { command: 'echo sub-agent', description: 'サブの作業' }) +
        line({ type: 'user', isSidechain: true, message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'sub-agent' }] } }) +
        '書きかけでない、壊れた行\n' +
        line({ type: 'assistant', message: { content: 'ブロックでない応答' } }) +
        line({ type: 'assistant', message: { content: [{ type: 'text', text: '途中経過' }, { type: 'tool_use', id: 'x', input: {} }] } }) +
        toolUseLine('t2', 'Read', { file_path: `${CWD}/note.txt` }) +
        toolUseLine('t3', 'Grep', { pattern: 'TODO' }) +
        toolUseLine('t4', 'Glob', { pattern: '**/*.ts' }) +
        toolUseLine('t5', 'WebFetch', { url: 'https://example.com/a' }) +
        // 書きかけの行（改行がまだ無い）は、次に読む
        toolUseLine('t6', 'Edit', { file_path: `${CWD}/src/a.ts` }).trimEnd(),
    );
    const before = runs.length;
    await poll();
    expect(runs.length).toBe(before + 1);
    expect(run('toolu_agent')).toMatchObject({
      toolCalls: 5,
      recent: [
        { name: 'Bash', target: 'echo sub-agent' },
        { name: 'Read', target: 'note.txt' },
        { name: 'Grep', target: 'TODO' },
        { name: 'Glob', target: '**/*.ts' },
        { name: 'WebFetch', target: 'https://example.com/a' },
      ],
    });
    // 書き終わった行と、入力の無いツール。直近は 5 つまで
    appendFileSync(log(AGENT_ID), `\n${line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't7', name: 'TodoRead' }] } })}`);
    await poll();
    expect(run('toolu_agent')).toMatchObject({ toolCalls: 7 });
    expect(run('toolu_agent')!.recent.map((r) => r.name)).toEqual(['Grep', 'Glob', 'WebFetch', 'Edit', 'TodoRead']);
    expect(run('toolu_agent')!.recent.at(-2)).toEqual({ name: 'Edit', target: 'src/a.ts' });
    // 変わっていなければ知らせない
    const settled = runs.length;
    await poll();
    expect(runs.length).toBe(settled);
    // 会話ログの場所
    expect(tracker.logFile('toolu_agent', '/fallback')).toBe(log(AGENT_ID));
    expect(tracker.logFile('toolu_unknown', '/fallback')).toBeNull();
  });

  it('meta.json に model があれば使う（起動の結果の resolvedModel があればそちら）', async () => {
    tracker.start('toolu_m', sessionDir, false, null);
    meta('m1', { toolUseId: 'toolu_m', model: 'claude-haiku-9' });
    await poll();
    expect(run('toolu_m')).toMatchObject({ agentId: 'm1', model: 'claude-haiku-9' });
    // 起動の結果に agentId が無くても、resolvedModel は使う。会話ログは meta.json で見つける
    tracker.start('toolu_n', sessionDir, false, null);
    tracker.finish('toolu_n', { status: 'async_launched', resolvedModel: 'claude-opus-5-5' }, false, false);
    meta('n1', { toolUseId: 'toolu_n', model: 'claude-haiku-9' });
    await poll();
    expect(run('toolu_n')).toMatchObject({ agentId: 'n1', model: 'claude-opus-5-5' });
  });

  it('バックグラウンドの起動の結果では実行中のまま。完了通知で終わり、使用量と結果（長いものは切り詰め）を入れる', () => {
    tracker.start('toolu_agent', sessionDir, false, '調べもの');
    tracker.finish('toolu_agent', LAUNCHED, false, false);
    expect(run('toolu_agent')).toMatchObject({ agentId: AGENT_ID, model: 'claude-opus-5-5', background: true, state: 'running' });
    tracker.notified('toolu_agent', 'completed', 'サブエージェントの結果', { durationMs: 1746, totalTokens: 120, toolUses: 2 });
    expect(run('toolu_agent')).toMatchObject({ state: 'done', durationMs: 1746, tokens: 120, toolCalls: 2, result: 'サブエージェントの結果' });

    tracker.start('toolu_long', sessionDir, true, null);
    const long = 'あ'.repeat(3001);
    tracker.notified('toolu_long', 'failed', long);
    expect(run('toolu_long')!.result).toBe(`${'あ'.repeat(3000)}\n…（省略）`);
    expect(run('toolu_long')!.state).toBe('failed');
    // 使用量が付いていなければ、起動を見た時刻から求める
    expect(run('toolu_long')!.durationMs).toBeGreaterThanOrEqual(0);
    expect(run('toolu_long')!.tokens).toBeNull();

    tracker.start('toolu_killed', sessionDir, true, null);
    tracker.notified('toolu_killed', 'killed', null);
    expect(run('toolu_killed')).toMatchObject({ state: 'stopped', result: null });
    // 追っていないものの通知は無視する
    const before = runs.length;
    tracker.notified('toolu_unknown', 'completed', 'x');
    expect(runs.length).toBe(before);
  });

  it('終わったあとに数値の付いた通知が届いたら、数値だけ埋める。数値の無い通知は無視する', () => {
    tracker.start('toolu_agent', sessionDir, true, null);
    // 順番待ちの形（数値の無いもの）が先に届く
    tracker.notified('toolu_agent', 'completed', '結果', null);
    expect(run('toolu_agent')).toMatchObject({ state: 'done', tokens: null, result: '結果' });
    const before = runs.length;
    tracker.notified('toolu_agent', 'completed', '結果', null);
    expect(runs.length).toBe(before);
    tracker.notified('toolu_agent', 'completed', '結果', { durationMs: 900, totalTokens: 50, toolUses: null });
    expect(run('toolu_agent')).toMatchObject({ state: 'done', durationMs: 900, tokens: 50, toolCalls: 0, result: '結果' });
    expect(runs.length).toBe(before + 1);
    // 埋まっていないものは前のまま
    tracker.notified('toolu_agent', 'completed', '結果', { durationMs: null, totalTokens: null, toolUses: 3 });
    expect(run('toolu_agent')).toMatchObject({ durationMs: 900, tokens: 50, toolCalls: 3 });
  });

  it('前で動いて結果を返したものは、結果の数値で終わる。エラー・失敗は failed', () => {
    tracker.start('toolu_fg', sessionDir, false, '前の調べもの');
    tracker.finish('toolu_fg', { status: 'completed', agentId: 'f1', totalToolUseCount: 4, totalDurationMs: 2500, totalTokens: 900 }, false, false);
    expect(run('toolu_fg')).toMatchObject({ agentId: 'f1', background: false, state: 'done', toolCalls: 4, durationMs: 2500, tokens: 900 });
    tracker.start('toolu_err', sessionDir, false, null);
    tracker.finish('toolu_err', 'Agent が失敗しました', true, false);
    expect(run('toolu_err')).toMatchObject({ state: 'failed', agentId: null, toolCalls: 0, durationMs: null, tokens: null });
    tracker.start('toolu_failed', sessionDir, false, null);
    tracker.finish('toolu_failed', { status: 'failed' }, false, false);
    expect(run('toolu_failed')?.state).toBe('failed');
  });

  it('起動を見ていないものの結果: 過去の行なら止まったものとして加え、今の行の起動の知らせなら実行中で加える。前で返した今の結果は加えない', () => {
    tracker.finish('toolu_old', LAUNCHED, false, true);
    expect(run('toolu_old')).toMatchObject({ state: 'stopped', background: true, startedAt: null, agentId: AGENT_ID });
    tracker.finish('toolu_old_fg', { status: 'completed', totalToolUseCount: 1 }, false, true);
    expect(run('toolu_old_fg')).toMatchObject({ state: 'done', background: false, toolCalls: 1 });
    // 引き継いだ claude の、今も動いているもの
    tracker.finish('toolu_adopted', { ...LAUNCHED, agentId: 'ad1' }, false, false);
    expect(run('toolu_adopted')).toMatchObject({ state: 'running', background: true, agentId: 'ad1', startedAt: null });
    tracker.finish('toolu_ignored', { status: 'completed' }, false, false);
    expect(run('toolu_ignored')).toBeUndefined();
    // 過去の行から加えたものは会話ログのフォルダが分からないので、会話ログは今のセッションのフォルダで探す
    expect(tracker.logFile('toolu_old', '/now/subagents')).toBe(`/now/subagents/agent-${AGENT_ID}.jsonl`);
  });

  it('SendMessage で再開したものは、別の実行として加える。説明は元のものから引き継ぎ、ツールの回数は再開してからの分だけ数える', async () => {
    tracker.start('toolu_agent', sessionDir, true, '最初の調べもの');
    tracker.finish('toolu_agent', LAUNCHED, false, false);
    meta(AGENT_ID, { agentType: 'general-purpose', description: '最初の調べもの', toolUseId: 'toolu_agent' });
    writeFileSync(log(AGENT_ID), HEAD + toolUseLine('t1', 'Bash', { command: 'echo first' }));
    tracker.notified('toolu_agent', 'completed', '最初の結果');

    tracker.resume('toolu_send', AGENT_ID, sessionDir, false);
    expect(run('toolu_send')).toMatchObject({ agentId: AGENT_ID, description: '最初の調べもの', background: true, state: 'running', toolCalls: 0 });
    // 同じ再開をもう一度渡されても増えない
    tracker.resume('toolu_send', AGENT_ID, sessionDir, false);
    expect(tracker.all()).toHaveLength(2);
    appendFileSync(log(AGENT_ID), toolUseLine('t2', 'Bash', { command: 'echo again', description: '続きの作業' }));
    await poll();
    expect(run('toolu_send')).toMatchObject({ toolCalls: 1, recent: [{ name: 'Bash', target: 'echo again' }] });
    // 前の実行は終わっているので、数え直さない
    expect(run('toolu_agent')).toMatchObject({ state: 'done', toolCalls: 0 });
    tracker.notified('toolu_send', 'completed', '続きの結果', { durationMs: 762, totalTokens: 120, toolUses: 1 });
    expect(run('toolu_send')).toMatchObject({ state: 'done', result: '続きの結果', durationMs: 762 });
  });

  it('過去の行の再開は止まったものとして加え、会話ログがまだ無い再開は最初から数える。元が分からなければ説明は null', () => {
    tracker.resume('toolu_send_old', 'gone', sessionDir, true);
    expect(run('toolu_send_old')).toMatchObject({ state: 'stopped', startedAt: null, description: null });
    expect(timer()).toBeNull();
    // 過去の行の再開は、会話ログを今のセッションのフォルダ（呼ぶ側が渡す）で探す
    expect(tracker.logFile('toolu_send_old', '/now/subagents')).toBe('/now/subagents/agent-gone.jsonl');
    // 読み直しの途中で通知が届いても、所要時間は分からないまま
    tracker.notified('toolu_send_old', 'completed', '昔の結果');
    expect(run('toolu_send_old')).toMatchObject({ state: 'done', durationMs: null, result: '昔の結果' });
    tracker.resume('toolu_send_new', 'fresh', sessionDir, false);
    expect(run('toolu_send_new')).toMatchObject({ state: 'running', toolCalls: 0 });
    expect(timer()).not.toBeNull();
  });

  it('Claude Code が終わったら、実行中のものを止まったことにして知らせる。動いているものが無ければ知らせない', () => {
    tracker.start('toolu_a', sessionDir, true, null);
    tracker.start('toolu_b', sessionDir, true, null);
    tracker.notified('toolu_b', 'completed', null);
    const before = runs.length;
    tracker.stopRunning();
    expect(runs.length).toBe(before + 1);
    expect(tracker.all().map((r) => r.state)).toEqual(['stopped', 'done']);
    expect(timer()).toBeNull();
    tracker.stopRunning();
    expect(runs.length).toBe(before + 1);
  });

  it('1 秒ごとに読み、実行中のものが無くなったら読むのをやめる。読んでいる途中に重ねて読まない', async () => {
    vi.useFakeTimers();
    tracker.start('toolu_agent', sessionDir, true, null);
    meta(AGENT_ID, { toolUseId: 'toolu_agent' });
    writeFileSync(log(AGENT_ID), toolUseLine('t1', 'Bash', { command: 'echo 1' }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(run('toolu_agent')?.toolCalls).toBe(1), { timeout: 2000, interval: 20 });
    // 読んでいる途中（polling）に頼まれても、重ねて読まない
    (tracker as unknown as { polling: boolean }).polling = true;
    appendFileSync(log(AGENT_ID), toolUseLine('t2', 'Bash', { command: 'echo 2' }));
    await poll();
    expect(run('toolu_agent')?.toolCalls).toBe(1);
    (tracker as unknown as { polling: boolean }).polling = false;
    tracker.notified('toolu_agent', 'completed', null);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(timer()).toBeNull(), { timeout: 2000, interval: 20 });
    // 終わったものは読まない
    expect(run('toolu_agent')?.toolCalls).toBe(1);
  });
});
