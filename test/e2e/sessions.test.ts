import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sessionToolId } from '@shared/session-tools';
import type { Step } from '../cli/mock-api';
import { NUMBERED_PROMPT } from '../scenarios/input';
import { E2EApp } from './app';

// Claude がセッションの MCP で子セッションを始める。始める前に許可の確認がカードで出て、答えると、
// 子はアプリのふつうのセッションとして一覧に並び（親の下）、最初の指示で動き出す。親は子の一覧を読める。
// 番号付きの手順が続く長い指示（NUMBERED_PROMPT）でも、子に全文が届き、子は動き出す

const PARENT = '子セッションに任せてください';
const CHILD = '子の作業として、返事だけしてください';
const CHILD_NAME = '子の作業';
const CHILD_REPLY = '子の返事です';
const PARENT_DONE = '子を始めました';
// 台本は、はじめの発言に含まれる文字で選ばれる。PARENT の文字を含めない
const NUMBERED_PARENT = '手順を並べた指示を、別のセッションに渡してください';
const NUMBERED_NAME = '手順のある作業';
const NUMBERED_REPLY = '手順を受け取った子の返事です';
const NUMBERED_DONE = '手順のある子を始めました';

describe('Claude がセッションの MCP で子セッションを始める', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: PARENT,
          steps: [
            [{ type: 'tool_use', id: 'toolu_start', name: sessionToolId('start_session'), input: { prompt: CHILD, worktree: false, name: CHILD_NAME } }],
            [{ type: 'tool_use', id: 'toolu_list', name: sessionToolId('list_sessions'), input: {} }],
            [{ type: 'text', text: PARENT_DONE }],
          ],
        },
        { match: CHILD, steps: [[{ type: 'text', text: CHILD_REPLY }]] },
        {
          match: NUMBERED_PARENT,
          steps: [
            [{ type: 'tool_use', id: 'toolu_numbered', name: sessionToolId('start_session'), input: { prompt: NUMBERED_PROMPT, worktree: false, name: NUMBERED_NAME } }],
            [{ type: 'text', text: NUMBERED_DONE }],
          ],
        },
        { match: NUMBERED_PROMPT.split('\n')[0], steps: [[{ type: 'text', text: NUMBERED_REPLY }]] },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`sessions-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('子セッションを始める前に、許可の確認がカードで出る', async () => {
    await app.startSession(PARENT, { mode: 'manual' });
    const card = await app.menuCard('permission');
    expect(await card.textContent()).toContain(CHILD);
    await app.choose(card, /^許可する/);
  });

  it('子は一覧に並び、親は子の一覧を読める', async () => {
    await app.byText('.chat-list', PARENT_DONE).waitFor();
    await app.byText('.session-list .session-row', CHILD_NAME).waitFor();
    expect(app.api.toolResults.some((r) => r.includes(CHILD_NAME))).toBe(true);
  });

  it('子を開くと、最初の指示で動いた返事が出ている', async () => {
    await app.byText('.session-list .session-row', CHILD_NAME).click();
    await app.byText('.claude-header .claude-title', CHILD_NAME).waitFor();
    await app.byText('.chat-list', CHILD).waitFor();
    await app.byText('.chat-list', CHILD_REPLY).waitFor();
  });

  it('番号付きの手順が続く長い指示でも、子は最初の指示で動き出す。カードは出ない', async () => {
    await app.startSession(NUMBERED_PARENT, { mode: 'manual' });
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', NUMBERED_DONE).waitFor();
    await app.byText('.session-list .session-row', NUMBERED_NAME).click();
    await app.byText('.claude-header .claude-title', NUMBERED_NAME).waitFor();
    await app.byText('.chat-list', NUMBERED_REPLY).waitFor();
    expect(await app.page.locator('.chat-list .menu-card').count()).toBe(0);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});

// アプリを起動し直すと、動き続けている親の Claude Code を引き継ぐ。親のモードは変わっていないので、そのあとに始める子も、
// 親のモードで始まる（引き継ぎで、アプリが決めたモードを忘れると、親が manual 扱いになり、子が manual に絞られる）
const ADOPTED_PARENT = '起動し直したあとも任せます';
const ADOPTED_FIRST = '起動し直す前の返事です';
const ADOPTED_ASK = '起動し直したあとに、別のセッションを始めてください';
const ADOPTED_CHILD = '引き継いだ親からの作業として、返事だけしてください';
const ADOPTED_CHILD_NAME = '引き継いだ親の子';
const ADOPTED_CHILD_REPLY = '引き継いだ親の子の返事です';
const ADOPTED_DONE = '引き継いだあとに子を始めました';

describe('アプリを起動し直したあとに始めた子も、親の権限モードで始まる', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: ADOPTED_PARENT,
          steps: [
            [{ type: 'text', text: ADOPTED_FIRST }],
            [{ type: 'tool_use', id: 'toolu_adopted', name: sessionToolId('start_session'), input: { prompt: ADOPTED_CHILD, worktree: false, name: ADOPTED_CHILD_NAME } }],
            [{ type: 'text', text: ADOPTED_DONE }],
          ],
        },
        { match: ADOPTED_CHILD, steps: [[{ type: 'text', text: ADOPTED_CHILD_REPLY }]] },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`sessions-adopted-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('acceptEdits で始めた親を、アプリを起動し直して引き継ぐ', async () => {
    await app.startSession(ADOPTED_PARENT, { mode: 'acceptEdits' });
    await app.byText('.chat-list', ADOPTED_FIRST).waitFor();
    await app.restart();
    await app.byText('.session-list .session-row', ADOPTED_PARENT).click();
    await app.byText('.chat-list', ADOPTED_FIRST).waitFor();
  });

  it('引き継いだ親が、モードを省いて始めた子は、親と同じ acceptEdits で動く', async () => {
    await app.send(ADOPTED_ASK);
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', ADOPTED_DONE).waitFor();
    expect(app.api.toolResults.find((r) => r.includes(ADOPTED_CHILD_NAME))).toMatch(/"permission_mode":\s*"acceptEdits"/);
    // 子のヘッダーのモードも、acceptEdits
    await app.byText('.session-list .session-row', ADOPTED_CHILD_NAME).click();
    await app.byText('.chat-list', ADOPTED_CHILD_REPLY).waitFor();
    await expect.poll(() => app.page.locator('.chat-options select[title^="権限モード"]').inputValue()).toBe('acceptEdits');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});

