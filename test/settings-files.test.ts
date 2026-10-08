import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSettings } from '../src/main/app-settings';
import { claudeArgs } from '../src/main/claude-session';
import { defaultName, mergeSettings, SettingsFiles } from '../src/main/settings-files';
import type { SettingsFile } from '../src/shared/settings-file';

// 登録した設定ファイル。選んだセッションだけ、アプリの設定と合わせて Claude Code を起動する

let root: string;
let runDir: string;
let settingsPath: string;
let changes: SettingsFile[][];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-settings-files-'));
  runDir = join(root, 'userData', 'session-settings');
  settingsPath = join(root, 'userData', 'settings.json');
  changes = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (name: string, value: unknown) => {
  const path = join(root, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};

// アプリの設定の保存先を共有して作る（作り直すと、保存した登録が読み直される）
const make = () => new SettingsFiles(new AppSettings(settingsPath), runDir, (files) => changes.push(files));

describe('defaultName', () => {
  it('settings- と .json を外す。外すと空になるときはそのまま', () => {
    expect(defaultName('/x/settings-litellm.json')).toBe('litellm');
    expect(defaultName('/x/work.json')).toBe('work');
    expect(defaultName('/x/settings.json')).toBe('settings');
    expect(defaultName('/x/settings-.json')).toBe('settings-');
    // 名前が無ければ「設定ファイル」
    expect(defaultName('/x/.json')).toBe('設定ファイル');
    // 外すのは、末尾の .json と、先頭の settings- だけ
    expect(defaultName('/x/a.json.bak')).toBe('a.json.bak');
    expect(defaultName('/x/my-settings-a.json')).toBe('my-settings-a');
  });
});

describe('登録', () => {
  it('登録すると、名前とパスを覚えて、model も読む。作り直しても残る', () => {
    const path = file('.claude/settings-litellm.json', { model: 'sonnet', env: { ANTHROPIC_AUTH_TOKEN: 'sk-secret' } });
    const added = make().add(path);
    expect(added).toMatchObject({ name: 'litellm', path, error: null, model: 'sonnet' });
    expect(make().list()).toEqual([added]);
    // 覚えるのは名前とパスだけ。ファイルの中身（キー）は、アプリの設定に写さない
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('sk-secret');
    expect(changes).toHaveLength(1);
  });

  it('名前を決めて登録できる。同じ名前があれば番号を足す', () => {
    const files = make();
    const a = files.add(file('a.json', {}), '仕事');
    const b = files.add(file('b.json', {}), '仕事');
    const c = files.add(file('c.json', {}), '仕事');
    expect([a.name, b.name, c.name]).toEqual(['仕事', '仕事 2', '仕事 3']);
  });

  it('同じファイルは二重に登録できない', () => {
    const path = file('a.json', {});
    const files = make();
    files.add(path, 'one');
    expect(() => files.add(path, 'two')).toThrow('すでに「one」として登録されています');
  });

  it('読めないファイル・絶対パスでないものは登録できない（何も増えない）', () => {
    const files = make();
    expect(() => files.add(join(root, 'missing.json'))).toThrow('ファイルが見つかりません');
    expect(() => files.add(file('broken.json', '{ not json'))).toThrow('JSON として読めません');
    expect(() => files.add(file('array.json', '[]'))).toThrow('JSON のオブジェクトではありません');
    for (const value of ['"text"', '1', 'null']) expect(() => files.add(file(`v${value.length}.json`, value)), value).toThrow('JSON のオブジェクトではありません');
    expect(() => files.add('relative/settings.json')).toThrow('絶対パス');
    expect(files.list()).toEqual([]);
    expect(changes).toHaveLength(0);
  });

  it('名前の変更と削除。削除してもファイルは消えない', () => {
    const path = file('a.json', {});
    const files = make();
    const { id } = files.add(path, 'one');
    files.add(file('b.json', {}), 'two');
    files.rename(id, ' 仕事 ');
    expect(files.list().map((f) => f.name)).toEqual(['仕事', 'two']);
    expect(() => files.rename(id, '')).toThrow('名前を入力してください');
    expect(() => files.rename(id, 'two')).toThrow('すでにあります');
    expect(() => files.rename('nope', 'x')).toThrow('登録が見つかりません');
    files.remove(id);
    expect(files.list().map((f) => f.name)).toEqual(['two']);
    expect(statSync(path).isFile()).toBe(true);
    // 無い ID の削除は何もしない
    const notified = changes.length;
    expect(() => files.remove(id)).not.toThrow();
    expect(changes).toHaveLength(notified);
  });

  it('登録したあとでファイルが消えた・壊れたときは、一覧に理由を出す（登録は残す）', () => {
    const path = file('a.json', { model: 'haiku' });
    const files = make();
    files.add(path, 'one');
    rmSync(path);
    expect(files.list()[0]).toMatchObject({ name: 'one', error: 'ファイルが見つかりません', model: null });
    writeFileSync(path, '{ not json');
    expect(files.list()[0].error).toContain('JSON として読めません');
    writeFileSync(path, '{}');
    expect(files.list()[0].error).toBeNull();
  });
});

describe('mergeSettings', () => {
  const own = {
    statusLine: { type: 'command', command: 'cat > "$F"' },
    hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'ask' }] }] },
  };

  it('env・model などは登録した設定のまま、statusLine はアプリのものにする', () => {
    const merged = mergeSettings({ env: { A: '1' }, model: 'haiku', statusLine: { type: 'command', command: 'theirs' } }, own);
    expect(merged.env).toEqual({ A: '1' });
    expect(merged.model).toBe('haiku');
    expect(merged.statusLine).toEqual(own.statusLine);
  });

  it('フックは登録した設定のものとアプリのものを両方残す（同じイベントは登録した設定が先）', () => {
    const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: 'theirs' }] };
    const other = { matcher: '*', hooks: [{ type: 'command', command: 'stop' }] };
    const merged = mergeSettings({ hooks: { PreToolUse: [theirs], Stop: [other] } }, own);
    expect(merged.hooks).toEqual({ PreToolUse: [theirs, own.hooks.PreToolUse[0]], Stop: [other] });
  });

  it('登録した設定にフックが無くてもよい', () => {
    expect(mergeSettings({}, own).hooks).toEqual(own.hooks);
  });

  it('フックの形が違うもの（配列でない・オブジェクトでない）は、無いものとして合わせる', () => {
    const theirs = { PreToolUse: [{ matcher: 'Bash', hooks: [] }] };
    // アプリの設定にフックが無い
    expect(mergeSettings({ hooks: theirs }, { statusLine: own.statusLine }).hooks).toEqual(theirs);
    // アプリの設定のフックの中身が配列でない
    expect(mergeSettings({ hooks: theirs }, { hooks: { PreToolUse: 'x', Stop: null } }).hooks).toEqual({ PreToolUse: theirs.PreToolUse, Stop: [] });
    // 登録した設定のフックの中身が配列でない・フックが配列
    expect(mergeSettings({ hooks: { PreToolUse: 'x' } }, own).hooks).toEqual(own.hooks);
    expect(mergeSettings({ hooks: [theirs] }, own).hooks).toEqual(own.hooks);
  });
});

