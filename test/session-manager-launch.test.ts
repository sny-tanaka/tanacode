import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreparedSettings, SettingsFiles } from '../src/main/settings-files';
import { line, ScriptedApp, type ScriptedOptions } from './helpers/scripted-claude';

// 起動のしかた: 登録した設定ファイル（--settings・--model）と、アプリが足す MCP サーバー（--mcp-config）、プロファイルの設定のフォルダ（SessionManager）

let app: ScriptedApp;
const start = (options: ScriptedOptions = {}) => (app = new ScriptedApp(options));
afterEach(() => app.dispose());

// 登録した設定ファイルの作り物。broken は読めない（check・prepare で失敗する）。呼ばれた順に控える
function fakeSettingsFiles(model: string | null = 'opus') {
  const calls: string[] = [];
  const files = {
    check(settingsId: string) {
      calls.push(`check:${settingsId}`);
      if (settingsId === 'broken') throw new Error('設定ファイルを読めません: broken');
    },
    prepare(sessionId: string, settingsId: string, browser = false, sessions = false): PreparedSettings {
      calls.push(`prepare:${settingsId}:${browser}:${sessions}`);
      if (settingsId === 'broken') throw new Error('設定ファイルを読めません: broken');
      return { settingsFile: `/run/${sessionId}.json`, model };
    },
    release(sessionId: string) {
      calls.push(`release:${sessionId}`);
    },
  };
  return { files: files as unknown as SettingsFiles, calls };
}

const NEW = { model: null, effort: null, settingsFile: null, mode: null, remoteControl: false, worktree: false };

