import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handoffText } from '../src/shared/optimized-compact';
import { line, ScriptedApp, stream } from './helpers/scripted-claude';

// stream-json の行と会話ログの、二重・順番・ターンの終わり（SessionManager。設計書 7 節の「順番と二重の扱い」）。
// チャットの中身は会話ログから作り、動いている間の状態は stream-json の行から作る。同じものを 2 つの道から取らない。
// stream-json の行は、pipe.emit の中で読み終わる（会話ログの行は、ファイルを見張って読むので、あとで届く）。「まだ終えていない」などは、
// 時間を置かずに emit の直後に確かめる。ターンの終わりを待つ時間（turnEndWaitMs）は、時間切れを確かめるテストのほかは長くして、時間切れで通らないようにする

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

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
    await app.waitFor('時間切れ', () => turnEnds(id) === 1);
    expect(app.manager.stateOf(id)).toBe('idle');
    expect(app.turnsCompleted).toHaveLength(1);
  });

  it('次のターンが始まったら、待っていた前のターンの終わりを先に出す', async () => {
    app.manager.turnEndWaitMs = 60_000;
    const { id, pipe } = app.create();
    await app.ready(id);
    app.append(id, line.user('はじめ'));
    pipe.emit(stream.assistant(line.text('出ない応答')));
    app.finish(id);
    expect(turnEnds(id)).toBe(0);
    // スマホから次の発言が届いた
    pipe.emit(stream.remoteUser('つぎ'));
    expect(turnEnds(id)).toBe(1);
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

  it('応答の前に中断・失敗で終わったターンは、そのターンを始めた発言が会話ログに出てから終える（チャットで、発言より前に終わりを並べない）', async () => {
    app.manager.turnEndWaitMs = 60_000;
    const { id, pipe } = app.create();
    await app.ready(id);
    for (const ending of [stream.interrupted(app.claudeId(id), 'aborted_streaming'), stream.result(app.claudeId(id), { subtype: 'error_during_execution', is_error: true, terminal_reason: 'model_error', errors: ['overloaded'] })]) {
      const before = turnEnds(id);
      const uuid = await app.send(id, '仕上げて');
      pipe.emit(stream.lifecycle(uuid, 'started'));
      // 応答の前に終わった。result が、会話ログの発言の行より先に届く
      pipe.emit(ending);
      expect(turnEnds(id)).toBe(before);
      app.append(id, { ...line.user('仕上げて'), uuid });
      await app.waitFor('ターンの終わり', () => turnEnds(id) === before + 1);
      const kinds = app.events(id).map((e) => e.type);
      expect(kinds.lastIndexOf('user')).toBeLessThan(kinds.lastIndexOf('turn-end'));
      // 会話ログに残らない失敗の理由も、発言より前に並べず、ターンの終わりの直前に出す（最適化圧縮は、仕上げの頼みのあとの失敗を見る）
      if ('errors' in ending) expect(kinds.slice(kinds.lastIndexOf('user') + 1).filter((k) => k !== 'queue')).toEqual(['api-error', 'turn-end']);
    }
    expect(app.events(id).find((e) => e.type === 'turn-end')).toEqual({ type: 'turn-end', interrupted: true });
    // 作業中に送って、ターンの途中に取り込まれた発言（会話ログには queued_command の attachment で出る）も同じ
    const before = turnEnds(id);
    const queued = await app.send(id, 'これも');
    pipe.emit(stream.lifecycle(queued, 'started'));
    pipe.emit(stream.interrupted(app.claudeId(id), 'aborted_streaming'));
    expect(turnEnds(id)).toBe(before);
    app.append(id, { type: 'attachment', uuid: 'att-1', attachment: { type: 'queued_command', prompt: 'これも', source_uuid: queued } });
    await app.waitFor('ターンの終わり', () => turnEnds(id) === before + 1);
  });

  it('応答の前に終わったターンでも、発言が先に会話ログに出ていれば、待たずに終える', async () => {
    app.manager.turnEndWaitMs = 60_000;
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, 'はじめ');
    await app.waitFor('発言', () => app.events(id).some((e) => e.type === 'user'));
    pipe.emit(stream.interrupted(app.claudeId(id), 'aborted_streaming'));
    expect(turnEnds(id)).toBe(1);
  });

  it('応答の前に終わったターンの発言が、会話ログに出ないままなら、時間切れで終える', async () => {
    app.manager.turnEndWaitMs = 600;
    const { id, pipe } = app.create();
    await app.ready(id);
    const uuid = await app.send(id, 'つぎ');
    pipe.emit(stream.lifecycle(uuid, 'started'));
    pipe.emit(stream.interrupted(app.claudeId(id), 'aborted_streaming'));
    expect(turnEnds(id)).toBe(0);
    await app.waitFor('時間切れ', () => turnEnds(id) === 1);
    expect(app.events(id).some((e) => e.type === 'user')).toBe(false);
  });

  it('時間切れで終えたあとに、待っていた発言の行が届いたら、その発言のあとにもう一度ターンの終わりを出す（最適化圧縮が、仕上げの頼みのあとの終わりを待ち続けない）', async () => {
    app.manager.turnEndWaitMs = 50;
    const { id, pipe } = app.create();
    await app.ready(id);
    const uuid = await app.send(id, handoffText());
    pipe.emit(stream.lifecycle(uuid, 'started'));
    pipe.emit(stream.interrupted(app.claudeId(id), 'aborted_streaming'));
    await app.waitFor('時間切れ', () => turnEnds(id) === 1);
    const completed = app.turnsCompleted.length;
    // 仕上げの頼みの行が、遅れて会話ログに出た
    app.append(id, { ...line.user(handoffText()), uuid });
    await app.waitFor('もう一度のターンの終わり', () => turnEnds(id) === 2);
    const events = app.events(id);
    const handoff = events.findIndex((e) => e.type === 'notice' && e.compact === 'handoff');
    expect(handoff).toBeGreaterThan(-1);
    expect(events.slice(handoff + 1).filter((e) => e.type === 'turn-end')).toEqual([{ type: 'turn-end', interrupted: true }]);
    expect(events.at(-1)).toEqual({ type: 'turn-end', interrupted: true });
    expect(app.manager.stateOf(id)).toBe('idle');
    // 完了の知らせは繰り返さない
    expect(app.turnsCompleted).toHaveLength(completed);
    // 作業中に送って、ターンの途中に取り込まれた発言（会話ログには queued_command の attachment で出る）・失敗で終わったターンも同じ
    const queued = await app.send(id, 'これも');
    pipe.emit(stream.lifecycle(queued, 'started'));
    pipe.emit(stream.result(app.claudeId(id), { subtype: 'error_during_execution', is_error: true, terminal_reason: 'model_error', errors: ['overloaded'] }));
    await app.waitFor('時間切れ', () => turnEnds(id) === 3);
    const again = app.turnsCompleted.length;
    app.append(id, { type: 'attachment', uuid: 'att-1', attachment: { type: 'queued_command', prompt: 'これも', source_uuid: queued } });
    await app.waitFor('もう一度のターンの終わり', () => turnEnds(id) === 4);
    // 失敗の理由も、その行のあとに出し直す（画面は、同じ id の知らせを今の位置に移す）
    expect(app.events(id).slice(-2)).toEqual([{ type: 'api-error', id: expect.any(String), text: 'overloaded', retrying: false }, { type: 'turn-end' }]);
    expect(app.turnsCompleted).toHaveLength(again);
  });

  it('時間切れで終えたあと、待っていた発言の行より先に次のターンが始まったら、もう一度は出さない', async () => {
    app.manager.turnEndWaitMs = 50;
    const { id, pipe } = app.create();
    await app.ready(id);
    const uuid = await app.send(id, '仕上げて');
    pipe.emit(stream.lifecycle(uuid, 'started'));
    pipe.emit(stream.interrupted(app.claudeId(id), 'aborted_streaming'));
    await app.waitFor('時間切れ', () => turnEnds(id) === 1);
    const next = await app.send(id, 'つぎ');
    pipe.emit(stream.lifecycle(next, 'started'));
    app.append(id, { ...line.user('仕上げて'), uuid }, { ...line.user('つぎ'), uuid: next });
    await app.waitFor('2 つの発言', () => app.events(id).filter((e) => e.type === 'user').length === 2);
    expect(turnEnds(id)).toBe(1);
    expect(app.manager.stateOf(id)).toBe('working');
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
    app.manager.turnEndWaitMs = 60_000;
    const { id, pipe } = app.create();
    await app.ready(id);
    app.append(id, line.user('はじめ'));
    pipe.emit(stream.assistant(line.text('出ない応答')));
    app.finish(id);
    expect(turnEnds(id)).toBe(0);
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
    app.say(id, line.text('タスクが終わりました'));
    expect(app.manager.stateOf(id)).toBe('working');
    // サブエージェントの行では始まらない
    app.finish(id);
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
    pipe.emit({ ...stream.assistant(line.text('サブエージェント')), parent_tool_use_id: 'toolu_agent' });
    pipe.emit(stream.blockStart('text', 'toolu_agent'));
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
    expect(app.statusLineInfos.get(id)?.rateLimits?.fiveHour?.percent).toBe(42);
  });

  it('statusLine を送り直すとき（費用・コンテキストの量が変わったなど）、利用枠には受け取った時刻を添えたままにする', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42 } } }, uuid: 'l1' });
    await app.waitFor('利用枠', () => !!app.statusLineInfos.get(id)?.rateLimits);
    const received = app.statusLineInfos.get(id)!;
    expect(received.rateLimitsAt).toBe(received.updatedAt);
    // 時計を進めてから送り直させる（2 つの時刻を、待たずに違える。進み方は本物のまま）
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + 60_000);
    try {
      await app.prompt(id, 'はじめ');
      app.say(id, line.text('はい'));
      pipe.emit(stream.result(app.claudeId(id), { total_cost_usd: 0.5 }));
      await app.waitFor('費用', () => app.statusLineInfos.get(id)?.costUsd === 0.5);
    } finally {
      clock.mockRestore();
    }
    const resent = app.statusLineInfos.get(id)!;
    expect(resent.updatedAt).toBeGreaterThan(received.updatedAt);
    expect(resent.rateLimitsAt).toBe(received.rateLimitsAt);
  });
});

