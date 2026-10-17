import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreparedSettings, SettingsFiles } from '../src/main/settings-files';
import { line, ScriptedApp, stream, type ScriptedOptions } from './helpers/scripted-claude';

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
    prepare(sessionId: string, settingsId: string, browser = false, sessions = false, checklist = false): PreparedSettings {
      calls.push(`prepare:${settingsId}:${browser}:${sessions}:${checklist}`);
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
    const { id, pipe } = app.create({ settingsFile: 'work' });
    expect(calls).toEqual(['check:work', 'prepare:work:false:false:false']);
    expect(pipe.arg('--settings')).toBe(`/run/${id}.json`);
    expect(pipe.arg('--model')).toBe('opus');
    expect(app.manager.summary(id)?.settingsFile).toBe('work');
  });

  it('登録した設定ファイルに読めない項目があれば（合わせたファイルの get_settings の errors）、理由をチャットに出して止める。ほかのファイルの誤りは知らせるだけ', async () => {
    // Claude Code は読めない項目を使わない。登録した設定（Team プランと従量課金の切り替えなど）を黙って標準に切り替えないよう、止める
    const { files } = fakeSettingsFiles();
    start({ settingsFiles: files });
    // 合わせたファイルの名前はセッションの ID で決まる。get_settings は起動の答えのあとに届くので、そのときに読む
    let merged = '';
    app.answers.set('get_settings', () => ({
      applied: {},
      errors: [
        { file: '/x/settings.json', path: 'model', message: 'Expected string' },
        { file: merged, path: 'permissions.allow', message: 'Expected array' },
      ],
    }));
    const { id, pipe } = app.create({ settingsFile: 'work' });
    merged = `/run/${id}.json`;
    await app.waitFor('止める', () => pipe.requests('end_session').length === 1);
    expect(app.events(id).flatMap((e) => (e.type === 'info' ? [e.text] : []))).toEqual([
      expect.stringMatching(/^設定ファイルに読めない項目があります。[\s\S]*\/x\/settings\.json: model/),
      expect.stringMatching(new RegExp(`^設定ファイルに読めない項目があるため、Claude Code を止めました。[\\s\\S]*/run/${id}\\.json: permissions\\.allow`)),
    ]);
    expect(app.events(id).some((e) => e.type === 'ready')).toBe(false);
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
    expect(app.host.pipes).toEqual([]);
  });

  it('configure: 設定ファイルを変えると、モデルとエフォートを既定に戻して起動し直す。標準に戻すと、合わせたファイルを片付ける', async () => {
    const { files, calls } = fakeSettingsFiles(null);
    start({ settingsFiles: files });
    const { id, pipe } = app.create({ model: 'sonnet', effort: 'high' });
    await app.ready(id);
    await app.manager.configure(id, { model: 'sonnet', effort: 'high', settingsFile: 'work' });
    expect(pipe.exitedWith).toBe(0);
    expect(app.manager.summary(id)).toMatchObject({ model: null, effort: null, settingsFile: 'work' });
    // 設定ファイルにモデルが無ければ、既定のモデル
    expect(app.pipe(id).arg('--model')).toBe('default');
    expect(app.pipe(id).arg('--effort')).toBeNull();
    expect(app.pipe(id).arg('--settings')).toBe(`/run/${id}.json`);
    calls.length = 0;
    await app.manager.configure(id, { model: null, effort: null, settingsFile: null });
    // 止まった claude の分と、標準に戻した分
    expect(calls).toEqual([`release:${id}`, `release:${id}`]);
    expect(app.pipe(id).arg('--settings')).not.toBe(`/run/${id}.json`);
  });

  it('configure: 使えない設定ファイルには変えない（記録も、動いている claude もそのまま）', async () => {
    const { files } = fakeSettingsFiles();
    start({ settingsFiles: files });
    const { id, pipe } = app.create({ model: 'sonnet' });
    await expect(app.manager.configure(id, { model: null, effort: null, settingsFile: 'broken' })).rejects.toThrow('設定ファイルを読めません');
    expect(pipe.requests('end_session')).toEqual([]);
    expect(pipe.exitedWith).toBeNull();
    expect(app.manager.summary(id)).toMatchObject({ model: 'sonnet', settingsFile: null });
  });

  it('configure: 止まっているセッションは起動し直さず、次の起動で使う', async () => {
    start();
    const { id, pipe } = app.create();
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.manager.configure(id, { model: 'haiku', effort: 'low', settingsFile: null });
    expect(app.host.pipes).toHaveLength(1);
    expect(app.sessions.find((s) => s.id === id)).toMatchObject({ model: 'haiku', effort: 'low' });
    // restart は、止まっていれば開き直す
    await app.manager.restart(id);
    expect(app.host.pipes).toHaveLength(2);
    expect(app.pipe(id).arg('--model')).toBe('haiku');
    expect(app.pipe(id).arg('--effort')).toBe('low');
  });

  it('restart: 設定ファイルが使えなくなっていたら、動いている claude を止めずに断る', async () => {
    const { files, calls } = fakeSettingsFiles();
    start({ settingsFiles: files });
    const { id, pipe } = app.create({ settingsFile: 'work' });
    calls.length = 0;
    // 登録した設定ファイルが、あとから読めなくなった
    files.check = () => {
      throw new Error('設定ファイルを読めません: work');
    };
    await expect(app.manager.restart(id)).rejects.toThrow('設定ファイルを読めません: work');
    expect(pipe.requests('end_session')).toEqual([]);
    expect(app.host.pipes).toHaveLength(1);
  });

  it('claude が終わった・アーカイブした・アプリを終えて claude も止めたときは、合わせた設定のファイルを片付ける', async () => {
    const { files, calls } = fakeSettingsFiles();
    start({ settingsFiles: files });
    const a = app.create({ settingsFile: 'work' });
    const b = app.create({ settingsFile: 'work' });
    const c = app.create({ settingsFile: 'work' });
    calls.length = 0;
    a.pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(a.id) === 'exited');
    expect(calls).toEqual([`release:${a.id}`]);
    await app.manager.archive(b.id);
    expect(calls).toEqual([`release:${a.id}`, `release:${b.id}`]);
    calls.length = 0;
    app.manager.closeAll(true);
    // 起動したことのあるセッションは、どれも片付ける（アーカイブしたものは片付け済み）
    expect(calls.sort()).toEqual([`release:${a.id}`, `release:${c.id}`].sort());
    expect(c.pipe.kills).toEqual(['SIGTERM']);
  });
});

