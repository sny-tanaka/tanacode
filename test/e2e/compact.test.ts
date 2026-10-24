import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checklistToolId } from '@shared/checklist-tools';
import { HANDOFF_TAG, RESUME_TAG } from '@shared/optimized-compact';
import { E2EApp } from './app';

// チャットのヘッダーの「最適化圧縮」を、通しで動かす。要約は作らず、会話を消して、チェックリストから再開する。
// 押す → アプリが仕上げの頼みを送り、Claude が MCP で「いまの状態」を書く → アプリが /clear を送る →
// 新しい会話の最初の発言として、アプリが再開の文（決定事項と今の状態・前の会話の発言の原文）を送る → Claude がリストを読んで報告する

const PROMPT = '税率を可変にしてください';
const REPLY = '税率を引数にしました';
const STATE = 'いまの状態';
const STATE_CARD = 'tax.ts は済み。次は README';
const STATE_BODY = 'ブランチ: feat/tax';
const WRITTEN = 'いまの状態に書きました';
const RESUMED = '引き継ぎました。次は README です';
// 長い再開の文（2 万文字ほど）も、貼り付けで欠けずに届くかを見るための、本文の長い決定事項
const LONG_CARDS = Array.from({ length: 9 }, (_, i) => ({ title: `決定 ${i + 1}`, body: `${`理由 ${i + 1} `.repeat(300)}おわり${i + 1}` }));
const UP_TO_DATE = 'チェックリストは最新です';
const HANDOFF_NOTICE = '最適化圧縮: 続きに要ることを、チェックリストに書くよう頼みました';
const RESUME_NOTICE = '最適化圧縮: 会話を消して、チェックリストから再開しました';
const WORK_DONE = '作業が完了しました';
const COMPACT_DONE = 'コンテキストの最適化が完了しました';

