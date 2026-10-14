import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHECKLIST_REMINDER_TAG, checklistToolId } from '@shared/checklist-tools';
import { E2EApp } from './app';

// 決定事項（チェックで消えないリスト）を、画面と Claude の両方から通しで使う。
// Claude が MCP で決定事項と確認事項のリストを作る → 人が確認事項のカードをチェック（承認）すると、決定事項に移る →
// 次の発言で、有効な決定が Claude に渡る（承認したものも）→ Claude は取り消せて、取り消したカードはゴミ箱に入る。有効なカードは消せない →
// 人は、ゴミ箱から戻して取り消しを戻せて、自分でも取り消せる（画面に残る）→ 取り消したものは、次の発言から Claude に渡らない →
// 人が取り消して残っているカードは、Claude が消せる

const PROMPT = '決済には触らずに、税率を可変にしてください';
const NEXT = '続けてください';
const LAST = '最後に確かめてください';
const DECISIONS = '決定事項';
const REVIEW = '確認事項';
const RULE = '決済には、この PR では触らない';
const JUDGMENT = '端数は四捨五入にした';
const REASON = 'ユーザーが、決済もこの PR でやると言った';
const HUMAN_REASON = '切り捨てに戻す';
const READY = 'リストに書きました';
const DONE = '取り消しました';
const CHECKED = '確かめました';