describe('アプリが足す MCP サーバー', () => {
  const launch = (name: string) => ({ command: '/Apps/tanacode Helper', script: `/Apps/out/main/${name}.js`, socketPath: `/u/${name}.sock`, version: '1.0.0' });
  const mcpOf = (args: string[]) =>
    JSON.parse(args[args.indexOf('--mcp-config') + 1]) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };

  it('アプリ内ブラウザ・セッション・チェックリスト・ウォークスルーを 1 つの --mcp-config で足し、設定ファイルにブラウザ・セッション・チェックリストのフックを入れる', () => {
    const { files, calls } = fakeSettingsFiles();
    start({
      settingsFiles: files,
      browser: () => launch('browser-mcp'),
      sessionsMcp: () => launch('sessions-mcp'),
      checklistMcp: () => launch('checklist-mcp'),
      walkthroughMcp: () => launch('walkthrough-mcp'),
    });
    const { id, pipe } = app.create({ settingsFile: 'work' });
    expect(calls).toContain('prepare:work:true:true:true');
    // 最適化圧縮が、このセッションで使えるかを見る
    expect(app.manager.hasChecklistMcp(id)).toBe(true);
    expect(app.manager.hasChecklistMcp('nope')).toBeNull();
    expect(app.manager.claudeSessionOf(id)).toBe(pipe.arg('--session-id'));
    expect(app.manager.claudeSessionOf('nope')).toBeNull();
    const servers = mcpOf(pipe.request.args).mcpServers;
    expect(Object.keys(servers)).toEqual(['tanacode-browser', 'tanacode-sessions', 'tanacode-checklist', 'tanacode-walkthrough']);
    expect(servers['tanacode-sessions'].env).toMatchObject({ TANACODE_SESSIONS_SESSION: id });
    expect(servers['tanacode-sessions'].env.TANACODE_SESSIONS_CHILD).toBeUndefined();
    expect(servers['tanacode-checklist'].args).toEqual(['/Apps/out/main/checklist-mcp.js']);
    // JavaScript の実行の確認のフックは、Claude Code の環境で動くので、環境変数でも渡す
    expect(pipe.request.env).toMatchObject({ TANACODE_BROWSER_SOCKET: '/u/browser-mcp.sock', TANACODE_BROWSER_SESSION: id });
    // チェックリストを使い続けさせるフックも同じ
    expect(pipe.request.env).toMatchObject({ TANACODE_CHECKLIST_SOCKET: '/u/checklist-mcp.sock', TANACODE_CHECKLIST_SESSION: id, TANACODE_CHECKLIST_SCRIPT: '/Apps/out/main/checklist-mcp.js' });
  });

  it('子セッションには、子を動かすツールを見せない（読むだけのツール）。メニューでオフのものは足さない', () => {
    start({ sessionsMcp: () => launch('sessions-mcp') });
    const parent = app.create();
    const child = app.create({ mode: 'manual' }, parent.id);
    expect(mcpOf(parent.pipe.request.args).mcpServers['tanacode-sessions'].env.TANACODE_SESSIONS_CHILD).toBeUndefined();
    const servers = mcpOf(child.pipe.request.args).mcpServers;
    expect(Object.keys(servers)).toEqual(['tanacode-sessions']);
    expect(servers['tanacode-sessions'].env.TANACODE_SESSIONS_CHILD).toBe('1');
    expect(child.pipe.request.env.TANACODE_BROWSER_SOCKET).toBeUndefined();
  });

  it('何も足さなければ --mcp-config を付けない', () => {
    start();
    const { pipe } = app.create();
    expect(pipe.request.args).not.toContain('--mcp-config');
    expect(pipe.request.args).not.toContain('--allowedTools');
  });
});

