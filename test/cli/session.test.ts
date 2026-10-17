import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent } from '@shared/chat';
import { REWOUND } from '../scenario';
import { ClaudeRun, claudeVersion, shown } from './claude-run';
import { MockApi, type Block } from './mock-api';

// 本物の claude をモックの API で動かし、会話の操作を、画面にキーを送らずに制御の要求と発言で行えるかを確かめる（stream-json。設計書 8 節）。
// 権限モード（set_permission_mode）・作業中の進み具合・作業中に送った発言の順番待ち・応答のモデル・モデルとエフォート（set_model・
// apply_flag_settings）・裏の Bash の停止（stop_task）・/compact（指示を添えたものも）・/clear・--resume・巻き戻し（rewind_files・rewind_conversation）

const SLOW = 'ゆっくり返事してください';
const QUEUED = '順番待ちの発言です';
const AFTER_CLEAR = '新しい会話を始めます';
const AFTER_RESUME = REWOUND;
const AFTER_REWIND = '巻き戻したあとの発言です';
const WRITE = 'ファイルを書いてください（WRITE-FILE）';
const SLEEP = '裏で待ってください（BG-SLEEP）';
// /compact に添える指示（コンテキストのパネルで組み立てたもの）
const COMPACT_INSTRUCTIONS = ['順番待ちの発言の話は詳しく残す。', 'ゆっくりの返事の話は捨ててよい。', '（指示が届いたかの目印 COMPACT-MARK-1）', '以上'].join('\n');
// 応答に書くモデル。会話ログ・stream-json のモデルが、ヘッダーのモデルになるかを見る
const MOCK_MODEL = 'claude-mockmodel-9';

const version = claudeVersion();