describe('起動の準備', () => {
  it('合わせた設定を自分だけが読めるファイルに書き、パスと model を返す', () => {
    const files = make();
    const { id } = files.add(file('a.json', { model: 'sonnet', env: { ANTHROPIC_AUTH_TOKEN: 'sk-secret' } }), 'one');
    const prepared = files.prepare('session-1', id);
    expect(prepared.model).toBe('sonnet');
    expect(prepared.settingsFile).toBe(join(runDir, 'session-1.json'));
    const written = JSON.parse(readFileSync(prepared.settingsFile, 'utf8'));
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret');
    expect(written.statusLine.command).toContain('TANACODE_STATUS_FILE');
    expect(written.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
    expect(statSync(prepared.settingsFile).mode & 0o777).toBe(0o600);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
  });

  it('登録した設定の statusLine は、アプリの statusLine が包んで動かす', () => {
    const files = make();
    const { id } = files.add(file('a.json', { statusLine: { type: 'command', command: 'my-line' } }));
    const written = JSON.parse(readFileSync(files.prepare('s', id).settingsFile, 'utf8'));
    expect(written.statusLine.command).toBe('tee "$TANACODE_STATUS_FILE" | my-line');
  });

  it('書き直しても、前のファイルの権限を緩めない', () => {
    const files = make();
    const { id } = files.add(file('a.json', {}));
    const first = files.prepare('s', id).settingsFile;
    writeFileSync(first, '{}', { mode: 0o644 });
    files.prepare('s', id);
    expect(statSync(first).mode & 0o777).toBe(0o600);
  });

  it('release でファイルを消す。無くても失敗しない', () => {
    const files = make();
    const { id } = files.add(file('a.json', {}));
    const { settingsFile } = files.prepare('s', id);
    files.release('s');
    expect(() => statSync(settingsFile)).toThrow();
    expect(() => files.release('s')).not.toThrow();
  });

  it('model が文字でない・空なら、model は無いものとする', () => {
    const files = make();
    expect(files.add(file('a.json', { model: 123 })).model).toBeNull();
    expect(files.add(file('b.json', { model: '' })).model).toBeNull();
    const { id } = files.add(file('c.json', { model: '' }));
    expect(files.prepare('s', id).model).toBeNull();
  });

  it('アプリ内ブラウザ・セッションの確認のフックは、使うときだけ足す', () => {
    const files = make();
    const { id } = files.add(file('a.json', {}));
    const matchers = (sessionId: string, ...flags: boolean[]) =>
      (JSON.parse(readFileSync(files.prepare(sessionId, id, ...flags).settingsFile, 'utf8')).hooks.PreToolUse as { matcher: string }[]).map((h) => h.matcher);
    expect(matchers('s1')).toEqual(['AskUserQuestion', 'Bash']);
    expect(matchers('s2', true, true)).toHaveLength(4);
  });

  it('読めない理由の文には、ホームの外のパスをそのまま書く', () => {
    const files = make();
    const path = file('a.json', {});
    const { id } = files.add(path, 'one');
    rmSync(path);
    expect(() => files.check(id)).toThrow(`設定ファイル「one」（${path}）を使えません: ファイルが見つかりません`);
  });

  it('登録が外された・ファイルが消えた・壊れたときは、起動を断る理由を添えて投げる', () => {
    const files = make();
    const path = file('a.json', {});
    const { id } = files.add(path, 'one');
    rmSync(path);
    expect(() => files.check(id)).toThrow('「one」');
    expect(() => files.prepare('s', id)).toThrow('ファイルが見つかりません');
    writeFileSync(path, '{ not json');
    expect(() => files.check(id)).toThrow('JSON として読めません');
    files.remove(id);
    expect(() => files.check(id)).toThrow('登録から外されています');
    expect(() => files.prepare('s', id)).toThrow('登録から外されています');
  });
});

describe('ホームのフォルダ', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('~/ から始まるパスはホームの下として登録する。読めない理由の文では、ホームを ~ と書く', () => {
    vi.stubEnv('HOME', root);
    const path = file('.claude/settings-work.json', { model: 'opus' });
    const files = make();
    const added = files.add('~/.claude/settings-work.json');
    expect(added).toMatchObject({ name: 'work', path, model: 'opus' });
    rmSync(path);
    expect(() => files.check(added.id)).toThrow('設定ファイル「work」（~/.claude/settings-work.json）を使えません: ファイルが見つかりません');
  });

  it('登録した設定に statusLine が無ければ、ユーザー自身の設定の statusLine を包む。コマンドでない statusLine なら、どちらも使わない', () => {
    vi.stubEnv('HOME', root);
    file('.claude/settings.json', { statusLine: { type: 'command', command: 'user-line' } });
    const files = make();
    const plain = files.add(file('a.json', {}));
    expect(JSON.parse(readFileSync(files.prepare('s1', plain.id).settingsFile, 'utf8')).statusLine.command).toBe('tee "$TANACODE_STATUS_FILE" | user-line');
    const fixed = files.add(file('b.json', { statusLine: { type: 'static', command: 'their-line' } }));
    expect(JSON.parse(readFileSync(files.prepare('s2', fixed.id).settingsFile, 'utf8')).statusLine.command).toBe('cat > "$TANACODE_STATUS_FILE"');
  });

  it('知らせる先を省いても、登録・名前の変更・削除ができる', () => {
    const files = new SettingsFiles(new AppSettings(settingsPath), runDir);
    const { id } = files.add(file('a.json', {}), 'one');
    files.rename(id, 'two');
    expect(files.list().map((f) => f.name)).toEqual(['two']);
    files.remove(id);
    expect(files.list()).toEqual([]);
  });
});

