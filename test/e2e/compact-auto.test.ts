import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checklistToolId } from '@shared/checklist-tools';
import { CANCELLED_TAG, HANDOFF_TAG, RESUME_TAG } from '@shared/optimized-compact';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// 最適化圧縮を、自動で始める。モックの API が返す入力のトークン数を大きくして、コンテキストが埋まってきたことにする
// （上限はモデルによるので、ヘッダーのメーターから読む）。
// - ターンの終わりに、設定の大きさ（既定は 80%）を超えていたら、仕上げ → /clear → 再開の文、と進む（続けるか待つかは「いまの状態」で決めさせる）
// - 1 つのターンが長くて 90% を超えたら、ツールの切れ目で止めて（PostToolUse のフック）切り替え、止めた場所を再開の文に入れる
// - 「自動」のトグルをオフにしたセッションでは始めず、Claude Code の自動の圧縮（要約）が今までどおり動く
// - 始める大きさは、メニューで選ぶ。続けて 2 回取りやめになったら、そのセッションでは休む

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
const NOT_WRITTEN = '書くことはありません';
const SUMMARY_REQUEST = 'Your task is to create a detailed summary';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('最適化圧縮を自動で始める', () => {
  let app: E2EApp;
  let stateCards = 0;
  let lowAfterReset = false;
  // 仕上げの頼みに、チェックリストのツールを使わずに答える（取りやめになる）
  let skipTools = false;
  // 取りやめになる仕上げの頼みに答えたら、コンテキストが小さくなったことにする（続きのターンで、また止めない）
  let lowAfterSkip = false;
  // 最後に返した手順の番号（取りやめのあとに続きを頼まれたら、次の手順から続ける）
  let lastStep = 0;
  // 長い頼みを送った回数（ツールの呼び出しの ID を、回ごとに分ける）
  let longRuns = 0;
  // コンテキストの上限（トークン）。ヘッダーのメーター（「2% · 20.0k」）から求める
  let limit = 0;
  const use = (percent: number) => {
    app.api.inputTokens = Math.round((limit * percent) / 100);
  };
  // タイトルを作る裏の呼び出し（<session> で囲んだ発言）は数えない
  const prompts = (mark: string) => app.api.lastPrompts.filter((p) => p.includes(mark) && !p.includes('<session>'));
  const handoffs = () => prompts(`<${HANDOFF_TAG} `);
  const resumes = () => prompts(`<${RESUME_TAG} `);
  const steps = () => app.api.toolResults.filter((r) => /step-\d/.test(r)).length;
  const button = () => app.page.locator('.claude-header button[aria-label="最適化圧縮"]:not([disabled])');
  const toggle = () => app.page.locator('.claude-header [role="switch"][aria-label="自動の最適化圧縮"]');
  // メニューの「tanacode → 自動で最適化圧縮する大きさ」の項目を選ぶ（id で探す）。選ばれている項目の名前を返す
  const pickPercent = (percent: number) =>
    app.app.evaluate(({ Menu }, percent) => {
      const sizes = () => Menu.getApplicationMenu()?.getMenuItemById('autoCompactPercent')?.submenu?.items ?? [];
      Menu.getApplicationMenu()?.getMenuItemById(`autoCompactPercent-${percent}`)?.click();
      // 選ぶと、メニューを作り直す
      return sizes()
        .filter((item) => item.checked)
        .map((item) => item.label);
    }, percent);

  // チャットに、その文が何回出ているか。最適化圧縮の切り替えではチャットを消さないので、前の同じ応答が残っている。数で待つ
  const shown = async (text: string) => (await app.page.locator('.chat-list').innerText()).split(text).length - 1;
  const untilShown = async (text: string, count: number) => {
    const deadline = Date.now() + 60_000;
    while ((await shown(text)) < count) {
      if (Date.now() > deadline) throw new Error(`「${text}」が ${count} 回出るのを待ちましたが、来ません`);
      await sleep(100);
    }
  };
  // 発言を送って、その応答が出るのを待つ
  const ask = async (prompt: string, reply: string) => {
    const before = await shown(reply);
    await app.send(prompt);
    await untilShown(reply, before + 1);
  };
  // n 回めの「引き継ぎました」が出るのを待つ
  const resumed = (n: number) => untilShown(RESUMED, n);

  // 何番目の応答かが決まらない（どのツールの切れ目で止まるかは、そのときしだい）ので、最後の発言の中身で応答を決める
  const respond = (prompt: string, results: string[]): Block[] | null => {
    if (prompt.includes(`<${HANDOFF_TAG} `) && skipTools) {
      if (lowAfterSkip) use(1);
      return [{ type: 'text', text: NOT_WRITTEN }];
    }
    if (prompt.includes(`<${HANDOFF_TAG} `)) {
      stateCards += 1;
      return [{ type: 'tool_use', id: `toolu_state_${stateCards}`, name: checklistToolId('card_add'), input: { list: 'いまの状態', list_description: '変わったら書き換える', list_kind: 'state', cards: [{ title: `状態 ${stateCards}`, body: '手順の途中' }] } }];
    }
    // 会話を消したあとは、コンテキストが小さくなる（lowAfterReset のとき。モックは、言われた量をそのまま返すため）
    if (prompt.includes(`<${RESUME_TAG} `) && lowAfterReset) use(1);
    if (prompt.includes(`<${RESUME_TAG} `)) return [{ type: 'tool_use', id: `toolu_overview_${resumes().length}`, name: checklistToolId('checklist_overview'), input: {} }];
    // 再開の文のあとの会話では、何番目の応答かが変わるので、ふつうの発言にも、中身で答える
    if (prompt.includes(SMALL)) return [{ type: 'text', text: SMALL_REPLY }];
    if (prompt.includes(OFF)) return [{ type: 'text', text: OFF_REPLY }];
    if (prompt.includes(LONG)) {
      lastStep = 1;
      longRuns += 1;
      return [{ type: 'tool_use', id: `toolu_step_${longRuns}_1`, name: 'Bash', input: { command: 'sleep 0.6 && echo step-1', description: '手順 1' } }];
    }
    const result = results.join('\n');
    const step = /step-(\d)/.exec(result);
    const cancelled = prompt.includes(`<${CANCELLED_TAG}>`);
    if (step || cancelled) {
      const next = (step ? Number(step[1]) : lastStep) + 1;
      lastStep = next;
      return next > 8 ? [{ type: 'text', text: '手順を終えました' }] : [{ type: 'tool_use', id: `toolu_step_${longRuns}_${next}`, name: 'Bash', input: { command: `sleep 0.6 && echo step-${next}`, description: `手順 ${next}` } }];
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

  it('始める大きさは、メニューで選ぶ。選んだら、すぐトグルの説明に出る', async () => {
    expect(await pickPercent(60)).toEqual(['60%']);
    await app.page.locator('.claude-header [role="switch"][aria-label="自動の最適化圧縮"][data-tip*="コンテキストが 60% を超えたら"]').waitFor();
    expect(await pickPercent(80)).toEqual(['80%']);
    await app.page.locator('.claude-header [role="switch"][aria-label="自動の最適化圧縮"][data-tip*="コンテキストが 80% を超えたら"]').waitFor();
    expect(handoffs()).toEqual([]);
  });

  it('ターンの終わりに 80% を超えていたら、自動で切り替える（仕上げ → /clear → 再開の文）。再開のあとに続けるか待つかは、手動と同じく「いまの状態」で決めさせる', async () => {
    // 次の応答から、コンテキストの 85% を使っていることにする
    use(85);
    await app.send(NEXT);
    await app.waitUntil('自動の仕上げの頼み', () => handoffs().length === 1, 60_000);
    // 画面の言語（E2E は日本語）で書く
    expect(handoffs()[0]).toContain('これから消します（自動・コンテキスト 85%）。');
    expect(handoffs()[0]).toContain('今回は自動の切り替えです。ユーザーは何も押しておらず');
    expect(handoffs()[0]).toContain('消したあとは、いまの状態のリストから作業を再開します。リストに答え待ちと書いてなければ、作業を続けます。');
    await app.waitUntil('再開の文', () => resumes().length === 1, 60_000);
    const resume = resumes()[0];
    expect(resume).toContain('消しました（自動・コンテキスト 85%）。要約は作っていません。');
    expect(resume).toContain('- そのうえで、ユーザー（または、作業を指示した親セッション）の答えを待っているかを、いまの状態のリストから決めてください:');
    expect(resume).not.toContain('Do not continue the work until the user tells you to.');
    expect(resume).toContain(`<user-message>\n${NEXT}\n</user-message>`);
    // 切り替える前の最後の応答も入る（人が、それに短く答えるかもしれない）
    expect(resume).toContain(`<your-last-reply>\n${NEXT_REPLY}\n</your-last-reply>`);
    await resumed(1);
    // 人が読んでいる途中の答えを、画面から消さない（Claude Code の会話は消えている）
    expect(await app.byText('.chat-list', NEXT_REPLY).count()).toBe(1);
    expect(await app.byText('.chat-list', REPLY).count()).toBe(1);
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

  it('1 つのターンが長くて 90% を超えたら、ツールの切れ目で止めて切り替え、止めたことと止めた場所を再開の文に入れる', async () => {
    // いったん下がったことにして（設定より 10 ポイント下を下回ると、また始められる）、次の長いターンで 92% を超える
    use(1);
    await ask(SMALL, SMALL_REPLY);
    await button().waitFor();
    use(92);
    await app.send(LONG);
    await app.waitUntil('途中で止めたあとの仕上げの頼み', () => handoffs().length === 2, 90_000);
    // 8 つの手順を終える前に、止まっている
    const done = steps();
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(8);
    expect(handoffs()[1]).toContain('tanacode がツールの切れ目であなたのターンを止めたので、消したあとは、同じ作業を続けます。');
    await app.waitUntil('再開の文', () => resumes().length === 2, 60_000);
    const resume = resumes()[1];
    expect(resume).toContain('- この切り替えは、あなたのターンの途中で起きました。');
    expect(resume).toContain('進めていた作業を、止まったところから続けてください（いまの状態のリストと、下の「ターンを止めた場所」）。');
    expect(resume).not.toContain('Do not continue the work until the user tells you to.');
    expect(resume).toContain('# ターンを止めた場所（tanacode が記録したもので、あなたが書いたものではありません）');
    expect(resume).toContain(`- Bash: sleep 0.6 && echo step-${done} → 終わった`);
    expect(resume).toContain(`<user-message>\n${LONG}\n</user-message>`);
    // 止めたあとは、手順を進めていない（切り替えの間に、ツールが走り続けない）
    expect(steps()).toBe(done);
    await resumed(2);
    await button().waitFor();
    expect(prompts(SUMMARY_REQUEST)).toEqual([]);
    // 止めた記録（コマンドの無い hook_stopped_continuation）は、ユーザーのフックの「止めた」として、ツールのカードに付けない。
    // 続けて呼んだツールのカードは 1 行にまとまり、開くまでカード（とフック）を描かないので、まとまりを開いてから数える
    const heads = app.page.locator('.chat-list .tool-group-head[aria-expanded="false"]');
    for (let n = await heads.count(); n > 0; n = await heads.count()) await heads.first().click();
    await app.page.locator('.chat-list .tool-card', { hasText: `手順 ${done}` }).first().waitFor();
    expect(await app.page.locator('.chat-list .hook-run.blocked').count()).toBe(0);
  });

  it('Claude Code の自動の圧縮が始まる大きさ（97%）でも、圧縮の前のフックで止めて、要約を作らせずに切り替える', async () => {
    // 下の「オフにしたセッション」と同じ大きさ。オフなら、次の発言を送る前に Claude Code が自分で圧縮する。
    // オンなら、次の発言（アプリの仕上げの頼み）の前に始まろうとした圧縮を、フックが止める
    use(1);
    await ask(SMALL, SMALL_REPLY);
    await button().waitFor();
    use(97);
    lowAfterReset = true;
    await app.send(OFF);
    await app.waitUntil('仕上げの頼み', () => handoffs().length === 3, 60_000);
    await app.waitUntil('再開の文', () => resumes().length === 3, 60_000);
    await resumed(3);
    await button().waitFor();
    expect(prompts(SUMMARY_REQUEST)).toEqual([]);
  });

  it('続けて 2 回取りやめになったら、このセッションでは休む（ボタンの左に出す）。休んでいる間は、始めない', async () => {
    const failed = app.page.locator('.claude-header .compact-status.failed');
    lowAfterReset = false;
    skipTools = true;
    use(85);
    // 1 回め: 仕上げでチェックリストのツールを使わなかったので、取りやめ（会話は消さない）
    await app.send(SMALL);
    await app.waitUntil('1 回めの仕上げの頼み', () => handoffs().length === 4, 60_000);
    await failed.waitFor();
    await button().waitFor();
    // 2 回め: 次のターンの終わりに、もう 1 回だけ試す
    await app.send(SMALL);
    await app.waitUntil('2 回めの仕上げの頼み', () => handoffs().length === 5, 60_000);
    await failed.waitFor();
    await button().waitFor();
    expect(resumes()).toHaveLength(3);
    // 取りやめの知らせを閉じると、休んでいることが出る
    await failed.locator('.compact-status-close').click();
    await app.byText('.claude-header .compact-status', '自動の最適化圧縮を休んでいます').waitFor();
    // 休んでいる間は、超えていても始めない
    await ask(SMALL, SMALL_REPLY);
    await button().waitFor();
    await sleep(4000);
    expect(handoffs()).toHaveLength(5);
    skipTools = false;
  });

  it('「自動」をオフにしたセッションでは、始めない。Claude Code の自動の圧縮（要約）が、今までどおり動く', async () => {
    use(1);
    await ask(SMALL, SMALL_REPLY);
    await button().waitFor();
    await toggle().click();
    await app.page.locator('.claude-header [role="switch"][aria-label="自動の最適化圧縮"][aria-checked="false"]').waitFor();
    use(97);
    await ask(OFF, OFF_REPLY);
    // もう 1 回発言すると、Claude Code が、送る前に自分で圧縮する
    await button().waitFor();
    await app.send(OFF);
    await app.waitUntil('Claude Code の自動の圧縮（要約の頼み）', () => prompts(SUMMARY_REQUEST).length > 0, 60_000);
    expect(handoffs()).toHaveLength(5);
  });

  it('ターンの途中で止めたのに取りやめになったら、会話を消さずに、止めたところから続けるよう頼む（止めたままにしない）', async () => {
    use(1);
    await ask(SMALL, SMALL_REPLY);
    await button().waitFor();
    // 「自動」を入れ直す（休んでいたのも戻る）
    await toggle().click();
    await app.page.locator('.claude-header [role="switch"][aria-label="自動の最適化圧縮"][aria-checked="true"]').waitFor();
    const handed = handoffs().length;
    const resumedBefore = resumes().length;
    const finishedBefore = await shown('手順を終えました');
    skipTools = true;
    lowAfterSkip = true;
    use(92);
    await app.send(LONG);
    await app.waitUntil('途中で止めたあとの仕上げの頼み', () => handoffs().length === handed + 1, 90_000);
    await app.waitUntil('続きを頼む文', () => prompts(`<${CANCELLED_TAG}>`).length === 1, 60_000);
    expect(prompts(`<${CANCELLED_TAG}>`)[0]).toContain('止めたところから作業を続けてください。');
    await untilShown('手順を終えました', finishedBefore + 1);
    await app.byText('.chat-list .chat-notice', '最適化圧縮を取りやめたので、止めたところから続けるよう頼みました').waitFor();
    // 会話は消していない
    expect(resumes()).toHaveLength(resumedBefore);
    await button().waitFor();
    skipTools = false;
    lowAfterSkip = false;
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
