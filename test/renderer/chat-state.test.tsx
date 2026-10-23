// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, HookRun } from '@shared/chat';
import type { UnknownEvent } from '@shared/unknown-event';
import { acceptsInput, chatFromEvents, EMPTY_CHAT, statusBarStatus, statusOf, UNKNOWN_SAMPLES, useSessionChats, withStatus } from '../../src/renderer/src/chat/chatState';
import { groupTools } from '../../src/renderer/src/chat/toolGroups';
import { applyOptions } from '../../src/renderer/src/export/exportContent';
import { mockApi } from './mock-api';

// チャットの状態（会話ログから作ったイベントを、チャットの行と状態にする）。
// 状態の移り変わり・再試行の表示・中断されたツール・巻き戻し・順番待ち・hooks のまとめ・ToDo と、
// main から届く配信（通し番号での重複の除去・途中から受けたときのスナップショット）

const run = (events: ChatEvent[]) => chatFromEvents(events);
const hook = (over: Partial<HookRun> = {}): HookRun => ({ event: 'Stop', name: 'Stop', command: 'echo', outcome: 'success', exitCode: 0, ...over }) as HookRun;

describe('状態の移り変わり', () => {
  it('起動中は入力を受け付けず、ready で待機中、発言で作業中、ターンの終わりで待機中、終了で終了', () => {
    expect(run([{ type: 'process-start' }]).status).toBe('starting');
    expect(run([{ type: 'process-start' }, { type: 'ready' }]).status).toBe('idle');
    expect(run([{ type: 'process-start' }, { type: 'ready' }, { type: 'user', id: 'u', text: 'a' }]).status).toBe('running');
    expect(run([{ type: 'process-start' }, { type: 'ready' }, { type: 'user', id: 'u', text: 'a' }, { type: 'turn-end' }]).status).toBe('idle');
    const exited = run([{ type: 'process-start' }, { type: 'ready' }, { type: 'process-exit', exitCode: 1 }]);
    expect(exited).toMatchObject({ status: 'exited', exitCode: 1 });
    expect(acceptsInput('starting')).toBe(false);
    expect(acceptsInput('idle') && acceptsInput('running')).toBe(true);
    expect(acceptsInput('exited')).toBe(false);
  });

  it('起動中に読み直した過去の会話では状態を変えず、引き継いだ claude がターンの途中なら ready のあとも作業中', () => {
    const replaying = run([{ type: 'process-start' }, { type: 'user', id: 'u', text: 'a' }]);
    expect(replaying).toMatchObject({ status: 'starting', inTurn: true });
    expect(run([{ type: 'process-start' }, { type: 'user', id: 'u', text: 'a' }, { type: 'ready' }]).status).toBe('running');
  });

  it('終了のわけ（ターミナルモードで起動を終える前に終わった など）を持つ。わけの無い終了では持たない', () => {
    const early: ChatEvent = { type: 'process-exit', exitCode: 1, reason: '起動を終える前に終わりました' };
    expect(run([{ type: 'process-start' }, early])).toMatchObject({ status: 'exited', exitCode: 1, exitReason: '起動を終える前に終わりました' });
    expect(run([{ type: 'process-start' }, early, { type: 'process-start' }, { type: 'ready' }, { type: 'process-exit', exitCode: 0 }]).exitReason).toBeNull();
  });

  it('終了したあとの発言・ターンの終わりで、状態を戻さない', () => {
    expect(run([{ type: 'process-start' }, { type: 'ready' }, { type: 'process-exit', exitCode: 0 }, { type: 'user', id: 'u', text: 'a' }, { type: 'turn-end' }]).status).toBe('exited');
  });

  it('知らせ（notice）と、別の Claude からのターンの始まり（turn-start）でも作業中になる', () => {
    const base: ChatEvent[] = [{ type: 'process-start' }, { type: 'ready' }];
    expect(run([...base, { type: 'notice', id: 'n', text: '完了しました', sessions: ['child'] }])).toMatchObject({
      status: 'running',
      items: [{ kind: 'notice', text: '完了しました', sessions: ['child'] }],
    });
    expect(run([...base, { type: 'turn-start' }])).toMatchObject({ status: 'running', items: [] });
  });

  it('起動し直すと（process-start）、前の表示を捨てる', () => {
    expect(run([{ type: 'user', id: 'u', text: 'a' }, { type: 'process-start' }]).items).toEqual([]);
  });
});

