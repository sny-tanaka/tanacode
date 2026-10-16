import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceWatchers } from '../src/main/workspace-watcher';
import { INIT_RESPONSE, line, ScriptedApp, type ScriptedPipe } from './helpers/scripted-claude';

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
function addDirs(pipe: ScriptedPipe): string[] | null {
  const args = pipe.request.args;
  const i = args.indexOf('--add-dir');
  if (i < 0) return null;
  const end = args.findIndex((arg, j) => j > i && arg.startsWith('--'));
  return args.slice(i + 1, end < 0 ? undefined : end);
}

const spawnedFor = (id: string) => app.host.pipes.filter((p) => p.request.tag === id).length;
// 起動し直しは、状態の知らせを終えてから（setImmediate）なので、その分だけ待つ
const settle = () => new Promise((r) => setImmediate(r));
// 起動し直した claude が起動を終えて、手が空くのを待つ
async function readyAgain(id: string): Promise<void> {
  await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
}

describe('記録と起動の引数', () => {
  it('始めるときに渡したフォルダを覚えて一覧に出し、--add-dir で渡す（値は --settings より前で終わる）', () => {
    const { id, pipe } = app.create({ addedFolders: [a, b] });
    expect(app.manager.summary(id)?.addedFolders).toEqual([a, b]);
    expect(app.manager.addedFoldersOf(id)).toEqual([a, b]);
    expect(addDirs(pipe)).toEqual([a, b]);
    expect(pipe.request.args.indexOf('--add-dir')).toBeLessThan(pipe.request.args.indexOf('--settings'));
  });

  it('追加したフォルダが無ければ --add-dir を付けない。一覧は空', () => {
    const { id, pipe } = app.create();
    expect(addDirs(pipe)).toBeNull();
    expect(app.manager.summary(id)?.addedFolders).toEqual([]);
  });

  it('止まっているセッションは起動し直さず、次に開くときに渡す', async () => {
    const { id, pipe } = app.create();
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    app.manager.setAddedFolders(id, [a]);
    await settle();
    expect(spawnedFor(id)).toBe(1);
    expect(app.sessions.find((s) => s.id === id)?.addedFolders).toEqual([a]);
    await app.manager.open(id);
    expect(addDirs(app.pipe(id))).toEqual([a]);
  });

  it('追加したあとで消したフォルダは、--add-dir に渡さない（一覧には残す）', async () => {
    const { id, pipe } = app.create({ addedFolders: [a, b] });
    rmSync(a, { recursive: true });
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.manager.open(id);
    expect(addDirs(app.pipe(id))).toEqual([b]);
    expect(app.manager.summary(id)?.addedFolders).toEqual([a, b]);
  });

  it('知らないセッションには足さない', () => {
    expect(() => app.manager.setAddedFolders('unknown', [a])).toThrow('unknown session: unknown');
  });
});

describe('動いているセッションで変えたとき', () => {
  it('待機中なら、すぐに起動し直して渡す。外したときも同じ', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.manager.setAddedFolders(id, [a, b]);
    // 一覧には、起動し直す前から出す
    expect(app.sessions.find((s) => s.id === id)?.addedFolders).toEqual([a, b]);
    await app.waitFor('起動し直し', () => spawnedFor(id) === 2);
    expect(pipe.requests('end_session')).toHaveLength(1);
    expect(addDirs(app.pipe(id))).toEqual([a, b]);

    await readyAgain(id);
    app.manager.setAddedFolders(id, [b]);
    await app.waitFor('起動し直し', () => spawnedFor(id) === 3);
    expect(addDirs(app.pipe(id))).toEqual([b]);
    // 渡し終えたら、手が空いても、もう起動し直さない
    await readyAgain(id);
    await settle();
    expect(spawnedFor(id)).toBe(3);
  });

  it('作業中は止めず、ターンが終わって手が空いてから起動し直す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('作業して'), line.text('作業中です'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    app.manager.setAddedFolders(id, [a]);
    await settle();
    expect(pipe.requests('end_session')).toEqual([]);
    app.say(id, line.text('しました'));
    app.finish(id);
    await app.waitFor('起動し直し', () => spawnedFor(id) === 2);
    expect(pipe.requests('end_session')).toHaveLength(1);
    // 会話があるので、同じ会話を --resume で続ける
    expect(app.pipe(id).arg('--resume')).toBe(pipe.arg('--session-id'));
    expect(addDirs(app.pipe(id))).toEqual([a]);
  });

  it('起動中（入力欄が出る前）に変えたら、入力欄が出て手が空いてから起動し直す', async () => {
    app.answers.set('initialize', null);
    const { id, pipe } = app.create();
    app.manager.setAddedFolders(id, [a]);
    await settle();
    expect(pipe.requests('end_session')).toEqual([]);
    pipe.respond(pipe.requests('initialize')[0].request_id, INIT_RESPONSE);
    await app.waitFor('起動し直し', () => spawnedFor(id) === 2);
    expect(addDirs(app.pipe(id))).toEqual([a]);
  });

  it('ほかの理由で先に起動し直したら（restart）、そのときに渡すので、手が空いても重ねて起動し直さない', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.say(id, line.user('作業して'), line.text('作業中です'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    app.manager.setAddedFolders(id, [a]);
    await app.manager.restart(id);
    expect(addDirs(app.pipe(id))).toEqual([a]);
    await readyAgain(id);
    await settle();
    expect(spawnedFor(id)).toBe(2);
  });

  it('渡す前にアプリを終えて、次のアプリが claude を引き継いだら、手が空いてから起動し直して渡す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('作業して'), line.text('作業中です'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    app.manager.setAddedFolders(id, [a]);
    // 前のアプリでは渡せないまま、claude は動き続けている（ここでは、引き継ぐ前に今のパイプを終えて、引き継ぐパイプに替える）
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    app.host.hosted = [
      { kind: 'pipe', id: 'pipe-1', tag: id, pid: 100, startedAt: Date.now() - 60_000, exitCode: null, lastSeq: 1, firstSeq: 1, retained: [], pending: [], ended: false, stderr: '' },
    ];
    await app.manager.adopt();
    const adopted = app.host.attachedPipes.find((p) => p.request.tag === id)!;
    // 前のアプリの頃に始まった、まだ終わっていないターン
    adopted.emit({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started', uuid: 'l1' }, 1);
    adopted.replayed();
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    expect(spawnedFor(id)).toBe(1);
    // ターンが終わって手が空いたら、引き継いだ claude を止めて、--add-dir を付けて起動し直す
    app.say(id, line.text('しました'));
    app.finish(id);
    await app.waitFor('起動し直し', () => spawnedFor(id) === 2);
    expect(adopted.requests('end_session')).toHaveLength(1);
    expect(addDirs(app.pipe(id))).toEqual([a]);
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
