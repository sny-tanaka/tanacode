import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sessionToolId } from '@shared/session-tools';
import { E2EApp } from './app';

// 「親にする」を押さずに、チャットで親を頼んだセッションにも、TANACODE_PARENT.md が渡る。
// そのセッションの Claude が子を初めて始めたとき、start_session の結果に付けて 1 回だけ渡り、2 本目の子では渡らない

const PARENT_RULES = '# 親として動くときの決まり\n- 子の見回りを予約しない（PARENT-RULES）\n';
const PARENT = '親として、子を 2 つ始めてください（PARENT-RULES）';
const CHILD_A = 'ひとつ目の子への指示です';
const CHILD_B = 'ふたつ目の子への指示です';
const DONE = '子を 2 つ始めました';

describe('「親にする」を押していない親にも、子を初めて始めたときに親の決まりが渡る', () => {
  let app: E2EApp;
  // start_session の結果（ツールの結果の文章）
  const startResults = () => app.api.toolResults.filter((r) => r.includes('"permission_mode"'));

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      files: { 'TANACODE_PARENT.md': PARENT_RULES },
      conversations: () => [
        {
          match: PARENT,
          steps: [
            [{ type: 'tool_use', id: 'toolu_start_a', name: sessionToolId('start_session'), input: { prompt: CHILD_A, worktree: false, name: 'ひとつ目' } }],
            [{ type: 'tool_use', id: 'toolu_start_b', name: sessionToolId('start_session'), input: { prompt: CHILD_B, worktree: false, name: 'ふたつ目' } }],
            [{ type: 'text', text: DONE }],
          ],
        },
        { match: CHILD_A, steps: [[{ type: 'text', text: 'ひとつ目を終えました' }]] },
        { match: CHILD_B, steps: [[{ type: 'text', text: 'ふたつ目を終えました' }]] },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`parent-rules-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('親にせずに始めたセッションが子を 2 つ始める', async () => {
    await app.startSession(PARENT, { mode: 'manual' });
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', DONE).waitFor();
    // 最初の指示には付けない（「親として始める」ではない）
    expect(app.api.lastPrompts.find((p) => p.includes(PARENT))).not.toContain('<tanacode-parent-role>');
  });

  it('1 本目の子を始めた結果にだけ TANACODE_PARENT.md が付き、2 本目には付かない', () => {
    const results = startResults();
    expect(results).toHaveLength(2);
    expect(results[0]).toContain('TANACODE_PARENT.md has not been passed to this conversation yet');
    expect(results[0]).toContain(`<instructions-file path="${app.work}/TANACODE_PARENT.md">`);
    expect(results[0]).toContain(PARENT_RULES.trim());
    expect(results[1]).not.toContain(PARENT_RULES.trim());
    // チャットには知らせを出さない（「親にする」の知らせとも取り違えない）
    return expect(app.byText('.chat-list .chat-notice', 'TANACODE_PARENT.md を読ませて').count()).resolves.toBe(0);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