describe('最適化圧縮', () => {
  let app: E2EApp;
  const button = () => app.page.locator('.claude-header button[aria-label="最適化圧縮"]');
  // Claude に届いた再開の文。タイトル作りの呼び出し（<session> で始まる）にも、再開の文の抜粋が入るので除く
  // （どちらの呼び出しが先に届くかは、そのときどき）
  const resumes = () => app.api.lastPrompts.filter((p) => p.includes(`<${RESUME_TAG} `) && !p.startsWith('<session>'));

  // main が出そうとした macOS の通知の本文（count 件になるまで待つ）
  const notified = async (count: number) => {
    const read = () => app.app.evaluate(() => (globalThis as { shownNotifications?: string[] }).shownNotifications ?? []);
    const deadline = Date.now() + 30_000;
    let shown = await read();
    while (shown.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      shown = await read();
    }
    return shown;
  };

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      appSettings: { notifications: true },
      conversations: () => [
        {
          match: PROMPT,
          steps: [
            [{ type: 'tool_use', id: 'toolu_decisions', name: checklistToolId('card_add'), input: { list: '決定事項', list_description: '決まったこと', list_kind: 'decisions', cards: LONG_CARDS } }],
            [{ type: 'text', text: REPLY }],
            // 仕上げの頼みへの応答。続きに要ることを「いまの状態」に書く
            [
              {
                type: 'tool_use',
                id: 'toolu_state',
                name: checklistToolId('card_add'),
                input: { list: STATE, list_description: '変わったら書き換える', list_kind: 'state', cards: [{ title: STATE_CARD, body: STATE_BODY }] },
              },
            ],
            [{ type: 'text', text: WRITTEN }],
          ],
        },
        // /clear のあとの新しい会話。はじめの発言は再開の文（前の会話の発言の原文も入るので、それより後ろに出てくる文字で選ぶ）
        {
          match: '</user-message>',
          steps: [
            [{ type: 'tool_use', id: 'toolu_overview', name: checklistToolId('checklist_overview'), input: {} }],
            [{ type: 'text', text: RESUMED }],
            // 続けてもう一度押したときの、仕上げの頼みへの応答（リストはもう最新。読んで確かめるだけ）
            [{ type: 'tool_use', id: 'toolu_again', name: checklistToolId('checklist_overview'), input: {} }],
            [{ type: 'text', text: UP_TO_DATE }],
          ],
        },
      ],
    });
    // 通知は出さずに、出そうとした本文を控える。見ているセッションの通知は、ウインドウが前にあると出さないので、後ろにあることにする
    await app.app.evaluate(({ BrowserWindow, Notification }) => {
      const shown: string[] = [];
      (globalThis as { shownNotifications?: string[] }).shownNotifications = shown;
      BrowserWindow.prototype.isFocused = () => false;
      Notification.prototype.show = function show(this: { body: string }) {
        shown.push(this.body);
      };
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`compact-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('ヘッダーには「最適化圧縮」だけがあり、通常の圧縮のボタンと ▾ のメニューは無い', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', REPLY).waitFor();
    await button().waitFor();
    expect(await app.page.locator('.claude-header button[aria-label="圧縮"]').count()).toBe(0);
    expect(await app.page.locator('.claude-header button[aria-label="圧縮のしかたを選ぶ"]').count()).toBe(0);
  });

  it('押すと、仕上げ → /clear → 再開の文、と進み、Claude がチェックリストから再開する', async () => {
    await app.page.click('.claude-header button[aria-label="最適化圧縮"]:not([disabled])');
    // 仕上げ: Claude が「いまの状態」を書く（サイドパネルのチェックリストにも出る）
    await app.waitUntil('仕上げの頼み', () => app.api.lastPrompts.some((p) => p.includes(`<${HANDOFF_TAG} `)));
    // 仕上げのターンが終わったら、/clear を打って、再開の文はすぐに届く。/clear は発言として会話ログに出ないので、
    // 「送信中」の扱いが残ると、15 秒ほど待たされる
    await app.byText('.chat-list', WRITTEN).waitFor();
    const written = Date.now();
    await app.byText('.chat-list', RESUME_NOTICE).waitFor();
    expect(Date.now() - written).toBeLessThan(10_000);
    // 再開の文が最初の発言になり、Claude がリストを読んで報告する
    await app.byText('.chat-list', RESUMED).waitFor();
    // チャットの画面は消さない: 前の会話（応答も、仕上げの頼みも）は残り、再開の知らせの行が区切りになる。
    // Claude Code の会話は消えている（下のテストで、再開の文を受けた会話に前の応答が入っていないことを見る）
    expect(await app.byText('.chat-list', REPLY).count()).toBe(1);
    expect(await app.byText('.chat-list', HANDOFF_NOTICE).count()).toBe(1);
    const order = await app.page.locator('.chat-list').innerText();
    expect(order.indexOf(REPLY)).toBeLessThan(order.indexOf(HANDOFF_NOTICE));
    expect(order.indexOf(HANDOFF_NOTICE)).toBeLessThan(order.indexOf(RESUME_NOTICE));
    expect(order.indexOf(RESUME_NOTICE)).toBeLessThan(order.indexOf(RESUMED));
    // 流れが終わると、ボタンがまた押せる
    await app.page.locator('.claude-header button[aria-label="最適化圧縮"]:not([disabled])').waitFor();
    // 通知は、流れが最後まで終わったときの 1 回。仕上げのターンの終わり（このあと /clear）では、「作業が完了しました」を出さない
    expect(await notified(2)).toEqual([WORK_DONE, COMPACT_DONE]);
  });

  it('再開の文には、「いまの状態」の中身と、前の会話の発言の原文が入る。要約は頼まない', () => {
    const resume = resumes()[0] ?? '';
    // 画面の言語（E2E は日本語）で書く
    expect(resume).toContain('要約は作っていません。');
    expect(resume).toContain(`# ${STATE}（あなたが最後に書いた、いまの状態）`);
    expect(resume).toContain(`## #1 ${STATE_CARD}\n${STATE_BODY}`);
    expect(resume).toContain(`<user-message>\n${PROMPT}\n</user-message>`);
    // 長い文も、欠けずに届く（決定事項の本文の終わりまで・囲みの閉じタグまで）
    expect(resume.length).toBeGreaterThan(15_000);
    for (const card of LONG_CARDS) expect(resume).toContain(card.body.slice(-20));
    expect(resume).toContain(`</${RESUME_TAG}>`);
    // 仕上げの頼みは、発言の原文には入れない
    expect(resume).not.toContain(`<${HANDOFF_TAG} `);
    // 要約のリクエスト（/compact）は 1 回も送っていない
    expect(app.api.lastPrompts.some((p) => p.includes('Your task is to create a detailed summary'))).toBe(false);
    // 再開の文を受けた会話には、前の会話の応答は入っていない
    const resumed = app.api.contexts.find((c) => c.includes(`<${RESUME_TAG} `)) ?? '';
    expect(resumed).not.toContain(HANDOFF_NOTICE);
  });

  it('サイドパネルのチェックリストに、「いまの状態」のリストが残っている', async () => {
    await app.page.click('.activity-bar [aria-label^="チェックリスト"]');
    await app.page.locator('.checklist-list.kind-state .checklist-list-head', { hasText: STATE }).waitFor();
    await app.page.locator('.checklist-card', { hasText: STATE_CARD }).waitFor();
  });

  it('続けてもう一度押しても進む（リストがもう最新でも）。1 回めの会話の発言の原文は、2 回めの再開の文にも入る', async () => {
    const before = resumes().length;
    await app.page.click('.claude-header button[aria-label="最適化圧縮"]:not([disabled])');
    await app.waitUntil('2 回めの再開の文', () => resumes().length > before, 60_000);
    const second = resumes().at(-1) ?? '';
    expect(second).toContain(`<user-message>\n${PROMPT}\n</user-message>`);
    expect(second).not.toContain('（発言はありません）');
    expect(second).toContain(`## #1 ${STATE_CARD}\n${STATE_BODY}`);
    await app.page.locator('.claude-header button[aria-label="最適化圧縮"]:not([disabled])').waitFor();
    expect(await app.page.locator('.compact-status.failed').count()).toBe(0);
    expect(await notified(3)).toEqual([WORK_DONE, COMPACT_DONE, COMPACT_DONE]);
  });

  it('メニューの「Claude に送る文…」で変えた文が、次の仕上げの頼みと再開の文から届く（データは tanacode が足す）。既定に戻すと、既定の文に戻る', async () => {
    const handoffs = () => app.api.lastPrompts.filter((p) => p.includes(`<${HANDOFF_TAG} `) && !p.startsWith('<session>'));
    const dialog = app.page.locator('.prompts-dialog');
    const field = (key: string) => dialog.locator('.prompt-field').filter({ has: app.page.locator(`#prompt-${key}`) });
    const open = async () => {
      await app.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('prompts')!.click());
      await dialog.waitFor();
    };
    const compact = async (what: string) => {
      const before = resumes().length;
      await app.page.click('.claude-header button[aria-label="最適化圧縮"]:not([disabled])');
      await app.waitUntil(what, () => resumes().length > before, 60_000);
      await app.page.locator('.claude-header button[aria-label="最適化圧縮"]:not([disabled])').waitFor();
    };
    const PRESSED = '（ユーザーが「最適化圧縮」のボタンを押しました）';

    await open();
    await dialog.locator('.prompts-tab', { hasText: '最適化圧縮の仕上げの頼み' }).click();
    await app.page.fill('#prompt-handoff', '（試験）リストを最新にして{trigger}。');
    await dialog.locator('.prompts-tab', { hasText: '最適化圧縮のあとの再開' }).click();
    await app.page.fill('#prompt-resume', '（試験）会話を消しました{trigger}。報告して待ってください。');
    await dialog.locator('button', { hasText: '保存' }).click();
    await dialog.waitFor({ state: 'detached' });
    await compact('変えた文の再開の文');
    expect(handoffs().at(-1)).toContain(`<${HANDOFF_TAG} trigger="manual">\n（試験）リストを最新にして${PRESSED}。\n</${HANDOFF_TAG}>`);
    const custom = resumes().at(-1) ?? '';
    expect(custom).toContain(`<${RESUME_TAG} trigger="manual">\n（試験）会話を消しました${PRESSED}。報告して待ってください。\n\n# 決定事項（有効な決定事項）\n`);
    expect(custom).toContain(`## #1 ${STATE_CARD}\n${STATE_BODY}`);
    expect(custom).toContain(`<user-message>\n${PROMPT}\n</user-message>`);
    expect(custom).not.toContain('要約は作っていません。');

    // 既定に戻す
    await open();
    await dialog.locator('.prompts-tab', { hasText: '最適化圧縮の仕上げの頼み' }).click();
    await field('handoff').locator('button', { hasText: '既定に戻す' }).click();
    await dialog.locator('.prompts-tab', { hasText: '最適化圧縮のあとの再開' }).click();
    await field('resume').locator('button', { hasText: '既定に戻す' }).click();
    await dialog.locator('button', { hasText: '保存' }).click();
    await dialog.waitFor({ state: 'detached' });
    await compact('既定の文の再開の文');
    expect(handoffs().at(-1)).toContain(`tanacode は、この会話を圧縮する代わりに、これから消します${PRESSED}。`);
    expect(resumes().at(-1)).toContain(`<${RESUME_TAG} trigger="manual">\ntanacode は、会話を圧縮する代わりに消しました${PRESSED}。要約は作っていません。`);
    expect(await app.page.locator('.compact-status.failed').count()).toBe(0);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
