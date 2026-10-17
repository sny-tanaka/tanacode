import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// 同じ userData で動くアプリは 1 つだけ（開発版とパッケージ版を同じ userData で起動したときなど。2 つ動くと、同じ会話を
// 2 回 claude --resume し、チェックリストなどの保存もぶつかる）。2 つめはすぐに終わり、動いているアプリのウインドウを前に出す

describe('同じ userData での二重起動', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch();
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`single-instance-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('2 つめはすぐに終わり、動いているアプリが知らせを受けて、動き続ける', async () => {
    // 動いているアプリに、2 つめの起動の知らせが届くか
    const notified = app.app.evaluate(({ app: electronApp }) => new Promise<boolean>((resolve) => electronApp.once('second-instance', () => resolve(true))));
    expect(await app.launchAgain(20_000)).toBe(0);
    expect(await notified).toBe(true);
    // 動いているアプリは、そのまま使える
    await app.page.click('nav.sidebar .new-session-button');
    await app.page.locator('section.claude:has(.new-session-body)').waitFor();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
