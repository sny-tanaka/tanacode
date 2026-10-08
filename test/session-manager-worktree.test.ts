import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import { prepareNodeModules, type NodeModulesResult } from '../src/main/worktree';
import { fixtureScreen, ScriptedApp, type ScriptedOptions, type ScriptedPty } from './helpers/scripted-claude';

// worktree のセッション（claude --worktree）の、SessionManager が受け持つところ。本物の git で確かめる。
// Claude Code が worktree を作るところは、Claude Code と同じ形（.claude/worktrees/<名前>・ブランチ worktree-<名前>）を git で作って代わりにする。
// node_modules の用意（prepareNodeModules。test/worktree.test.ts が確かめる）は、結果を決めて差し替えられるようにする。PR（gh）は調べられないことにする

vi.mock('../src/main/github', () => ({ pullRequestsOf: vi.fn(async () => null) }));
vi.mock('../src/main/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/worktree')>();
  return { ...actual, prepareNodeModules: vi.fn(actual.prepareNodeModules) };
});
const prepare = vi.mocked(prepareNodeModules);

let app: ScriptedApp;
let tasks: { owner: string; cwd: string; command: string; name: string }[];
const start = (options: ScriptedOptions = {}) => {
  tasks = [];
  app = new ScriptedApp({
    runTask: async (owner, cwd, command, name) => {
      tasks.push({ owner, cwd, command, name });
      return command.startsWith('yarn') ? 1 : 0;
    },
    ...options,
  });
  git(app.cwd, 'init', '-q', '-b', 'main');
  git(app.cwd, 'config', 'user.email', 'me@example.com');
  git(app.cwd, 'config', 'user.name', 'me');
  writeFileSync(join(app.cwd, 'a.txt'), 'a\n');
  git(app.cwd, 'add', '.');
  git(app.cwd, 'commit', '-qm', 'init');
};
beforeEach(() => {
  // 前のテストで決めた結果を残さない（既定は本物の prepareNodeModules）
  prepare.mockReset();
});
afterEach(() => app.dispose());

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const NEW = { model: null, effort: null, settingsFile: null, mode: null, remoteControl: false, worktree: true };
const EMPTY: NodeModulesResult = { cloned: [], failed: [], installs: [] };

// worktree で始める。Claude Code が起動するまで待ち、その pty と、一覧に出たセッションを返す
async function begin(): Promise<{ creating: Promise<string>; pty: ScriptedPty; session: SessionSummary }> {
  const creating = app.manager.createInWorktree(app.cwd, NEW);
  await app.waitFor('起動', () => app.host.spawned.length > 0);
  return { creating, pty: app.host.spawned[0], session: app.manager.list()[0] };
}

// Claude Code が worktree を作る（claude --worktree <名前> と同じ形）
function createWorktree(session: SessionSummary): void {
  git(app.cwd, 'worktree', 'add', '-q', '-b', session.worktree!.branch, session.cwd);
}

const infos = (id: string) => app.manager.snapshot(id).events.flatMap((e) => (e.type === 'info' ? [e.text] : []));