describe('起動の権限モードと再開', () => {
  it('子セッションは起動したときのモードで開き直す。ほかのセッションは、前回のモードでなく、新しいセッションと同じ決まり（設定の既定か auto）で開き直す', async () => {
    start();
    const parent = app.create({ mode: 'manual' });
    const child = app.create({ mode: 'plan' }, parent.id);
    expect(parent.pipe.arg('--permission-mode')).toBe('manual');
    expect(child.pipe.arg('--permission-mode')).toBe('plan');
    for (const { id, pipe } of [parent, child]) {
      await app.ready(id);
      app.say(id, line.user('はじめ'), line.text('はい'));
      // 人が切り替えた（子は、起動したときのモードより強くしない）
      pipe.emit(stream.status('acceptEdits'));
      app.finish(id);
      await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
      pipe.exit(0);
      await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
      await app.manager.open(id);
    }
    expect(app.pipe(parent.id).arg('--permission-mode')).toBe('auto');
    expect(app.pipe(child.id).arg('--permission-mode')).toBe('plan');
    // Claude が始めた独立したセッション（親が無い。capMode）も、起動したときのモードより強くしない
    const independent = app.create({ mode: 'plan', capMode: true });
    await app.ready(independent.id);
    independent.pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(independent.id) === 'exited');
    await app.manager.open(independent.id);
    expect(app.pipe(independent.id).arg('--permission-mode')).toBe('plan');
    // 動いているセッションを開いても、何もしない
    await app.manager.open(parent.id);
    expect(app.host.pipes).toHaveLength(6);
  });

  it('開き直すときも、設定の defaultMode があればそのモード（bypassPermissions は使わない）', async () => {
    start();
    const { id, pipe } = app.create({ mode: 'manual' });
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    const settings = join(app.cwd, '.claude', 'settings.json');
    mkdirSync(join(app.cwd, '.claude'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'plan' } }));
    await app.manager.open(id);
    expect(app.pipe(id).arg('--permission-mode')).toBe('plan');
    app.pipe(id).exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
    await app.manager.open(id);
    expect(app.pipe(id).arg('--permission-mode')).toBe('auto');
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
      const { id, pipe } = app.create();
      expect(pipe.request.env.CLAUDE_CONFIG_DIR).toBe(claudeDir);
      expect(app.transcript(id).startsWith(join(claudeDir, 'projects'))).toBe(true);
      await app.ready(id);
      app.say(id, line.user('はじめ'), line.text('プロファイルの会話です'));
      await app.waitFor('応答', () => app.events(id).some((e) => e.type === 'assistant-text' && e.text === 'プロファイルの会話です'));
      app.dispose();
      start();
      expect(app.create().pipe.request.env.CLAUDE_CONFIG_DIR || null).toBeNull();
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});
