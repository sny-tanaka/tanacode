import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// Claude が SendUserFile で送った画像を、ファイル名でなく絵でチャットに出すこと。
// 画像は、画面がエディタと同じ読み方（workspace.readFile）で取りに行くので、本物のアプリで確かめる。
// SendUserFile は、ふだんは claude.ai でログインしたセッションでしか使えないので、CLAUDE_CODE_ATTACHMENTS_BY_PATH で使えるようにする

const PROMPT = '画像を送ってください';
// 1×1 の赤い PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

describe('Claude から届いた画像', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      env: { CLAUDE_CODE_ATTACHMENTS_BY_PATH: '1' },
      files: { 'report.md': '# 報告\n' },
      conversations: (work) => [
        {
          match: PROMPT,
          steps: [
            [{ type: 'tool_use', id: 'toolu_send', name: 'SendUserFile', input: { files: [join(work, 'shot.png'), join(work, 'report.md')], caption: '見本です', status: 'normal' } }],
            [{ type: 'text', text: '送りました' }],
          ],
        },
      ],
    });
    writeFileSync(join(app.work, 'shot.png'), PNG);
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`sent-files-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('画像は絵で、ほかのファイルは名前で出る', async () => {
    await app.startSession(PROMPT, { mode: 'auto' });
    await app.byText('.chat-list', '送りました').waitFor();
    const card = app.page.locator('.sent-files');
    await card.locator('.chat-image img').waitFor();
    expect(await card.locator('.chat-image img').getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    await app.byText('.sent-files .chat-image-with-footer .sent-file-name', 'shot.png').waitFor();
    await app.byText('.sent-files > .sent-file .sent-file-name', 'report.md').waitFor();
  });
});
