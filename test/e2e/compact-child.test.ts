import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checklistToolId } from '@shared/checklist-tools';
import { HANDOFF_TAG, RESUME_TAG } from '@shared/optimized-compact';
import { SESSION_EVENT_TAG, sessionToolId } from '@shared/session-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// 子セッションで、最適化圧縮が自動で動く（自動は既定でオンなので、親が指示した子でも起きる）。
// 子の長いターンを、アプリがツールの切れ目で止めて切り替え、続きを進めさせる。親から見ると:
// - 止めた瞬間（子が一瞬「待機」に戻る）には、作業が終わった知らせは届かない
// - 続きを終えたときに、知らせが 1 回届く
// - get_session で読めるのは、親が出した指示と、続きを終えたあとの応答（仕上げの頼み・再開の文と、その返事ではない）

const PARENT = '子セッションに、手順を任せてください';
const CHILD = '子の作業として、手順を 1 から 8 まで順に実行してください';
const CHILD_NAME = '手順の子';
const PARENT_STARTED = '子を始めました。終わるのを待ちます';
const WRITTEN = 'いまの状態に書きました';
const CHILD_DONE = '自動で切り替わりました。残りの手順を終えました';
const PARENT_READ = '子の報告を読みました';
const SUMMARY_REQUEST = 'Your task is to create a detailed summary';
// 子の応答に付ける入力のトークン数。20 万を超えると上限は 100 万と見なすので、95%（途中で止める大きさの 90% より上）
const CHILD_TOKENS = 950_000;
const LOW_TOKENS = 20_000;

