import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HANDOFF_TAG } from '@shared/optimized-compact';
import { E2EApp } from './app';

// 最適化圧縮の仕上げの頼みを、応答の前に中断する。Claude Code は、応答の前に中断した発言を入力欄に戻す（2.1.296 では本文そのもの。
// 長い文は入力欄に収まらず、途中の一部だけが見える）。それが人のチャットの入力欄に移らないこと・Claude Code の入力欄に残って
// 次の発言に混ざらないこと・会話を消さずに取りやめることを確かめる

const PROMPT = '税率を可変にしてください';
const REPLY = '税率を引数にしました';
const NEXT = '続きです';
// 押してから中断するまで。打ってから 5 秒（打った文字を画面に知らせない時間。session-manager の TYPING_MS）を過ぎてから中断する
const WAIT_MS = 6000;
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

  it('戻った仕上げの頼みは、チャットの入力欄に移らない。会話を消さずに取りやめ、理由を出す', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', REPLY).waitFor();
    await app.page.click('.claude-header button[aria-label="最適化圧縮"]:not([disabled])');
    await app.waitUntil('仕上げの頼みが届く', () => app.api.lastPrompts.some((p) => p.includes(`<${HANDOFF_TAG}>`)));
    await sleep(WAIT_MS);
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

  it('Claude Code の入力欄にも残さない（次の発言に、仕上げの頼みが混ざらない）', async () => {
    await app.send(NEXT);
    await app.waitUntil('次の発言が届く', () => app.api.lastPrompts.some((p) => p.includes(NEXT)), 60_000);
    const next = app.api.lastPrompts.filter((p) => p.includes(NEXT));
    expect(next.some((p) => p.includes(HANDOFF_TAG) || p.includes('reset this conversation'))).toBe(false);
  }, 120_000);

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
