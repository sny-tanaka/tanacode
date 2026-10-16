import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { terminalToolId } from '@shared/terminal-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude が人のターミナル（エディタの下のターミナルパネル）を読み、人に頼まれて打つ（tanacode-terminal の MCP サーバー）。
// アプリが起動する Claude Code に足す中継から、アプリの terminal-control.ts を通って、人が開いたシェルまで。
// - 人が xterm で打ったコマンドの出力を、Claude が read_terminal で読める（確認なし）
// - auto のモードでも、Claude が打つ前に許可のカードが出て、打つ文字がそのまま出る。許すと xterm に出る

const START = 'ターミナルを使う準備をしてください';
const READY = '準備できました';
const READ = 'ターミナルの出力を読んでください';
const READ_DONE = '出力を読みました';
const TYPE = 'ターミナルでコマンドを打ってください';
const TYPE_DONE = 'コマンドを打ちました';
// 人が最初に開いたシェル（アプリのシェルの通し番号。台本は先に書くので、id を決め打ちにする）
const SHELL = 'shell-1';

const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name, input }];

describe('Claude が人のターミナルを読み、頼まれて打つ', () => {
  let app: E2EApp;
  const shell = () => app.page.locator('.terminal-panel .terminal-host:not([hidden]) .terminal-instance:not([hidden])');

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: START,
          steps: [
            [{ type: 'text', text: READY }],
            tool('toolu_read', terminalToolId('read_terminal'), { id: SHELL, lines: 20 }),
            [{ type: 'text', text: READ_DONE }],
            tool('toolu_type', terminalToolId('type_in_terminal'), { id: SHELL, text: 'echo claude-$((30+3))' }),
            [{ type: 'text', text: TYPE_DONE }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`terminal-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('人が xterm で打ったコマンドの出力を、Claude が確認なしに読める', async () => {
    await app.startSession(START, { mode: 'auto' });
    await app.byText('.chat-list', READY).waitFor();
    await app.page.click('.activity-bar [aria-label="ターミナル"]');
    await shell().locator('.xterm-rows').waitFor();
    await shell().locator('.xterm-helper-textarea').focus();
    // 打った行（$((20+1))）と出力（human-21）を見分ける
    await app.page.keyboard.type('echo human-$((20+1))');
    await app.page.keyboard.press('Enter');
    await shell().locator('.xterm-rows').getByText('human-21', { exact: false }).waitFor();
    await app.send(READ);
    await app.byText('.chat-list', READ_DONE).waitFor();
    expect(app.api.toolResults.find((r) => r.includes(`terminal ${SHELL}`))).toMatch(/\nhuman-21\n/);
    expect(await app.page.locator('.chat-list .menu-card.permission').count()).toBe(0);
  });

  it('auto のモードでも、打つ前に許可のカードが出て、打つ文字がそのまま出る。許すと xterm に出る', async () => {
    await app.send(TYPE);
    const card = await app.menuCard('permission');
    const text = await card.textContent();
    expect(text).toContain('tanacode-terminal — 打ち込む');
    // tanacode のフックが出させた確認の理由。打つ先のタブと、打つ文字がそのまま出る
    expect(text).toContain('権限モードによらず毎回確認を求めます。「zsh 1」に打つもの: echo claude-$((30+3)) ⏎');
    // まだ打っていない
    expect(await shell().locator('.xterm-rows').textContent()).not.toContain('claude-');
    await app.choose(card, /^許可する/);
    await app.byText('.chat-list', TYPE_DONE).waitFor();
    await shell().locator('.xterm-rows').getByText('claude-33', { exact: false }).waitFor();
    expect(app.api.toolResults.find((r) => r.startsWith('Typed '))).toContain('claude-33');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
