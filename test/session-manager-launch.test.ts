import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComposedSettings, SettingsFiles } from '../src/main/settings-files';
import type { SessionStore } from '../src/main/session-store';
import { fileArg } from './helpers/launch';
import { line, ScriptedApp, stream, type ScriptedOptions } from './helpers/scripted-claude';

// 起動のしかた: 登録した設定ファイル（--settings・--model）と、アプリが足す MCP サーバー（--mcp-config）、プロファイルの設定のフォルダ（SessionManager）

let app: ScriptedApp;
const start = (options: ScriptedOptions = {}) => (app = new ScriptedApp(options));
afterEach(() => app.dispose());

// 登録した設定ファイルの作り物。broken は読めない（check・compose で失敗する）。呼ばれた順に控える。
// 合わせたものには、どの設定ファイルかの印（registered）を入れる
function fakeSettingsFiles(model: string | null = 'opus') {
  const calls: string[] = [];
  const files = {
    check(settingsId: string) {
      calls.push(`check:${settingsId}`);
      if (settingsId === 'broken') throw new Error('設定ファイルを読めません: broken');
    },
    compose(settingsId: string, browser = false, checklist = false): ComposedSettings {
      calls.push(`compose:${settingsId}:${browser}:${checklist}`);
      if (settingsId === 'broken') throw new Error('設定ファイルを読めません: broken');
      return { settings: { registered: settingsId, ...(model ? { model } : {}) }, model };
    },
  };
  return { files: files as unknown as SettingsFiles, calls };
}

// アプリが --settings・--mcp-config のファイルを書く場所（userData/session-settings。launch-files.ts）
// 名前は <セッション ID>.<中身の hash>.json（MCP は .mcp.json）
const launchDir = () => join(app.userData, 'session-settings');
const isLaunchFile = (path: string | null, id: string, suffix = '.json') =>
  !!path && dirname(path) === launchDir() && new RegExp(`^${escapeRegExp(id)}\\.[0-9a-f]{16}${escapeRegExp(suffix)}$`).test(basename(path));
// そのセッションのファイルの名前（並べ替えたもの）
const filesOf = (id: string) => (existsSync(launchDir()) ? readdirSync(launchDir()).filter((name) => name.startsWith(`${id}.`)).sort() : []);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const NEW = { model: null, effort: null, settingsFile: null, mode: null, remoteControl: false, worktree: false };

