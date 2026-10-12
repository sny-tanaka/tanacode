import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checklistToolId } from '@shared/checklist-tools';
import { HANDOFF_TAG, RESUME_TAG } from '@shared/optimized-compact';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// 最適化圧縮を、自動で始める。モックの API が返す入力のトークン数を大きくして、コンテキストが埋まってきたことにする
// （上限はモデルによるので、ヘッダーのメーターから読む）。
// - ターンの終わりに、設定の大きさ（既定は 80%）を超えていたら、仕上げ → /clear → 再開の文、と進む（Claude は報告して待つ）
// - 1 つのターンが長くて 90% を超えたら、ツールの切れ目で止めて（PostToolUse のフック）切り替え、続きを進めさせる
// - 「自動」のトグルをオフにしたセッションでは始めず、Claude Code の自動の圧縮（要約）が今までどおり動く

const PROMPT = '税率を可変にしてください';
const REPLY = '税率を引数にしました';
const NEXT = 'README も直してください';
const NEXT_REPLY = 'README を直しました';
const SMALL = '小さな質問です';
const SMALL_REPLY = '小さな答えです';
const LONG = '手順を 1 から 8 まで順に実行してください';
const OFF = 'トグルを切ったあとの頼みです';
const OFF_REPLY = 'トグルを切ったあとの答えです';
const WRITTEN = 'いまの状態に書きました';
const RESUMED = '引き継ぎました';
const SUMMARY_REQUEST = 'Your task is to create a detailed summary';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('最適化圧縮を自動で始める', () => {
  let app: E2EApp;
  let stateCards = 0;
  let lowAfterReset = false;
  // コンテキストの上限（トークン）。ヘッダーのメーター（「2% · 20.0k」）から求める
  let limit = 0;
  const use = (percent: number) => {
    app.api.inputTokens = Math.round((limit * percent) / 100);
  };
  // タイトルを作る裏の呼び出し（<session> で囲んだ発言）は数えない
  const prompts = (mark: string) => app.api.lastPrompts.filter((p) => p.includes(mark) && !p.includes('<session>'));
  const handoffs = () => prompts(`<${HANDOFF_TAG}>`);
  const resumes = () => prompts(`<${RESUME_TAG}>`);
  const steps = () => app.api.toolResults.filter((r) => /step-\d/.test(r)).length;
  const button = () => app.page.locator('.claude-header button[aria-label="最適化圧縮"]:not([disabled])');
  const toggle = () => app.page.locator('.claude-header [role="switch"][aria-label="自動の最適化圧縮"]');

  // 何番目の応答かが決まらない（どのツールの切れ目で止まるかは、そのときしだい）ので、最後の発言の中身で応答を決める
  const respond = (prompt: string, results: string[]): Block[] | null => {
    if (prompt.includes(`<${HANDOFF_TAG}>`)) {
      stateCards += 1;
      return [{ type: 'tool_use', id: `toolu_state_${stateCards}`, name: checklistToolId('card_add'), input: { list: 'いまの状態', list_description: '変わったら書き換える', list_kind: 'state', cards: [{ title: `状態 ${stateCards}`, body: '手順の途中' }] } }];
    }
    // 会話を消したあとは、コンテキストが小さくなる（lowAfterReset のとき。モックは、言われた量をそのまま返すため）
    if (prompt.includes(`<${RESUME_TAG}>`) && lowAfterReset) use(1);
    if (prompt.includes(`<${RESUME_TAG}>`)) return [{ type: 'tool_use', id: `toolu_overview_${resumes().length}`, name: checklistToolId('checklist_overview'), input: {} }];
    // 再開の文のあとの会話では、何番目の応答かが変わるので、ふつうの発言にも、中身で答える
    if (prompt.includes(SMALL)) return [{ type: 'text', text: SMALL_REPLY }];
    if (prompt.includes(OFF)) return [{ type: 'text', text: OFF_REPLY }];
    if (prompt.includes(LONG)) return [{ type: 'tool_use', id: 'toolu_step_1', name: 'Bash', input: { command: 'sleep 0.6 && echo step-1', description: '手順 1' } }];
    const result = results.join('\n');
    const step = /step-(\d)/.exec(result);
    if (step) {
      const next = Number(step[1]) + 1;
      return next > 8 ? [{ type: 'text', text: '手順を終えました' }] : [{ type: 'tool_use', id: `toolu_step_${next}`, name: 'Bash', input: { command: `sleep 0.6 && echo step-${next}`, description: `手順 ${next}` } }];
    }
    if (result.includes('Added #')) return [{ type: 'text', text: WRITTEN }];
    if (result.includes('## ')) return [{ type: 'text', text: RESUMED }];
    return null;
  };

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        { match: PROMPT, steps: [[{ type: 'text', text: REPLY }], [{ type: 'text', text: NEXT_REPLY }]] },
      ],
    });
    app.api.intercept = respond;
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`compact-auto-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('新しいセッションは「自動」がオン。設定の大きさに届かないあいだは、始めない', async () => {
    app.api.inputTokens = 20_000;
    await app.startSession(PROMPT);
    await app.byText('.chat-list', REPLY).waitFor();
    await toggle().waitFor();
    const meter = app.page.locator('.claude-header .context-meter-value');
    await meter.filter({ hasText: /\d+% · 20/ }).waitFor();
    // はじめは会話ログの使用量からの見積もり（上限 20 万）で出て、statusLine が届くと正確な上限に変わる。落ち着くのを待つ
    for (let before = ''; ; ) {
      await sleep(1500);
      const now = (await meter.textContent()) ?? '';
      if (now === before) break;
      before = now;
    }
    limit = Math.round(20_000 / (Number(/(\d+)%/.exec((await meter.textContent()) ?? '')?.[1]) / 100));
    expect([200_000, 1_000_000]).toContain(limit);
    expect(await toggle().getAttribute('aria-checked')).toBe('true');
    expect(await toggle().getAttribute('data-tip')).toContain('コンテキストが 80% を超えたら');
    await sleep(1500);
    expect(handoffs()).toEqual([]);
  });

  it('ターンの終わりに 80% を超えていたら、自動で切り替える（仕上げ → /clear → 再開の文）。再開のあとは、報告して待たせる', async () => {
    // 次の応答から、コンテキストの 85% を使っていることにする
    use(85);
    await app.send(NEXT);
    await app.waitUntil('自動の仕上げの頼み', () => handoffs().length === 1, 60_000);
    expect(handoffs()[0]).toContain('This reset is automatic (automatic; context 85% full)');
    expect(handoffs()[0]).toContain('After the reset you will report what you carried over and wait for the user.');
    await app.waitUntil('再開の文', () => resumes().length === 1, 60_000);
    const resume = resumes()[0];
    expect(resume).toContain('(automatic; context 85% full). No summary was made.');
    expect(resume).toContain('Do not continue the work until the user tells you to.');
    expect(resume).toContain(`<user-message>\n${NEXT}\n</user-message>`);
    await app.byText('.chat-list', RESUMED).waitFor();
    // 知らせの行で、手動と見分けられる
    await app.byText('.chat-list', '最適化圧縮（自動・コンテキスト 85%）: 会話を消して、チェックリストから再開しました').waitFor();
    await button().waitFor();
  });

  it('切り替えた直後に、まだ超えていても、繰り返さない。Claude Code の自動の圧縮（要約）も動かない', async () => {
    // 再開のターンの応答も、85% のまま返っている
    await sleep(4000);
    expect(handoffs()).toHaveLength(1);
    expect(prompts(SUMMARY_REQUEST)).toEqual([]);
  });

  it('1 つのターンが長くて 90% を超えたら、ツールの切れ目で止めて切り替え、続きを進めさせる（止めた場所を、再開の文に入れる）', async () => {
    // いったん下がったことにして（設定より 10 ポイント下を下回ると、また始められる）、次の長いターンで 92% を超える
    use(1);
    await app.send(SMALL);
    await app.byText('.chat-list', SMALL_REPLY).waitFor();
    await button().waitFor();
    use(92);
    await app.send(LONG);
    await app.waitUntil('途中で止めたあとの仕上げの頼み', () => handoffs().length === 2, 90_000);
    // 8 つの手順を終える前に、止まっている
    const done = steps();
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(8);
    expect(handoffs()[1]).toContain('tanacode stopped your turn between tool calls, and after the reset you will continue the same work.');
    await app.waitUntil('再開の文', () => resumes().length === 2, 60_000);
    const resume = resumes()[1];
    expect(resume).toContain('This reset happened in the middle of your turn');
    expect(resume).toContain('continue the work from where it stopped');
    expect(resume).not.toContain('Do not continue the work until the user tells you to.');
    expect(resume).toContain('# Where the turn was stopped (recorded by tanacode, not written by you)');
    expect(resume).toContain(`- Bash: sleep 0.6 && echo step-${done} → finished`);
    expect(resume).toContain(`<user-message>\n${LONG}\n</user-message>`);
    // 止めたあとは、手順を進めていない（切り替えの間に、ツールが走り続けない）
    expect(steps()).toBe(done);
    await app.byText('.chat-list', RESUMED).last().waitFor();
    await button().waitFor();
    expect(prompts(SUMMARY_REQUEST)).toEqual([]);
  });

  it('Claude Code の自動の圧縮が始まる大きさ（97%）でも、圧縮の前のフックで止めて、要約を作らせずに切り替える', async () => {
    // 下の「オフにしたセッション」と同じ大きさ。オフなら、次の発言を送る前に Claude Code が自分で圧縮する。
    // オンなら、次の発言（アプリの仕上げの頼み）の前に始まろうとした圧縮を、フックが止める
    use(1);
    await app.send(SMALL);
    await app.byText('.chat-list', SMALL_REPLY).last().waitFor();
    await button().waitFor();
    use(97);
    lowAfterReset = true;
    await app.send(OFF);
    await app.waitUntil('仕上げの頼み', () => handoffs().length === 3, 60_000);
    await app.waitUntil('再開の文', () => resumes().length === 3, 60_000);
    await app.byText('.chat-list', RESUMED).last().waitFor();
    await button().waitFor();
    expect(prompts(SUMMARY_REQUEST)).toEqual([]);
  });

  it('「自動」をオフにしたセッションでは、始めない。Claude Code の自動の圧縮（要約）が、今までどおり動く', async () => {
    use(1);
    await app.send(SMALL);
    await app.byText('.chat-list', SMALL_REPLY).last().waitFor();
    await button().waitFor();
    await toggle().click();
    await app.page.locator('.claude-header [role="switch"][aria-label="自動の最適化圧縮"][aria-checked="false"]').waitFor();
    use(97);
    await app.send(OFF);
    await app.byText('.chat-list', OFF_REPLY).first().waitFor();
    // もう 1 回発言すると、Claude Code が、送る前に自分で圧縮する
    await button().waitFor();
    await app.send(OFF);
    await app.waitUntil('Claude Code の自動の圧縮（要約の頼み）', () => prompts(SUMMARY_REQUEST).length > 0, 60_000);
    expect(handoffs()).toHaveLength(3);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