describe('利用枠（get_usage）', () => {
  it('ターンが終わったら、利用枠（モデル別の週の枠を含む）を get_usage で聞く。聞くのは 5 分に 1 回まで', async () => {
    app.answers.set('get_usage', {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 42, resets_at: null }, seven_day: { utilization: 10, resets_at: null }, model_scoped: [{ display_name: 'Fable', utilization: 55, resets_at: null }] },
    });
    const { id, pipe } = app.create();
    await app.ready(id);
    for (const text of ['はじめ', 'つぎ']) {
      await app.prompt(id, text);
      app.say(id, line.text('はい'));
      app.finish(id);
      await app.waitFor('ターンの終わり', () => app.manager.stateOf(id) === 'idle');
    }
    await app.waitFor('利用枠', () => app.usages.length === 1);
    expect(app.usages[0]).toEqual({
      limits: [
        { label: '5時間', percent: 42, resetsAt: null },
        { label: '週', percent: 10, resetsAt: null },
        { label: '週', model: 'Fable', percent: 55, resetsAt: null },
      ],
      modelsKnown: true,
    });
    expect(pipe.requests('get_usage')).toHaveLength(1);
  });

  it('get_usage には skip_behaviors を付ける（使わない behaviors のために、手元の会話ログを集計させない）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, 'はじめ');
    app.say(id, line.text('はい'));
    app.finish(id);
    await app.waitFor('get_usage', () => pipe.requests('get_usage').length === 1);
    expect(pipe.requests('get_usage')[0].request).toEqual({ subtype: 'get_usage', skip_behaviors: true });
  });

  it('5 分たったら、次のターンの終わりに聞き直す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const turn = async (text: string, count: number) => {
      await app.prompt(id, text);
      app.say(id, line.text('はい'));
      app.finish(id);
      await app.waitFor('ターンの終わり', () => app.manager.stateOf(id) === 'idle' && turnEnds(id) === count);
    };
    await turn('はじめ', 1);
    await app.waitFor('get_usage', () => pipe.requests('get_usage').length === 1);
    // 時計を 5 分進める（進み方は本物のまま）
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + 5 * 60_000);
    try {
      await turn('つぎ', 2);
      await app.waitFor('聞き直し', () => pipe.requests('get_usage').length === 2);
    } finally {
      clock.mockRestore();
    }
  });

  it('get_usage が失敗しても、答えが来なくても、利用枠を変えず、ターンも次の発言も待たせない', async () => {
    app.answers.set('get_usage', new Error('rate limited'));
    const first = app.create();
    await app.ready(first.id);
    await app.prompt(first.id, 'はじめ');
    app.say(first.id, line.text('はい'));
    app.finish(first.id);
    await app.waitFor('失敗した get_usage', () => first.pipe.requests('get_usage').length === 1);
    await app.waitFor('ターンの終わり', () => app.manager.stateOf(first.id) === 'idle');

    // 答えない（時間切れまで待つ）
    first.pipe.answers.set('get_usage', null);
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + 5 * 60_000);
    try {
      await app.prompt(first.id, 'つぎ');
      app.say(first.id, line.text('はい'));
      app.finish(first.id);
      await app.waitFor('答えの無い get_usage', () => first.pipe.requests('get_usage').length === 2);
      await app.waitFor('ターンの終わり', () => app.manager.stateOf(first.id) === 'idle' && turnEnds(first.id) === 2);
      const uuid = await app.prompt(first.id, 'そのつぎ');
      expect(first.pipe.prompts.some((p) => p.uuid === uuid)).toBe(true);
    } finally {
      clock.mockRestore();
    }
    expect(app.usages).toEqual([]);
  });
});

