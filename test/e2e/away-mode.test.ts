import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sessionToolId } from '@shared/session-tools';
import { E2EApp } from './app';

// 離席モード。Claude が set_away_mode で入れた親セッションでは、人に回った許可の確認・質問を、待つ時間のあとにアプリが断り、
// Claude は先へ進む。離席モードでない親は、今までどおり人の答えを待ち続ける。画面のスイッチで解くと、Claude に報告を頼む。
// 待つ時間は、環境変数で短くする

const WAIT_SECONDS = 3;
const NORMAL = 'ふつうに進めてください';
const NORMAL_DONE = 'ふつうの作業を終えました';
const AWAY = '離席モードにして進めてください';
const AWAY_DONE = '離席中の作業を終えました';
const AWAY_ACK = '離席中のまま続けます';
const AWAY_REPORT = '保留したことと決めたことを報告します';
const QUESTION = {
  question: 'どちらの書き方にしますか？',
  header: '書き方',
  multiSelect: false,
  options: [
    { label: 'です・ます', description: '丁寧な書き方' },
    { label: 'だ・である', description: '言い切る書き方' },
  ],
};

describe('離席モード', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      env: { TANACODE_AWAY_WAIT_SECONDS: String(WAIT_SECONDS) },
      conversations: () => [
        {
          match: NORMAL,
          steps: [
            [{ type: 'tool_use', id: 'toolu_normal', name: 'Bash', input: { command: 'mkdir normal-made', description: 'フォルダを作る' } }],
            [{ type: 'text', text: NORMAL_DONE }],
          ],
        },
        {
          match: AWAY,
          steps: [
            [{ type: 'tool_use', id: 'toolu_away_on', name: sessionToolId('set_away_mode'), input: { away: true } }],
            [{ type: 'tool_use', id: 'toolu_away_bash', name: 'Bash', input: { command: 'mkdir away-held', description: '保留されるフォルダを作る' } }],
            [{ type: 'tool_use', id: 'toolu_away_ask', name: 'AskUserQuestion', input: { questions: [QUESTION] } }],
            [{ type: 'text', text: AWAY_DONE }],
            // 人がスマホなどから書いた（離席モードは解けない）
            [{ type: 'text', text: AWAY_ACK }],
            // 画面のスイッチで解いたときの知らせ
            [{ type: 'text', text: AWAY_REPORT }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`away-mode-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('離席モードでない親では、許可の確認は待つ時間を過ぎても出たまま、人の答えを待ち続ける', async () => {
    await app.startSession(NORMAL, { mode: 'manual' });
    const card = await app.menuCard('permission');
    await new Promise((resolve) => setTimeout(resolve, (WAIT_SECONDS + 3) * 1000));
    expect(await card.isVisible()).toBe(true);
    expect(app.api.toolResults.some((r) => r.includes('away mode'))).toBe(false);
    await app.choose(card, /^許可する/);
    await app.byText('.chat-list', NORMAL_DONE).waitFor();
    expect(existsSync(join(app.work, 'normal-made'))).toBe(true);
  });

  it('Claude が離席モードにした親では、許可の確認を待つ時間のあとに断り、質問を返して、Claude が先へ進む', async () => {
    await app.startSession(AWAY, { mode: 'manual' });
    const toggle = app.page.locator('.claude-header [role="switch"][aria-label="離席モード"]');
    await app.page.locator('.claude-header [role="switch"][aria-label="離席モード"][aria-checked="true"]').waitFor();
    // 許可の確認は、待つ時間の間はカードに出ている（人が答えられる）
    await app.menuCard('permission');
    await app.byText('.chat-list', /許可の確認を断りました/).waitFor();
    await app.menuCard('question');
    await app.byText('.chat-list', /質問を Claude に返しました/).waitFor();
    await app.byText('.chat-list', AWAY_DONE).waitFor();
    expect(existsSync(join(app.work, 'away-held'))).toBe(false);
    expect(app.api.toolResults.some((r) => r.includes('tanacode declined this permission prompt: away mode is on'))).toBe(true);
    expect(app.api.toolResults.some((r) => r.includes('Do not ask it again. Decide yourself'))).toBe(true);
    expect(app.api.toolResults.some((r) => r.includes('Away mode is now on.'))).toBe(true);
    // 一覧にも印が出る
    await app.page.locator('nav.sidebar .session-away').first().waitFor();
    expect(await toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('離席中は、人の発言のたびに決まりを Claude に渡す。発言だけでは解けない', async () => {
    await app.send('まだ席を外しています');
    await app.byText('.chat-list', AWAY_ACK).waitFor();
    expect(app.api.contexts.some((c) => c.includes('<tanacode-away-mode>'))).toBe(true);
    expect(await app.page.locator('.claude-header [role="switch"][aria-label="離席モード"]').getAttribute('aria-checked')).toBe('true');
  });

  it('画面のスイッチで解くと、Claude に保留したこと・決めたことの報告を頼む', async () => {
    await app.page.click('.claude-header [role="switch"][aria-label="離席モード"]');
    await app.page.locator('.claude-header [role="switch"][aria-label="離席モード"][aria-checked="false"]').waitFor();
    await app.byText('.chat-list', AWAY_REPORT).waitFor();
    expect(app.api.lastPrompts.some((p) => p.includes('Away mode is off: the user is back.'))).toBe(true);
    expect(await app.page.locator('nav.sidebar .session-away').count()).toBe(0);
  });
});