describe('チャットの行', () => {
  it('再試行中の API エラーは、応答・ツール・ターンの終わり・次のエラーで消す。あきらめたエラーは残す', () => {
    const retrying: ChatEvent = { type: 'api-error', id: 'e1', text: '529 再試行中', retrying: true };
    expect(run([retrying]).items).toMatchObject([{ kind: 'error', retrying: true }]);
    expect(run([retrying, { type: 'assistant-text', id: 't', text: '返事' }]).items.map((i) => i.kind)).toEqual(['text']);
    expect(run([retrying, { type: 'tool-use', id: 'x', name: 'Bash', target: 'ls', input: 'ls' }]).items.map((i) => i.kind)).toEqual(['tool']);
    expect(run([retrying, { type: 'turn-end' }]).items).toEqual([]);
    expect(run([retrying, { type: 'api-error', id: 'e2', text: '400', retrying: false }, { type: 'turn-end' }]).items).toMatchObject([{ id: 'e2', retrying: false }]);
  });

  it('同じ id の失敗の知らせが届き直したら（応答の前に終わったターンの発言の行が遅れて届いたとき）、前の行を外して今の位置に出す', () => {
    const error: ChatEvent = { type: 'api-error', id: 'r1', text: 'overloaded', retrying: false };
    const chat = run([error, { type: 'turn-end' }, { type: 'user', id: 'u', text: '仕上げて' }, error, { type: 'turn-end' }]);
    expect(chat.items.map((i) => `${i.kind}:${i.id}`)).toEqual(['user:u', 'error:r1']);
  });

  it('お知らせ（info）は、開くと読める全文と警告の印を持つ。作業中・待機中は変えない', () => {
    const chat = run([
      { type: 'process-start' },
      { type: 'ready' },
      { type: 'info', id: 'f', text: 'モデルを Opus 5.5 から Sonnet 5.5 に切り替えました', detail: 'Switched to Sonnet 5.5', warning: true },
      { type: 'info', id: 'm', text: 'メモリを 1 件思い出しました', detail: 'build.md' },
    ]);
    expect(chat.status).toBe('idle');
    expect(chat.items).toEqual([
      { kind: 'info', id: 'f', text: 'モデルを Opus 5.5 から Sonnet 5.5 に切り替えました', detail: 'Switched to Sonnet 5.5', warning: true },
      { kind: 'info', id: 'm', text: 'メモリを 1 件思い出しました', detail: 'build.md', warning: undefined },
    ]);
  });

  it('ツールは結果で完了・失敗になり、結果が来ないままターンが終わったら（中断）失敗にする', () => {
    const chat = run([
      { type: 'tool-use', id: 'a', name: 'Edit', target: 'a.ts', input: '', filePath: '/w/a.ts', at: 1 },
      { type: 'tool-use', id: 'b', name: 'Bash', target: 'npm test', input: 'npm test' },
      { type: 'tool-use', id: 'c', name: 'Bash', target: 'sleep', input: 'sleep 99' },
      { type: 'tool-result', id: 'a', isError: false, added: 3, removed: 1, line: 10, patch: ['+x'], at: 2 },
      { type: 'tool-result', id: 'b', isError: true, output: 'exit 1' },
      { type: 'turn-end' },
    ]);
    expect(chat.items).toMatchObject([
      { id: 'a', status: 'done', added: 3, removed: 1, line: 10, patch: ['+x'], startedAt: 1, endedAt: 2, filePath: '/w/a.ts' },
      { id: 'b', status: 'error', output: 'exit 1' },
      { id: 'c', status: 'error' },
    ]);
  });

  it('! のコマンドの出力は、まだ出力の無い直前のコマンドに付ける。無ければ出力だけの行にする', () => {
    expect(run([{ type: 'shell', id: 's', command: 'ls', output: '' }, { type: 'shell-output', id: 'o', output: 'a.txt' }]).items).toEqual([
      { kind: 'shell', id: 's', command: 'ls', output: 'a.txt' },
    ]);
    expect(run([{ type: 'shell', id: 's', command: 'ls', output: 'x' }, { type: 'shell-output', id: 'o', output: 'y' }]).items).toEqual([
      { kind: 'shell', id: 's', command: 'ls', output: 'x' },
      { kind: 'shell', id: 'o', command: '', output: 'y' },
    ]);
  });

  it('hooks: ツールのものはツールのカードに付け、ほかは同じきっかけのものをまとめる。同じ実行は重ねない', () => {
    const chat = run([
      { type: 'tool-use', id: 't', name: 'Bash', target: 'ls', input: 'ls' },
      { type: 'hook', id: 'h1', run: hook({ event: 'PostToolUse', toolUseId: 't' } as Partial<HookRun>) },
      { type: 'hook', id: 'h2', run: hook({ command: 'a' }) },
      { type: 'hook', id: 'h3', run: hook({ command: 'b' }) },
      { type: 'hook', id: 'h4', run: hook({ command: 'b' }) },
      { type: 'hook', id: 'h5', run: hook({ event: 'SessionStart', command: 'a' }) },
    ]);
    expect(chat.items.map((i) => (i.kind === 'tool' ? `tool:${i.hooks?.length}` : i.kind === 'hook' ? `hook:${i.runs.map((r) => r.command).join(',')}` : i.kind))).toEqual([
      'tool:1',
      'hook:a,b',
      'hook:a',
    ]);
  });

  it('hooks: 何も出力しなかったフック（hook_id のあるもの）は、1 回ずつ別の実行なので重ねない（カードに付けるものも、ツールに付かない行も）', () => {
    const quiet = (hookId: string, toolUseId: string | null) => hook({ event: 'PreToolUse', name: 'PreToolUse:Read', command: null, toolUseId, hookId } as Partial<HookRun>);
    const chat = run([
      { type: 'tool-use', id: 't', name: 'Read', target: 'a', input: 'a' },
      { type: 'hook', id: 'hook:q1', run: quiet('q1', 't') },
      { type: 'hook', id: 'hook:q2', run: quiet('q2', 't') },
      // 並べて呼んだ同じ名前のツールのもの（どの呼び出しのものか決められない）
      { type: 'hook', id: 'hook:q3', run: quiet('q3', null) },
      { type: 'hook', id: 'hook:q4', run: quiet('q4', null) },
      // 同じ実行が重ねて届いたもの（同じ hook_id）は重ねない
      { type: 'hook', id: 'hook:q4', run: quiet('q4', null) },
    ]);
    expect(chat.items.map((i) => (i.kind === 'tool' ? `tool:${i.hooks?.map((h) => h.hookId).join(',')}` : i.kind === 'hook' ? `hook:${i.runs.map((r) => r.hookId).join(',')}` : i.kind))).toEqual([
      'tool:q1,q2',
      'hook:q3,q4',
    ]);
  });

  it('ツールのまとまり: どの呼び出しのものか決められなかったツールの hooks（ツールに付かない行）は、まとまりの中に入れて切らない。ほかの hooks では切る', () => {
    const quiet = (hookId: string, event: string) => hook({ event, name: `${event}:Read`, command: null, toolUseId: null, hookId } as Partial<HookRun>);
    const chat = run([
      { type: 'tool-use', id: 'glob', name: 'Glob', target: '*.ts', input: '*.ts' },
      { type: 'tool-use', id: 'a', name: 'Read', target: 'a', input: 'a' },
      { type: 'tool-use', id: 'b', name: 'Read', target: 'b', input: 'b' },
      { type: 'hook', id: 'hook:q1', run: quiet('q1', 'PreToolUse') },
      { type: 'hook', id: 'hook:q2', run: quiet('q2', 'PostToolUse') },
      { type: 'tool-use', id: 'bash', name: 'Bash', target: 'ls', input: 'ls' },
      { type: 'hook', id: 'hook:s1', run: quiet('s1', 'Stop') },
      { type: 'tool-use', id: 'edit', name: 'Edit', target: 'a.ts', input: '' },
    ]);
    const rows = groupTools(chat.items).map((row) =>
      row.kind === 'tool-group' ? `group:${row.tools.map((t) => t.id).join(',')}/${row.items.length}` : row.kind === 'hook-group' ? `hooks:${row.runs.map((r) => r.hookId).join(',')}` : row.kind,
    );
    expect(rows).toEqual(['group:glob,a,b,bash/6', 'hooks:s1', 'group:edit/1']);
  });

  it('hooks: 質問のフック（アプリが足したもの）が AskUserQuestion に答えた記録（コマンドの無い PermissionRequest）は出さない', () => {
    const decided = (toolUseId: string, command: string | null = null) => ({ type: 'hook' as const, id: `h-${toolUseId}`, run: hook({ event: 'PermissionRequest', name: 'PermissionRequest', command, toolUseId } as Partial<HookRun>) });
    const chat = run([
      { type: 'tool-use', id: 'ask', name: 'AskUserQuestion', target: 'どちら?', input: 'どちら?' },
      decided('ask'),
      // ユーザーのフック（コマンドが残る）・ほかのツールの決定は出す
      decided('ask', 'my-hook'),
      { type: 'tool-use', id: 'bash', name: 'Bash', target: 'ls', input: 'ls' },
      decided('bash'),
    ]);
    expect(chat.items.map((i) => (i.kind === 'tool' ? `${i.name}:${i.hooks?.map((h) => h.command ?? '-').join(',') ?? ''}` : i.kind))).toEqual(['AskUserQuestion:my-hook', 'Bash:-']);
  });

  it('巻き戻し（replace）で表示を置き換え、reset で行と ToDo を空にする。順番待ち・Remote Control・PR を覚える', () => {
    const before: ChatEvent[] = [{ type: 'user', id: 'u1', text: '一' }, { type: 'user', id: 'u2', text: '二' }];
    expect(run([...before, { type: 'replace', events: [{ type: 'user', id: 'u1', text: '一' }] }]).items.map((i) => i.id)).toEqual(['u1']);
    expect(run([...before, { type: 'reset' }]).items).toEqual([]);
    // 最適化圧縮の切り替え（アプリが打った /clear）では、行を消さない（人が読んでいる途中の答えが消えないように）。ToDo は空にする
    const kept = run([...before, { type: 'reset', compact: true }]);
    expect(kept.items).toEqual(run(before).items);
    expect(kept.items.length).toBeGreaterThan(0);
    expect(kept.todos).toBeNull();
    const pr = { number: 7, url: 'https://github.com/o/r/pull/7', repository: 'o/r' };
    const later = { id: 'q1', text: 'あとで', pastes: [], images: 0, state: 'queued' as const };
    const chat = run([
      { type: 'queue', prompts: [later] },
      { type: 'remote-control', url: 'https://claude.ai/code/x' },
      { type: 'pr-link', pr },
    ]);
    expect(chat).toMatchObject({ unsent: [later], remoteControlUrl: 'https://claude.ai/code/x', pr });
    // 送った発言が会話に出たら、main が空の一覧を知らせる
    expect(run([{ type: 'queue', prompts: [later] }, { type: 'queue', prompts: [] }]).unsent).toEqual([]);
  });
});