describe('createInWorktree', () => {
  it('元のフォルダで claude --worktree <名前> を起動し、Claude Code が worktree を作るまで待ってから返す', async () => {
    start();
    prepare.mockResolvedValueOnce(EMPTY);
    const { creating, pty, session } = await begin();
    const { name, branch, root } = session.worktree!;
    expect(name).toMatch(/^tc-\d{4}-[a-z0-9]{4}$/);
    expect(branch).toBe(`worktree-${name}`);
    expect(root).toBe(app.cwd);
    expect(session.cwd).toBe(join(app.cwd, '.claude', 'worktrees', name));
    expect(pty.request.cwd).toBe(app.cwd);
    expect(pty.arg('--worktree')).toBe(name);
    // 作るまでは準備中
    expect(session.worktree?.preparing).toBe('creating');
    expect(app.manager.stateOf(session.id)).toBe('starting');
    // 元のフォルダのソース管理に、worktree が未追跡として出ないようにする
    expect(readFileSync(join(app.cwd, '.git', 'info', 'exclude'), 'utf8')).toContain('/.claude/worktrees/');
    createWorktree(session);
    expect(await creating).toBe(session.id);
    expect(app.manager.cwdOf(session.id)).toBe(session.cwd);
    pty.output(fixtureScreen('prompt'));
    await app.waitFor('受け付け', () => app.manager.stateOf(session.id) === 'idle');
  });

  it('入力欄が出てから node_modules を用意し、終わったら知らせて受け付ける。用意している間は、入力欄が出ていても起動中のまま', async () => {
    start();
    let release!: (result: NodeModulesResult) => void;
    prepare.mockImplementationOnce(async (_root, path, hooks) => {
      hooks.onStep('copying');
      await hooks.install(path, '', 'npm install');
      await hooks.install(join(path, 'pkg'), 'pkg', 'yarn install');
      hooks.onStep('installing');
      return new Promise<NodeModulesResult>((resolve) => (release = resolve));
    });
    const { creating, pty, session } = await begin();
    createWorktree(session);
    const id = await creating;
    expect(prepare).not.toHaveBeenCalled();
    pty.output(fixtureScreen('prompt'));
    await app.waitFor('用意', () => release !== undefined);
    expect(prepare).toHaveBeenCalledWith(app.cwd, session.cwd, expect.anything());
    // install は、アプリのターミナルのタブで実行する（場所が上でなければ、名前に添える）
    expect(tasks).toEqual([
      { owner: id, cwd: session.cwd, command: 'npm install', name: 'npm install' },
      { owner: id, cwd: join(session.cwd, 'pkg'), command: 'yarn install', name: 'yarn install（pkg）' },
    ]);
    await app.waitFor('installing', () => app.manager.summary(id)?.worktree?.preparing === 'installing');
    expect(app.sessionLists.some((list) => list.find((s) => s.id === id)?.worktree?.preparing === 'copying')).toBe(true);
    // 入力欄は出ているが、用意が終わるまでは受け付けない（最初の指示を送らない）
    await new Promise((r) => setTimeout(r, 500));
    expect(app.manager.stateOf(id)).toBe('starting');
    release({
      cloned: [''],
      failed: ['pkg'],
      installs: [
        { dir: '', command: 'npm install', exitCode: 0 },
        { dir: 'pkg', command: 'yarn install', exitCode: 1 },
      ],
    });
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    const { name, branch } = session.worktree!;
    expect(infos(id)).toEqual([
      `worktree .claude/worktrees/${name}（ブランチ ${branch}） で始めました。` +
        'node_modules を元のフォルダから複製しました。pkg/node_modules は複製できませんでした。npm install（いちばん上） を実行しました。' +
        'yarn install（pkg・終了コード 1） が失敗しました。ターミナルのタブで確かめてください',
    ]);
    const types = app.manager.snapshot(id).events.map((e) => e.type);
    expect(types.indexOf('ready')).toBeGreaterThan(types.indexOf('info'));
    expect(app.manager.summary(id)?.worktree?.preparing).toBeNull();
  });

  it('node_modules を用意できなくても（失敗）、worktree で始めたことを知らせて受け付ける', async () => {
    start();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    prepare.mockRejectedValueOnce(new Error('git ls-files に失敗しました'));
    const { creating, pty, session } = await begin();
    createWorktree(session);
    const id = await creating;
    pty.output(fixtureScreen('prompt'));
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    expect(infos(id)).toEqual([`worktree .claude/worktrees/${session.worktree!.name}（ブランチ ${session.worktree!.branch}） で始めました`]);
    expect(errors).toHaveBeenCalledWith('node_modules を用意できませんでした', expect.any(Error));
    errors.mockRestore();
  });

  it('runTask を渡さなければ、install を画面に出さずに実行して、終了コードを返す', async () => {
    start({ runTask: undefined });
    const codes: number[] = [];
    prepare.mockImplementationOnce(async (_root, path, hooks) => {
      codes.push(await hooks.install(path, '', 'exit 3'));
      codes.push(await hooks.install(path, '', 'true'));
      // 実行できない（フォルダが無い）ときは 1
      codes.push(await hooks.install(join(path, 'nonexistent'), 'nonexistent', 'true'));
      return EMPTY;
    });
    const { creating, pty, session } = await begin();
    createWorktree(session);
    const id = await creating;
    pty.output(fixtureScreen('prompt'));
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    expect(codes).toEqual([3, 0, 1]);
  });

  it('用意している途中でアーカイブしたら、知らせも受け付けもしない', async () => {
    start();
    let release!: (result: NodeModulesResult) => void;
    let step!: (step: 'copying' | 'installing') => void;
    prepare.mockImplementationOnce(async (_root, _path, hooks) => {
      step = hooks.onStep;
      return new Promise<NodeModulesResult>((resolve) => (release = resolve));
    });
    const { creating, pty, session } = await begin();
    createWorktree(session);
    const id = await creating;
    pty.output(fixtureScreen('prompt'));
    await app.waitFor('用意', () => release !== undefined);
    await app.manager.archive(id);
    const lists = app.sessionLists.length;
    step('installing');
    release(EMPTY);
    await new Promise((r) => setTimeout(r, 100));
    expect(app.sessionLists).toHaveLength(lists);
    expect(infos(id)).toEqual([]);
    expect(app.manager.stateOf(id)).toBe('archived');
  });

  it('worktree ができたあと、入力欄が出る前に Claude Code が終わっても、開き直したら受け付ける（準備中のままにしない）', async () => {
    start();
    const { creating, pty, session } = await begin();
    createWorktree(session);
    const id = await creating;
    // 入力欄が出る前に終わった
    pty.exit(1);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.manager.open(id);
    app.pty(id).output(fixtureScreen('prompt'));
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle', 3000);
    expect(app.manager.summary(id)?.worktree?.preparing).toBeNull();
  });

  it('信頼していないフォルダでは、Claude Code が worktree を作らずに終わる。記録を消し、先に信頼の確認に答えるよう案内する', async () => {
    start();
    const { creating, pty } = await begin();
    pty.output('\x1b[H\x1b[2JError: Workspace trust not yet accepted for this folder');
    await new Promise((r) => setTimeout(r, 200));
    pty.exit(1);
    await expect(creating).rejects.toThrow('このフォルダは、まだ Claude Code で信頼していません');
    expect(app.manager.list()).toEqual([]);
    expect(app.sessions).toEqual([]);
  });

  it('ほかの理由で作れずに終わったら、記録を消し、そのときの画面の最後の行を添えて失敗する', async () => {
    start();
    const { creating, pty } = await begin();
    pty.output(`\x1b[H\x1b[2J${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\r\n')}\r\nfatal: worktree を作れません`);
    await new Promise((r) => setTimeout(r, 200));
    pty.exit(1);
    const error = await creating.then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toBe(`Claude Code が worktree を作れませんでした\n\n${['line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10', 'fatal: worktree を作れません'].join('\n')}`);
    expect(app.manager.list()).toEqual([]);
  });

  it('画面に何も出さずに終わったら、画面を添えずに失敗する', async () => {
    start();
    const { creating, pty } = await begin();
    pty.exit(1);
    await expect(creating).rejects.toThrow(/^Claude Code が worktree を作れませんでした$/);
  });

  it('git のリポジトリでなければ、起動せずに失敗する', async () => {
    start();
    const other = join(app.root, 'plain');
    execFileSync('mkdir', [other]);
    await expect(app.manager.createInWorktree(other, NEW)).rejects.toThrow('git のリポジトリのフォルダを選んでください');
    expect(app.host.spawned).toEqual([]);
    expect(app.manager.list()).toEqual([]);
  });
});