describe('子セッションで、最適化圧縮が自動で動く', () => {
  let app: E2EApp;
  // 親に届いた、子の知らせ（子の ID）
  let noticed: string[] = [];
  // 子が、仕上げの頼みを受けた時点で、親に知らせが届いていたか
  let noticedAtHandoff: number | null = null;

  const prompts = (mark: string) => app.api.lastPrompts.filter((p) => p.includes(mark) && !p.includes('<session>'));
  const steps = () => app.api.toolResults.filter((r) => /step-\d/.test(r)).length;
  const status = () => app.api.toolResults.find((r) => r.includes('"last_response"')) ?? '';

  // 親と子の応答を、最後の発言・ツールの結果の中身で決める
  const respond = (prompt: string, results: string[]): Block[] | null => {
    const result = results.join('\n');
    // --- 親 ---
    app.api.inputTokens = LOW_TOKENS;
    if (prompt.includes(PARENT)) return [{ type: 'tool_use', id: 'toolu_start', name: sessionToolId('start_session'), input: { prompt: CHILD, worktree: false, name: CHILD_NAME } }];
    if (result.includes('"session_id"') && !result.includes('"last_response"')) return [{ type: 'text', text: PARENT_STARTED }];
    const event = new RegExp(`<${SESSION_EVENT_TAG} sessions="([0-9a-f-]+)"`).exec(prompt);
    if (event) {
      noticed.push(event[1]);
      return [{ type: 'tool_use', id: `toolu_get_${noticed.length}`, name: sessionToolId('get_session'), input: { session_id: event[1] } }];
    }
    if (result.includes('"last_response"')) return [{ type: 'text', text: PARENT_READ }];
    // --- 子 ---
    if (prompt.includes(`<${HANDOFF_TAG}>`)) {
      noticedAtHandoff ??= noticed.length;
      app.api.inputTokens = CHILD_TOKENS;
      return [{ type: 'tool_use', id: 'toolu_state', name: checklistToolId('card_add'), input: { list: 'いまの状態', list_description: '変わったら書き換える', list_kind: 'state', cards: [{ title: '手順の途中', body: '残りの手順を進める' }] } }];
    }
    if (result.includes('Added #')) return [{ type: 'text', text: WRITTEN }];
    // 会話を消したあとは、コンテキストが小さくなる
    if (prompt.includes(`<${RESUME_TAG}>`)) return [{ type: 'tool_use', id: 'toolu_overview', name: checklistToolId('checklist_overview'), input: {} }];
    if (result.includes('## ')) return [{ type: 'text', text: CHILD_DONE }];
    app.api.inputTokens = CHILD_TOKENS;
    if (prompt.includes(CHILD)) return [{ type: 'tool_use', id: 'toolu_step_1', name: 'Bash', input: { command: 'sleep 0.6 && echo step-1', description: '手順 1' } }];
    const step = /step-(\d)/.exec(result);
    if (step) {
      const next = Number(step[1]) + 1;
      return next > 8 ? [{ type: 'text', text: '手順を終えました' }] : [{ type: 'tool_use', id: `toolu_step_${next}`, name: 'Bash', input: { command: `sleep 0.6 && echo step-${next}`, description: `手順 ${next}` } }];
    }
    return null;
  };

  beforeAll(async () => {
    app = await E2EApp.launch({ trusted: true });
    app.api.intercept = respond;
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`compact-child-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('親が子を始める。子の長いターンが、ツールの切れ目で止まって切り替わり、続きを終える', async () => {
    app.api.inputTokens = LOW_TOKENS;
    await app.startSession(PARENT);
    const card = await app.menuCard('permission');
    await app.choose(card, /^Yes/);
    await app.byText('.chat-list', PARENT_STARTED).waitFor();
    await app.waitUntil('子の仕上げの頼み', () => prompts(`<${HANDOFF_TAG}>`).length === 1, 90_000);
    expect(prompts(`<${HANDOFF_TAG}>`)[0]).toContain('tanacode stopped your turn between tool calls');
    await app.waitUntil('子の再開の文', () => prompts(`<${RESUME_TAG}>`).length === 1, 60_000);
    // 8 つの手順を終える前に、止まっている
    expect(steps()).toBeGreaterThan(0);
    expect(steps()).toBeLessThan(8);
    // 再開の文には、親の指示が「親セッションからの指示」として入る
    expect(prompts(`<${RESUME_TAG}>`)[0]).toContain(`<user-message from="the Claude in the parent session">\n${CHILD}\n</user-message>`);
  });

  it('親には、子が続きを終えたときに、知らせが 1 回だけ届く（止めた瞬間・仕上げのあと・/clear のあとのすき間では届かない）', async () => {
    await app.byText('.chat-list', PARENT_READ).waitFor({ timeout: 90_000 });
    expect(noticedAtHandoff).toBe(0);
    expect(noticed).toHaveLength(1);
    // 知らせが届いたのは、子が続きを終えたあと（get_session で読めたのが、続きの応答）
    const read = JSON.parse(status()) as { state: string; last_prompt: { from: string; text: string }; last_response: string };
    expect(read.state).toBe('idle');
    expect(read.last_prompt).toEqual({ from: 'parent', text: CHILD });
    expect(read.last_response).toBe(CHILD_DONE);
    // しばらく待っても、知らせは増えない
    await new Promise((r) => setTimeout(r, 4000));
    expect(noticed).toHaveLength(1);
    expect(prompts(SUMMARY_REQUEST)).toEqual([]);
  });

  it('子を開くと、切り替える前の会話が画面に残っている（指示・止める前の手順・再開の知らせ・続きの応答の順）', async () => {
    await app.byText('.session-list .session-row', CHILD_NAME).click();
    await app.byText('.claude-header .claude-title', CHILD_NAME).waitFor();
    await app.byText('.chat-list', CHILD_DONE).waitFor();
    const text = await app.page.locator('.chat-list').innerText();
    const at = [CHILD, '最適化圧縮（自動・コンテキスト 95%）: 続きに要ることを', WRITTEN, '最適化圧縮（自動・コンテキスト 95%）: 会話を消して', CHILD_DONE].map((part) => text.indexOf(part));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