describe('未知のイベント', () => {
  const unknown = (id: string, over: Partial<UnknownEvent> = {}): UnknownEvent => ({
    type: 'unknown-event',
    id,
    name: 'system/ui_toast',
    problem: 'unknown',
    source: 'stream',
    raw: `{"uuid":"${id}"}`,
    ...over,
  });
  // 行ごとの [名前, 数, 生の行の ID と出どころ]
  const rows = (events: ChatEvent[]) =>
    run(events).items.map((i) => (i.kind === 'unknown' ? [i.name, i.count, i.samples.map((s) => `${s.id}@${s.source}`)] : i.kind));

  it('ターンを始めず、作業中・待機中を変えない', () => {
    const idle = run([{ type: 'process-start' }, { type: 'ready' }, unknown('unknown:a')]);
    expect(idle).toMatchObject({ status: 'idle', inTurn: false });
    const running = run([{ type: 'process-start' }, { type: 'ready' }, { type: 'user', id: 'u', text: 'a' }, unknown('unknown:a')]);
    expect(running).toMatchObject({ status: 'running', inTurn: true });
  });

  it('同じ種類が間を置かずに続いたら 1 行にまとめて数え、それぞれの生の行を残す。ほかの行を挟んだら・種類やわけが違えば、別の行にする', () => {
    expect(
      rows([
        unknown('unknown:a'),
        unknown('unknown:b'),
        // 画面の行にならないもの（ターンの終わり・順番待ちなど）は、間に挟んでも切らない
        { type: 'turn-end' },
        unknown('unknown:c'),
        unknown('unknown:d', { name: 'system/files_persisted' }),
        unknown('unknown:e', { name: 'system/files_persisted', problem: 'malformed' }),
        { type: 'info', id: 'i', text: 'お知らせ' },
        unknown('unknown:f'),
      ]),
    ).toEqual([
      ['system/ui_toast', 3, ['unknown:a@stream', 'unknown:b@stream', 'unknown:c@stream']],
      ['system/files_persisted', 1, ['unknown:d@stream']],
      ['system/files_persisted', 1, ['unknown:e@stream']],
      'info',
      ['system/ui_toast', 1, ['unknown:f@stream']],
    ]);
  });

  it('stream と会話ログの両方に出た同じ行（同じ id）は、前に出た行の隣に生の行を足し、数は増やさない。同じところから届き直したものは足さない', () => {
    expect(
      rows([
        unknown('unknown:a'),
        { type: 'assistant-text', id: 't', text: '返事' },
        unknown('unknown:a', { source: 'transcript' }),
        unknown('unknown:a', { source: 'transcript' }),
        unknown('unknown:a'),
      ]),
    ).toEqual([['system/ui_toast', 1, ['unknown:a@stream', 'unknown:a@transcript']], 'text']);
  });

  it('まとめた行の生の行は、新しいほうから UNKNOWN_SAMPLES 件まで残す。数は全部を数える', () => {
    const events = Array.from({ length: UNKNOWN_SAMPLES + 5 }, (_, i) => unknown(`unknown:${i}`));
    const [item] = run(events).items;
    expect(item).toMatchObject({ kind: 'unknown', count: UNKNOWN_SAMPLES + 5 });
    expect(item.kind === 'unknown' && item.samples.map((s) => s.id)).toEqual(events.slice(5).map((e) => e.id));
  });

  it('作業の書き出しには入れない', () => {
    const items = run([{ type: 'user', id: 'u', text: 'a' }, unknown('unknown:a')]).items;
    expect(applyOptions(items, { thinking: true, toolOutput: true, diffs: true, images: true, homeToTilde: false }, '/Users/me').map((i) => i.kind)).toEqual(['user']);
  });
});

