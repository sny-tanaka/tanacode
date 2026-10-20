import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PARENT_MESSAGE_TAG, sessionToolId } from '@shared/session-tools';
import { E2EApp } from './app';

// 親の Claude が、作業中の子に send_message で 2 つ続けて指示すると、子の Claude Code は 2 つを順番待ちにし、ターンが終わってから
// まとめて 1 つの発言の行にする（mergedSendUuids）。子のチャットでは、2 つの指示が別々の「親からの指示」として出て、
// 囲みのタグは文字で出ない。まとめた行が会話に出たら、どちらの指示も順番待ちから外れる

const PARENT = '子に続けて指示してください（MERGED）';
const CHILD = 'ゆっくり作業してください（MERGED の子）';
const CHILD_NAME = 'まとめられる子';
const FIRST = '指示 A: テストも直してください';
const SECOND = '指示 B: 文書も直してください';

describe('子に続けて送った指示がまとめられても、1 つずつの指示として出る', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        { match: PARENT, steps: [[{ type: 'tool_use', id: 'toolu_start', name: sessionToolId('start_session'), input: { prompt: CHILD, worktree: false, name: CHILD_NAME } }]] },
        // 子は、はじめの返事を遅らせて作業中のままにする（その間に 2 つの指示が順番待ちになる）
        { match: CHILD, delayMs: 5000, steps: [[{ type: 'text', text: 'はじめの作業を終えました' }], [{ type: 'text', text: '2 つの指示を受け取りました' }]] },
      ],
    });
    // 子を始めたら、子が作業を始める（最初の指示がモックの API に届く）まで子の一覧を読んで待ち、作業中の子に 2 つの指示を続けて送る
    let child: string | null = null;
    let calls = 0;
    let sent = false;
    app.api.intercept = (_prompt, results) => {
      // 2 つの指示を送った結果を受けたら、ターンを終える
      if (sent && results.length > 0) return [{ type: 'text', text: '子に指示しました' }];
      // 子を始めた結果（start_session の permission_mode）・子の一覧を読んだ結果のあとだけ、続きを決める（子の呼び出しは台本のまま）
      if (!results.some((r) => r.includes('"permission_mode"') || r.includes('"sessions"'))) return null;
      child ??= results.map((r) => r.match(/"session_id":\s*"([0-9a-f-]{36})"/)?.[1]).find(Boolean) ?? null;
      // 子の最初の指示が、まだモックの API に届いていない（子が作業を始めていない）
      if (!child || !app.api.requests.some((r) => r.includes(`「${CHILD}」の会話`))) return [{ type: 'tool_use', id: `toolu_list_${++calls}`, name: sessionToolId('list_sessions'), input: {} }];
      sent = true;
      return [
        { type: 'tool_use', id: 'toolu_send_a', name: sessionToolId('send_message'), input: { session_id: child, message: FIRST } },
        { type: 'tool_use', id: 'toolu_send_b', name: sessionToolId('send_message'), input: { session_id: child, message: SECOND } },
      ];
    };
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`merged-parent-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('親が子を始め、作業中の子に 2 つの指示を続けて送る', async () => {
    await app.startSession(PARENT, { mode: 'manual' });
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', '子に指示しました').waitFor({ timeout: 30_000 });
    await app.byText('.session-list .session-row', CHILD_NAME).click();
    await app.byText('.claude-header .claude-title', CHILD_NAME).waitFor();
  });

  it('子のチャットでは、2 つの指示が別々の「親からの指示」として出て、囲みのタグは文字で出ない。どちらも順番待ちに残らない', async () => {
    await app.byText('.chat-list', '2 つの指示を受け取りました').waitFor({ timeout: 30_000 });
    // 子の Claude Code が、2 つを 1 つの発言の行にまとめたこと（この確かめの前提）
    expect(app.api.lastPrompts.some((p) => p.includes(FIRST) && p.includes(SECOND))).toBe(true);
    const parents = app.page.locator('.chat-list .chat-user.from-parent:not(.pending)');
    await app.byText('.chat-list .chat-user.from-parent', SECOND).waitFor();
    // 最初の指示と、まとめられた 2 つの指示。直す前は、2 つが 1 つの発言になり、本文の途中に閉じタグと開きタグが文字で出ていた
    expect(await parents.allInnerTexts()).toEqual([expect.stringContaining(CHILD), expect.stringContaining(FIRST), expect.stringContaining(SECOND)]);
    expect(await app.byText('.chat-list', PARENT_MESSAGE_TAG).count()).toBe(0);
    await app.byText('.statusbar', 'Claude Code 待機中').waitFor();
    expect(await app.page.locator('.chat-list .chat-user.pending').count()).toBe(0);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