describe('何も出力しなかったフック（--include-hook-events の hook_response）', () => {
  // Claude Code 2.1.302 の hook_response の形（コマンドとツールの ID は載らない）
  const started = (hookId: string, hookName: string) => ({ type: 'system', subtype: 'hook_started', hook_id: hookId, hook_name: hookName, hook_event: hookName.split(':')[0], uuid: `s-${hookId}` });
  const response = (hookId: string, hookName: string, patch: Record<string, unknown> = {}) => ({
    type: 'system',
    subtype: 'hook_response',
    hook_id: hookId,
    hook_name: hookName,
    hook_event: hookName.split(':')[0],
    output: '',
    stdout: '',
    stderr: '',
    exit_code: 0,
    outcome: 'success',
    uuid: `r-${hookId}`,
    ...patch,
  });
  const hooks = (id: string) => app.events(id).flatMap((e) => (e.type === 'hook' ? [e.run] : []));

  it('ツールの前後のフックは、そのツールのカードに付ける。会話ログのカードより先に届いたら、カードが出るまで待つ', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, 'はじめ');
    const tool = line.toolUse('toolu_1', 'Bash', { command: 'ls' });
    // stream に先に届く（会話ログはまだ）
    pipe.emit(stream.assistant(tool, app.claudeId(id)));
    pipe.emit(started('h1', 'PreToolUse:Bash'));
    pipe.emit(response('h1', 'PreToolUse:Bash'));
    expect(hooks(id)).toEqual([]);
    // 会話ログにカードが出たら、そのあとに付ける
    app.append(id, tool);
    await app.waitFor('フック', () => hooks(id).length === 1);
    const types = app.events(id).map((e) => e.type);
    expect(types.indexOf('hook')).toBeGreaterThan(types.indexOf('tool-use'));
    expect(hooks(id)[0]).toMatchObject({ event: 'PreToolUse', name: 'PreToolUse:Bash', command: null, outcome: 'success', exitCode: 0, toolUseId: 'toolu_1', stdout: '', stderr: '' });
    expect(typeof hooks(id)[0].durationMs).toBe('number');
    // カードが出たあとのフックは、すぐ付ける
    pipe.emit(response('h2', 'PostToolUse:Bash'));
    await app.waitFor('あとのフック', () => hooks(id).length === 2);
    expect(hooks(id)[1]).toMatchObject({ event: 'PostToolUse', toolUseId: 'toolu_1', durationMs: null });
  });

  it('同じ名前のツールを並べて呼んだときは、どの呼び出しのものか決められないフックをカードに付けず、ツールに付かない行として出す。結果が来て 1 つに決まれば、そのカードに付ける', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, 'はじめ');
    const a = line.toolUse('toolu_a', 'Read', { file_path: '/a' });
    const b = line.toolUse('toolu_b', 'Read', { file_path: '/b' });
    const resultA = line.toolResult('toolu_a', 'a');
    const resultB = line.toolResult('toolu_b', 'b');
    // Claude Code 2.1.302 で Read を 2 つ並べて呼んだときの順番（実測）。PostToolUse の返事は、そのツールの結果より先に届く
    pipe.emit(stream.assistant(a, app.claudeId(id)));
    pipe.emit(started('h1', 'PreToolUse:Read'));
    pipe.emit(stream.assistant(b, app.claudeId(id)));
    pipe.emit(started('h2', 'PreToolUse:Read'));
    pipe.emit(response('h1', 'PreToolUse:Read'));
    pipe.emit(response('h2', 'PreToolUse:Read'));
    pipe.emit(started('h3', 'PostToolUse:Read'));
    pipe.emit(started('h4', 'PostToolUse:Read'));
    pipe.emit(response('h3', 'PostToolUse:Read'));
    pipe.emit(stream.user(resultB));
    pipe.emit(response('h4', 'PostToolUse:Read'));
    pipe.emit(stream.user(resultA));
    app.append(id, a, b, resultB, resultA);
    await app.waitFor('フック', () => hooks(id).length === 4);
    expect(hooks(id).map((r) => [r.name, r.toolUseId, r.hookId])).toEqual([
      ['PreToolUse:Read', null, 'h1'],
      ['PreToolUse:Read', null, 'h2'],
      ['PostToolUse:Read', null, 'h3'],
      ['PostToolUse:Read', 'toolu_a', 'h4'],
    ]);
    // 付けるものは、そのカードが出てから
    const kinds = app.events(id).map((e) => (e.type === 'hook' ? `hook:${e.run.hookId}` : e.type === 'tool-use' ? `tool:${e.id}` : e.type));
    expect(kinds.indexOf('hook:h4')).toBeGreaterThan(kinds.indexOf('tool:toolu_a'));
  });

  it('発言のとき（UserPromptSubmit）のフックは、その発言がチャットに出てから、そのすぐあとに出す（発言の上の、前のターンの続きに見せない）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const uuid = await app.send(id, 'はじめ');
    // Claude Code 2.1.302 の順番（実測）: 取り込まれた知らせ（started）→ フック → 会話ログの発言の行
    pipe.emit(stream.lifecycle(uuid, 'started'));
    pipe.emit(started('h1', 'UserPromptSubmit'));
    pipe.emit(response('h1', 'UserPromptSubmit'));
    pipe.emit(started('h2', 'UserPromptSubmit'));
    pipe.emit(response('h2', 'UserPromptSubmit'));
    expect(hooks(id)).toEqual([]);
    app.append(id, { ...line.user('はじめ'), uuid });
    await app.waitFor('フック', () => hooks(id).length === 2);
    const kinds = types(id);
    const user = kinds.indexOf('user');
    expect(kinds.slice(user, user + 3)).toEqual(['user', 'hook', 'hook']);
  });

  it('発言のときのフックが発言を止めた（発言が会話に出ないまま、モデルを呼ばずに終わった）ときは、待たせていたフックをターンの終わりの前に出す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const uuid = await app.send(id, 'ブロックして');
    // 2.1.302 の順番（実測）: started → フック（止めたものは失敗）→ result（num_turns 0・success）
    pipe.emit(stream.lifecycle(uuid, 'started'));
    pipe.emit(response('h1', 'UserPromptSubmit'));
    pipe.emit(response('h2', 'UserPromptSubmit', { outcome: 'error', exit_code: 2, stderr: '止めました' }));
    app.finish(id, { num_turns: 0, terminal_reason: null });
    expect(types(id).slice(-2)).toEqual(['hook', 'turn-end']);
  });

  it('ツールに付かないフック（発言のとき・起動のとき）は、そのまま出す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.emit(response('h1', 'UserPromptSubmit'));
    pipe.emit(response('h2', 'SessionStart:startup'));
    await app.waitFor('フック', () => hooks(id).length === 2);
    expect(hooks(id).map((r) => [r.name, r.toolUseId])).toEqual([
      ['UserPromptSubmit', null],
      ['SessionStart:startup', null],
    ]);
  });

  it('出力したフック（会話ログに残る）・アプリのフック（suppressOutput）・Stop（要約に残る）・失敗したフックは出さない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.emit(response('h1', 'UserPromptSubmit', { stdout: 'ユーザーのフックの出力\n', output: 'ユーザーのフックの出力\n' }));
    pipe.emit(response('h2', 'UserPromptSubmit', { stdout: '{"suppressOutput":true}\n' }));
    pipe.emit(response('h3', 'UserPromptSubmit', { stderr: '注意\n' }));
    pipe.emit(response('h4', 'Stop'));
    pipe.emit(response('h5', 'UserPromptSubmit', { outcome: 'error', exit_code: 1 }));
    // 出力の欄が無い・文字列でない（Claude Code が欄を変えたなど。何も出力しなかったかを決められないので、出さない側に倒す）
    pipe.emit(response('h7', 'UserPromptSubmit', { stdout: undefined }));
    pipe.emit(response('h8', 'UserPromptSubmit', { stderr: null }));
    // 最後に出すもので、ここまでを読み終えたことを確かめる
    pipe.emit(response('h6', 'SessionStart:startup'));
    await app.waitFor('フック', () => hooks(id).length > 0);
    expect(hooks(id).map((r) => r.name)).toEqual(['SessionStart:startup']);
  });

  it('カードが会話ログに出ないまま（サブエージェントのツールでない、知らないツール）ターンが終わったら、ターンの終わりの前に出す。サブエージェントのツールのフックは出さない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, 'はじめ');
    const sub = { ...line.toolUse('toolu_sub', 'Read', { file_path: '/a' }), parent_tool_use_id: 'toolu_agent' };
    pipe.emit({ ...stream.assistant(sub, app.claudeId(id)), parent_tool_use_id: 'toolu_agent' });
    pipe.emit(response('h1', 'PreToolUse:Read'));
    pipe.emit(stream.assistant(line.toolUse('toolu_lost', 'Grep', { pattern: 'x' }), app.claudeId(id)));
    pipe.emit(response('h2', 'PreToolUse:Grep'));
    app.say(id, line.text('おわり'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    expect(hooks(id).map((r) => [r.name, r.toolUseId])).toEqual([['PreToolUse:Grep', 'toolu_lost']]);
    const types = app.events(id).map((e) => e.type);
    expect(types.lastIndexOf('hook')).toBeLessThan(types.lastIndexOf('turn-end'));
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
    expect(named.pipe.requests('generate_session_title')).toEqual([]);
    expect(titled.pipe.requests('generate_session_title')).toEqual([]);
  });
});