describe('チャットの状態は、main の状態（一覧の state）から決める', () => {
  it('動いているセッションは state から。まだ読んでいない・アーカイブ・一覧の外のセッションは、イベントから作ったまま', () => {
    const idle = run([{ type: 'process-start' }, { type: 'ready' }]);
    expect(idle.status).toBe('idle');
    expect(statusOf(idle, 'starting')).toBe('starting');
    // 作業中と、ターンの途中で人の答えを待っているもの。ターミナルモード（人が TUI で操作している）も、チャットからは操作しない
    for (const state of ['working', 'question', 'permission', 'terminal', 'browser'] as const) expect(statusOf(idle, state)).toBe('running');
    // ターンが終わって、裏のタスクだけが動いている間も、発言を受け付ける
    expect(statusOf(idle, 'background')).toBe('idle');
    expect(statusOf(run([{ type: 'process-start' }, { type: 'ready' }, { type: 'user', id: 'u1', text: '頼み' }]), 'idle')).toBe('idle');
    expect(statusOf(idle, 'exited')).toBe('exited');
    expect(statusOf(idle, 'archived')).toBe('idle');
    expect(statusOf(idle, null)).toBe('idle');
    expect(statusOf(idle, undefined)).toBe('idle');
    // まだチャットを読んでいない（起動していない）セッションは、開くまで起動前のまま
    expect(statusOf(EMPTY_CHAT, 'working')).toBe('not-started');
  });

  it('ステータスバーは、ターミナルモードの間だけ、TUI がターンの途中か（terminalWorking）で待機中・作業中を出す（一覧の印と同じ）', () => {
    const terminal = statusOf(run([{ type: 'process-start' }, { type: 'ready' }]), 'terminal');
    expect(terminal).toBe('running');
    expect(statusBarStatus(terminal, { state: 'terminal', terminalWorking: false })).toBe('idle');
    expect(statusBarStatus(terminal, { state: 'terminal', terminalWorking: true })).toBe('running');
    expect(statusBarStatus(terminal, { state: 'terminal' })).toBe('idle');
    // ターミナルモードでなければ、チャットの状態のまま
    expect(statusBarStatus('running', { state: 'working', terminalWorking: false })).toBe('running');
    expect(statusBarStatus('starting', { state: 'starting' })).toBe('starting');
    expect(statusBarStatus('idle', null)).toBe('idle');
  });

  it('withStatus: 状態が同じならそのまま返す。違えば状態だけを替え、同じチャットと状態には同じものを返す（描き直しを増やさない）', () => {
    const idle = run([{ type: 'process-start' }, { type: 'ready' }]);
    expect(withStatus(idle, 'idle')).toBe(idle);
    const running = withStatus(idle, 'working');
    expect(running).toEqual({ ...idle, status: 'running' });
    expect(withStatus(idle, 'working')).toBe(running);
    expect(withStatus(idle, 'permission')).toBe(running);
    expect(withStatus(idle, 'starting').status).toBe('starting');
  });
});

