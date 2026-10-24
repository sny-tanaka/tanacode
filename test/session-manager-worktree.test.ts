import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import type { SessionStore } from '../src/main/session-store';
import { prepareNodeModules, type NodeModulesResult } from '../src/main/worktree';
import { INIT_RESPONSE, ScriptedApp, type ScriptedOptions, type ScriptedPipe } from './helpers/scripted-claude';

// worktree のセッション（claude --worktree）の、SessionManager が受け持つところ。本物の git で確かめる。
// Claude Code が worktree を作るところは、Claude Code と同じ形（.claude/worktrees/<名前>・ブランチ worktree-<名前>）を git で作って代わりにする。
// node_modules の用意（prepareNodeModules。test/worktree.test.ts が確かめる）は、結果を決めて差し替えられるようにする。PR（gh）は調べられないことにする。
// Claude Code は worktree を作り終えてから initialize に答えるので、テストが答える（initialized）

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
  app.answers.set('initialize', null);
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

// worktree で始める。Claude Code が起動するまで待ち、そのパイプと、一覧に出たセッションを返す
async function begin(): Promise<{ creating: Promise<string>; pipe: ScriptedPipe; session: SessionSummary }> {
  const creating = app.manager.createInWorktree(app.cwd, NEW);
  await app.waitFor('起動', () => app.host.pipes.length > 0);
  return { creating, pipe: app.host.pipes[0], session: app.manager.list()[0] };
}