describe('登録した設定ファイル', () => {
  it('選ぶと、合わせた設定のファイルを --settings に渡し、モデルを選んでいなければ設定ファイルのモデルを --model に渡す', () => {
    const { files, calls } = fakeSettingsFiles();
    start({ settingsFiles: files });
    const { id, pty } = app.create({ settingsFile: 'work' });
    expect(calls).toEqual(['check:work', 'prepare:work:false:false']);
    expect(pty.arg('--settings')).toBe(`/run/${id}.json`);
    expect(pty.arg('--model')).toBe('opus');
    expect(app.manager.summary(id)?.settingsFile).toBe('work');
  });

  it('使えない設定ファイル・設定ファイルを使えない状態なら、記録を作らずに断る', () => {
    const { files } = fakeSettingsFiles();
    start({ settingsFiles: files });
    expect(() => app.manager.create(app.cwd, { ...NEW, settingsFile: 'broken' })).toThrow('設定ファイルを読めません: broken');
    expect(app.manager.list()).toEqual([]);
    app.dispose();
    start();
    expect(() => app.manager.create(app.cwd, { ...NEW, settingsFile: 'work' })).toThrow('設定ファイルを使えない状態です');
    expect(app.manager.list()).toEqual([]);
    expect(app.host.spawned).toEqual([]);
  });

  it('configure: 設定ファイルを変えると、モデルとエフォートを既定に戻して起動し直す。標準に戻すと、合わせたファイルを片付ける', async () => {
    const { files, calls } = fakeSettingsFiles(null);
    start({ settingsFiles: files });
    const { id, pty } = app.create({ model: 'sonnet', effort: 'high' });
    await app.ready(id);
    app.manager.configure(id, { model: 'sonnet', effort: 'high', settingsFile: 'work' });
    expect(pty.killed).toBe(true);
    expect(app.manager.summary(id)).toMatchObject({ model: null, effort: null, settingsFile: 'work' });
    // 設定ファイルにモデルが無ければ、既定のモデル
    expect(app.pty(id).arg('--model')).toBe('default');
    expect(app.pty(id).arg('--effort')).toBeNull();
    expect(app.pty(id).arg('--settings')).toBe(`/run/${id}.json`);
    calls.length = 0;
    app.manager.configure(id, { model: null, effort: null, settingsFile: null });
    expect(calls).toEqual([`release:${id}`]);
    expect(app.pty(id).arg('--settings')).not.toBe(`/run/${id}.json`);
  });

  it('configure: 使えない設定ファイルには変えない（記録も、動いている claude もそのまま）', async () => {
    const { files } = fakeSettingsFiles();
    start({ settingsFiles: files });
    const { id, pty } = app.create({ model: 'sonnet' });
    expect(() => app.manager.configure(id, { model: null, effort: null, settingsFile: 'broken' })).toThrow('設定ファイルを読めません');
    expect(pty.killed).toBe(false);
    expect(app.manager.summary(id)).toMatchObject({ model: 'sonnet', settingsFile: null });
  });

  it('configure: 止まっているセッションは起動し直さず、次の起動で使う', async () => {
    start();
    const { id, pty } = app.create();
    pty.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    app.manager.configure(id, { model: 'haiku', effort: 'low', settingsFile: null });
    expect(app.host.spawned).toHaveLength(1);
    expect(app.sessions.find((s) => s.id === id)).toMatchObject({ model: 'haiku', effort: 'low' });
    // restart は、止まっていれば開き直す
    app.manager.restart(id);
    await app.waitFor('起動', () => app.host.spawned.length === 2);
    expect(app.pty(id).arg('--model')).toBe('haiku');
    expect(app.pty(id).arg('--effort')).toBe('low');
  });

  it('restart: 設定ファイルが使えなくなっていたら、動いている claude を止めずに断る', async () => {
    const { files, calls } = fakeSettingsFiles();
    start({ settingsFiles: files });
    const { id, pty } = app.create({ settingsFile: 'work' });
    calls.length = 0;
    // 登録した設定ファイルが、あとから読めなくなった
    files.check = () => {
      throw new Error('設定ファイルを読めません: work');
    };
    expect(() => app.manager.restart(id)).toThrow('設定ファイルを読めません: work');
    expect(pty.killed).toBe(false);
    expect(app.host.spawned).toHaveLength(1);
  });

  it('claude が終わった・アーカイブした・アプリを終えて claude も止めたときは、合わせた設定のファイルを片付ける', async () => {
    const { files, calls } = fakeSettingsFiles();
    start({ settingsFiles: files });
    const a = app.create({ settingsFile: 'work' });
    const b = app.create({ settingsFile: 'work' });
    const c = app.create({ settingsFile: 'work' });
    calls.length = 0;
    a.pty.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(a.id) === 'exited');
    expect(calls).toEqual([`release:${a.id}`]);
    await app.manager.archive(b.id);
    expect(calls).toEqual([`release:${a.id}`, `release:${b.id}`]);
    calls.length = 0;
    app.manager.closeAll(true);
    // 起動したことのあるセッションは、どれも片付ける（アーカイブしたものは片付け済み）
    expect(calls.sort()).toEqual([`release:${a.id}`, `release:${c.id}`].sort());
    expect(c.pty.killed).toBe(true);
  });
});

