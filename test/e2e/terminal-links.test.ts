import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// ターミナルパネルのリンク（出力の URL と、プログラムが付けた OSC 8 のハイパーリンク）。⌘ クリックはアプリ内ブラウザ（見ているセッションの
// ブラウザの新しいタブ）、⌘⇧ クリックはふだんのブラウザで開くか（決めたこと）。
// 直す前: ⌘ クリックはふだんのブラウザで開いた。OSC 8 のリンクは、xterm の既定の確かめ（confirm）のあと何も開かなかった。
// ふだんのブラウザを開かないよう、main の shell.openExternal を差し替えて、渡された URL を控える。
// リンクを見つけるのは、マウスを動かしたとき（xterm がそこにリンクがあるかを調べる）なので、乗せてから押す

// パスを題にしたページを返すサーバー。届いたパスはそのまま HTML に書かず、決めたページだけを返す（ほかは 404）
const PAGES = new Map([
  ['/plain', 'page/plain'],
  ['/osc', 'page/osc'],
]);
async function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const title = PAGES.get(req.url ?? '');
    if (!title) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('ターミナルのリンクを ⌘ クリックするとアプリ内ブラウザ、⌘⇧ クリックするとふだんのブラウザで開く', () => {
  let app: E2EApp;
  let server: Server;
  let base: string;
  const shell = () => app.page.locator('.terminal-panel .terminal-host:not([hidden]) .terminal-instance:not([hidden])');
  const rows = () => shell().locator('.xterm-rows');
  const browserTabs = () => app.page.locator('.preview-pane .preview-tab');
  const opened = () => app.app.evaluate(() => (globalThis as { e2eOpened?: string[] }).e2eOpened ?? []);

  // ターミナルの、text だけの出力の行（1 つだけ）の頭にマウスを乗せ、modifiers を押したまま押す
  async function clickText(text: string, modifiers: ('Meta' | 'Shift')[]): Promise<void> {
    const row = rows().locator('div', { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) });
    await row.waitFor();
    const box = (await row.boundingBox())!;
    // 行の頭から 1〜2 文字め（12px の等幅で、1 文字は 7px ほど）
    const x = box.x + 10;
    const y = box.y + box.height / 2;
    await app.page.mouse.move(x, y - 20);
    await app.page.mouse.move(x, y, { steps: 3 });
    for (const key of modifiers) await app.page.keyboard.down(key);
    await app.page.mouse.click(x, y);
    for (const key of [...modifiers].reverse()) await app.page.keyboard.up(key);
  }

  beforeAll(async () => {
    ({ server, url: base } = await serve());
    app = await E2EApp.launch({ trusted: true });
    const stubbed = await app.app.evaluate(({ shell: electronShell }) => {
      const list: string[] = [];
      (globalThis as { e2eOpened?: string[] }).e2eOpened = list;
      electronShell.openExternal = async (url: string) => void list.push(url);
      return electronShell.openExternal.toString().includes('list.push');
    });
    expect(stubbed).toBe(true);
    // 新規セッションの画面で、作業フォルダを選ぶ（ブラウザとターミナルは、そのフォルダのものとして開く）
    const page = app.page;
    await page.click('nav.sidebar .new-session-button');
    const chosen = page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${app.work}"]`);
    const other = app.byText('.folder-menu-item', '別のフォルダを選ぶ…');
    await page.click('.new-session-chips .folder-picker > button.new-session-chip');
    await chosen.or(other).first().waitFor();
    if (await other.isVisible()) await other.click();
    await chosen.waitFor();
    await page.click('.activity-bar [aria-label="ターミナル"]');
    await rows().waitFor();
    await shell().locator('.xterm-helper-textarea').focus();
    // シェルが打つものを待つところまで待つ（起動の前に打つと、打った文字の映りが画面に残る）。ready-2 は、シェルが計算した出力にだけ出る
    await page.keyboard.type('echo ready-$((1+1))');
    await page.keyboard.press('Enter');
    await rows().locator('div', { hasText: /^ready-2\s*$/ }).waitFor();
    // URL と、OSC 8 のハイパーリンク（見える文字は URL と違う）を出す。打ったコマンドの行に、出力と同じ文字が入らないようにする
    // （"" で切る。入ると、出力より先に打った行で待ち終わり、出力の行が出る前に押してしまう）
    await page.keyboard.type(`echo "${base}/pl""ain"; printf '\\033]8;;%s\\033\\\\%s\\033]8;;\\033\\\\\\n' "${base}/o""sc" "osc-link-""text"`);
    await page.keyboard.press('Enter');
    await rows().getByText('osc-link-text').waitFor();
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`terminal-links-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  });

  it('URL を ⌘ クリックすると、アプリ内ブラウザの新しいタブで開き、ブラウザを出す。ふだんのブラウザでは開かない', async () => {
    await clickText(`${base}/plain`, ['Meta']);
    await app.byText('.preview-pane .preview-tab', 'page/plain').waitFor();
    expect(await app.page.locator('.preview-pane').isVisible()).toBe(true);
    expect(await app.page.locator('.activity-bar [aria-label="ブラウザ"]').getAttribute('aria-pressed')).toBe('true');
    expect(await opened()).toEqual([]);
  });

  it('URL を ⌘⇧ クリックすると、ふだんのブラウザで開く（アプリ内ブラウザにはタブを足さない）', async () => {
    const before = await browserTabs().count();
    await clickText(`${base}/plain`, ['Meta', 'Shift']);
    await expect.poll(opened).toEqual([`${base}/plain`]);
    expect(await browserTabs().count()).toBe(before);
  });

  it('⌘ を押さずに押しても、どちらでも開かない', async () => {
    const before = await browserTabs().count();
    await clickText(`${base}/plain`, []);
    await app.rendered();
    expect(await browserTabs().count()).toBe(before);
    expect(await opened()).toEqual([`${base}/plain`]);
  });

  it('OSC 8 のハイパーリンクも、⌘ クリックでアプリ内ブラウザ、⌘⇧ クリックでふだんのブラウザで開く', async () => {
    await clickText('osc-link-text', ['Meta']);
    await app.byText('.preview-pane .preview-tab', 'page/osc').waitFor();
    await clickText('osc-link-text', ['Meta', 'Shift']);
    await expect.poll(opened).toEqual([`${base}/plain`, `${base}/osc`]);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
