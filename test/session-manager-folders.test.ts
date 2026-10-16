import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceWatchers } from '../src/main/workspace-watcher';
import { fixtureScreen, line, ScriptedApp, type ScriptedPty } from './helpers/scripted-claude';

// ワークスペースに追加したフォルダ（SessionManager）: 記録・一覧・--add-dir での受け渡しと、変えたときの起動し直しの時期・見張り

let app: ScriptedApp;
let a: string;
let b: string;
beforeEach(() => {
  app = new ScriptedApp();
  a = join(app.root, 'a');
  b = join(app.root, 'b');
  mkdirSync(a);
  mkdirSync(b);
});
afterEach(() => {
  vi.restoreAllMocks();
  app.dispose();
});

// --add-dir の値（次の -- まで）。付いていなければ null
function addDirs(pty: ScriptedPty): string[] | null {
  const args = pty.request.args;
  const i = args.indexOf('--add-dir');
  if (i < 0) return null;
  const end = args.findIndex((arg, j) => j > i && arg.startsWith('--'));
  return args.slice(i + 1, end < 0 ? undefined : end);
}

const spawnedFor = (id: string) => app.host.spawned.filter((p) => p.request.tag === id).length;
// 起動し直しは、状態の知らせを終えてから（setImmediate）なので、その分だけ待つ
const settle = () => new Promise((r) => setImmediate(r));
// 起動し直した claude の入力欄を出して、手が空くのを待つ（app.ready は、前の claude の画面で済んだことになるので使わない）
async function readyAgain(id: string): Promise<void> {
  app.pty(id).output(fixtureScreen('prompt'));
  await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
}

describe('記録と起動の引数', () => {
  it('始めるときに渡したフォルダを覚えて一覧に出し、--add-dir で渡す（値は --settings より前で終わる）', () => {
    const { id, pty } = app.create({ addedFolders: [a, b] });
    expect(app.manager.summary(id)?.addedFolders).toEqual([a, b]);
    expect(app.manager.addedFoldersOf(id)).toEqual([a, b]);
    expect(addDirs(pty)).toEqual([a, b]);
    expect(pty.request.args.indexOf('--add-dir')).toBeLessThan(pty.request.args.indexOf('--settings'));
  });

  it('追加したフォルダが無ければ --add-dir を付けない。一覧は空', () => {
    const { id, pty } = app.create();
    expect(addDirs(pty)).toBeNull();
    expect(app.manager.summary(id)?.addedFolders).toEqual([]);
  });

  it('止まっているセッションは起動し直さず、次に開くときに渡す', async () => {
    const { id, pty } = app.create();
    pty.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    app.manager.setAddedFolders(id, [a]);
    await settle();
    expect(spawnedFor(id)).toBe(1);
    expect(app.sessions.find((s) => s.id === id)?.addedFolders).toEqual([a]);
    await app.manager.open(id);
    expect(addDirs(app.pty(id))).toEqual([a]);
  });

  it('追加したあとで消したフォルダは、--add-dir に渡さない（一覧には残す）', async () => {
    const { id, pty } = app.create({ addedFolders: [a, b] });
    rmSync(a, { recursive: true });
    pty.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.manager.open(id);
    expect(addDirs(app.pty(id))).toEqual([b]);
    expect(app.manager.summary(id)?.addedFolders).toEqual([a, b]);
  });

  it('知らないセッションには足さない', () => {
    expect(() => app.manager.setAddedFolders('unknown', [a])).toThrow('unknown session: unknown');
  });
});

