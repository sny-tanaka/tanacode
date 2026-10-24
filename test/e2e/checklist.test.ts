import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checklistToolId } from '@shared/checklist-tools';
import { E2EApp } from './app';

// 人がチェックリストを画面で作って使う。リストとカードを作り、チェックを付け、カードのスレッドで
// 「Claude に通知する」で返信すると、手の空いた Claude に知らせが届く。Claude が MCP でスレッドに返信すると、画面に出る。
// Claude がツールを使ってチェックリストに触れずにターンを終えても、続きを始めさせず（会話ログの最後の応答は作業の報告のまま。
// Remote Control に出る最後の応答も同じ）、次の発言の知らせで、前のターンの分もリストを直させる

const PROMPT = 'チェックリストを一緒に見てください';
const LIST = '確認事項';
const RULE = '終える前に、すべて確かめる';
const CARD = '画面の文言をそろえる';
const REPLY = 'ボタンの文言も見てください';
const CLAUDE_REPLY = 'ボタンの文言も確かめました';
const DONE = 'スレッドに返信しました';
const WORK = 'ファイルの一覧を見てください';
const REPORT = 'ファイルの一覧を見ました';
const NEXT = '続けてください';
const LATE = 'Your previous turn ended without touching the checklists (1 tool call).';

describe('人がチェックリストを画面で使い、Claude とやりとりする', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: PROMPT,
          steps: [
            [{ type: 'text', text: 'どうぞ' }],
            // 人の返信の知らせを受けて、スレッドに返信する
            [{ type: 'tool_use', id: 'toolu_reply', name: checklistToolId('card_reply'), input: { list: LIST, number: 1, text: CLAUDE_REPLY } }],
            [{ type: 'text', text: DONE }],
            // 次の発言。チェックリストに触れずにツールを使って終える
            [{ type: 'tool_use', id: 'toolu_glob', name: 'Glob', input: { pattern: '*' } }],
            [{ type: 'text', text: REPORT }],
            // その次の発言
            [{ type: 'text', text: 'はい' }],
          ],
        },
      ],
    });
  });

  // 会話ログ（Claude Code が書く .jsonl）の最後の応答の文
  const lastAnswer = () => {
    const files = readdirSync(join(app.home, '.claude', 'projects'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.jsonl'));
    const texts = files
      .flatMap((f) => readFileSync(join(app.home, '.claude', 'projects', f), 'utf8').split('\n'))
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as { type?: string; timestamp?: string; message?: { content?: unknown } };
          if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return [];
          const text = (entry.message.content as { type?: string; text?: string }[]).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join(' ');
          return text ? [{ at: entry.timestamp ?? '', text }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.at.localeCompare(b.at));
    return texts.at(-1)?.text;
  };
  const idle = () =>
    vi.waitFor(
      async () => {
        const states = await app.page.evaluate(() =>
          (window as unknown as { tanacode: { sessions: { list(): Promise<{ state: string | null }[]> } } }).tanacode.sessions.list().then((list) => list.map((s) => s.state)),
        );
        expect(states).toEqual(['idle']);
      },
      { timeout: 30_000, interval: 100 },
    );

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`checklist-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('リストとカードを作り、チェックを付けられる', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', 'どうぞ').waitFor();
    await app.page.click('.activity-bar [aria-label^="チェックリスト"]');
    await app.byText('.checklist-toolbar button', 'リストを作る').click();
    await app.page.fill('.checklist-panel input[placeholder^="名前"]', LIST);
    await app.page.fill('.checklist-panel textarea[placeholder^="使い方のルール"]', RULE);
    await app.byText('.checklist-panel button[type="submit"]', '作る').click();
    const head = app.page.locator('.checklist-list-head', { hasText: LIST });
    await head.waitFor();
    await app.byText('.checklist-list-description', RULE).waitFor();
    // カードを足すボタンは、見出しにマウスを乗せると出る
    await head.hover();
    await head.locator('[aria-label="カードを足す"]').click();
    await app.page.fill('.checklist-panel input[placeholder^="タイトル"]', CARD);
    await app.page.keyboard.press('Enter');
    const card = app.page.locator('.checklist-card', { hasText: CARD });
    await card.waitFor();
    await card.locator('.card-check').click();
    await app.page.locator('.checklist-card.checked', { hasText: CARD }).waitFor();
  });

  it('カードのスレッドに「Claude に通知する」で返信すると、手の空いた Claude に知らせが届く', async () => {
    await app.byText('.checklist-card .checklist-title', CARD).click();
    await app.page.fill('.card-composer textarea', REPLY);
    const notify = app.page.locator('.card-composer .checklist-notify input[type="checkbox"]');
    if (!(await notify.isChecked())) await notify.check();
    await app.page.click('.card-composer [aria-label="返信する"]');
    await app.byText('.card-thread .card-thread-reply.by-human', REPLY).waitFor();
    // 知らせは、カードの場所と返信の中身を付けて Claude に届く
    await app.waitUntil('知らせが Claude に届く', () => app.api.lastPrompts.some((p) => p.includes(REPLY) && p.includes(LIST)));
  });

  it('Claude が MCP でスレッドに返信すると、画面のスレッドに出る', async () => {
    await app.byText('.chat-list', DONE).waitFor();
    await app.byText('.card-thread .card-thread-reply.by-claude', CLAUDE_REPLY).waitFor();
  });

  it('ツールを使ってチェックリストに触れずにターンを終えても、続きを始めさせず、最後の応答は作業の報告のまま', async () => {
    await idle();
    const from = app.api.contexts.length;
    await app.send(WORK);
    await app.byText('.chat-list', REPORT).waitFor();
    await idle();
    // ツールと最後の応答で 2 回。ターンの終わりの知らせで続きを始めていない
    expect(app.api.contexts.length - from).toBe(2);
    expect(app.api.contexts.some((c) => c.includes('Stop hook additional context'))).toBe(false);
    await app.waitUntil('会話ログの最後の応答が作業の報告になる', () => lastAnswer() === REPORT);
  });

  it('次の発言の知らせで、前のターンの分もチェックリストを直させる', async () => {
    await app.send(NEXT);
    await app.byText('.chat-list', 'はい').waitFor();
    const context = [...app.api.contexts].reverse().find((c) => c.includes(NEXT)) ?? '';
    expect(context.slice(context.lastIndexOf(NEXT))).toContain(LATE);
    await idle();
    expect(lastAnswer()).toBe('はい');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