describe('ToDo', () => {
  it('TodoWrite は一覧を置き換え、TaskCreate は結果で番号が分かってから足し、TaskUpdate で状態を変え、deleted で消す', () => {
    const chat = run([
      { type: 'tool-use', id: 'w', name: 'TodoWrite', target: '', input: '', todos: [{ content: '古い', status: 'pending' }] },
      { type: 'tool-use', id: 'c1', name: 'TaskCreate', target: '', input: '', taskChange: { kind: 'create', subject: '設計する' } },
      { type: 'tool-use', id: 'c2', name: 'TaskCreate', target: '', input: '', taskChange: { kind: 'create', subject: '実装する' } },
      { type: 'tool-result', id: 'c1', isError: false, createdTaskId: '1' },
      { type: 'tool-result', id: 'c2', isError: false, createdTaskId: '2' },
      { type: 'tool-use', id: 'u1', name: 'TaskUpdate', target: '', input: '', taskChange: { kind: 'update', taskId: '1', status: 'completed' } },
      { type: 'tool-use', id: 'u2', name: 'TaskUpdate', target: '', input: '', taskChange: { kind: 'update', taskId: '2', status: 'deleted' } },
    ]);
    // TodoWrite の一覧（番号が無い）とは混ぜない
    expect(chat.todos).toEqual([{ content: '設計する', status: 'completed', activeForm: undefined, id: '1' }]);
    expect(chat.pendingTasks).toEqual({});
  });

  it('失敗した TaskCreate は一覧に足さない', () => {
    const chat = run([
      { type: 'tool-use', id: 'c1', name: 'TaskCreate', target: '', input: '', taskChange: { kind: 'create', subject: '設計する' } },
      { type: 'tool-result', id: 'c1', isError: true },
    ]);
    expect(chat.todos).toBeNull();
  });
});

