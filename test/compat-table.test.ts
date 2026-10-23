import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCompatTable } from '@shared/claude-compat';

// 毎日の互換性の確認が、動作確認済のバージョンを上げるときの、対応表（compat.json）の書き換え（scripts/compat-table.mjs）
describe('scripts/compat-table.mjs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-compat-table-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const SCRIPT = join(__dirname, '..', 'scripts', 'compat-table.mjs');
  const setup = (app: string, rows: { app: string; claudeCode: string }[]) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: app }));
    writeFileSync(join(dir, 'compat.json'), JSON.stringify({ rows }));
  };
  // その版の控えの行の目録（中身は、比べて同じか違うかが分かればよい）
  const inventory = (version: string, kinds: string[]) => {
    const d = join(dir, 'test', 'fixtures', 'claude-code', version);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'inventory.json'), JSON.stringify({ transcript: Object.fromEntries(kinds.map((k) => [k, ['type']])), stream: {} }));
  };
  const update = (version: string) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { updateCompatTable } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; updateCompatTable(${JSON.stringify(version)});`], { cwd: dir, stdio: 'pipe' });
  const table = () => readFileSync(join(dir, 'compat.json'), 'utf8');
  const rows = () => (JSON.parse(table()) as { rows: unknown[] }).rows;
  const current = () => execFileSync(process.execPath, [SCRIPT, 'current'], { cwd: dir, encoding: 'utf8' }).trim();

  it('目録に差が無ければ、いまのアプリの行を上げる（リリースしなくても、公開済みのアプリの印が変わる）', () => {
    setup('2.2.3', [{ app: '>=2.2.0', claudeCode: '2.1.305' }]);
    inventory('2.1.305', ['user']);
    inventory('2.1.306', ['user']);
    update('2.1.306');
    expect(rows()).toEqual([{ app: '>=2.2.0', claudeCode: '2.1.306' }]);
    expect(current()).toBe('2.1.306');
    // 1 行に 1 つの範囲で書き、アプリが読める形のまま
    expect(table()).toBe('{\n  "rows": [\n    { "app": ">=2.2.0", "claudeCode": "2.1.306" }\n  ]\n}\n');
    expect(parseCompatTable(JSON.parse(table()))).not.toBeNull();
  });

  it('目録に差があれば、いまのアプリの行は据え置き、次にリリースするバージョンから上げる。そのあと差の無いバージョンは、次の行だけを上げる', () => {
    setup('2.2.3', [
      { app: '>=2.1.0 <2.2.0', claudeCode: '2.1.290' },
      { app: '>=2.2.0', claudeCode: '2.1.305' },
    ]);
    inventory('2.1.305', ['user']);
    inventory('2.1.306', ['user', 'system/new']);
    inventory('2.1.307', ['user', 'system/new']);
    update('2.1.306');
    expect(rows()).toEqual([
      { app: '>=2.1.0 <2.2.0', claudeCode: '2.1.290' },
      { app: '>=2.2.0 <2.2.4', claudeCode: '2.1.305' },
      { app: '>=2.2.4', claudeCode: '2.1.306' },
    ]);
    expect(current()).toBe('2.1.305');
    // 公開済みの 2.2.3 は 2.1.305 と比べるので、差があるまま
    update('2.1.307');
    expect(rows()).toEqual([
      { app: '>=2.1.0 <2.2.0', claudeCode: '2.1.290' },
      { app: '>=2.2.0 <2.2.4', claudeCode: '2.1.305' },
      { app: '>=2.2.4', claudeCode: '2.1.307' },
    ]);
    expect(parseCompatTable(JSON.parse(table()))).not.toBeNull();
  });

  it('リリースしたあと（次の行がいまのアプリの行になった）は、その行を差が無ければ上げる', () => {
    setup('2.3.0', [
      { app: '>=2.2.0 <2.2.4', claudeCode: '2.1.305' },
      { app: '>=2.2.4', claudeCode: '2.1.306' },
    ]);
    inventory('2.1.305', ['user']);
    inventory('2.1.306', ['user', 'system/new']);
    inventory('2.1.307', ['user', 'system/new']);
    update('2.1.307');
    expect(rows()).toEqual([
      { app: '>=2.2.0 <2.2.4', claudeCode: '2.1.305' },
      { app: '>=2.2.4', claudeCode: '2.1.307' },
    ]);
  });

  it('前の目録が無ければ、差があるとみなす', () => {
    setup('2.2.3', [{ app: '>=2.2.0', claudeCode: '2.1.305' }]);
    inventory('2.1.306', ['user']);
    update('2.1.306');
    expect(rows()).toEqual([
      { app: '>=2.2.0 <2.2.4', claudeCode: '2.1.305' },
      { app: '>=2.2.4', claudeCode: '2.1.306' },
    ]);
  });

  it('次にリリースするバージョンの行が無ければ、失敗にする', () => {
    setup('2.2.3', [{ app: '>=2.2.0 <2.2.4', claudeCode: '2.1.305' }]);
    inventory('2.1.306', ['user']);
    expect(() => update('2.1.306')).toThrow();
  });
});
