import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents } from '@shared/chat';
import { REWOUND, checkRewindRestore } from '../scenario';
import { ClaudeRun, claudeVersion, menuOf, sleep } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、会話の操作をアプリと同じ部品で読めるかを確かめる。
// 権限モードの切り替え（Shift+Tab）・作業中の進み具合・作業中に送った発言の順番待ち・/compact・/clear・--resume・/rewind

const SLOW = 'ゆっくり返事してください';
const QUEUED = '順番待ちの発言です';
const AFTER_CLEAR = '新しい会話を始めます';
const AFTER_RESUME = REWOUND;

const version = claudeVersion();

describe(`Claude Code ${version} の会話の操作`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const events = () => run.entries.flatMap((e) => toChatEvents(e, run.cwd));
  const replied = (text: string) => () => events().some((e) => e.type === 'assistant-text' && e.text === text);

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [
      // 作業中の画面を見るため、応答を遅らせる（/compact の要約もこの会話の続きとして届く）
      { match: SLOW, delayMs: 4000, steps: [[{ type: 'text', text: 'ゆっくりの返事' }], [{ type: 'text', text: '順番待ちへの返事' }]] },
      { match: AFTER_CLEAR, steps: [[{ type: 'text', text: '新しい会話の返事' }], [{ type: 'text', text: '再開後の返事' }]] },
    ];
    run = new ClaudeRun(await api.start());
    await run.open();
  });

  afterAll(async () => {
    if (process.env.TANACODE_RECORD) run?.recordScreens(join('test', 'fixtures', 'claude-code', version));
    run?.stop();
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
  });

  it('作業中に送った発言が順番待ちになり、あとで受け取られる', async () => {
    await run.send(QUEUED);
    // session-manager の trackQueue が読む、順番待ちの行
    await run.waitFor('順番待ち', () =>
      run.entries.some((e) => e.type === 'queue-operation' && (e as { operation?: string; content?: unknown }).operation === 'enqueue' && (e as { content?: unknown }).content === QUEUED),
    );
    await run.waitFor('順番待ちへの返事', replied('順番待ちへの返事'), 30_000);
    expect(events()).toContainEqual(expect.objectContaining({ type: 'user', text: QUEUED }));
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && run.activities.at(-1) === null);
  });

  it('/compact で会話の区切りが出る', async () => {
    await run.send('/compact');
    await run.waitFor('圧縮の区切り', () => events().some((e) => e.type === 'divider'), 30_000);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt');
  });

  it('/clear のあと、statusLine の会話ログのパスで新しい会話ログに乗り換える', async () => {
    const before = run.claudeSessionId;
    await run.send('/clear');
    await sleep(1000);
    await run.send(AFTER_CLEAR);
    await run.waitFor('新しい会話の返事', replied('新しい会話の返事'));
    expect(run.switches).toHaveLength(1);
    expect(run.claudeSessionId).not.toBe(before);
  });

  it('--resume で再開すると、前の会話を読み直してから続けられる', async () => {
    run.stopClaude();
    const seen = run.seen.length;
    run.start({ resume: true });
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
    expect(run.historyLoaded).toBe(true);
    const history = run.seen.slice(seen).filter((s) => s.isHistory);
    expect(history.some((s) => s.entry.type === 'user')).toBe(true);
    await run.send(AFTER_RESUME);
    await run.waitFor('再開後の返事', replied('再開後の返事'));
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
});
