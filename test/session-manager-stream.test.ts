import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { line, ScriptedApp, stream } from './helpers/scripted-claude';

// stream-json の行と会話ログの、二重・順番・ターンの終わり（SessionManager。設計書 7 節の「順番と二重の扱い」）。
// チャットの中身は会話ログから作り、動いている間の状態は stream-json の行から作る。同じものを 2 つの道から取らない

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const turnEnds = (id: string) => app.events(id).filter((e) => e.type === 'turn-end').length;
const types = (id: string) => app.events(id).map((e) => e.type);
// 送ったが、まだ会話に出ていない発言（最後の queue のイベント）
const unsent = (id: string) => {
  const last = [...app.events(id)].reverse().find((e) => e.type === 'queue');
  return last?.type === 'queue' ? last.prompts : [];
};

describe('二重にしない', () => {
  it('本体の応答は stream-json と会話ログの両方に出るが、チャットには会話ログからの 1 回だけ出す', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('ひとつめ'), line.toolUse('toolu_1', 'Read', { file_path: '/a.ts' }), line.toolResult('toolu_1', 'x'), line.text('ふたつめ'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    expect(app.events(id).filter((e) => e.type === 'assistant-text').map((e) => (e.type === 'assistant-text' ? e.text : ''))).toEqual(['ひとつめ', 'ふたつめ']);
    expect(app.events(id).filter((e) => e.type === 'tool-use')).toHaveLength(1);
    expect(app.events(id).filter((e) => e.type === 'user')).toHaveLength(1);
  });

  it('作業の完了は、ターンごとに 1 回だけ知らせる（result が重ねて届いても）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('はい'));
    app.finish(id);
    pipe.emit(stream.result());
    await app.waitFor('完了の知らせ', () => app.turnsCompleted.length === 1);
    await sleep(200);
    expect(app.turnsCompleted).toHaveLength(1);
    expect(turnEnds(id)).toBe(1);
  });
});