describe('アプリが足す MCP サーバー', () => {
  const launch = (name: string) => ({ command: '/Apps/tanacode Helper', script: `/Apps/out/main/${name}.js`, socketPath: `/u/${name}.sock`, version: '1.0.0' });
  const mcpOf = (args: string[]) =>
    JSON.parse(args[args.indexOf('--mcp-config') + 1]) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };

  it('アプリ内ブラウザ・セッション・チェックリスト・ウォークスルーを 1 つの --mcp-config で足し、設定ファイルにブラウザとセッションの確認のフックを入れる', () => {
    const { files, calls } = fakeSettingsFiles();
    start({
      settingsFiles: files,
      browser: () => launch('browser-mcp'),
      sessionsMcp: () => launch('sessions-mcp'),
      checklistMcp: () => launch('checklist-mcp'),
      walkthroughMcp: () => launch('walkthrough-mcp'),
    });
    const { id, pty } = app.create({ settingsFile: 'work' });
    expect(calls).toContain('prepare:work:true:true');
    const servers = mcpOf(pty.request.args).mcpServers;
    expect(Object.keys(servers)).toEqual(['tanacode-browser', 'tanacode-sessions', 'tanacode-checklist', 'tanacode-walkthrough']);
    expect(servers['tanacode-sessions'].env).toMatchObject({ TANACODE_SESSIONS_SESSION: id });
    expect(servers['tanacode-sessions'].env.TANACODE_SESSIONS_CHILD).toBeUndefined();
    expect(servers['tanacode-checklist'].args).toEqual(['/Apps/out/main/checklist-mcp.js']);
    // JavaScript の実行の確認のフックは、Claude Code の環境で動くので、環境変数でも渡す
    expect(pty.request.env).toMatchObject({ TANACODE_BROWSER_SOCKET: '/u/browser-mcp.sock', TANACODE_BROWSER_SESSION: id });
  });

  it('子セッションには、子を動かすツールを見せない（読むだけのツール）。メニューでオフのものは足さない', () => {
    start({ sessionsMcp: () => launch('sessions-mcp') });
    const parent = app.create();
    const child = app.create({ mode: 'manual' }, parent.id);
    expect(mcpOf(parent.pty.request.args).mcpServers['tanacode-sessions'].env.TANACODE_SESSIONS_CHILD).toBeUndefined();
    const servers = mcpOf(child.pty.request.args).mcpServers;
    expect(Object.keys(servers)).toEqual(['tanacode-sessions']);
    expect(servers['tanacode-sessions'].env.TANACODE_SESSIONS_CHILD).toBe('1');
    expect(child.pty.request.env.TANACODE_BROWSER_SOCKET).toBeUndefined();
  });

  it('何も足さなければ --mcp-config を付けない', () => {
    start();
    const { pty } = app.create();
    expect(pty.request.args).not.toContain('--mcp-config');
    expect(pty.request.args).not.toContain('--allowedTools');
  });
});

describe('起動の権限モードと再開', () => {
  it('子セッションは起動したときのモードで開き直す。ほかのセッションは既定のモードで開き直す', async () => {
    start();
    const parent = app.create({ mode: 'acceptEdits' });
    const child = app.create({ mode: 'plan' }, parent.id);
    expect(parent.pty.arg('--permission-mode')).toBe('acceptEdits');
    expect(child.pty.arg('--permission-mode')).toBe('plan');
    for (const { id, pty } of [parent, child]) {
      await app.ready(id);
      app.append(id, line.user('はじめ'), line.text('はい'), line.turnEnd());
      await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
      pty.exit(0);
      await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
      await app.manager.open(id);
    }
    expect(app.pty(parent.id).arg('--permission-mode')).toBeNull();
    expect(app.pty(child.id).arg('--permission-mode')).toBe('plan');
    // 動いているセッションを開いても、何もしない
    await app.manager.open(parent.id);
    expect(app.host.spawned).toHaveLength(4);
  });

  it('知らないセッションは開けない', async () => {
    start();
    await expect(app.manager.open('nope')).rejects.toThrow('unknown session: nope');
  });
});

describe('プロファイルの Claude Code の設定のフォルダ', () => {
  it('指定すると、Claude Code に CLAUDE_CONFIG_DIR として渡し、会話ログもそのフォルダの中から読む。既定のプロファイルは渡さない', async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'tanacode-profile-'));
    try {
      start({ claudeDir });
      const { id, pty } = app.create();
      expect(pty.request.env.CLAUDE_CONFIG_DIR).toBe(claudeDir);
      expect(app.transcript(id).startsWith(join(claudeDir, 'projects'))).toBe(true);
      await app.ready(id);
      app.append(id, line.user('はじめ'), line.text('プロファイルの会話です'), line.turnEnd());
      await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
      app.dispose();
      start();
      expect(app.create().pty.request.env.CLAUDE_CONFIG_DIR || null).toBeNull();
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});
