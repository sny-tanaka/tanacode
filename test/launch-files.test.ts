import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchFiles } from '../src/main/launch-files';

// 起動する claude の --settings・--mcp-config に渡すファイル（中身を引数に載せない。名前に中身の hash を入れ、動いているものを書き換えない）

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-launch-files-'));
  dir = join(root, 'session-settings');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const names = () => readdirSync(dir).sort();

describe('LaunchFiles', () => {
  it('セッションごとに、名前に中身の hash を入れて、自分だけが読み書きできるファイルに書く。MCP が無ければ MCP のファイルは作らない', () => {
    const files = new LaunchFiles(dir);
    const written = files.write('s1', { statusLine: { type: 'command' } }, { mcpServers: { x: {} } });
    expect(dirname(written.settingsFile)).toBe(dir);
    expect(basename(written.settingsFile)).toMatch(/^s1\.[0-9a-f]{16}\.json$/);
    expect(basename(written.mcpConfigFile!)).toMatch(/^s1\.[0-9a-f]{16}\.mcp\.json$/);
    expect(JSON.parse(readFileSync(written.settingsFile, 'utf8'))).toEqual({ statusLine: { type: 'command' } });
    expect(JSON.parse(readFileSync(written.mcpConfigFile!, 'utf8'))).toEqual({ mcpServers: { x: {} } });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(written.settingsFile).mode & 0o777).toBe(0o600);
    expect(statSync(written.mcpConfigFile!).mode & 0o777).toBe(0o600);
    expect(files.write('s2', {}, null).mcpConfigFile).toBeNull();
    expect(names().filter((n) => n.startsWith('s2.'))).toHaveLength(1);
  });

  it('中身が変われば別のファイルに書き、前のファイル（動いている claude が使っているもの）は書き換えない。同じ中身なら、同じファイルを書かずに使う', () => {
    const files = new LaunchFiles(dir);
    const first = files.write('s1', { v: 1 }, null).settingsFile;
    // 書いた時刻を過去にして、書き直したら分かるようにする
    utimesSync(first, new Date(2000, 0, 1), new Date(2000, 0, 1));
    const writtenAt = statSync(first).mtimeMs;
    const second = files.write('s1', { v: 2 }, null).settingsFile;
    expect(second).not.toBe(first);
    expect(JSON.parse(readFileSync(first, 'utf8'))).toEqual({ v: 1 });
    expect(JSON.parse(readFileSync(second, 'utf8'))).toEqual({ v: 2 });
    expect(files.write('s1', { v: 1 }, null).settingsFile).toBe(first);
    expect(statSync(first).mtimeMs).toBe(writtenAt);
  });

  it('同じ名前のファイルの権限が緩められていたら、同じ中身で書き直して絞る', () => {
    const files = new LaunchFiles(dir);
    const { settingsFile } = files.write('s1', { v: 1 }, null);
    chmodSync(settingsFile, 0o644);
    files.write('s1', { v: 1 }, null);
    expect(statSync(settingsFile).mode & 0o777).toBe(0o600);
    expect(names().some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('release でそのセッションのものをすべて消す（ほかのセッションのものは残す）。無くても失敗しない', () => {
    const files = new LaunchFiles(dir);
    files.write('s1', { v: 1 }, { mcpServers: {} });
    files.write('s1', { v: 2 }, null);
    const other = files.write('s2', {}, null).settingsFile;
    files.release('s1');
    expect(names()).toEqual([basename(other)]);
    expect(() => files.release('s1')).not.toThrow();
    expect(() => new LaunchFiles(join(root, 'none')).release('s1')).not.toThrow();
  });

  it('sweep は、残すと決めたセッションのもの以外を消す（前のバージョンの名前と書きかけも。知らない名前のファイルは触らない）。フォルダが無くても失敗しない', () => {
    expect(() => new LaunchFiles(dir).sweep(() => false)).not.toThrow();
    const files = new LaunchFiles(dir);
    const live = files.write('live', {}, { mcpServers: {} });
    files.write('gone', {}, { mcpServers: {} });
    writeFileSync(join(dir, 'old.json'), '{}');
    writeFileSync(join(dir, 'gone.0123456789abcdef.json.42.tmp'), '{}');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    files.sweep((id) => id === 'live');
    // 同じセッションでも、使っていない名前のものは消す
    files.write('live', { old: true }, null);
    files.sweep((id, name) => id === 'live' && name !== names().find((n) => n.startsWith('live.') && !n.endsWith('.mcp.json') && n !== basename(live.settingsFile)));
    expect(names()).toEqual([basename(live.mcpConfigFile!), basename(live.settingsFile), 'notes.txt'].sort());
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });
});
