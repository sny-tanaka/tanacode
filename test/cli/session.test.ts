import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent } from '@shared/chat';
import { promptKeys } from '@shared/prompt-keys';
import { REWOUND, checkRewindRestore } from '../scenario';
import { ClaudeRun, claudeVersion, menuOf, shown } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、会話の操作をアプリと同じ部品で読めるかを確かめる。
// 権限モードの切り替え（Shift+Tab）・作業中の進み具合・作業中に送った発言の順番待ち・/compact（指示を添えたものも）・/clear・--resume・/rewind

const SLOW = 'ゆっくり返事してください';
const QUEUED = '順番待ちの発言です';
const AFTER_CLEAR = '新しい会話を始めます';
const AFTER_RESUME = REWOUND;
const AFTER_REWIND = '巻き戻したあとの発言です';
// /compact に添える指示（コンテキストのパネルで組み立てたもの）。行が多いと、入力欄では貼り付けの目印になる
const COMPACT_INSTRUCTIONS = ['順番待ちの発言の話は詳しく残す。', 'ゆっくりの返事の話は捨ててよい。', '（指示が届いたかの目印 COMPACT-MARK-1）', '以上'].join('\n');
// 応答に書くモデル（起動時のバナーのモデル名と違うもの）。会話ログのモデルが画面のモデル名になるかを見る
const MOCK_MODEL = 'claude-mockmodel-9';

const version = claudeVersion();