describe('動いているセッションで変えたとき', () => {
  it('待機中なら、すぐに起動し直して渡す。外したときも同じ', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    app.manager.setAddedFolders(id, [a, b]);
    // 一覧には、起動し直す前から出す
    expect(app.sessions.find((s) => s.id === id)?.addedFolders).toEqual([a, b]);
    await settle();
    expect(pty.killed).toBe(true);
    expect(addDirs(app.pty(id))).toEqual([a, b]);

    await readyAgain(id);
    app.manager.setAddedFolders(id, [b]);
    await settle();
    expect(spawnedFor(id)).toBe(3);
    expect(addDirs(app.pty(id))).toEqual([b]);
    // 渡し終えたら、手が空いても、もう起動し直さない
    await readyAgain(id);
    await settle();
    expect(spawnedFor(id)).toBe(3);
  });

  it('作業中は止めず、ターンが終わって手が空いてから起動し直す', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    app.append(id, line.user('作業して'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    app.manager.setAddedFolders(id, [a]);
    await settle();
    expect(pty.killed).toBe(false);
    app.append(id, line.text('しました'), line.turnEnd());
    await app.waitFor('起動し直し', () => spawnedFor(id) === 2);
    expect(pty.killed).toBe(true);
    // 会話があるので、同じ会話を --resume で続ける
    expect(app.pty(id).arg('--resume')).toBe(pty.arg('--session-id'));
    expect(addDirs(app.pty(id))).toEqual([a]);
  });

  it('起動中（入力欄が出る前）に変えたら、入力欄が出て手が空いてから起動し直す', async () => {
    const { id, pty } = app.create();
    app.manager.setAddedFolders(id, [a]);
    await settle();
    expect(pty.killed).toBe(false);
    await app.ready(id);
    await app.waitFor('起動し直し', () => spawnedFor(id) === 2);
    expect(addDirs(app.pty(id))).toEqual([a]);
  });

  it('ほかの理由で先に起動し直したら（restart）、そのときに渡すので、手が空いても重ねて起動し直さない', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('作業して'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    app.manager.setAddedFolders(id, [a]);
    app.manager.restart(id);
    expect(addDirs(app.pty(id))).toEqual([a]);
    await readyAgain(id);
    await settle();
    expect(spawnedFor(id)).toBe(2);
  });

  it('渡す前にアプリを終えて、次のアプリが claude を引き継いだら、手が空いてから起動し直して渡す', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    app.append(id, line.user('作業して'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    app.manager.setAddedFolders(id, [a]);
    // 前のアプリでは渡せないまま、claude は動き続けている（ここでは、引き継ぐ前に今の pty を終えて、引き継ぐ pty に替える）
    pty.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    app.host.hosted = [{ kind: 'pty', id: 'pty-1', tag: id, pid: 100, startedAt: Date.now() - 60_000, cols: 120, rows: 40, exitCode: null, screen: '' }];
    await app.manager.adopt();
    const adopted = app.host.attached.find((p) => p.request.tag === id)!;
    expect(spawnedFor(id)).toBe(1);
    // ターンが終わって手が空いたら、引き継いだ claude を止めて、--add-dir を付けて起動し直す
    app.append(id, line.text('しました'), line.turnEnd());
    adopted.output('');
    await app.waitFor('起動し直し', () => spawnedFor(id) === 2);
    expect(adopted.killed).toBe(true);
    expect(addDirs(app.pty(id))).toEqual([a]);
  });
});

describe('見張り', () => {
  it('動いているセッションの追加フォルダを見張り、外したら・アーカイブしたらやめる', async () => {
    const retain = vi.spyOn(WorkspaceWatchers.prototype, 'retain');
    const release = vi.spyOn(WorkspaceWatchers.prototype, 'release');
    const { id } = app.create({ addedFolders: [a] });
    expect(retain.mock.calls).toContainEqual([a]);
    app.manager.setAddedFolders(id, [b]);
    expect(retain.mock.calls.filter(([f]) => f === b)).toHaveLength(1);
    expect(release.mock.calls).toEqual([[a]]);
    await app.manager.archive(id);
    expect(release.mock.calls).toContainEqual([b]);
    // アーカイブしたセッションで変えても、見張らない
    retain.mockClear();
    app.manager.setAddedFolders(id, [a]);
    expect(retain).not.toHaveBeenCalled();
  });
});