// Claude Code が起動を終えた（initialize に答えた）
function initialized(pipe: ScriptedPipe): void {
  pipe.respond(pipe.requests('initialize')[0].request_id, INIT_RESPONSE);
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
    const { creating, pipe, session } = await begin();
    const { name, branch, root } = session.worktree!;
    expect(name).toMatch(/^tc-\d{4}-[a-z0-9]{4}$/);
    expect(branch).toBe(`worktree-${name}`);
    expect(root).toBe(app.cwd);
    expect(session.cwd).toBe(join(app.cwd, '.claude', 'worktrees', name));
    expect(pipe.request.cwd).toBe(app.cwd);
    expect(pipe.arg('--worktree')).toBe(name);
    // 作るまでは準備中
    expect(session.worktree?.preparing).toBe('creating');
    expect(app.manager.stateOf(session.id)).toBe('starting');
    // 元のフォルダのソース管理に、worktree が未追跡として出ないようにする
    expect(readFileSync(join(app.cwd, '.git', 'info', 'exclude'), 'utf8')).toContain('/.claude/worktrees/');
    createWorktree(session);
    expect(await creating).toBe(session.id);
    expect(app.manager.cwdOf(session.id)).toBe(session.cwd);
    initialized(pipe);
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
    const { creating, pipe, session } = await begin();
    createWorktree(session);
    const id = await creating;
    expect(prepare).not.toHaveBeenCalled();
    initialized(pipe);
    await app.waitFor('用意', () => release !== undefined);
    expect(prepare).toHaveBeenCalledWith(app.cwd, session.cwd, expect.anything());
    // install は、アプリのターミナルで実行する（画面に出すときのタブの名前に、場所が上でなければ添える）
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
    // 失敗した install は、チャットの注意の行にし、親と子に伝えるために残す（複製できなかった pkg は install を受け持ったので数えない）
    expect(app.manager.snapshot(id).events.find((e) => e.type === 'info')).toMatchObject({ warning: true });
    expect(app.manager.worktreeSetup(id)).toEqual({ installsFailed: [{ dir: 'pkg', command: 'yarn install', exitCode: 1 }], notCopied: [], error: null });
  });

  it('node_modules を用意できなくても（失敗）、worktree で始めたことを知らせて受け付ける', async () => {
    start();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    prepare.mockRejectedValueOnce(new Error('git ls-files に失敗しました'));
    const { creating, pipe, session } = await begin();
    createWorktree(session);
    const id = await creating;
    initialized(pipe);
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    expect(infos(id)).toEqual([
      `worktree .claude/worktrees/${session.worktree!.name}（ブランチ ${session.worktree!.branch}） で始めました。node_modules を用意できませんでした（git ls-files に失敗しました）`,
    ]);
    expect(errors).toHaveBeenCalledWith('node_modules を用意できませんでした', expect.any(Error));
    expect(app.manager.worktreeSetup(id)).toEqual({ installsFailed: [], notCopied: [], error: 'git ls-files に失敗しました' });
    errors.mockRestore();
  });

  it('install が入力を待っているように見えたら（アプリはタブに出す）、チャットの注意の行と、親が読む準備の問題で知らせる。答えて終わったら問題から外す', async () => {
    let answer: (code: number) => void = () => {};
    start({
      runTask: (_owner, _cwd, _command, _name, onWaiting) =>
        new Promise<number>((resolve) => {
          answer = resolve;
          onWaiting?.();
        }),
    });
    prepare.mockImplementationOnce(async (_root, path, hooks) => {
      hooks.onStep('installing');
      const exitCode = await hooks.install(path, '', 'pnpm install');
      return { cloned: [], failed: [], installs: [{ dir: '', command: 'pnpm install', exitCode }] };
    });
    const { creating, pipe, session } = await begin();
    createWorktree(session);
    const id = await creating;
    initialized(pipe);
    await app.waitFor('入力待ちの知らせ', () => infos(id).length > 0);
    expect(infos(id)).toEqual(['pnpm install（いちばん上） が入力を待っているようです。ターミナルのタブで答えてください']);
    expect(app.manager.snapshot(id).events.find((e) => e.type === 'info')).toMatchObject({ warning: true });
    expect(app.manager.worktreeSetup(id)).toEqual({ installsFailed: [], notCopied: [], error: null, waiting: { dir: '', command: 'pnpm install' } });
    // 答えるまでは、最初の指示を受け付けない
    expect(app.manager.stateOf(id)).toBe('starting');
    answer(0);
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    expect(app.manager.worktreeSetup(id)).toBeNull();
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
    const { creating, pipe, session } = await begin();
    createWorktree(session);
    const id = await creating;
    initialized(pipe);
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
    const { creating, pipe, session } = await begin();
    createWorktree(session);
    const id = await creating;
    initialized(pipe);
    await app.waitFor('用意', () => release !== undefined);
    await app.manager.archive(id);
    // フォルダが残っていることを裏で見つけて、一覧を配り直し終えるまで待つ
    await app.waitFor('残っている印', () => app.manager.summary(id)?.worktree?.left === true);
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
    const { creating, pipe, session } = await begin();
    createWorktree(session);
    const id = await creating;
    // 起動を終える前に終わった
    pipe.exit(1);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.manager.open(id);
    initialized(app.pipe(id));
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle', 3000);
    expect(app.manager.summary(id)?.worktree?.preparing).toBeNull();
  });

  it('node_modules を用意している途中でアプリを終えたら、次のアプリが引き継いだときに用意をやり直し、終わってから受け付けて、送る前だった最初の指示を送る', async () => {
    start();
    prepare.mockResolvedValueOnce(EMPTY);
    const { creating, pipe, session } = await begin();
    createWorktree(session);
    const id = await creating;
    // 用意している間は、記録に「準備の途中」を残す（終わる前にアプリを終えたら、次のアプリがやり直す）
    const store = (app.manager as unknown as { store: SessionStore }).store;
    expect(store.get(id)?.worktreePreparing).toBe(true);
    initialized(pipe);
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    expect(store.get(id)?.worktreePreparing).toBe(false);
    // 前のアプリが、用意の途中で、最初の指示を送る前に終えた（install はアプリのターミナルで動くので、アプリを終えると止まる）。
    // そのときの記録にして、動き続けている claude を今のアプリで引き継ぐ
    const parent = '0f8c2a1e-0000-4000-8000-000000000001';
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    store.update(id, { worktreePreparing: true, waiting: [{ text: { parent, body: '登録画面を作って', setupNote: true }, timeoutMs: 60_000 }] });
    let release!: (result: NodeModulesResult) => void;
    prepare.mockImplementationOnce(async (_root, _path, hooks) => {
      hooks.onStep('installing');
      return new Promise<NodeModulesResult>((resolve) => (release = resolve));
    });
    app.host.hosted = [{ kind: 'pipe', id: `pipe-${id}`, tag: id, pid: 100, startedAt: Date.now() - 60_000, exitCode: null, lastSeq: 0, firstSeq: 1, retained: [], pending: [], ended: false, stderr: '' }];
    await app.manager.adopt();
    const adopted = app.pipe(id);
    adopted.replayed();
    // 直す前は、引き継いだら用意をやり直さずに受け付けていた（最初の指示も、アプリの終了で消えていた）
    await app.waitFor('やり直し', () => release !== undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(app.manager.stateOf(id)).toBe('starting');
    expect(adopted.prompts).toEqual([]);
    release({ cloned: [], failed: [], installs: [{ dir: '', command: 'npm install', exitCode: 1 }] });
    await app.waitFor('最初の指示', () => adopted.prompts.length === 1);
    const sent = String(adopted.prompts[0].message.content);
    expect(sent).toContain('登録画面を作って');
    // やり直した用意でうまくいかなかったことを添える
    expect(sent).toContain('npm install');
    expect(store.get(id)?.worktreePreparing).toBe(false);
    expect(store.get(id)?.waiting).toBeNull();
  });

  it('アプリが手を離せない間に、終わりが届いても、標準エラーを添えて失敗する', async () => {
    start();
    const { creating, pipe } = await begin();
    // worktree ができたかを見る間隔（200ms）より長く、アプリが手を離せない（CI の遅いランナーで起きる）
    const busyUntil = Date.now() + 300;
    while (Date.now() < busyUntil);
    pipe.exit(1, 'fatal: worktree を作れません');
    await expect(creating).rejects.toThrow('Claude Code が worktree を作れませんでした\n\nfatal: worktree を作れません');
    expect(app.manager.list()).toEqual([]);
  });

  it('ほかの理由で作れずに終わったら、記録を消し、標準エラーの最後の行を添えて失敗する', async () => {
    start();
    const { creating, pipe } = await begin();
    await new Promise((r) => setTimeout(r, 200));
    pipe.exit(1, `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')}\nfatal: worktree を作れません\n`);
    const error = await creating.then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toBe(`Claude Code が worktree を作れませんでした\n\n${['line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10', 'fatal: worktree を作れません'].join('\n')}`);
    expect(app.manager.list()).toEqual([]);
  });

  it('標準エラーに何も出さずに終わったら、何も添えずに失敗する', async () => {
    start();
    const { creating, pipe } = await begin();
    pipe.exit(1);
    await expect(creating).rejects.toThrow(/^Claude Code が worktree を作れませんでした$/);
  });

  it('git のリポジトリでなければ、起動せずに失敗する', async () => {
    start();
    const other = join(app.root, 'plain');
    execFileSync('mkdir', [other]);
    await expect(app.manager.createInWorktree(other, NEW)).rejects.toThrow('git のリポジトリのフォルダを選んでください');
    expect(app.host.pipes).toEqual([]);
    expect(app.manager.list()).toEqual([]);
  });
});

