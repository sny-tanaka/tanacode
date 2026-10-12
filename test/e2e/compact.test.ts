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

describe('最適化圧縮', () => {
  let app: E2EApp;
  const button = () => app.page.locator('.claude-header button[aria-label="最適化圧縮"]');
  // Claude に届いた再開の文。タイトル作りの呼び出し（<session> で始まる）にも、再開の文の抜粋が入るので除く
  // （どちらの呼び出しが先に届くかは、そのときどき）
  const resumes = () => app.api.lastPrompts.filter((p) => p.includes(`<${RESUME_TAG}>`) && !p.startsWith('<session>'));

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
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
    await app.waitUntil('仕上げの頼み', () => app.api.lastPrompts.some((p) => p.includes(`<${HANDOFF_TAG}>`)));
    // 新しい会話になったら（前の会話がチャットから消える）、再開の文はすぐに届く。/clear は発言として会話ログに出ないので、
    // 「送信中」の扱いが残ると、15 秒ほど待たされる
    await app.byText('.chat-list', REPLY).waitFor({ state: 'detached' });
    const cleared = Date.now();
    await app.byText('.chat-list', RESUME_NOTICE).waitFor();
    expect(Date.now() - cleared).toBeLessThan(8000);
    // 再開の文が最初の発言になり、Claude がリストを読んで報告する
    await app.byText('.chat-list', RESUMED).waitFor();
    // 前の会話は消えている（仕上げの頼みも、前の会話のもの）
    expect(await app.byText('.chat-list', REPLY).count()).toBe(0);
    expect(await app.byText('.chat-list', HANDOFF_NOTICE).count()).toBe(0);
    // 流れが終わると、ボタンがまた押せる
    await app.page.locator('.claude-header button[aria-label="最適化圧縮"]:not([disabled])').waitFor();
  });

  it('再開の文には、「いまの状態」の中身と、前の会話の発言の原文が入る。要約は頼まない', () => {
    const resume = resumes()[0] ?? '';
    expect(resume).toContain('No summary was made.');
    expect(resume).toContain(`# ${STATE} (state, as you last wrote it)`);
    expect(resume).toContain(`## #1 ${STATE_CARD}\n${STATE_BODY}`);
    expect(resume).toContain(`<user-message>\n${PROMPT}\n</user-message>`);
    // 長い文も、欠けずに届く（決定事項の本文の終わりまで・囲みの閉じタグまで）
    expect(resume.length).toBeGreaterThan(15_000);
    for (const card of LONG_CARDS) expect(resume).toContain(card.body.slice(-20));
    expect(resume).toContain(`</${RESUME_TAG}>`);
    // 仕上げの頼みは、発言の原文には入れない
    expect(resume).not.toContain(`<${HANDOFF_TAG}>`);
    // 要約のリクエスト（/compact）は 1 回も送っていない
    expect(app.api.lastPrompts.some((p) => p.includes('Your task is to create a detailed summary'))).toBe(false);
    // 再開の文を受けた会話には、前の会話の応答は入っていない
    const resumed = app.api.contexts.find((c) => c.includes(`<${RESUME_TAG}>`)) ?? '';
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
    expect(second).not.toContain('(no messages)');
    expect(second).toContain(`## #1 ${STATE_CARD}\n${STATE_BODY}`);
    await app.page.locator('.claude-header button[aria-label="最適化圧縮"]:not([disabled])').waitFor();
    expect(await app.page.locator('.compact-status.failed').count()).toBe(0);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