// 親が、始めたあとの子の権限モードとエフォートを変える（configure_session）。どちらも、動いている子の Claude Code を
// その場で切り替える（set_permission_mode・apply_flag_settings。起動し直さない）
const CONFIG_PARENT = '子の設定をあとから変えます';
const CONFIG_CHILD = 'あとで設定を変える子の作業として、返事だけしてください';
const CONFIG_CHILD_NAME = '設定を変える子';
const CONFIG_CHILD_REPLY = '設定を変える前の子の返事です';
const CONFIG_STARTED = '設定を変える子を始めました';
const CONFIG_ASK = '子を acceptEdits にして、エフォートを low にしてください';
const CONFIG_DONE = '子の設定を変えました';

describe('親が、始めたあとの子の権限モードとエフォートを変える', () => {
  let app: E2EApp;
  // 親の台本。子の ID は始めてから分かるので、設定を変える手順は、あとで足す
  const parentSteps: Step[] = [
    [
      {
        type: 'tool_use',
        id: 'toolu_config_start',
        name: sessionToolId('start_session'),
        input: { prompt: CONFIG_CHILD, worktree: false, name: CONFIG_CHILD_NAME, permission_mode: 'manual' },
      },
    ],
    [{ type: 'text', text: CONFIG_STARTED }],
  ];
  const modeSelect = () => app.page.locator('.chat-options select[title^="権限モード"]');
  const effortSelect = () => app.page.locator('.chat-options select[title^="エフォート"]');

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        { match: CONFIG_PARENT, steps: parentSteps },
        { match: CONFIG_CHILD, steps: [[{ type: 'text', text: CONFIG_CHILD_REPLY }]] },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`sessions-configure-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('acceptEdits の親が、manual の子を始める', async () => {
    await app.startSession(CONFIG_PARENT, { mode: 'acceptEdits' });
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', CONFIG_STARTED).waitFor();
    await app.byText('.session-list .session-row', CONFIG_CHILD_NAME).click();
    await app.byText('.chat-list', CONFIG_CHILD_REPLY).waitFor();
    await expect.poll(() => modeSelect().inputValue()).toBe('manual');
  });

  it('親が configure_session で子を acceptEdits・エフォート low にすると、確認なしに、子の Claude Code を起動し直さずに変わる', async () => {
    const started = app.api.toolResults.find((r) => r.includes(CONFIG_CHILD_NAME));
    const childId = (JSON.parse(started ?? '{}') as { session_id?: string }).session_id;
    expect(childId).toBeTruthy();
    parentSteps.push(
      [{ type: 'tool_use', id: 'toolu_configure', name: sessionToolId('configure_session'), input: { session_id: childId, permission_mode: 'acceptEdits', effort: 'low' } }],
      [{ type: 'text', text: CONFIG_DONE }],
    );
    await app.byText('.session-list .session-row', CONFIG_PARENT).click();
    const running = await app.claudeArgs();
    await app.send(CONFIG_ASK);
    await app.byText('.chat-list', CONFIG_DONE).waitFor();
    const result = app.api.toolResults.find((r) => r.includes('"changed"'));
    expect(result).toMatch(/"permission_mode":\s*"acceptEdits"/);
    expect(result).toMatch(/"effort":\s*"low"/);
    // 許可の確認は出ない（親に許している範囲の中の変更）
    expect(await app.page.locator('.chat-list .menu-card').count()).toBe(0);
    // 子のヘッダーも、変えたエフォートとモードになる
    await app.byText('.session-list .session-row', CONFIG_CHILD_NAME).click();
    await app.byText('.chat-list', CONFIG_CHILD_REPLY).waitFor();
    await expect.poll(() => effortSelect().inputValue()).toBe('low');
    await expect.poll(() => modeSelect().inputValue(), { timeout: 30_000 }).toBe('acceptEdits');
    // 子の Claude Code は起動し直していない（動いている claude は、変える前と同じ引数のまま）
    expect((await app.claudeArgs()).sort()).toEqual([...running].sort());
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});

// 止まっている親を一覧から開くと、新しいセッションと同じ決まりのモード（設定の defaultMode、無ければ auto。前回のモードは引き継がない）を
// --permission-mode に付けて --resume で起動する。そのあとに始める子も、開き直した親のモードで始まる
const REOPENED_PARENT = '開き直したあとも任せます';
const REOPENED_FIRST = '開き直す前の返事です';
const REOPENED_ASK = '開き直したあとに、別のセッションを始めてください';
const REOPENED_CHILD = '開き直した親からの作業として、返事だけしてください';
const REOPENED_CHILD_NAME = '開き直した親の子';
const REOPENED_CHILD_REPLY = '開き直した親の子の返事です';
const REOPENED_DONE = '開き直したあとに子を始めました';

describe('止まっていた親を開き直したあとに始めた子も、親の権限モードで始まる', () => {
  let app: E2EApp;
  const parentRow = () => app.page.locator('.session-list .session-row:not(.archived)', { hasText: REOPENED_PARENT });

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: REOPENED_PARENT,
          steps: [
            [{ type: 'text', text: REOPENED_FIRST }],
            [{ type: 'tool_use', id: 'toolu_reopened', name: sessionToolId('start_session'), input: { prompt: REOPENED_CHILD, worktree: false, name: REOPENED_CHILD_NAME } }],
            [{ type: 'text', text: REOPENED_DONE }],
          ],
        },
        { match: REOPENED_CHILD, steps: [[{ type: 'text', text: REOPENED_CHILD_REPLY }]] },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`sessions-reopened-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('acceptEdits で始めた親をアーカイブで止め、一覧から戻して開くと、新しいセッションと同じく auto で始まる', async () => {
    await app.startSession(REOPENED_PARENT, { mode: 'acceptEdits' });
    await app.byText('.chat-list', REOPENED_FIRST).waitFor();
    await parentRow().hover();
    await parentRow().locator('[aria-label="アーカイブ"]').click();
    await app.byText('.session-list .pane-heading', 'アーカイブ済み（1）').click();
    const archived = app.page.locator('.session-list .session-row.archived', { hasText: REOPENED_PARENT });
    await archived.hover();
    await archived.locator('[aria-label="アクティブに戻す"]').click();
    await parentRow().click();
    await app.byText('.chat-list', REOPENED_FIRST).waitFor();
    // 開き直した Claude Code には、前回のモード（acceptEdits）ではなく、新しいセッションと同じモードを渡す
    await expect.poll(async () => (await app.claudeArgs()).join('\n')).toContain('--resume');
    expect((await app.claudeArgs()).join(' ')).toContain('--permission-mode auto');
    await expect.poll(() => app.page.locator('.chat-options select[title^="権限モード"]').inputValue()).toBe('auto');
  });

  it('開き直した親が、モードを省いて始めた子は、親と同じ auto で動く', async () => {
    await app.send(REOPENED_ASK);
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', REOPENED_DONE).waitFor();
    expect(app.api.toolResults.find((r) => r.includes(REOPENED_CHILD_NAME))).toMatch(/"permission_mode":\s*"auto"/);
    // 子のヘッダーのモードも、auto
    await app.byText('.session-list .session-row', REOPENED_CHILD_NAME).click();
    await app.byText('.chat-list', REOPENED_CHILD_REPLY).waitFor();
    await expect.poll(() => app.page.locator('.chat-options select[title^="権限モード"]').inputValue()).toBe('auto');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