describe('startInWorktree', () => {
  // worktree で始める。Claude Code が worktree を作るのを待たずに返る
  async function begun(): Promise<{ id: string; created: Promise<boolean>; pipe: ScriptedPipe; session: SessionSummary }> {
    const { id, created } = await app.manager.startInWorktree(app.cwd, NEW);
    return { id, created, pipe: app.pipe(id), session: app.manager.summary(id)! };
  }
  // 決まったか（成功でも失敗でも）
  const settledOf = (promise: Promise<unknown>) => {
    const state = { settled: false };
    const mark = () => void (state.settled = true);
    promise.then(mark, mark);
    return state;
  };

  it('Claude Code が worktree を作るのを待たずに id を返す。作り終えたら、created が true になる', async () => {
    start();
    prepare.mockResolvedValueOnce(EMPTY);
    const { id, created, pipe, session } = await begun();
    // 起動しただけで、worktree はまだ無い。一覧には「作成中」で出ている
    expect(pipe.arg('--worktree')).toBe(session.worktree!.name);
    expect(existsSync(session.cwd)).toBe(false);
    expect(session.worktree?.preparing).toBe('creating');
    expect(app.manager.stateOf(id)).toBe('starting');
    expect(app.sessions.map((s) => s.id)).toEqual([id]);
    const state = settledOf(created);
    await new Promise((r) => setTimeout(r, 400));
    expect(state.settled).toBe(false);
    createWorktree(session);
    expect(await created).toBe(true);
    initialized(pipe);
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
  });

  it('作れずに Claude Code が終わったら、記録を消して、created が理由を添えて失敗する', async () => {
    start();
    const { created, pipe } = await begun();
    await new Promise((r) => setTimeout(r, 200));
    pipe.exit(1, 'fatal: worktree を作れません');
    await expect(created).rejects.toThrow('Claude Code が worktree を作れませんでした');
    expect(app.manager.list()).toEqual([]);
    expect(app.sessions).toEqual([]);
  });

  it('作っている途中でアーカイブしたら、すぐ created が false になる。作れなかったとは扱わず、記録は残す', async () => {
    start();
    const { id, created } = await begun();
    await app.manager.archive(id);
    // 止めた Claude Code からは終了の知らせが来ないが、待ち続けない
    const started = Date.now();
    expect(await created).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(app.manager.stateOf(id)).toBe('archived');
    expect(app.manager.summary(id)?.worktree?.preparing).toBeNull();
  });

  it('作っている途中で一覧から消しても、created は false になる（失敗にしない）', async () => {
    start();
    const { id, created } = await begun();
    await app.manager.remove(id);
    expect(await created).toBe(false);
    expect(app.manager.list()).toEqual([]);
  });

  it('createInWorktree は、作っている途中でアーカイブされたら、理由を添えて失敗する（記録は残す）', async () => {
    start();
    const { creating, session } = await begin();
    await app.manager.archive(session.id);
    await expect(creating).rejects.toThrow('worktree を作っている途中で、セッションがアーカイブされたか、一覧から消されました');
    expect(app.manager.stateOf(session.id)).toBe('archived');
  });

  it('作っている途中に起動し直しても（再起動）、新しい起動が作るのを待つ。前の起動の待ちが終わっても「作成中」のまま', async () => {
    start();
    prepare.mockResolvedValueOnce(EMPTY);
    const { id, created, pipe, session } = await begun();
    const state = settledOf(created);
    await app.manager.restart(id);
    const next = app.pipe(id);
    expect(next).not.toBe(pipe);
    expect(next.arg('--worktree')).toBe(session.worktree!.name);
    // 前の起動の待ち（200 ミリ秒ごとに確かめている）が終わるまで待つ
    await new Promise((r) => setTimeout(r, 500));
    expect(state.settled).toBe(false);
    expect(app.manager.summary(id)?.worktree?.preparing).toBe('creating');
    createWorktree(session);
    expect(await created).toBe(true);
    initialized(next);
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    expect(app.manager.summary(id)?.worktree?.preparing).toBeNull();
  });
});