describe('main からの配信（useSessionChats）', () => {
  let api: ReturnType<typeof mockApi>;
  beforeEach(() => {
    api = mockApi({ 'sessions.snapshot': () => Promise.resolve({ sessionId: 's1', fromSeq: 0, events: [{ type: 'user', id: 'u1', text: '一' }, { type: 'user', id: 'u2', text: '二' }] }) });
    api.install();
  });

  it('届いた配信をつなげ、同じ通し番号のものは重ねない', () => {
    const { result } = renderHook(() => useSessionChats('s1'));
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 0, events: [{ type: 'user', id: 'u1', text: '一' }], live: true }));
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 0, events: [{ type: 'user', id: 'u1', text: '一' }, { type: 'user', id: 'u2', text: '二' }], live: true }));
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 1, events: [{ type: 'user', id: 'u2', text: '二' }], live: true }));
    expect(result.current.chatOf('s1').items.map((i) => i.id)).toEqual(['u1', 'u2']);
    expect(api.argsOf('sessions.snapshot')).toEqual([]);
  });

  it('書いている途中の文（partial）は、届いたら今の全部に置き換える。イベントの無い配信でも置き換え、通し番号は進めない', () => {
    const { result } = renderHook(() => useSessionChats('s1'));
    const partial = (text: string) => [{ id: 'm:0', kind: 'text' as const, text }];
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 0, events: [{ type: 'user', id: 'u1', text: '一' }], live: true }));
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 1, events: [], live: true, partial: partial('パ') }));
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 1, events: [], live: true, partial: partial('パンは') }));
    expect(result.current.partials.get('s1')).toEqual(partial('パンは'));
    // partial の無い配信では、途中の文を変えない
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 1, events: [{ type: 'info', id: 'i', text: '知らせ' }], live: true }));
    expect(result.current.partials.get('s1')).toEqual(partial('パンは'));
    // 会話ログに出た応答と、途中の文を外したものは、同じ配信で届く
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 2, events: [{ type: 'assistant-text', id: 'a', text: 'パンは小麦から' }], live: true, partial: [] }));
    const chat = result.current.chatOf('s1');
    expect(chat.items.map((i) => i.id)).toEqual(['u1', 'i', 'a']);
    expect(result.current.partials.get('s1')).toEqual([]);
    // 途中の文が外れたのと同じ配信で出た本文には、印を付ける（出るときの動きを付けない）。ほかの配信で出た行には付けない
    expect(chat.items.map((i) => (i.kind === 'text' ? i.settled : undefined))).toEqual([undefined, undefined, true]);
    // 持っているものより古い配信（もう受け取ったイベントの配信）の途中の文は使わない
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 1, events: [{ type: 'info', id: 'i', text: '知らせ' }], live: true, partial: partial('古い') }));
    expect(result.current.partials.get('s1')).toEqual([]);
    expect(api.argsOf('sessions.snapshot')).toEqual([]);
  });

  it('途中の文だけの配信では、チャットを入れ替えず（App を描き直さず）、途中の文の聞き手にだけ知らせる', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSessionChats('s1');
    });
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 0, events: [{ type: 'user', id: 'u1', text: '一' }], live: true }));
    act(() => api.emit('sessions.onChat', { sessionId: 's2', fromSeq: 0, events: [{ type: 'user', id: 'v1', text: '別の' }], live: true }));
    const chat = result.current.chatOf('s1');
    const heard: string[] = [];
    const off = result.current.partials.subscribe('s1', () => heard.push(result.current.partials.get('s1').map((p) => p.text).join('')));
    const before = renders;
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 1, events: [], live: true, partial: [{ id: 'm:0', kind: 'text', text: 'パ' }] }));
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 1, events: [], live: true, partial: [{ id: 'm:0', kind: 'text', text: 'パン' }] }));
    expect(renders).toBe(before);
    expect(result.current.chatOf('s1')).toBe(chat);
    expect(heard).toEqual(['パ', 'パン']);
    // ほかのセッションの途中の文では知らせない
    act(() => api.emit('sessions.onChat', { sessionId: 's2', fromSeq: 1, events: [], live: true, partial: [{ id: 'm:0', kind: 'text', text: '別' }] }));
    expect(renders).toBe(before);
    expect(heard).toEqual(['パ', 'パン']);
    // 会話に行が出る配信では描き直す。途中の文が外れたことも知らせる
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 1, events: [{ type: 'assistant-text', id: 'a', text: 'パン' }], live: true, partial: [] }));
    expect(renders).toBe(before + 1);
    expect(heard).toEqual(['パ', 'パン', '']);
    off();
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 2, events: [], live: true, partial: [{ id: 'm:1', kind: 'text', text: '次' }] }));
    expect(heard).toEqual(['パ', 'パン', '']);
  });

  it('ターンの終わり・終了・/clear・起動で途中の文を消し、巻き戻しの組み立て直しでは残す（main が持つものなので）', () => {
    const partial = [{ id: 'm:0', kind: 'text' as const, text: '書きかけ' }];
    const cases: [ChatEvent, boolean][] = [
      [{ type: 'turn-end' }, false],
      [{ type: 'process-exit', exitCode: 0 }, false],
      [{ type: 'reset' }, false],
      [{ type: 'process-start' }, false],
      [{ type: 'replace', events: [{ type: 'user', id: 'u1', text: '一' }] }, true],
      [{ type: 'info', id: 'i', text: '知らせ' }, true],
    ];
    cases.forEach(([event, kept], n) => {
      const id = `s${n + 10}`;
      const { result } = renderHook(() => useSessionChats(id));
      act(() => api.emit('sessions.onChat', { sessionId: id, fromSeq: 0, events: [{ type: 'user', id: 'u1', text: '一' }], live: true, partial }));
      act(() => api.emit('sessions.onChat', { sessionId: id, fromSeq: 1, events: [event], live: true }));
      expect(result.current.partials.get(id)).toEqual(kept ? partial : []);
    });
  });

  it('途中の文が外れた配信の行の印は、外れたブロックと同じ種類・同じ数だけ、出た順に付ける（途中の文の無かった行には付けない）', () => {
    const { result } = renderHook(() => useSessionChats('s1'));
    const thinking = { id: 'm:0', kind: 'thinking' as const, text: '考え' };
    const text = { id: 'm:1', kind: 'text' as const, text: '答え' };
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 0, events: [{ type: 'user', id: 'u1', text: '一' }], live: true, partial: [thinking, text] }));
    act(() =>
      api.emit('sessions.onChat', {
        sessionId: 's1',
        fromSeq: 1,
        events: [
          { type: 'thinking', id: 'th', text: '考え' },
          { type: 'assistant-text', id: 'a1', text: '答え（途中の文が無かった前の行）' },
        ],
        live: true,
        partial: [text],
      }),
    );
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 3, events: [{ type: 'assistant-text', id: 'a2', text: '答え' }], live: true, partial: [] }));
    const settled = result.current.chatOf('s1').items.map((i) => [i.id, i.kind === 'text' || i.kind === 'thinking' ? !!i.settled : null]);
    expect(settled).toEqual([
      ['u1', null],
      ['th', true],
      ['a1', false],
      ['a2', true],
    ]);
  });

  it('スナップショットの途中の文も受け取る', async () => {
    mockApi({ 'sessions.snapshot': () => Promise.resolve({ sessionId: 's1', fromSeq: 0, events: [{ type: 'user', id: 'u1', text: '一' }], partial: [{ id: 'm:0', kind: 'text', text: '書きかけ' }] }) }).install();
    const { result } = renderHook(() => useSessionChats('s1'));
    await act(async () => {
      result.current.load('s1');
      await Promise.resolve();
    });
    expect(result.current.partials.get('s1')).toEqual([{ id: 'm:0', kind: 'text', text: '書きかけ' }]);
  });

  it('途中から受けたセッションは、取りこぼした分をスナップショットで埋める', async () => {
    const { result } = renderHook(() => useSessionChats('s1'));
    await act(async () => {
      api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 1, events: [{ type: 'user', id: 'u2', text: '二' }], live: true });
      await Promise.resolve();
    });
    expect(api.argsOf('sessions.snapshot')).toEqual([['s1']]);
    expect(result.current.chatOf('s1').items.map((i) => i.id)).toEqual(['u1', 'u2']);
  });
});
