// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, HookRun } from '@shared/chat';
import { acceptsInput, chatFromEvents, EMPTY_CHAT, statusOf, useSessionChats, withStatus } from '../../src/renderer/src/chat/chatState';
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