describe('claudeArgs と設定ファイル', () => {
  const base = { claudeSessionId: 'c1', resume: false, remoteControlName: null, model: null, effort: null, permissionMode: null };

  it('設定ファイルを選んでいなければ、今までどおり JSON を --settings に渡す', () => {
    const args = claudeArgs(base);
    expect(args[args.indexOf('--model') + 1]).toBe('default');
    expect(args[args.indexOf('--settings') + 1]).toMatch(/^\{.*"statusLine"/);
  });

  it('設定ファイルを選んでいれば、合わせたファイルのパスを 1 つだけ渡し、モデルは設定の model にする', () => {
    const args = claudeArgs({ ...base, settings: { settingsFile: '/run/s.json', model: 'sonnet' } });
    expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    expect(args[args.indexOf('--settings') + 1]).toBe('/run/s.json');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('モデルを選んでいれば、それが設定の model より優先される。設定に model が無ければ既定', () => {
    const picked = claudeArgs({ ...base, model: 'opus', settings: { settingsFile: '/run/s.json', model: 'sonnet' } });
    expect(picked[picked.indexOf('--model') + 1]).toBe('opus');
    const none = claudeArgs({ ...base, settings: { settingsFile: '/run/s.json', model: null } });
    expect(none[none.indexOf('--model') + 1]).toBe('default');
  });
});
