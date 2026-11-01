import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// エクスプローラーの「Claude の設定ファイル」の欄と、エディタへのドラッグ＆ドロップ。
// セッションの Claude Code が読む設定ファイルのうち、あるものだけが強い順に並ぶか・押すとエディタで開くか・
// 作ったファイルが窓に戻ると並ぶか。エクスプローラーのファイルの行をエディタに落とすと開くか

const PROMPT = '設定を見てください';

describe('Claude の設定ファイルをエクスプローラーに出し、ドロップでエディタに開く', () => {
  let app: E2EApp;
  const row = (path: string) => app.page.locator(`.tree-row[title="${path}"]`);

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      ownTmp: true,
      files: { 'README.md': '# shop\n', 'src/tax.ts': 'export const rate = 0.1;\n', '.claude/settings.json': '{ "env": {} }\n' },
      claudeSettings: { permissions: { allow: ['Read'] } },
      conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: 'わかりました' }]] }],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`claude-settings-files-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('あるものだけを強い順に並べ、押すとエディタで開く。作ったファイルは、窓に戻ると並ぶ', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', 'わかりました').waitFor();
    await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
    await app.byText('.tree-section', 'Claude の設定ファイル').waitFor();
    const project = join(app.work, '.claude', 'settings.json');
    const user = join(app.home, '.claude', 'settings.json');
    const local = join(app.work, '.claude', 'settings.local.json');
    await row(user).waitFor();
    const listed = () => app.page.locator('.tree-section.divided ~ .tree-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('title')));
    expect(await listed()).toEqual([project, user]);
    // ユーザーの設定（作業フォルダの外）は絶対パスで開く
    await row(user).click();
    await app.byText('.editor-tab.active', 'settings.json').waitFor();
    await app.page.locator('.editor-monaco', { hasText: 'permissions' }).waitFor();
    // まだ無かった settings.local.json を作ると、並ぶ（.claude の中の変更の知らせか、窓に戻ったとき）
    mkdirSync(join(app.work, '.claude'), { recursive: true });
    writeFileSync(local, '{}\n');
    await app.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await row(local).waitFor();
    expect(await listed()).toEqual([local, project, user]);
  });

  it('エクスプローラーのファイルの行をエディタに落とすと、そのファイルを開く', async () => {
    await app.page.click('.tree-row[title="src"]');
    await app.page.dragAndDrop('.tree-row[title="src/tax.ts"]', 'section.editor');
    await app.byText('.editor-tab.active', 'tax.ts').waitFor();
    await app.page.locator('.editor-monaco', { hasText: 'rate' }).waitFor();
    // 文字としては入らない（開いていたファイルは書き換わらない）
    expect(await app.page.locator('.editor-tab-dot.dirty').count()).toBe(0);
  });
});