describe('ターンの終わりの順番', () => {
  it('result は会話ログより先に届く。チャットのターンの終わりは、最後の応答が会話ログに出てから出す（実行中のツールを、いったんエラーにしない）', async () => {
    // 会話ログを読むのが遅くても、時間切れのターンの終わりが先に出ないよう、待つ時間を長くする
    app.manager.turnEndWaitMs = 60_000;
    const { id, pipe } = app.create();
    await app.ready(id);
    const use = line.toolUse('toolu_1', 'Bash', { command: 'make' });
    const result = line.toolResult('toolu_1', 'ok');
    const answer = line.text('ビルドしました');
    app.append(id, line.user('ビルドして'), use);
    pipe.emit(stream.assistant(use));
    pipe.emit(stream.assistant(answer));
    app.finish(id);
    await app.waitFor('ツールの呼び出し', () => types(id).includes('tool-use'));
    await sleep(200);
    expect(turnEnds(id)).toBe(0);
    expect(app.manager.stateOf(id)).toBe('working');
    app.append(id, result, answer);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    // ツールの結果のあとに、ターンの終わり
    expect(types(id).lastIndexOf('tool-result')).toBeLessThan(types(id).lastIndexOf('turn-end'));
    expect(app.manager.stateOf(id)).toBe('idle');
  });

  it('ツールの切れ目でフックが止めたターン（最後の行がツールの結果）は、ツールの結果が会話ログに出てからターンの終わりを出す', async () => {
    // 自動の最適化圧縮は、ターンの終わりのチャットから止めた場所（直前のツールと、その結果）を取り出す。結果を読む前に終わりを出すと、
    // 終わったツールを「結果が無い」と書いてしまう（E2E の compact-auto で落ちた）
    app.manager.turnEndWaitMs = 60_000;
    const { id, pipe } = app.create();
    await app.ready(id);
    const use = line.toolUse('toolu_1', 'Bash', { command: 'echo step-1' });
    const result = line.toolResult('toolu_1', 'step-1');
    app.append(id, line.user('手順を進めて'), use);
    pipe.emit(stream.assistant(use));
    pipe.emit(stream.user(result));
    pipe.emit(stream.result('session', { terminal_reason: 'hook_stopped' }));
    await app.waitFor('ツールの呼び出し', () => types(id).includes('tool-use'));
    await sleep(200);
    expect(turnEnds(id)).toBe(0);
    expect(app.manager.stateOf(id)).toBe('working');
    app.append(id, result);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    expect(types(id).lastIndexOf('tool-result')).toBeLessThan(types(id).lastIndexOf('turn-end'));
  });

  it('最後の応答が会話ログに出ないまま（書けなかった・読めなかった）でも、時間切れでターンを終える', async () => {
    app.manager.turnEndWaitMs = 600;
    const { id, pipe } = app.create();
    await app.ready(id);
    app.append(id, line.user('はじめ'));
    pipe.emit(stream.assistant(line.text('会話ログに出ない応答')));
    app.finish(id);
    expect(turnEnds(id)).toBe(0);
    expect(app.manager.stateOf(id)).toBe('working');
    await app.waitFor('時間切れ', () => turnEnds(id) === 1, 5000);
    expect(app.manager.stateOf(id)).toBe('idle');
    expect(app.turnsCompleted).toHaveLength(1);
  });

  it('次のターンが始まったら、待っていた前のターンの終わりを先に出す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.append(id, line.user('はじめ'));
    pipe.emit(stream.assistant(line.text('出ない応答')));
    app.finish(id);
    await sleep(100);
    // スマホから次の発言が届いた
    pipe.emit(stream.remoteUser('つぎ'));
    await app.waitFor('前のターンの終わり', () => turnEnds(id) === 1);
    expect(app.manager.stateOf(id)).toBe('working');
  });

  it('中断で終わったターン（terminal_reason が aborted_…）は、中断の印を付けて終える', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('長い作業'), line.text('始めます'));
    pipe.emit(stream.interrupted(app.claudeId(id), 'aborted_streaming'));
    await app.waitFor('中断', () => turnEnds(id) === 1);
    expect(app.events(id).find((e) => e.type === 'turn-end')).toEqual({ type: 'turn-end', interrupted: true });
  });

  it('Claude Code の中で済むコマンド（/clear・/compact。モデルを呼ばず num_turns が 0）のターンは、終えるが、完了を知らせない', async () => {
    const notices: string[] = [];
    app.manager.turnNotice = (_id, starter) => (notices.push(starter), 'work');
    const { id, pipe } = app.create();
    await app.ready(id);
    // ふつうのターン
    await app.prompt(id, 'はじめ');
    app.say(id, line.text('はい'));
    app.finish(id);
    await app.waitFor('ふつうのターンの終わり', () => turnEnds(id) === 1);
    expect(app.turnsCompleted).toHaveLength(1);
    // /clear（会話ログに発言の行は出ない）。result は num_turns 0・terminal_reason なし（実測）
    const clear = await app.send(id, '/clear');
    pipe.emit(stream.lifecycle(clear, 'started'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    app.finish(id, { num_turns: 0, terminal_reason: null });
    await app.waitFor('/clear のターンの終わり', () => turnEnds(id) === 2);
    expect(app.manager.stateOf(id)).toBe('idle');
    expect(app.turnsCompleted).toHaveLength(1);
    // 最適化圧縮の通知の数え方（流れの途中で出さなかった通知を覚える）にも入れない
    expect(notices).toEqual(['other']);
    // 失敗で終わったものは、num_turns が 0 でもふつうのターンとして終える
    await app.prompt(id, 'つぎ');
    app.finish(id, { num_turns: 0, subtype: 'error_during_execution', is_error: true, terminal_reason: 'model_error', errors: ['API Error'] });
    await app.waitFor('失敗のターンの終わり', () => turnEnds(id) === 3);
    expect(app.turnsCompleted).toHaveLength(2);
  });

  it('claude が終わったら、待っていたターンの終わりを出す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.append(id, line.user('はじめ'));
    pipe.emit(stream.assistant(line.text('出ない応答')));
    app.finish(id);
    await sleep(100);
    pipe.exit(1);
    await app.waitFor('終了', () => types(id).includes('process-exit'));
    expect(types(id).indexOf('turn-end')).toBeLessThan(types(id).indexOf('process-exit'));
  });
});

