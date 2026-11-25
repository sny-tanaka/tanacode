import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appFile } from '../src/main/remote-app-files';

// ログインしたスマホに /app/ で配る画面のファイル（src/main/remote-app-files.ts）

const root = mkdtempSync(join(tmpdir(), 'tanacode-app-'));
mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'remote.html'), '<html>remote</html>');
writeFileSync(join(root, 'assets', 'remote-abc.js'), 'console.log(1)');
writeFileSync(join(root, 'notes.txt'), 'secret');
writeFileSync(join(root, 'index.html'), '<html>mac</html>');
writeFileSync(join(root, '..', 'tanacode-app-outside.js'), 'outside');
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(join(root, '..', 'tanacode-app-outside.js'), { force: true });
});

describe('appFile', () => {
  it('/app と /app/ は入口（remote.html）。キャッシュさせない', async () => {
    for (const path of ['/app', '/app/']) {
      const file = await appFile(root, path);
      expect(file).toMatchObject({ type: 'text/html; charset=utf-8', immutable: false });
      expect(file?.body.toString()).toBe('<html>remote</html>');
    }
  });

  it('assets/ のファイルは、名前に中身の印が付くので長くキャッシュさせる', async () => {
    expect(await appFile(root, '/app/assets/remote-abc.js')).toMatchObject({ type: 'text/javascript; charset=utf-8', immutable: true });
    // .. をたどったあとのパスで見る（assets を通って入口に戻っても、入口はキャッシュさせない）
    expect(await appFile(root, '/app/assets/../remote.html')).toMatchObject({ immutable: false });
    expect(await appFile(root, '/app/assets/../index.html')).toBeNull();
  });

  it('置き場所の外・決めていない拡張子・無いファイル・壊れた %・NUL は配らない', async () => {
    for (const path of ['/app/../tanacode-app-outside.js', '/app/%2e%2e/tanacode-app-outside.js', '/app/notes.txt', '/app/index.html', '/app/remote.html/../index.html', '/app/assets/none.js', '/app/%E0.js', '/app/a%00.js']) {
      expect(await appFile(root, path), path).toBeNull();
    }
  });
});