describe(`Claude Code ${version} の会話の操作`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  // session-manager が持っている今のチャットを、画面と同じく reset・replace を当てて並べたもの
  const chat = () => shown(run.chat());
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  const texts = (events: ChatEvent[]) => events.flatMap((e) => (e.type === 'user' || e.type === 'assistant-text' ? [`${e.type}: ${e.text}`] : []));

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [
      // 作業中の画面を見るため、応答を遅らせる（/compact の要約もこの会話の続きとして届く）
      { match: SLOW, delayMs: 4000, model: MOCK_MODEL, steps: [[{ type: 'text', text: 'ゆっくりの返事' }], [{ type: 'text', text: '順番待ちへの返事' }]] },
      { match: AFTER_CLEAR, steps: [[{ type: 'text', text: '新しい会話の返事' }], [{ type: 'text', text: '再開後の返事' }]] },
    ];
    run = new ClaudeRun(await api.start());
    await run.open();
  });

  afterAll(async () => {
    if (process.env.TANACODE_RECORD) run?.recordScreens(join('test', 'fixtures', 'claude-code', version));
    await run?.stop();
    await api?.stop();
  });

  it('権限モードを切り替えて、入力欄の下の表示から読める', async () => {
    for (const mode of ['acceptEdits', 'plan', 'manual'] as const) {
      expect(await run.screen.setMode(mode), mode).toBe(true);
      expect(run.screen.current.mode).toBe(mode);
    }
  });

  it('作業中の進み具合が読める', async () => {
    await run.send(SLOW);
    await run.waitFor('作業中', () => run.activities.some((a) => a !== null));
    // セッションの一覧の状態（アプリを終了するときの確認にも出る）
    await run.waitFor('一覧の状態', () => run.manager.liveSessions()[0]?.state === '作業中');
  });

  it('作業中に送った発言が順番待ちになり、あとで受け取られる', async () => {
    await run.send(QUEUED);
    // session-manager の trackQueue が、会話ログの順番待ちの行（queue-operation）を 'queue' のイベントにする
    await run.waitFor('順番待ち', () => run.queue.includes(QUEUED));
    const queued = run.chatEvents.findIndex((e) => e.type === 'queue' && e.prompts.includes(QUEUED));
    expect(run.chatEvents[queued]).toEqual({ type: 'queue', prompts: [QUEUED] });
    // 受け取られたら、順番待ちから消えて発言になる
    await run.waitFor('順番待ちへの返事', replied('順番待ちへの返事'), 30_000);
    const after = run.chatEvents.slice(queued + 1);
    expect(after).toContainEqual({ type: 'queue', prompts: [] });
    expect(after).toContainEqual(expect.objectContaining({ type: 'user', text: QUEUED }));
    expect(run.queue).toEqual([]);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && run.activities.at(-1) === null);
  });

  it('会話ログの応答のモデルを、画面のモデル名にする', () => {
    // 会話ログの応答のモデル（session-manager の modelOf）を、ScreenTracker の noteModel に渡す。起動時のバナーより優先する
    expect(run.seen.some((s) => s.entry.type === 'assistant' && s.entry.message?.model === MOCK_MODEL)).toBe(true);
    // 起動時の表示に 1M コンテキストとあれば、それを付ける
    expect(run.screen.current.model).toMatch(/^Mockmodel 9( \(1M context\))?$/);
  });

  it('/compact で会話の区切りが出る', async () => {
    await run.send('/compact');
    await run.waitFor('圧縮の区切り', () => run.chatEvents.some((e) => e.type === 'divider'), 30_000);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt');
  });

  it('/compact に複数行の指示を添えると、要約の頼みに指示が入る', async () => {
    const dividers = () => run.chatEvents.filter((e) => e.type === 'divider').length;
    const before = dividers();
    // アプリ（ChatInput の submitToClaude）と同じく、promptKeys で打ち込んでから Enter を送る。
    // コマンドの名前は打鍵、指示は貼り付けになる（丸ごと貼り付けると、目印に置き換わってコマンドにならない）
    run.type(promptKeys(`/compact ${COMPACT_INSTRUCTIONS}`));
    await run.waitFor('入力欄に入る', (info) => info.state.kind === 'prompt' && info.draft.startsWith('/compact '));
    run.type('\r');
    await run.waitFor('圧縮の区切り', () => dividers() > before, 30_000);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt');
    // 指示は、要約の頼み（最後の user の発言）の「Additional Instructions:」の後ろに、改行もそのまま入る
    const asked = api.lastPrompts.find((p) => p.includes('Additional Instructions:'));
    expect(asked).toContain(`Additional Instructions:\n${COMPACT_INSTRUCTIONS}`);
  });

  it('/clear のあと、statusLine の会話ログのパスで新しい会話ログに乗り換える', async () => {
    const before = run.claudeSessionId;
    await run.send('/clear');
    // /clear は画面を消して描き直す。前の会話（/compact の行）が画面から消えて、入力欄が出るのを待つ
    await run.waitFor('/clear のあとの入力欄', (info) => info.state.kind === 'prompt' && !run.lines().some((l) => l.text.includes('/compact')));
    await run.send(AFTER_CLEAR);
    await run.waitFor('新しい会話の返事', replied('新しい会話の返事'));
    expect(run.switches).toHaveLength(1);
    expect(run.claudeSessionId).not.toBe(before);
    // 乗り換えると、session-manager はチャットを空にして（reset）新しい会話を出す。新しい会話ログは /clear の記録から始まる
    expect(texts(chat())).toEqual(['user: /clear', `user: ${AFTER_CLEAR}`, 'assistant-text: 新しい会話の返事']);
  });

  it('--resume で再開すると、前の会話を読み直してから続けられる', async () => {
    run.stopClaude();
    expect(run.chatEvents.at(-1)).toMatchObject({ type: 'process-exit' });
    const seen = run.seen.length;
    run.start({ resume: true });
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
    expect(run.historyLoaded).toBe(true);
    const history = run.seen.slice(seen).filter((s) => s.isHistory);
    expect(history.some((s) => s.entry.type === 'user')).toBe(true);
    // 読み直した会話は、過去のもの（live: false）として配信する
    const start = run.chatBatches.map((b) => b.events.some((e) => e.type === 'process-start')).lastIndexOf(true);
    expect(run.chatBatches.slice(start).some((b) => !b.live && b.events.some((e) => e.type === 'user' && e.text === AFTER_CLEAR))).toBe(true);
    await run.send(AFTER_RESUME);
    await run.waitFor('再開後の返事', replied('再開後の返事'));
    expect(texts(chat())).toEqual(['user: /clear', `user: ${AFTER_CLEAR}`, 'assistant-text: 新しい会話の返事', `user: ${AFTER_RESUME}`, 'assistant-text: 再開後の返事']);
  });

  it('/rewind で巻き戻し先を選び、何を戻すかのメニューが読める', async () => {
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt');
    expect(await run.screen.rewindTo(AFTER_RESUME)).toBe(true);
    const menu = await run.waitFor('何を戻すか', menuOf('other', /restore/i));
    run.capture('rewind-restore');
    checkRewindRestore(menu);
    // 戻さずに閉じる。「Never mind」で巻き戻し先の一覧に戻り、Esc で入力欄に戻る
    const cancel = menu.options.find((o) => /Never mind/i.test(o.label));
    expect(cancel).toBeDefined();
    await run.answer(menu.title, cancel!.id);
    await run.waitFor('巻き戻し先の一覧に戻る', (info) => info.state.kind === 'rewind');
    run.type('\x1b');
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt');
  });

  it('/rewind で会話を戻して発言すると、session-manager がチャットを巻き戻す（replace）', async () => {
    expect(await run.screen.rewindTo(AFTER_RESUME)).toBe(true);
    const menu = await run.waitFor('何を戻すか', menuOf('other', /restore/i));
    const restore = menu.options.find((o) => /^Restore conversation/.test(o.label));
    expect(restore).toBeDefined();
    await run.answer(menu.title, restore!.id);
    // 戻した発言は入力欄に入る。消してから、別の発言を送る
    await run.waitFor('戻した発言が入力欄に入る', (info) => info.state.kind === 'prompt' && info.draft.includes(AFTER_RESUME));
    run.type('\x15');
    await run.waitFor('入力欄が空になる', (info) => info.state.kind === 'prompt' && info.draft === '');
    const from = run.chatEvents.length;
    await run.send(AFTER_REWIND);
    // 巻き戻したあとの発言は、戻した発言より前の行を親にして書かれる（会話ログの中で枝分かれする）
    const replace = await run.waitFor('巻き戻し', () => run.chatEvents.slice(from).find((e) => e.type === 'replace'));
    // 戻した発言（AFTER_RESUME）とその返事を捨てた、親の時点のチャット
    expect(replace.type === 'replace' && texts(shown(replace.events))).toEqual(['user: /clear', `user: ${AFTER_CLEAR}`, 'assistant-text: 新しい会話の返事']);
    expect(run.chatBatches.find((b) => b.events.includes(replace))?.live).toBe(true);
    await run.waitFor('巻き戻したあとの返事', () => texts(chat()).length === 5);
    expect(texts(chat())).toEqual(['user: /clear', `user: ${AFTER_CLEAR}`, 'assistant-text: 新しい会話の返事', `user: ${AFTER_REWIND}`, 'assistant-text: 再開後の返事']);
  });
});
