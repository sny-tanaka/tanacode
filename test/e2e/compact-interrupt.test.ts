import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HANDOFF_TAG } from '@shared/optimized-compact';
import { E2EApp } from './app';

// 最適化圧縮の仕上げの頼みを、応答の前に中断する。stream-json では、中断した発言は入力欄に戻らず、会話に残る（そのあとに
// 中断の印。設計書 7 節）。人のチャットの入力欄に何も入らないこと・次の発言はそれだけで送り、Claude Code には仕上げの頼みが
// 中断されたと分かる形で届くこと・会話を消さずに取りやめることを確かめる

const PROMPT = '税率を可変にしてください';
const REPLY = '税率を引数にしました';
const NEXT = '続きです';
// Claude Code が中断した発言のあとに書く印
const INTERRUPTED = '[Request interrupted by user]';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('最適化圧縮の仕上げを、応答の前に中断する', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      // 応答を遅らせる（中断するまで、応答が始まらないように）
      conversations: () => [{ match: PROMPT, delayMs: 12_000, steps: [[{ type: 'text', text: REPLY }], [{ type: 'text', text: '遅い応答' }], [{ type: 'text', text: '続けます' }]] }],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`compact-interrupt-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('中断しても、チャットの入力欄には何も入らない。会話を消さずに取りやめ、理由を出す', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', REPLY).waitFor();
    await app.page.click('.claude-header button[aria-label="最適化圧縮"]:not([disabled])');
    // 応答を待っている間に中断する（応答は 12 秒遅らせている）
    await app.waitUntil('仕上げの頼みが届く', () => app.api.lastPrompts.some((p) => p.includes(`<${HANDOFF_TAG} `)));
    await app.page.click('.chat-input [aria-label="中断"]');
    // 取りやめるまでの間、入力欄は空のまま
    const input = app.page.locator('.chat-input textarea');
    const failed = app.page.locator('.compact-status.failed');
    const seen = new Set<string>();
    for (let i = 0; i < 100 && (await failed.count()) === 0; i++) {
      seen.add(await input.inputValue());
      await sleep(100);
    }
    expect(await failed.innerText()).toContain('最適化圧縮を取りやめました');
    expect(await failed.getAttribute('data-tip')).toBe('仕上げを中断したので、最適化圧縮を取りやめました。会話は消していません');
    await sleep(1500);
    seen.add(await input.inputValue());
    expect([...seen]).toEqual(['']);
    // 会話は消していない
    expect(await app.byText('.chat-list', REPLY).count()).toBe(1);
  }, 120_000);

  it('次の発言は、それだけで送る。中断した仕上げの頼みは、中断の印のあとの別の発言として Claude に届く', async () => {
    await app.send(NEXT);
    await app.waitUntil('次の発言が届く', () => app.api.lastPrompts.some((p) => p.includes(NEXT)), 60_000);
    // 応答の無いまま続いた発言は、API には 1 つのメッセージにまとめて届く。仕上げの頼み → 中断の印 → 次の発言、の順
    const next = app.api.lastPrompts.find((p) => p.includes(NEXT))!;
    expect(next.indexOf(HANDOFF_TAG)).toBeGreaterThanOrEqual(0);
    expect(next.indexOf(HANDOFF_TAG)).toBeLessThan(next.indexOf(INTERRUPTED));
    expect(next.indexOf(INTERRUPTED)).toBeLessThan(next.indexOf(NEXT));
    // チャットには、人の発言として次の発言だけが出る（仕上げの頼みは見出し付きの知らせのまま）
    expect(await app.byText('.chat-list', NEXT).count()).toBe(1);
  }, 120_000);

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