describe('ターンとターンの間・入力なしのターン', () => {
  it('ターンとターンの間に、手が空いたように見せない（次のターンを開いてから、前のターンの終わりを出す）', async () => {
    app.manager.turnEndWaitMs = 60_000;
    const { id, pipe } = app.create();
    await app.ready(id);
    // 状態が変わりうるたびの状態と、それまでにチャットに出たターンの終わりの数
    const states: [string | null, number][] = [];
    app.manager.watchState((changed) => {
      if (changed === id) states.push([app.manager.stateOf(id), turnEnds(id)]);
    });
    await app.prompt(id, 'ひとつめ');
    await app.waitFor('ひとつめが会話に出た', () => app.events(id).some((e) => e.type === 'user'));
    const next = await app.send(id, 'ふたつめ');
    pipe.emit(stream.lifecycle(next, 'queued'));
    // 最後の応答がまだ会話ログに出ないうちに result が届き、そのまま順番待ちの発言でつぎのターンが始まる
    const answer = line.text('ひとつめの答え');
    pipe.emit(stream.assistant(answer));
    app.finish(id);
    pipe.emit(stream.lifecycle(next, 'started'));
    await app.waitFor('ひとつめのターンの終わり', () => turnEnds(id) === 1);
    app.append(id, answer, { ...line.user('ふたつめ'), uuid: next });
    app.say(id, line.text('ふたつめの答え'));
    app.finish(id);
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
    // 手が空いたのは、ふたつめのターンが終わってから
    expect(new Set(states.filter(([state]) => state === 'idle').map(([, ended]) => ended))).toEqual(new Set([2]));
    expect(app.turnsCompleted).toHaveLength(2);
  });

  it('前のターンの終わりを待っている間に、入力なしでつぎのターンが始まっても、手が空いたように見せない', async () => {
    app.manager.turnEndWaitMs = 60_000;
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, 'ひとつめ');
    await app.waitFor('ひとつめが会話に出た', () => app.events(id).some((e) => e.type === 'user'));
    const states: (string | null)[] = [];
    app.manager.watchState((changed) => {
      if (changed === id) states.push(app.manager.stateOf(id));
    });
    pipe.emit(stream.assistant(line.text('ひとつめの答え')));
    app.finish(id);
    // 裏のタスクの完了の知らせなどで、入力なしにつぎのターンが始まる（前のターンの終わりは、ここで先に出す）
    pipe.emit(stream.blockStart('thinking'));
    expect(turnEnds(id)).toBe(1);
    expect(states).not.toContain('idle');
    expect(app.manager.stateOf(id)).toBe('working');
  });

  it('result のあとも、順番待ちの発言が残っていれば作業中（作業中の始まりは、送った発言の queued と started）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, 'ひとつめ');
    const next = await app.send(id, 'ふたつめ');
    pipe.emit(stream.lifecycle(next, 'queued'));
    app.say(id, line.text('ひとつめの答え'));
    app.finish(id);
    await app.waitFor('ひとつめのターンの終わり', () => turnEnds(id) === 1);
    expect(app.manager.stateOf(id)).toBe('working');
    // Claude Code が取り下げたら（cancelled・discarded）、手が空く
    pipe.emit(stream.lifecycle(next, 'cancelled'));
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
  });

  it('入力なしで始まったターンで再試行の行だけが続いても作業中にし、result で終える。会話ログに残らない失敗の理由（errors）はチャットに出す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const retry = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded', uuid: 'r1', session_id: 's' };
    pipe.emit(retry);
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    expect(app.progress.get(id)).not.toBeNull();
    pipe.emit(stream.result(app.claudeId(id), { subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', errors: ['Reached maximum number of turns (3)'] }));
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    expect(app.manager.stateOf(id)).toBe('idle');
    expect(app.events(id).flatMap((e) => (e.type === 'api-error' ? [[e.text, e.retrying]] : []))).toEqual([
      [expect.stringContaining('overloaded'), true],
      ['Reached maximum number of turns (3)', false],
    ]);
    // 中断で終わったターンの errors は出さない（人が止めた）
    pipe.emit({ ...retry, uuid: 'r2' });
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    pipe.emit(stream.result(app.claudeId(id), { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: ['aborted'] }));
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 2);
    expect(app.events(id).filter((e) => e.type === 'api-error' && !e.retrying)).toHaveLength(1);
  });

  it('裏のタスクが動いている間の再試行の行は、ターンの始まりに数えない（裏のクエリが利用枠を待つ間も、同じ形の行が出る）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(
      id,
      line.user('サーバーを起動して'),
      line.toolUse('toolu_bg', 'Bash', { command: 'npm run dev', run_in_background: true }),
      line.toolResult('toolu_bg', 'Command running in background with ID: b1. Output is being written to: /nonexistent/b1.output', {
        toolUseResult: { backgroundTaskId: 'b1' },
      }),
      line.text('起動しました'),
    );
    app.finish(id);
    await app.waitFor('裏のタスク', () => app.manager.stateOf(id) === 'background');
    pipe.emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 60_000, error_status: 429, error: 'rate_limit', uuid: 'r1', session_id: 's' });
    await sleep(100);
    expect(app.manager.stateOf(id)).toBe('background');
  });

});