describe('登録した設定ファイル', () => {
  it('選ぶと、合わせた設定のファイルを --settings に渡し、モデルを選んでいなければ設定ファイルのモデルを --model に渡す', () => {
    const { files, calls } = fakeSettingsFiles();
    start({ settingsFiles: files });
    const { id, pipe } = app.create({ settingsFile: 'work' });
    expect(calls).toEqual(['check:work', 'compose:work:false:false']);
    expect(isLaunchFile(pipe.arg('--settings'), id)).toBe(true);
    expect(fileArg(pipe.request.args, '--settings')).toMatchObject({ registered: 'work' });
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
    merged = pipe.arg('--settings')!;
    await app.waitFor('止める', () => pipe.requests('end_session').length === 1);
    expect(app.events(id).flatMap((e) => (e.type === 'info' ? [e.text] : []))).toEqual([
      expect.stringMatching(/^設定ファイルに読めない項目があります。[\s\S]*\/x\/settings\.json: model/),
      expect.stringMatching(new RegExp(`^設定ファイルに読めない項目があるため、Claude Code を止めました。[\\s\\S]*${escapeRegExp(merged)}: permissions\\.allow`)),
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
    expect(fileArg(app.pipe(id).request.args, '--settings')).toMatchObject({ registered: 'work' });
    calls.length = 0;
    await app.manager.configure(id, { model: null, effort: null, settingsFile: null });
    // 標準に戻すと、アプリの設定だけのファイルで起動し直す
    expect(calls).toEqual([]);
    expect(isLaunchFile(app.pipe(id).arg('--settings'), id)).toBe(true);
    expect(fileArg(app.pipe(id).request.args, '--settings')).not.toHaveProperty('registered');
    expect(fileArg(app.pipe(id).request.args, '--settings')).toHaveProperty('statusLine');
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

  it('restart: 止めている間に設定ファイルが使えなくなって起動し直せなければ、そこで終了を出す', async () => {
    const { files } = fakeSettingsFiles();
    start({ settingsFiles: files });
    const { id, pipe } = app.create({ settingsFile: 'work' });
    await app.ready(id);
    pipe.exitOnEnd = false;
    const restarting = app.manager.restart(id);
    await app.waitFor('end_session', () => pipe.requests('end_session').length === 1);
    files.compose = () => {
      throw new Error('設定ファイルを読めません: work');
    };
    pipe.exit(0);
    await expect(restarting).rejects.toThrow('設定ファイルを読めません: work');
    expect(app.manager.stateOf(id)).toBe('exited');
    expect(app.events(id).some((e) => e.type === 'process-exit')).toBe(true);
  });

});

describe('--settings・--mcp-config のファイル', () => {
  const launch = (name: string, version = '1.0.0') => ({ command: '/Apps/tanacode Helper', script: `/Apps/out/main/${name}.js`, socketPath: `/u/${name}.sock`, version });

  it('中身を引数に載せず、自分だけが読み書きできるファイルに書いてパスを渡す（pkill -f などの引数の文字での指定に当たらないように）', () => {
    start({ sessionsMcp: () => launch('sessions-mcp'), checklistMcp: () => launch('checklist-mcp') });
    const { id, pipe } = app.create();
    const args = pipe.request.args;
    expect(isLaunchFile(pipe.arg('--settings'), id)).toBe(true);
    expect(isLaunchFile(pipe.arg('--mcp-config'), id, '.mcp.json')).toBe(true);
    // 設定の中身（worktree の見張りのフックの awk のプログラムなど）と、MCP の中身（中継のソケットのパス）は、どの引数にも入らない
    expect(JSON.stringify(fileArg(args, '--settings'))).toContain('pushd');
    expect(args.filter((a) => a.includes('pushd') || a.includes('"hooks"') || a.includes('/u/sessions-mcp.sock'))).toEqual([]);
    expect(fileArg(args, '--mcp-config').mcpServers['tanacode-sessions'].env.TANACODE_SESSIONS_SOCKET).toBe('/u/sessions-mcp.sock');
    // 自分だけ
    expect(statSync(launchDir()).mode & 0o777).toBe(0o700);
    expect(statSync(pipe.arg('--settings')!).mode & 0o777).toBe(0o600);
    expect(statSync(pipe.arg('--mcp-config')!).mode & 0o777).toBe(0o600);
  });

  it('起動のたびに今の中身から書く。中身が変われば（アプリの更新など）、起動し直した claude（--resume）に新しい中身が渡る', async () => {
    let version = '1.0.0';
    start({ checklistMcp: () => launch('checklist-mcp', version) });
    const { id, pipe } = app.create();
    // 会話があるので、起動し直すと --resume で続ける
    const transcript = app.transcript(id);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ ...line.user('はじめ'), sessionId: pipe.arg('--session-id'), cwd: app.cwd })}\n`);
    await app.ready(id);
    const mcpOf = (args: string[]) => fileArg(args, '--mcp-config').mcpServers['tanacode-checklist'].env.TANACODE_VERSION;
    expect(mcpOf(pipe.request.args)).toBe('1.0.0');
    // 中身が同じなら、同じファイル（書き直さない）
    await app.manager.restart(id);
    const same = app.pipe(id);
    expect(same.arg('--resume')).toBe(app.claudeId(id));
    expect(same.arg('--mcp-config')).toBe(pipe.arg('--mcp-config'));
    await app.ready(id);
    // 更新したアプリの中身
    version = '2.0.0';
    await app.manager.restart(id);
    const next = app.pipe(id);
    expect(next.arg('--resume')).toBe(app.claudeId(id));
    expect(next.arg('--mcp-config')).not.toBe(pipe.arg('--mcp-config'));
    expect(mcpOf(next.request.args)).toBe('2.0.0');
    // 前の起動のファイルは、その claude が終わったときに消えている
    expect(filesOf(id)).toEqual([basename(next.arg('--mcp-config')!), basename(next.arg('--settings')!)].sort());
  });

  it('動いている claude が使っているファイルは、中身が変わったあとの起動で書き換えない（新しい起動は別のファイル）', async () => {
    let version = '1.0.0';
    start({ checklistMcp: () => launch('checklist-mcp', version) });
    const a = app.create();
    await app.ready(a.id);
    const used = a.pipe.arg('--mcp-config')!;
    const before = readFileSync(used, 'utf8');
    const writtenAt = statSync(used).mtimeMs;
    // 中身が変わった（アプリの更新など）あとに、ほかのセッションを起動しても、動いている claude のファイルはそのまま
    version = '2.0.0';
    const b = app.create();
    expect(fileArg(b.pipe.request.args, '--mcp-config').mcpServers['tanacode-checklist'].env.TANACODE_VERSION).toBe('2.0.0');
    expect(readFileSync(used, 'utf8')).toBe(before);
    expect(statSync(used).mtimeMs).toBe(writtenAt);
    // そのセッションを起動し直すと、新しい中身の別のファイルで起動し、前のファイルは前の claude が終わったときに消える
    await app.manager.restart(a.id);
    const next = app.pipe(a.id);
    expect(next.arg('--mcp-config')).not.toBe(used);
    expect(fileArg(next.request.args, '--mcp-config').mcpServers['tanacode-checklist'].env.TANACODE_VERSION).toBe('2.0.0');
    expect(existsSync(used)).toBe(false);
  });

  it('足す MCP サーバーが無くなったら、--mcp-config を付けない（前の起動の MCP のファイルは、その claude が終わったときに消えている）', async () => {
    let checklist = true;
    start({ checklistMcp: () => (checklist ? launch('checklist-mcp') : null) });
    const { id, pipe } = app.create();
    await app.ready(id);
    expect(isLaunchFile(pipe.arg('--mcp-config'), id, '.mcp.json')).toBe(true);
    checklist = false;
    await app.manager.restart(id);
    expect(app.pipe(id).request.args).not.toContain('--mcp-config');
    expect(filesOf(id)).toEqual([basename(app.pipe(id).arg('--settings')!)]);
  });

  it('claude が終わった・アーカイブした・アプリを終えて claude も止めたときは消す', async () => {
    const { files } = fakeSettingsFiles();
    start({ settingsFiles: files, checklistMcp: () => launch('checklist-mcp') });
    const a = app.create({ settingsFile: 'work' });
    const b = app.create();
    const c = app.create();
    for (const id of [a.id, b.id, c.id]) expect(filesOf(id)).toHaveLength(2);
    a.pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(a.id) === 'exited');
    expect(filesOf(a.id)).toEqual([]);
    await app.manager.archive(b.id);
    expect(filesOf(b.id)).toEqual([]);
    app.manager.closeAll(true);
    expect(filesOf(c.id)).toEqual([]);
    expect(c.pipe.kills).toEqual(['SIGTERM']);
  });

  it('起動と終了・起動し直しを何回くり返しても、ファイルは増え続けない（同じ中身なら同じファイル。終わったら消す）', async () => {
    start({ checklistMcp: () => launch('checklist-mcp') });
    const { id } = app.create();
    await app.ready(id);
    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      await app.manager.restart(id);
      await app.ready(id);
      counts.push(readdirSync(launchDir()).length);
    }
    for (let i = 0; i < 5; i++) {
      app.pipe(id).exit(0);
      await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
      counts.push(readdirSync(launchDir()).length);
      await app.manager.open(id);
      await app.ready(id);
      counts.push(readdirSync(launchDir()).length);
    }
    // 動いている間は 2 つ（--settings と --mcp-config）、終わっている間は 0
    expect(counts).toEqual([2, 2, 2, 2, 2, ...Array.from({ length: 5 }, () => [0, 2]).flat()]);
    // 使っているファイルを、セッションの記録に残す（次のアプリが、引き継いだ claude の使っているもののほかを片付けるため）
    const store = (app.manager as unknown as { store: SessionStore }).store;
    expect([...(store.get(id)?.launchFiles ?? [])].sort()).toEqual(filesOf(id));
  });

  it('claude を動かしたまま終えるときは、ファイルを残す（次のアプリが引き継ぐ claude が使う）', () => {
    start();
    const { id, pipe } = app.create();
    app.manager.closeAll(false);
    expect(filesOf(id)).toEqual([basename(pipe.arg('--settings')!)]);
    expect(readFileSync(pipe.arg('--settings')!, 'utf8')).toContain('statusLine');
  });
});

describe('アプリが足す MCP サーバー', () => {
  const launch = (name: string) => ({ command: '/Apps/tanacode Helper', script: `/Apps/out/main/${name}.js`, socketPath: `/u/${name}.sock`, version: '1.0.0' });
  const mcpOf = (args: string[]) => fileArg<{ mcpServers: Record<string, { args: string[]; env: Record<string, string> }> }>(args, '--mcp-config');

  it('アプリ内ブラウザ・セッション・チェックリスト・ウォークスルーを 1 つの --mcp-config で足し、設定ファイルにブラウザ・チェックリストのフックを入れる（セッションの確認は、ツールごとの許可のフックで、いつも入る）', () => {
    const { files, calls } = fakeSettingsFiles();
    start({
      settingsFiles: files,
      browser: () => launch('browser-mcp'),
      sessionsMcp: () => launch('sessions-mcp'),
      checklistMcp: () => launch('checklist-mcp'),
      walkthroughMcp: () => launch('walkthrough-mcp'),
    });
    const { id, pipe } = app.create({ settingsFile: 'work' });
    expect(calls).toContain('compose:work:true:true');
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