describe('決定事項を、人と Claude が画面と MCP で使う', () => {
  let app: E2EApp;
  const row = (title: string) => app.page.locator('.checklist-card', { hasText: title });
  const decisionsHead = () => app.page.locator('.checklist-list.kind-decisions .checklist-list-head');
  const trashed = (title: string) => app.page.locator('.checklist-trash-item', { hasText: title });
  // ゴミ箱を開く（開いたままなら、そのまま。見出しは押すたびに開け閉めする）
  const openTrash = async () => {
    await app.page.locator('.checklist-trash-head').waitFor();
    if (!(await app.page.locator('.checklist-trash-body').isVisible())) await app.page.click('.checklist-trash-head');
  };
  // 発言のときに Claude に渡った、今のチェックリスト（その発言を含む、いちばん新しいリクエスト）
  const reminderFor = (prompt: string) => {
    const context = [...app.api.contexts].reverse().find((c) => c.includes(prompt)) ?? '';
    const at = context.lastIndexOf(`<${CHECKLIST_REMINDER_TAG}>`);
    return at === -1 ? '' : context.slice(at);
  };

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: PROMPT,
          steps: [
            // 決まった時点で、決定事項に書く。聞かずに決めたことは、確認事項に書く
            [
              {
                type: 'tool_use',
                id: 'toolu_decide',
                name: checklistToolId('card_add'),
                input: { list: DECISIONS, list_description: '決まったこと', list_kind: 'decisions', cards: [{ title: RULE, body: 'ユーザーの発言:「決済には触らずに」' }] },
              },
            ],
            [{ type: 'tool_use', id: 'toolu_judge', name: checklistToolId('card_add'), input: { list: REVIEW, list_description: '判断と理由', list_kind: 'review', cards: [{ title: JUDGMENT }] } }],
            [{ type: 'text', text: READY }],
            // 2 つめの発言。決定を取り消す（理由つき）。有効な決定は消せない
            [{ type: 'tool_use', id: 'toolu_revoke', name: checklistToolId('card_revoke'), input: { list: DECISIONS, numbers: '1', reason: REASON } }],
            [{ type: 'tool_use', id: 'toolu_delete', name: checklistToolId('card_delete'), input: { list: DECISIONS, numbers: '2' } }],
            [{ type: 'text', text: DONE }],
            // 3 つめの発言。人が取り消して残っているカードを消す
            [{ type: 'tool_use', id: 'toolu_clean', name: checklistToolId('card_delete'), input: { list: DECISIONS, numbers: '2' } }],
            [{ type: 'text', text: CHECKED }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`checklist-decisions-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Claude が作った決定事項のリストは、チェック欄の代わりにピンと有効な数で出る', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', READY).waitFor();
    await app.page.click('.activity-bar [aria-label^="チェックリスト"]');
    await app.byText('.checklist-list.kind-decisions .checklist-list-name', DECISIONS).waitFor();
    await app.byText('.checklist-list.kind-decisions .checklist-progress.pinned', '1 件').waitFor();
    await row(RULE).locator('.checklist-pin').waitFor();
    expect(await row(RULE).locator('.card-check').count()).toBe(0);
    await app.byText('.checklist-list.kind-review .checklist-list-name', REVIEW).waitFor();
  });

  it('確認事項のカードを人がチェック（承認）すると、決定事項に移る', async () => {
    await row(JUDGMENT).locator('.card-check').click();
    await app.page.locator('.checklist-list.kind-decisions .checklist-card', { hasText: JUDGMENT }).waitFor();
    await app.byText('.checklist-list.kind-decisions .checklist-progress.pinned', '2 件').waitFor();
    expect(await app.page.locator('.checklist-list.kind-review .checklist-card').count()).toBe(0);
  });

  it('次の発言で、有効な決定（承認したものも）が Claude に渡る。Claude が取り消したものはゴミ箱に入る。有効な決定は消せない', async () => {
    await app.send(NEXT);
    await app.byText('.chat-list', DONE).waitFor();
    const reminder = reminderFor(NEXT);
    expect(reminder).toContain(`## ${DECISIONS} (decisions; 2 in force)`);
    expect(reminder).toContain(`- #1 ${RULE}\n- #2 ${JUDGMENT}`);
    // 取り消しは通り、リストからゴミ箱に移る（取り消したカードが画面にたまらない）
    await app.byText('.checklist-list.kind-decisions .checklist-progress.pinned', '1 件').waitFor();
    await row(RULE).waitFor({ state: 'detached' });
    await openTrash();
    await trashed(RULE).waitFor();
    // 有効な決定の削除は断られ、カードは残る
    expect(app.api.toolResults.some((r) => r.includes('You can delete only revoked cards') && r.includes('card_revoke'))).toBe(true);
    expect(await row(JUDGMENT).count()).toBe(1);
    expect(await row(JUDGMENT).locator('.checklist-revoked').count()).toBe(0);
  });

  it('人は、Claude が取り消したものをゴミ箱から戻して有効に戻せて、自分でも理由つきで取り消せる（画面に残る）', async () => {
    await trashed(RULE).locator('.ghost-button').click();
    // 戻すと、取り消したままリストに出る
    await row(RULE).locator('.checklist-revoked').waitFor();
    await row(RULE).locator('.checklist-title').click();
    await app.byText('.card-pane .card-pane-revoked', REASON).waitFor();
    await app.byText('.card-pane .ghost-button', '有効に戻す').click();
    await app.byText('.card-pane .card-pane-state', '有効').waitFor();
    await app.byText('.checklist-list.kind-decisions .checklist-progress.pinned', '2 件').waitFor();
    await row(JUDGMENT).locator('.checklist-title').click();
    await app.byText('.card-pane .card-pane-where', `${DECISIONS} #2`).waitFor();
    await app.byText('.card-pane .diff-pane-head .ghost-button', '取り消す').click();
    await app.page.fill('.card-pane-revoke input', HUMAN_REASON);
    await app.page.keyboard.press('Enter');
    await app.byText('.card-pane .card-pane-revoked', HUMAN_REASON).waitFor();
    await row(JUDGMENT).locator('.checklist-revoked').waitFor();
    expect(await row(RULE).locator('.checklist-revoked').count()).toBe(0);
    expect(await decisionsHead().locator('.checklist-progress.pinned').textContent()).toBe('1 件');
  });

  it('取り消したものは、次の発言から有効な決定として渡らない。戻したものは渡る。人が取り消して残っているものは、Claude が消せる', async () => {
    await app.send(LAST);
    await app.byText('.chat-list', CHECKED).waitFor();
    const reminder = reminderFor(LAST);
    expect(reminder).toContain(`## ${DECISIONS} (decisions; 1 in force, 1 revoked and not shown)`);
    expect(reminder).toContain(`- #1 ${RULE}`);
    expect(reminder).not.toContain(JUDGMENT);
    // Claude が消すと、ゴミ箱に移る
    expect(app.api.toolResults.some((r) => r.includes(`Moved #2 in "${DECISIONS}" to the trash (the user can restore it in the app).`))).toBe(true);
    await row(JUDGMENT).waitFor({ state: 'detached' });
    await openTrash();
    await trashed(JUDGMENT).waitFor();
    expect(await decisionsHead().locator('.checklist-progress.pinned').textContent()).toBe('1 件');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