describe('ターンの始まり', () => {
  it('スマホ・claude.ai から届いた発言（Remote Control）で、ターンが始まる', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.emit(stream.remoteUser('スマホからの頼み'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    app.say(id, line.user('スマホからの頼み'), line.text('はい'));
    app.finish(id);
    await app.waitFor('完了の知らせ', () => app.turnsCompleted.length === 1);
  });

  it('手が空いている間に届いた最初の応答・書いている途中の行でも、ターンが始まる（裏のタスクの完了や Stop のフックで、入力なしに始まる）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.emit(stream.blockStart('text'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    app.finish(id);
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
    pipe.emit(stream.assistant(line.text('タスクが終わりました')));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    // サブエージェントの行では始まらない
    app.finish(id);
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle', 5000);
    pipe.emit({ ...stream.assistant(line.text('サブエージェント')), parent_tool_use_id: 'toolu_agent' });
    pipe.emit(stream.blockStart('text', 'toolu_agent'));
    await sleep(100);
    expect(app.manager.stateOf(id)).toBe('idle');
  });
});

describe('順番待ち（command_lifecycle）', () => {
  it('作業中に送った発言は、queued で順番待ちに、会話ログに出たら（queued_command の source_uuid）外す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('作業しています'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    const uuid = await app.send(id, 'ついでにこれも');
    expect(unsent(id)).toEqual([{ id: uuid, text: 'ついでにこれも', pastes: [], images: 0, state: 'sending' }]);
    pipe.emit(stream.lifecycle(uuid, 'queued'));
    await app.waitFor('順番待ち', () => unsent(id)[0]?.state === 'queued');
    // 同じターンに取り込まれ、会話ログには attachment の queued_command として書かれる（実測）
    pipe.emit(stream.lifecycle(uuid, 'started'));
    app.append(id, { ...line.user(''), type: 'attachment', message: undefined, attachment: { type: 'queued_command', prompt: 'ついでにこれも', commandMode: 'prompt', source_uuid: uuid } });
    await app.waitFor('会話に出た', () => unsent(id).length === 0);
    expect(app.events(id).some((e) => e.type === 'user' && e.text === 'ついでにこれも' && e.id === uuid)).toBe(true);
    // 取り込まれたので、ターンはまだ続く
    expect(app.manager.stateOf(id)).toBe('working');
  });

  it('completed・cancelled・discarded で、送信中から外す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const done = await app.send(id, '終わったもの');
    const cancelled = await app.send(id, 'やめたもの');
    const discarded = await app.send(id, '捨てられたもの');
    expect(unsent(id).map((p) => p.text)).toEqual(['終わったもの', 'やめたもの', '捨てられたもの']);
    pipe.emit(stream.lifecycle(cancelled, 'cancelled'));
    await app.waitFor('取り消し', () => unsent(id).length === 2);
    pipe.emit(stream.lifecycle(discarded, 'discarded'));
    pipe.emit(stream.lifecycle(done, 'completed'));
    await app.waitFor('空', () => unsent(id).length === 0);
    // 知らない uuid の知らせは、何もしない
    pipe.emit(stream.lifecycle('unknown', 'completed'));
    await sleep(50);
    expect(unsent(id)).toEqual([]);
  });

  it('started で、ターンが始まる（送った発言を Claude Code が受け取った）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const uuid = await app.send(id, '頼み');
    pipe.emit(stream.lifecycle(uuid, 'started'));
    app.append(id, { ...line.user('頼み'), uuid });
    await app.waitFor('会話に出た', () => unsent(id).length === 0);
    // 送信中でなくなっても、ターンの途中なので作業中
    expect(app.manager.stateOf(id)).toBe('working');
  });
});

describe('知らせ', () => {
  it('API の再試行（system/api_retry）は、再試行中のエラーとしてチャットに出す。応答が来たら画面が消す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.emit({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 1000, error_status: 529, error: 'overloaded_error', uuid: 'r1' });
    await app.waitFor('再試行', () => types(id).includes('api-error'));
    expect(app.events(id).find((e) => e.type === 'api-error')).toMatchObject({ id: 'r1', retrying: true, text: expect.stringContaining('overloaded_error (529)') });
  });

  it('利用枠（rate_limit_event）を statusLine に入れる。値の無い知らせで空にしない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.emit({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1_800_000_000 }, seven_day: { utilization: 0.1 } } },
      uuid: 'l1',
    });
    await app.waitFor('利用枠', () => app.statusLineInfos.get(id)?.rateLimits !== null && app.statusLineInfos.get(id)?.rateLimits !== undefined);
    expect(app.statusLineInfos.get(id)?.rateLimits).toEqual({ fiveHour: { percent: 42, resetsAt: 1_800_000_000_000 }, sevenDay: { percent: 10, resetsAt: null } });
    pipe.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: 'l2' });
    await sleep(50);
    expect(app.statusLineInfos.get(id)?.rateLimits?.fiveHour?.percent).toBe(42);
  });
});

