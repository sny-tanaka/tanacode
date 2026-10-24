import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_EVENT_TAG, sessionToolId } from '@shared/session-tools';
import { E2EApp } from './app';

// Claude が restart_app で tanacode の再起動を頼む（人がスマホの Remote Control から「tanacode を更新して」と頼んだときなど）。
// - auto のモードでも、許可のカードが出る（tanacode のフックが ask を返す）。Mac の画面のダイアログ（終了の確認）は出ない
// - 許すと、結果が Claude に返ってから、アプリが Claude Code を動かしたまま終わる。起動し直したアプリが同じ claude を引き継ぐ
// - 起動し直したアプリが、呼んだセッションに「再起動しました」と知らせる（終える前のアプリは送らない）
// 起動し直すのはテストがする（TANACODE_E2E_NO_RELAUNCH=1。アプリは終えるだけ）。開発用のビルドなので、Homebrew の入れ替えは無い
// （入れ替えるかの判断は test/app-restart.test.ts、入れ替えのシェルは test/homebrew-update.test.ts）

const PROMPT = 'tanacode を再起動してください';
const ASKED = '再起動を頼みました。戻ったら知らせが届きます';
const NOTICED = '再起動の知らせを受け取りました';

describe('Claude が頼む tanacode の再起動', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      env: { TANACODE_E2E_NO_RELAUNCH: '1' },
      conversations: () => [
        {
          match: PROMPT,
          steps: [
            [{ type: 'tool_use', id: 'toolu_restart', name: sessionToolId('restart_app'), input: {} }],
            [{ type: 'text', text: ASKED }],
            [{ type: 'text', text: NOTICED }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`restart-app-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('auto のモードでも、許可のカードが出る。許すと、結果を返してから Claude Code を動かしたまま終わり、起動し直すと同じ claude を引き継いで、再起動の知らせが届く', async () => {
    await app.startSession(PROMPT, { mode: 'auto' });
    const card = await app.menuCard('permission');
    const text = await card.textContent();
    expect(text).toContain('tanacode を再起動');
    // tanacode のフックが出させた確認の理由
    expect(text).toContain('Claude Code は止めずに動かしたままにするので、セッションは続きます');
    const before = await app.claudePids();
    expect(before).toHaveLength(1);
    await app.choose(card, /^許可する/);
    await app.relaunchAfterExit(async () => {
      // 結果は終える前に Claude に届いている。知らせは、終える前のアプリからは送らない
      expect(app.api.toolResults.some((r) => r.startsWith('tanacode is restarting (v'))).toBe(true);
      expect(app.api.lastPrompts.some((p) => p.includes('tanacode has restarted'))).toBe(false);
    });
    const row = app.byText('.session-list .session-row', PROMPT);
    await row.waitFor();
    await row.click();
    await app.byText('.chat-list', NOTICED).waitFor();
    const notice = app.api.lastPrompts.find((p) => p.includes('tanacode has restarted'));
    expect(notice).toContain(`<${SESSION_EVENT_TAG} sessions="">`);
    expect(notice).toMatch(/tanacode has restarted \(v\d+\.\d+\.\d+\)/);
    // 再起動の前の返事も残っていて、claude は起動し直していない（動かしたまま引き継いだ）
    expect(await app.byText('.chat-list', ASKED).count()).toBeGreaterThan(0);
    expect(await app.claudePids()).toEqual(before);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
