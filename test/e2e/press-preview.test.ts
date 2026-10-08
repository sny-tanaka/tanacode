import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// 右の縦のバー（アクティビティバー）の、ブラウザとターミナルのボタン。新規セッションの画面でフォルダを選んだところで押して、
// 中央にアプリ内ブラウザ、下にターミナル（シェル）が開き、もう一度押すと閉じるか。
// 開いたブラウザ・シェルは本物（Electron の webview・pty）で動かす（jsdom の画面のテストでは確かめられない、本物の動き）:
// - ブラウザ: アドレス欄で開いたページの題がタブに出る。戻る・進むで履歴を移れる。読み込めなかったページは「もう一度」で読み込み直せる
// - ターミナル: シェルでコマンドが動く。閉じて開き直しても同じシェルが残っている

// title の題のページを返すサーバーを立てる（port を決めれば、その port で）
async function serve(title: string, port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

const stop = (server: Server | undefined) => new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));

describe('アクティビティバーのブラウザとターミナルのボタン', () => {
  let app: E2EApp;
  const servers: Server[] = [];
  const pressed = (label: string) => app.page.locator(`.activity-bar [aria-label="${label}"]`).getAttribute('aria-pressed');
  const tab = (title: string) => app.byText('.preview-pane .preview-tab', title);
  // title のページの読み込みが終わるまで待つ。題はページの読み込みの途中で出るので、題が出ただけで次のページへ移ると、
  // 前の読み込みが中断され、Electron の webview が画面のコンソールに中断（-3）の記録を出す
  const loaded = async (title: string) => {
    await tab(title).waitFor();
    await app.page.locator('.preview-pane .preview-toolbar [aria-label="読み込み直す"]').waitFor();
  };
  const address = '.preview-pane .preview-address input';
  const open = async (url: string) => {
    await app.page.fill(address, url);
    await app.page.press(address, 'Enter');
  };

  beforeAll(async () => {
    app = await E2EApp.launch({ trusted: true });
    // 新規セッションの画面で、作業フォルダを選ぶ（ブラウザとターミナルは、そのフォルダのものとして開く）
    const page = app.page;
    await page.click('nav.sidebar .new-session-button');
    const chosen = page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${app.work}"]`);
    const other = app.byText('.folder-menu-item', '別のフォルダを選ぶ…');
    await page.click('.new-session-chips .folder-picker > button.new-session-chip');
    await chosen.or(other).first().waitFor();
    if (await other.isVisible()) await other.click();
    await chosen.waitFor();
    await page.locator('.activity-bar [aria-label="ブラウザ"]').waitFor();
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`press-preview-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    for (const server of servers) await stop(server);
  });

  it('ブラウザのボタンで中央にブラウザを開き、開いたページを戻る・進むで移れる。もう一度押すと閉じ、開き直すとタブが残っている', async () => {
    const one = await serve('ページ 1');
    const two = await serve('ページ 2');
    servers.push(one.server, two.server);
    const pane = app.page.locator('.preview-pane');
    expect(await pressed('ブラウザ')).toBe('false');
    await app.page.click('.activity-bar [aria-label="ブラウザ"]');
    await pane.waitFor({ state: 'visible' });
    expect(await pressed('ブラウザ')).toBe('true');

    await open(one.url);
    await loaded('ページ 1');
    await open(two.url);
    await loaded('ページ 2');
    await app.page.click('.preview-pane [aria-label="戻る"]');
    await loaded('ページ 1');
    expect(await app.page.inputValue(address)).toBe(one.url);
    await app.page.click('.preview-pane [aria-label="進む"]');
    await loaded('ページ 2');

    await app.page.click('.activity-bar [aria-label="ブラウザ"]');
    await pane.waitFor({ state: 'hidden' });
    expect(await pressed('ブラウザ')).toBe('false');
    await app.page.click('.activity-bar [aria-label="ブラウザ"]');
    await pane.waitFor({ state: 'visible' });
    await tab('ページ 2').waitFor();
    expect(await app.page.locator('.preview-pane .preview-tab').count()).toBe(1);
  });

  it('読み込めなかったページ（サーバーが止まっている）は、サーバーを起こしてから「もう一度」で読み込み直せる', async () => {
    // 空いている port を決めて、まだ何も待ち受けない
    const probe = await serve('');
    const port = Number(new URL(probe.url).port);
    await stop(probe.server);
    await open(probe.url);
    await app.byText('.preview-pane .preview-hint.error', '読み込めませんでした').waitFor();

    const late = await serve('起きたサーバー', port);
    servers.push(late.server);
    await app.page.click('.preview-pane .preview-hint.error [aria-label="もう一度"]');
    await tab('起きたサーバー').waitFor();
    await app.page.locator('.preview-pane .preview-hint.error').waitFor({ state: 'detached' });
  });

  it('ターミナルのボタンで下にシェルを開いてコマンドを動かせる。もう一度押すと閉じ、開き直すと同じシェルが残っている', async () => {
    const panel = app.page.locator('.terminal-panel');
    const shell = app.page.locator('.terminal-panel .terminal-host:not([hidden]) .terminal-instance:not([hidden])');
    expect(await pressed('ターミナル')).toBe('false');
    await app.page.click('.activity-bar [aria-label="ターミナル"]');
    await panel.waitFor({ state: 'visible' });
    expect(await pressed('ターミナル')).toBe('true');
    // 新規セッションの画面には Claude Code の画面が無いので、そのタブは出さない
    expect(await app.page.locator('.terminal-panel [aria-label="Claude Code の画面"]').count()).toBe(0);
    await shell.locator('.xterm-rows').waitFor();
    await shell.locator('.xterm-helper-textarea').focus();
    await app.page.keyboard.type('echo press-$((40+2))');
    await app.page.keyboard.press('Enter');
    await shell.locator('.xterm-rows').getByText('press-42', { exact: false }).waitFor();

    await app.page.click('.activity-bar [aria-label="ターミナル"]');
    await panel.waitFor({ state: 'hidden' });
    expect(await pressed('ターミナル')).toBe('false');
    await app.page.click('.activity-bar [aria-label="ターミナル"]');
    await panel.waitFor({ state: 'visible' });
    await shell.locator('.xterm-rows').getByText('press-42', { exact: false }).waitFor();
    expect(await app.page.locator('.terminal-panel .terminal-tab:not(.claude-screen-tab)').count()).toBe(1);
  });

  it('画面のコンソールにエラーが出ていない（わざと読み込めなくしたページの、Electron の webview が出す記録を除く）', () => {
    const expected = /^Unexpected error while loading URL .*ERR_CONNECTION_REFUSED/;
    expect(app.consoleErrors.filter((message) => !expected.test(message))).toEqual([]);
  });
});
