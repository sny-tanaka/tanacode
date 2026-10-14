import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sessionToolId } from '@shared/session-tools';
import { E2EApp } from './app';

// Claude が自分のセッションに予約を入れる（tanacode-sessions の schedule_wakeup）。予約は人の予約と同じ一覧に入り、
// チャットの末尾（「Claude の予約」の印つき）と一覧の時計に出る。人が「今すぐ送る」を押すと、Claude への知らせとして届き、
// Claude が続きを始める。続きの終わりに預けた報告（report_result）は、アプリまで届いて受け取られる
// （ターンの終わりの通知そのものは E2E では切ってあるので、通知の本文は単体のテスト（test/main-app.test.ts）で確かめる）

const PROMPT = '子の作業が終わるまで、あとで様子を見に来てください';
const NOTE = '子の状態を get_session で確かめる';
const WAITING = '30 分後に様子を見に来ます';
const WOKE = '予約の時刻に起きて、様子を確かめました';
const REPORT = '子の作業が終わったことを確かめました。';

describe('Claude が自分に予約を入れ、人が今すぐ送ると、知らせで続きを始める', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: PROMPT,
          steps: [
            [{ type: 'tool_use', id: 'toolu_wake', name: sessionToolId('schedule_wakeup'), input: { message: NOTE, in_minutes: 30 } }],
            [{ type: 'text', text: WAITING }],
            // 予約の知らせが届いてからの続き
            [{ type: 'tool_use', id: 'toolu_report', name: sessionToolId('report_result'), input: { message: REPORT } }],
            [{ type: 'text', text: WOKE }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`wakeup-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  const row = () => app.page.locator('.chat-list .chat-user.scheduled.by-claude');

  it('予約は確認なしに入り、チャットの末尾に「Claude の予約」の印つきで、一覧に時計で出る', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', WAITING).waitFor();
    await row().waitFor();
    expect(await row().textContent()).toContain(NOTE);
    expect(await row().locator('.chat-scheduled-by').textContent()).toBe('Claude の予約');
    await app.page.locator('.session-list .session-row .session-scheduled').waitFor();
    // 許可の確認は出ていない
    expect(await app.page.locator('.chat-list .menu-card').count()).toBe(0);
  });

  it('「今すぐ送る」を押すと、Claude への知らせとして届き、Claude が続きを始める。予約は一覧から消える', async () => {
    await row().getByRole('button', { name: '今すぐ送る' }).click();
    await app.byText('.chat-list', WOKE).waitFor();
    await app.byText('.chat-list', 'Claude の予約の時刻になりました').waitFor();
    // 人の発言としては出さない
    expect(await app.byText('.chat-list .chat-user', 'tanacode-wakeup').count()).toBe(0);
    expect(await row().count()).toBe(0);
    await app.page.locator('.session-list .session-row .session-scheduled').waitFor({ state: 'detached' });
    // 予約の知らせは、囲みに入れて Claude に渡っている
    expect(app.api.lastPrompts.some((p) => p.includes(`<tanacode-wakeup>${NOTE}</tanacode-wakeup>`))).toBe(true);
  });

  it('続きの終わりに預けた報告は、確認なしにアプリが受け取る', () => {
    expect(app.api.toolResults.some((r) => r.startsWith('Saved. It is shown in the notification when this turn ends'))).toBe(true);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