describe(`Claude Code ${version} の会話の操作`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  // session-manager が持っている今のチャットを、画面と同じく reset・replace を当てて並べたもの
  const chat = () => shown(run.chat());
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  const texts = (events: ChatEvent[]) => events.flatMap((e) => (e.type === 'user' || e.type === 'assistant-text' ? [`${e.type}: ${e.text}`] : []));
  const idle = (label: string) => run.untilState(label, (state) => state === 'idle', 30_000);
  const file = () => join(run.cwd, 'rewind.txt');

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [
      // 作業中の進み具合を見るため、応答を遅らせる（/compact の要約もこの会話の続きとして届く）
      { match: SLOW, delayMs: 4000, model: MOCK_MODEL, steps: [[{ type: 'text', text: 'ゆっくりの返事' }], [{ type: 'text', text: '順番待ちへの返事' }]] },
      { match: AFTER_CLEAR, steps: [[{ type: 'text', text: '新しい会話の返事' }], [{ type: 'text', text: '再開後の返事' }]] },
    ];
    // 目印の発言には、ツールを呼ぶ。その結果と裏のタスクの知らせには、受け取ったことを返す
    api.intercept = (prompt, results): Block[] | null => {
      if (prompt.includes('WRITE-FILE')) return [{ type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: file(), content: '書いた\n' } }];
      if (prompt.includes('BG-SLEEP')) return [{ type: 'tool_use', id: 'toolu_sleep', name: 'Bash', input: { command: 'sleep 30', description: '待つ', run_in_background: true } }];
      if (prompt.includes('<task-notification>')) return [{ type: 'text', text: '裏のタスクの知らせを受け取りました' }];
      if (results.length > 0 && !prompt.includes(SLOW)) return [{ type: 'text', text: 'ツールの結果を受け取りました' }];
      return null;
    };
    run = new ClaudeRun(await api.start(), { settings: { permissions: { allow: ['Bash(sleep:*)'] } } });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('権限モードを、set_permission_mode で切り替える（Claude Code が知らせたモードが一覧に出る）', async () => {
    for (const mode of ['acceptEdits', 'plan', 'manual'] as const) {
      expect(await run.manager.setMode(run.sessionId!, mode), mode).toBe(true);
      await run.waitUntil(mode, () => run.summary()?.mode === mode);
    }
  });

  it('作業中の進み具合と、一覧の状態が読める', async () => {
    await run.send(SLOW);
    await run.waitUntil('作業中', () => run.activities.some((a) => a !== null));
    await run.waitUntil('一覧の状態', () => run.manager.liveSessions()[0]?.state === '作業中');
  });

  it('作業中に送った発言が順番待ちになり、あとで受け取られる', async () => {
    await run.send(QUEUED);
    await run.waitUntil('順番待ち', () => run.queue.includes(QUEUED));
    expect(run.manager.stateOf(run.sessionId!)).toBe('working');
    // 受け取られたら、順番待ちから消えて発言になる
    await run.waitUntil('順番待ちへの返事', replied('順番待ちへの返事'), 30_000);
    await run.waitUntil('順番待ちが空く', () => run.queue.length === 0);
    expect(run.chatEvents).toContainEqual(expect.objectContaining({ type: 'user', text: QUEUED }));
    await idle('待機中');
    expect(run.activities.at(-1)).toBeNull();
  });

  it('応答のモデルを、ヘッダーのモデルにする', () => {
    expect(run.statusLine?.model?.id).toBe(MOCK_MODEL);
  });

  it('モデルとエフォートを、起動し直さずに set_model・apply_flag_settings で切り替える。次の応答から使われる', async () => {
    const init = run.manager['runtimes'].get(run.sessionId!)!.init!;
    const target = init.models.find((m) => m.value !== 'default' && (m.supportedEffortLevels ?? []).includes('low'));
    expect(target, 'エフォートを選べるモデル').toBeDefined();
    const pid = init.pid;
    await run.manager.configure(run.sessionId!, { model: target!.value, effort: 'low', settingsFile: null });
    expect(run.summary()).toMatchObject({ model: target!.value, effort: 'low' });
    const from = api.calls.length;
    await run.send(AFTER_CLEAR.replace('始めます', '確かめます'));
    await run.waitUntil('次の応答', () => api.calls.length > from);
    expect(api.calls[from]).toEqual({ model: target!.resolvedModel, effort: 'low' });
    // 起動し直していない
    expect(run.manager['runtimes'].get(run.sessionId!)!.init!.pid).toBe(pid);
    await idle('待機中');
    // 元に戻す（既定のモデル・エフォート）と、次の応答から既定のモデルになる
    await run.manager.configure(run.sessionId!, { model: null, effort: null, settingsFile: null });
    expect(run.summary()).toMatchObject({ model: null, effort: null });
    // apply_flag_settings は --settings と同じ層を変えるので、アプリが --settings で入れたフック（書くだけの Stop のフック）が
    // そのあとも動くかを見る
    const idleFile = run.statusFile.replace(/\.json$/, '.idle.json');
    rmSync(idleFile, { force: true });
    const before = api.calls.length;
    await run.send(AFTER_CLEAR.replace('始めます', '戻します'));
    await run.waitUntil('既定での応答', () => api.calls.length > before);
    const defaultModel = init.models.find((m) => m.value === 'default')?.resolvedModel;
    expect(api.calls[before].model).toBe(defaultModel);
    expect(api.calls[before].effort).not.toBe('low');
    await idle('待機中');
    await run.waitUntil('Stop のフック', () => existsSync(idleFile));
  });

  it('裏の Bash を stop_task で止める。止まったことは Claude Code の知らせで分かる', async () => {
    await run.send(SLEEP);
    await run.waitUntil('裏の Bash', () => run.bashTasks.some((task) => task.state === 'running'));
    // ターンが終わっても、裏の Bash が動いている間は「裏で作業中」（待機中にはならない）
    await run.untilState('ターンの終わり', (state) => state === 'background', 30_000);
    const task = run.bashTasks.find((t) => t.state === 'running')!;
    expect(await run.manager.stopTask(run.sessionId!, { kind: 'bash', toolUseId: task.toolUseId })).toBeNull();
    await run.waitUntil('止まる', () => run.bashTasks.find((t) => t.toolUseId === task.toolUseId)?.state !== 'running', 30_000);
    await idle('待機中');
  });

  it('/compact で会話の区切りが出る', async () => {
    const dividers = () => run.chatEvents.filter((e) => e.type === 'divider').length;
    const before = dividers();
    await run.send('/compact');
    await run.waitUntil('圧縮の区切り', () => dividers() > before, 30_000);
    await idle('待機中');
  });

  it('/compact に複数行の指示を添えると、要約の頼みに指示が入る（発言 1 行で送る）', async () => {
    const dividers = () => run.chatEvents.filter((e) => e.type === 'divider').length;
    const before = dividers();
    await run.send(`/compact ${COMPACT_INSTRUCTIONS}`);
    await run.waitUntil('圧縮の区切り', () => dividers() > before, 30_000);
    await idle('待機中');
    const asked = api.lastPrompts.find((p) => p.includes('Additional Instructions:'));
    expect(asked).toContain(`Additional Instructions:\n${COMPACT_INSTRUCTIONS}`);
  });

  it('/clear のあと、新しい会話（init の session_id）の会話ログに乗り換え、チャットを空にして出し直す', async () => {
    const before = run.claudeSessionId;
    await run.send('/clear');
    await run.waitUntil('乗り換え', () => run.switches.length === 1, 30_000);
    expect(run.claudeSessionId).not.toBe(before);
    await idle('待機中');
    await run.send(AFTER_CLEAR);
    await run.waitUntil('新しい会話の返事', replied('新しい会話の返事'));
    expect(texts(chat()).filter((t) => !t.endsWith('/clear'))).toEqual([`user: ${AFTER_CLEAR}`, 'assistant-text: 新しい会話の返事']);
    await idle('待機中');
  });

  it('--resume で再開すると、前の会話を読み直してから続けられる', async () => {
    run.stopClaude();
    await run.waitUntil('終了', () => run.chatEvents.at(-1)?.type === 'process-exit');
    const seen = run.seen.length;
    run.start({ resume: true });
    await run.untilState('起動', (state) => state === 'idle', 30_000);
    expect(run.historyLoaded).toBe(true);
    expect(run.seen.slice(seen).some((s) => s.isHistory && s.entry.type === 'user')).toBe(true);
    await run.send(AFTER_RESUME);
    await run.waitUntil('再開後の返事', replied('再開後の返事'));
    await idle('待機中');
  });

  it('巻き戻し: コードを戻すと変わるファイルを調べ、コードだけを戻す（rewind_files）', async () => {
    await run.send(WRITE);
    const permission = await run.permission('Write の許可');
    run.replyPermission(permission, { kind: 'allow' });
    await idle('待機中');
    expect(existsSync(file())).toBe(true);
    const written = chat().find((e) => e.type === 'user' && e.text === WRITE);
    const preview = await run.manager.rewindPreview(run.sessionId!, written!.type === 'user' ? written!.id : '');
    expect(preview?.files).toEqual([file()]);
    expect(await run.manager.rewind(run.sessionId!, written!.type === 'user' ? written!.id : '', { conversation: false, code: true })).toMatchObject({ ok: true });
    expect(existsSync(file())).toBe(false);
  });

  it('巻き戻し: 会話を戻すと、戻した発言の文が返り、チャットはその前の時点になる。次の発言は枝分かれして続く', async () => {
    const target = chat().find((e) => e.type === 'user' && e.text === AFTER_RESUME);
    expect(target).toBeDefined();
    const outcome = await run.manager.rewind(run.sessionId!, target!.type === 'user' ? target!.id : '', { conversation: true, code: false });
    expect(outcome).toMatchObject({ ok: true, prefillText: AFTER_RESUME });
    expect(texts(chat())).not.toContain(`user: ${AFTER_RESUME}`);
    expect(texts(chat())).toContain(`user: ${AFTER_CLEAR}`);
    await run.send(AFTER_REWIND);
    await run.waitUntil('巻き戻したあとの返事', () => texts(chat()).includes(`user: ${AFTER_REWIND}`) && texts(chat()).at(-1)?.startsWith('assistant-text') === true, 30_000);
    expect(texts(chat())).not.toContain(`user: ${AFTER_RESUME}`);
    expect(texts(chat())).not.toContain(`user: ${WRITE}`);
  });
});