describe('worktree の片付けと作り直し', () => {
  // worktree で始めて、受け付けるまで進める
  async function ready(): Promise<{ id: string; pty: ScriptedPty; session: SessionSummary }> {
    prepare.mockResolvedValueOnce(EMPTY);
    const { creating, pty, session } = await begin();
    createWorktree(session);
    const id = await creating;
    pty.output(fixtureScreen('prompt'));
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    return { id, pty, session };
  }

  it('worktreeLeftovers: 消す前に、残っているもの（未コミット・未追跡・手元だけのコミット）を数える。worktree でなければ null', async () => {
    start();
    const { id, session } = await ready();
    writeFileSync(join(session.cwd, 'a.txt'), 'changed\n');
    writeFileSync(join(session.cwd, 'new.txt'), 'new\n');
    expect(await app.manager.worktreeLeftovers(id)).toEqual({
      exists: true,
      branch: session.worktree!.branch,
      uncommitted: 1,
      untracked: 1,
      unpushed: 0,
      contentIn: null,
      pr: { state: 'unknown' },
    });
    expect(await app.manager.worktreeLeftovers('nope')).toBeNull();
    const plain = app.create({ worktree: false });
    expect(await app.manager.worktreeLeftovers(plain.id)).toBeNull();
    expect(await app.manager.archive(plain.id, { removeWorktree: true })).toBeNull();
  });

  it('archive({ removeWorktree }): Claude Code が終わるのを待ってから worktree を消す。手元だけのコミットが無ければブランチも消す', async () => {
    start();
    const { id, pty, session } = await ready();
    pty.exitOnKill = true;
    const removal = await app.manager.archive(id, { removeWorktree: true });
    expect(pty.killed).toBe(true);
    expect(removal).toEqual({ backupRef: null, branch: session.worktree!.branch, branchKept: false });
    expect(existsSync(session.cwd)).toBe(false);
    expect(app.manager.stateOf(id)).toBe('archived');
  });

  it('open: 消した worktree を、残したブランチから作り直してから再開し、作り直したことを知らせる', async () => {
    start();
    const { id, pty, session } = await ready();
    // worktree でコミットした（ブランチは消さずに残る）
    writeFileSync(join(session.cwd, 'b.txt'), 'b\n');
    git(session.cwd, 'add', '.');
    git(session.cwd, 'commit', '-qm', 'b');
    pty.exitOnKill = true;
    expect((await app.manager.archive(id, { removeWorktree: true }))?.branchKept).toBe(true);
    expect(existsSync(session.cwd)).toBe(false);
    prepare.mockResolvedValueOnce(EMPTY);
    const opening = app.manager.open(id);
    // 作り直している間は「準備中」。もう一度開いても、二重に作り直さない
    expect(app.manager.summary(id)?.worktree?.preparing).toBe('restoring');
    expect(app.manager.stateOf(id)).toBe('starting');
    await app.manager.open(id);
    await opening;
    expect(readFileSync(join(session.cwd, 'b.txt'), 'utf8')).toBe('b\n');
    expect(app.manager.summary(id)?.archived).toBe(false);
    const next = app.pty(id);
    expect(next).not.toBe(pty);
    expect(app.host.spawned.filter((p) => p.request.tag === id)).toHaveLength(2);
    next.output(fixtureScreen('prompt'));
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    expect(infos(id)).toEqual([`消していた worktree .claude/worktrees/${session.worktree!.name}（ブランチ ${session.worktree!.branch}） を作り直しました`]);
  });
});