// worktree で始めて、受け付けるまで進める
async function ready(): Promise<{ id: string; pipe: ScriptedPipe; session: SessionSummary }> {
  prepare.mockResolvedValueOnce(EMPTY);
  const { creating, pipe, session } = await begin();
  createWorktree(session);
  const id = await creating;
  initialized(pipe);
  await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
  return { id, pipe, session };
}

describe('worktree の片付けと作り直し', () => {
  it('worktreeLeftovers: 消す前に、残っているもの（未コミット・未追跡・手元だけのコミット）を数える。worktree でなければ null', async () => {
    start();
    const { id, session } = await ready();
    writeFileSync(join(session.cwd, 'a.txt'), 'changed\n');
    writeFileSync(join(session.cwd, 'new.txt'), 'new\n');
    expect(await app.manager.worktreeLeftovers(id)).toEqual({
      exists: true,
      uncommitted: 1,
      untracked: 1,
      submodules: [],
      branches: [
        {
          name: session.worktree!.branch,
          launched: true,
          current: true,
          exists: true,
          unpushed: 0,
          contentIn: null,
          pr: { state: 'unknown' },
          keep: null,
        },
      ],
    });
    expect(await app.manager.worktreeLeftovers('nope')).toBeNull();
    const plain = app.create({ worktree: false });
    expect(await app.manager.worktreeLeftovers(plain.id)).toBeNull();
    expect(await app.manager.archive(plain.id, { removeWorktree: true })).toBeNull();
  });

  it('archive({ removeWorktree }): Claude Code が終わるのを待ってから worktree を消す。手元だけのコミットが無ければブランチも消す', async () => {
    start();
    const { id, pipe, session } = await ready();
    const removal = await app.manager.archive(id, { removeWorktree: true });
    expect(pipe.requests('end_session')).toHaveLength(1);
    expect(removal).toEqual({ backupRef: null, branches: [{ name: session.worktree!.branch, launched: true, current: true, deleted: true, keep: null }] });
    expect(pipe.exitedWith).toBe(0);
    expect(existsSync(session.cwd)).toBe(false);
    expect(app.manager.stateOf(id)).toBe('archived');
  });

  it('archive({ removeWorktree }): 再起動の途中にしても、止めたあとに Claude Code を起動し直さない（消した worktree で、誰も持たない claude が動き続けない）', async () => {
    start();
    const { id, pipe, session } = await ready();
    pipe.exitOnEnd = false;
    const restarting = app.manager.restart(id);
    await app.waitFor('end_session', () => pipe.requests('end_session').length === 1);
    const sent = app.manager.submit(id, '再起動のあとも');
    const archiving = app.manager.archive(id, { removeWorktree: true });
    pipe.exit(0);
    await restarting;
    expect((await archiving)?.branches[0]?.name).toBe(session.worktree!.branch);
    await expect(sent).rejects.toThrow('Claude Code が終了しました');
    expect(app.host.pipes).toHaveLength(1);
    expect(existsSync(session.cwd)).toBe(false);
    expect(app.manager.stateOf(id)).toBe('archived');
  });

  it('open: 消した worktree を、残したブランチから作り直してから再開し、作り直したことを知らせる', async () => {
    start();
    const { id, pipe, session } = await ready();
    // worktree でコミットした（ブランチは消さずに残る）
    writeFileSync(join(session.cwd, 'b.txt'), 'b\n');
    git(session.cwd, 'add', '.');
    git(session.cwd, 'commit', '-qm', 'b');
    expect((await app.manager.archive(id, { removeWorktree: true }))?.branches[0]).toMatchObject({ deleted: false, keep: 'localOnly' });
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
    const next = app.pipe(id);
    expect(next).not.toBe(pipe);
    expect(app.host.pipes.filter((p) => p.request.tag === id)).toHaveLength(2);
    initialized(next);
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    expect(infos(id)).toEqual([`消していた worktree .claude/worktrees/${session.worktree!.name}（ブランチ ${session.worktree!.branch}） を作り直しました`]);
  });

  it('open: 子が git switch -c で作って残したブランチで作り直し、未コミットの変更の控えを戻して、そのことを知らせる', async () => {
    start();
    const { id, session } = await ready();
    git(session.cwd, 'switch', '-q', '-c', 'fix/x');
    writeFileSync(join(session.cwd, 'b.txt'), 'b\n');
    git(session.cwd, 'add', '.');
    git(session.cwd, 'commit', '-qm', 'b');
    writeFileSync(join(session.cwd, 'new.txt'), 'new\n');
    const removal = await app.manager.archive(id, { removeWorktree: true });
    expect(removal?.branches.map((b) => [b.name, b.deleted])).toEqual([
      ['fix/x', false],
      [session.worktree!.branch, true],
    ]);
    const backupRef = removal!.backupRef!;
    prepare.mockResolvedValueOnce(EMPTY);
    await app.manager.open(id);
    expect(git(session.cwd, 'branch', '--show-current')).toBe('fix/x');
    expect(readFileSync(join(session.cwd, 'new.txt'), 'utf8')).toBe('new\n');
    expect(git(app.cwd, 'for-each-ref', 'refs/tanacode/backup/')).toBe('');
    initialized(app.pipe(id));
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    expect(infos(id)).toEqual([
      `消していた worktree .claude/worktrees/${session.worktree!.name}（ブランチ fix/x） を作り直しました。worktree を消す前の控え ${backupRef} の中身（未コミットの変更・未追跡のファイル）を戻し、控えを外しました`,
    ]);
  });
});