describe('会話のタイトル（generate_session_title）', () => {
  it('最初のターンが終わったあとに 1 回だけ、最初の発言を元に頼む（persist: true）。会話ログに ai-title が書かれたら、一覧に出す', async () => {
    app.answers.set('generate_session_title', { title: 'ログインの修正' });
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('ログインを直して'), line.text('直します'));
    expect(pipe.requests('generate_session_title')).toEqual([]);
    app.finish(id);
    await app.waitFor('タイトルの頼み', () => pipe.requests('generate_session_title').length === 1);
    expect(pipe.requests('generate_session_title')[0].request).toEqual({ subtype: 'generate_session_title', description: 'ログインを直して', persist: true });
    // Claude Code が会話ログに書く
    app.append(id, { type: 'ai-title', aiTitle: 'ログインの修正', sessionId: app.claudeId(id) });
    await app.waitFor('一覧のタイトル', () => app.manager.summary(id)?.title === 'ログインの修正');
    app.say(id, line.user('つぎ'), line.text('はい'));
    app.finish(id);
    await app.waitFor('2 つめのターン', () => turnEnds(id) === 2);
    await sleep(100);
    expect(pipe.requests('generate_session_title')).toHaveLength(1);
  });

  it('失敗（error・知らない要求）は黙って捨て、一覧は最初の発言のまま。ターンも送信も待たせない', async () => {
    app.answers.set('generate_session_title', new Error('Unsupported control request subtype: generate_session_title'));
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('ログインを直して'), line.text('直します'));
    app.finish(id);
    await app.waitFor('タイトルの頼み', () => pipe.requests('generate_session_title').length === 1);
    await app.waitFor('完了', () => app.turnsCompleted.length === 1);
    expect(app.manager.summary(id)?.title).toBe('ログインを直して');
    expect(app.manager.stateOf(id)).toBe('idle');
  });

  it('答えが来なくても（時間切れを待つ間も）、ターンを終え、次の発言を送れる', async () => {
    app.answers.set('generate_session_title', null);
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('ログインを直して'), line.text('直します'));
    app.finish(id);
    await app.waitFor('タイトルの頼み', () => pipe.requests('generate_session_title').length === 1);
    expect(app.manager.stateOf(id)).toBe('idle');
    await app.manager.submitWhenReady(id, 'つぎ', 500);
    expect(pipe.prompts.map((p) => p.message.content)).toEqual(['つぎ']);
  });

  it('最初の発言が無いまま最初のターンが終わったら（入力なしで始まったターン）、頼まずに、次のターンの終わりに見直す', async () => {
    app.answers.set('generate_session_title', { title: 'ログインの修正' });
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.text('裏のタスクが終わりました'));
    app.finish(id);
    await app.waitFor('ひとつめのターン', () => turnEnds(id) === 1);
    await sleep(100);
    expect(pipe.requests('generate_session_title')).toEqual([]);
    app.say(id, line.user('ログインを直して'), line.text('直します'));
    app.finish(id);
    await app.waitFor('タイトルの頼み', () => pipe.requests('generate_session_title').length === 1);
    expect(pipe.requests('generate_session_title')[0].request).toMatchObject({ description: 'ログインを直して' });
  });

  it('人が名前を付けた・会話ログにもうタイトル（ai-title・custom-title）があるときは、頼まない', async () => {
    const named = app.create();
    await app.ready(named.id);
    app.manager.rename(named.id, '自分で付けた名前');
    app.say(named.id, line.user('はじめ'), line.text('はい'));
    app.finish(named.id);
    const titled = app.create();
    await app.ready(titled.id);
    app.say(titled.id, line.user('はじめ'), { type: 'ai-title', aiTitle: '前に作ったタイトル' }, line.text('はい'));
    app.finish(titled.id);
    await app.waitFor('完了', () => app.turnsCompleted.length === 2);
    await sleep(100);
    expect(named.pipe.requests('generate_session_title')).toEqual([]);
    expect(titled.pipe.requests('generate_session_title')).toEqual([]);
  });
});
