import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PARENT_MESSAGE_TAG, sessionToolId } from '@shared/session-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// 親の Claude が、長いコマンドを実行している作業中の子に send_message で指示すると、
// deliver: next_step なら、子の Claude Code が今のターンの次のツールの切れ目（コマンドの結果のあと、次の応答の前）に差し込む。
// 既定（after_turn）なら、子のターンが終わってから、別のターンとして届く。
// どちらでも、子のチャットでは「親からの指示」として 1 度だけ出て、順番待ちに残らない

// 子の 1 つめのコマンドは、印のファイルができるまで終わらない。親の send_message が結果（queued）を返したら、テストが印を書く
// （時間で待たせると、CI が重いときに、親が送る前にコマンドが終わり、指示が 2 つめのコマンドのあとに入ってしまう）
const RELEASE_FILE = 'send-next-step-release';

describe.each([
  { deliver: 'next_step', mark: 'NEXT' },
  { deliver: 'after_turn', mark: 'LATER' },
] as const)('作業中の子に deliver: $deliver で送った指示', ({ deliver, mark }) => {
  const PARENT = `子を始めて、作業の途中で指示してください（${mark}）`;
  const CHILD = `2 つのコマンドを順に実行してください（${mark} の子）`;
  const CHILD_NAME = `${mark} の子`;
  const MESSAGE = `${mark} の親からの直し: 2 つめのコマンドの前に読んでください`;
  const PARENT_SENT = `${mark}: 子に指示しました`;
  const CHILD_DONE = `${mark}: 2 つのコマンドを終えました`;
  const CHILD_GOT = `${mark}: 指示を受け取りました`;

  let app: E2EApp;
  const release = (): void => writeFileSync(join(app.work, `${RELEASE_FILE}-${mark}`), '');
  let child: string | null = null;
  // 子が 1 つめのコマンドを始めた（そのコマンドを返した）
  let longStarted = false;
  // 子の API の呼び出しのうち、指示が会話に入っていたもの（1 つめのコマンドの結果のあと・2 つめのコマンドの結果のあと・別のターン）
  const seen = { afterFirst: false, afterSecond: false, newTurn: false };
  // 子が 2 つのコマンドを終えた
  let childDone = false;

  const respond = (prompt: string, results: string[], context: string): Block[] | null => {
    const result = results.join('\n');
    // --- 親 ---
    if (context.includes(PARENT)) {
      if (results.length === 0 && prompt.includes(PARENT)) {
        return [{ type: 'tool_use', id: 'toolu_start', name: sessionToolId('start_session'), input: { prompt: CHILD, worktree: false, name: CHILD_NAME } }];
      }
      if (result.includes('"permission_mode"')) child = /"session_id":\s*"([0-9a-f-]{36})"/.exec(result)?.[1] ?? null;
      // 子が 1 つめのコマンドを始めるまで、子の一覧を読んで待つ
      if (result.includes('"permission_mode"') || result.includes('"sessions"')) {
        if (!child || !longStarted) return [{ type: 'tool_use', id: `toolu_list_${Date.now()}`, name: sessionToolId('list_sessions'), input: {} }];
        return [{ type: 'tool_use', id: 'toolu_send', name: sessionToolId('send_message'), input: { session_id: child, message: MESSAGE, deliver } }];
      }
      if (result.includes('queued')) {
        // 指示を子の Claude Code に渡し終えてから、子の 1 つめのコマンドを終わらせる
        release();
        return [{ type: 'text', text: PARENT_SENT }];
      }
      return null;
    }
    // --- 子 ---
    if (!context.includes(CHILD)) return null;
    if (result.includes(`${mark}-one`)) {
      seen.afterFirst = context.includes(MESSAGE);
      return [{ type: 'tool_use', id: 'toolu_two', name: 'Bash', input: { command: `echo ${mark}-two`, description: '2 つめのコマンド' } }];
    }
    if (result.includes(`${mark}-two`)) {
      seen.afterSecond = context.includes(MESSAGE);
      childDone = true;
      return [{ type: 'text', text: CHILD_DONE }];
    }
    if (results.length === 0 && prompt.includes(MESSAGE)) {
      seen.newTurn = true;
      return [{ type: 'text', text: CHILD_GOT }];
    }
    if (results.length === 0 && prompt.includes(CHILD)) {
      longStarted = true;
      return [{ type: 'tool_use', id: 'toolu_one', name: 'Bash', input: { command: `while [ ! -f ${RELEASE_FILE}-${mark} ]; do sleep 0.1; done; echo ${mark}-one`, description: '1 つめのコマンド' } }];
    }
    return null;
  };

  beforeAll(async () => {
    app = await E2EApp.launch({ trusted: true });
    app.api.intercept = respond;
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`send-next-step-${mark}-${task.name}`);
  });

  afterAll(async () => {
    // 落ちたときも、子のコマンドを待たせたままにしない
    if (app) release();
    await app?.close();
  });

  it('親が子を始め、子が 1 つめのコマンドを実行している間に指示を送る', async () => {
    await app.startSession(PARENT);
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', PARENT_SENT).waitFor({ timeout: 60_000 });
  });

  it(
    deliver === 'next_step'
      ? '子には、1 つめのコマンドの結果のあと（2 つめのコマンドの前）に届き、別のターンにならない'
      : '子には、ターンが終わってから別のターンとして届く（2 つのコマンドの間には入らない）',
    async () => {
      if (deliver === 'next_step') {
        await app.waitUntil('子の作業の終わり', () => childDone, 60_000);
        expect(seen).toEqual({ afterFirst: true, afterSecond: true, newTurn: false });
      } else {
        // 子の作業が終わってから、指示の別のターンになる
        await app.waitUntil('指示の別のターン', () => childDone && seen.newTurn, 60_000);
        expect(seen).toEqual({ afterFirst: false, afterSecond: false, newTurn: true });
      }
    },
  );

  it('子のチャットでは「親からの指示」として 1 度だけ出て、囲みのタグは文字で出ず、順番待ちに残らない', async () => {
    await app.byText('.session-list .session-row', CHILD_NAME).click();
    await app.byText('.claude-header .claude-title', CHILD_NAME).waitFor();
    await app.byText('.chat-list', deliver === 'next_step' ? CHILD_DONE : CHILD_GOT).waitFor({ timeout: 30_000 });
    await app.byText('.statusbar', 'Claude Code 待機中').waitFor();
    expect(await app.page.locator('.chat-list .chat-user.from-parent:not(.pending)').filter({ hasText: MESSAGE }).count()).toBe(1);
    expect(await app.byText('.chat-list', PARENT_MESSAGE_TAG).count()).toBe(0);
    expect(await app.page.locator('.chat-list .chat-user.pending').count()).toBe(0);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