describe('worktree の片付け', () => {
  it('アーカイブ済みで残っている worktree を一覧に出し（一覧の印 left も）、消しても子セッションには触らない。控えの削除は、戻すときの記録も外す', async () => {
    start();
    const { id, session } = await ready();
    const child = app.manager.create(app.cwd, { ...NEW, worktree: false }, id);
    await app.manager.archive(id);
    // 人が子だけを戻した
    app.manager.unarchive(child);
    // フォルダが残っているかは、一覧を配るたびに同期では見ず、裏で見て配り直す
    await app.waitFor('残っている印', () => app.manager.summary(id)?.worktree?.left === true);
    const listed = await app.manager.worktreeCleanup();
    expect(listed.worktrees).toEqual([{ id, title: expect.any(String), path: session.cwd, branch: session.worktree!.branch }]);
    expect(listed.backups).toEqual([]);

    writeFileSync(join(session.cwd, 'new.txt'), 'new\n');
    const removal = await app.manager.removeLeftWorktree(id);
    expect(existsSync(session.cwd)).toBe(false);
    expect(app.manager.summary(id)?.worktree?.left).toBeUndefined();
    expect(app.manager.summary(child)?.archived).toBe(false);
    const after = await app.manager.worktreeCleanup();
    expect(after.worktrees).toEqual([]);
    expect(after.backups).toEqual([
      { root: app.cwd, ref: removal.backupRef, date: expect.any(Number), subject: expect.stringContaining(session.worktree!.name), strays: false, session: { id, title: expect.any(String) } },
    ]);
    await app.manager.deleteBackup(app.cwd, removal.backupRef!);
    expect((await app.manager.worktreeCleanup()).backups).toEqual([]);
    // 控えが無ければ、作り直しても戻さない（知らせも出さない）
    prepare.mockResolvedValueOnce(EMPTY);
    await app.manager.open(id);
    expect(existsSync(join(session.cwd, 'new.txt'))).toBe(false);
  });

  it('アーカイブしていないセッションの worktree は、片付けでは消さない', async () => {
    start();
    const { id } = await ready();
    await expect(app.manager.removeLeftWorktree(id)).rejects.toThrow();
  });

  it('アーカイブしていないほかのセッションが worktree の中で動いていれば、片付けの一覧に出さず、消すのも断る', async () => {
    start();
    const { id, session } = await ready();
    await app.manager.archive(id);
    // worktree を使わない子を、親の worktree の中で始めていた（親だけをアーカイブしたあとに戻した）
    const inside = app.manager.create(session.cwd, { ...NEW, worktree: false });
    expect(app.manager.summary(inside)?.archived).toBe(false);
    expect((await app.manager.worktreeCleanup()).worktrees).toEqual([]);
    await expect(app.manager.removeLeftWorktree(id)).rejects.toThrow('この worktree の中で動いているため');
    expect(existsSync(session.cwd)).toBe(true);
  });

  it('片付けで消している最中に開くと、消し終わるのを待ってから作り直して起動する。同じ worktree をもう一度消すと、同じ結果を待つ', async () => {
    start();
    const { id, session } = await ready();
    await app.manager.archive(id);
    const removing = app.manager.removeLeftWorktree(id);
    const again = app.manager.removeLeftWorktree(id);
    // 消している最中は、片付けの一覧に出さない
    expect((await app.manager.worktreeCleanup()).worktrees).toEqual([]);
    prepare.mockResolvedValueOnce(EMPTY);
    const opening = app.manager.open(id);
    expect(app.manager.summary(id)?.worktree?.preparing).toBe('restoring');
    const [first, second] = await Promise.all([removing, again]);
    expect(second).toEqual(first);
    await opening;
    // 消したあとに作り直したので、フォルダはあり、Claude Code はそこで起動している
    expect(existsSync(join(session.cwd, '.git'))).toBe(true);
    expect(app.host.pipes.filter((p) => p.request.tag === id)).toHaveLength(2);
  });

  it('幹のブランチ（develop など）に切り替えていたら、そのブランチは覚えず、起動したときのブランチで作り直す', async () => {
    start();
    const { id, session } = await ready();
    git(session.cwd, 'switch', '-q', '-c', 'develop');
    const removal = await app.manager.archive(id, { removeWorktree: true });
    expect(removal?.branches[0]).toMatchObject({ name: 'develop', deleted: false, keep: 'trunk' });
    // 元のフォルダで develop を取り出した
    git(app.cwd, 'switch', '-q', 'develop');
    prepare.mockResolvedValueOnce(EMPTY);
    await app.manager.open(id);
    expect(git(session.cwd, 'branch', '--show-current')).toBe(session.worktree!.branch);
  });

  it('残したブランチをほかの場所で取り出していたら、detached HEAD で作り直し、そのことを知らせる', async () => {
    start();
    const { id, session } = await ready();
    git(session.cwd, 'switch', '-q', '-c', 'fix/x');
    writeFileSync(join(session.cwd, 'b.txt'), 'b\n');
    git(session.cwd, 'add', '.');
    git(session.cwd, 'commit', '-qm', 'b');
    await app.manager.archive(id, { removeWorktree: true });
    git(app.cwd, 'switch', '-q', 'fix/x');
    prepare.mockResolvedValueOnce(EMPTY);
    await app.manager.open(id);
    expect(git(session.cwd, 'rev-parse', 'HEAD')).toBe(git(app.cwd, 'rev-parse', 'fix/x'));
    initialized(app.pipe(id));
    await app.waitFor('受け付け', () => app.manager.stateOf(id) === 'idle');
    expect(infos(id)[0]).toContain('ブランチ fix/x はほかの場所で取り出しているため、その先頭から、ブランチから外れた状態（detached HEAD）で作り直しました');
    // detached HEAD のまま、もう一度消して作り直しても、残したブランチ（fix/x）を忘れない
    app.manager.archive(id, { removeWorktree: true }).catch(() => null);
    await app.waitFor('消す', () => !existsSync(session.cwd));
    await app.waitFor('アーカイブ', () => app.manager.stateOf(id) === 'archived');
    git(app.cwd, 'switch', '-q', 'main');
    prepare.mockResolvedValueOnce(EMPTY);
    await app.manager.open(id);
    expect(git(session.cwd, 'branch', '--show-current')).toBe('fix/x');
  });

  it('作り直しに失敗しても、残したブランチは忘れず、次に開いたときにそのブランチで作り直す', async () => {
    start();
    const { id, session } = await ready();
    git(session.cwd, 'switch', '-q', '-c', 'fix/x');
    writeFileSync(join(session.cwd, 'b.txt'), 'b\n');
    git(session.cwd, 'add', '.');
    git(session.cwd, 'commit', '-qm', 'b');
    await app.manager.archive(id, { removeWorktree: true });
    // worktree を置くフォルダをファイルにして、git が worktree を作れないようにする（一時的な失敗の代わり）
    const parent = join(app.cwd, '.claude', 'worktrees');
    rmSync(parent, { recursive: true, force: true });
    writeFileSync(parent, '');
    await expect(app.manager.open(id)).rejects.toThrow();
    expect(app.manager.summary(id)?.worktree?.preparing).toBeNull();
    rmSync(parent);
    mkdirSync(parent);
    prepare.mockResolvedValueOnce(EMPTY);
    await app.manager.open(id);
    expect(git(session.cwd, 'branch', '--show-current')).toBe('fix/x');
  });

  it('アーカイブで worktree を消すときも、ほかのセッションが中で動いていれば消さずに理由を返す（ワークスペースに追加したフォルダも、シンボリックリンク越しでも）', async () => {
    start();
    const { id, session } = await ready();
    const alias = join(mkdtempSync(join(tmpdir(), 'tanacode-alias-')), 'repo');
    symlinkSync(app.cwd, alias);
    const through = join(alias, '.claude', 'worktrees', session.worktree!.name);
    const other = app.manager.create(app.cwd, { ...NEW, worktree: false, addedFolders: [through] });
    expect(app.manager.addedFoldersOf(other)).toEqual([through]);
    await expect(app.manager.archive(id, { removeWorktree: true })).rejects.toThrow('この worktree の中で動いているため');
    expect(app.manager.stateOf(id)).toBe('archived');
    expect(existsSync(session.cwd)).toBe(true);
  });

  it('消し終わるのを待っている間にアーカイブし直したら、「準備中」を一覧に残さない', async () => {
    start();
    const { id } = await ready();
    await app.manager.archive(id);
    const removing = app.manager.removeLeftWorktree(id);
    const opening = app.manager.open(id);
    expect(app.manager.summary(id)?.worktree?.preparing).toBe('restoring');
    await app.manager.archive(id);
    await removing;
    await opening;
    expect(app.manager.summary(id)?.worktree?.preparing).toBeNull();
    expect(app.sessionLists.at(-1)?.find((s) => s.id === id)?.worktree?.preparing).toBeNull();
  });
});
