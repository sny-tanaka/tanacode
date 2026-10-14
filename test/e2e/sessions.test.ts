import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sessionToolId } from '@shared/session-tools';
import { NUMBERED_PROMPT } from '../scenarios/input';
import { E2EApp } from './app';

// Claude がセッションの MCP で子セッションを始める。始める前に許可の確認がカードで出て、答えると、
// 子はアプリのふつうのセッションとして一覧に並び（親の下）、最初の指示で動き出す。親は子の一覧を読める。
// 番号付きの手順が続く長い指示（NUMBERED_PROMPT）でも、子の入力欄に打った指示が、打ちかけのまま止まらずに送られる

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
    await app.choose(card, /^Yes/);
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

  it('番号付きの手順が続く長い指示でも、子は最初の指示で動き出す（入力欄の番号付きの行を、選択メニューと読み違えない）', async () => {
    // 子の入力欄は、長い指示を打っている途中でスクロールして、見えているいちばん上の行が「❯ 6. 手順 6…」の形になる。
    // 選択メニューと読むと、打つのも Enter もやめて、子は指示を受け取らないまま、番号付きの行を選択肢にしたカードを出す
    await app.startSession(NUMBERED_PARENT, { mode: 'manual' });
    await app.choose(await app.menuCard('permission'), /^Yes/);
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
    await app.choose(await app.menuCard('permission'), /^Yes/);
    await app.byText('.chat-list', ADOPTED_DONE).waitFor();
    expect(app.api.toolResults.find((r) => r.includes(ADOPTED_CHILD_NAME))).toMatch(/"permission_mode":\s*"acceptEdits"/);
    // 子の Claude Code の画面に出ているモードも、acceptEdits
    await app.byText('.session-list .session-row', ADOPTED_CHILD_NAME).click();
    await app.byText('.chat-list', ADOPTED_CHILD_REPLY).waitFor();
    await expect.poll(() => app.page.locator('.chat-options select[title^="権限モード"]').inputValue()).toBe('acceptEdits');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
