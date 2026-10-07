import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostedPtyInfo } from '../src/main/pty-host-protocol';
import { DEFAULT_PTY_SIZE } from '../src/main/session-manager';
import { fixtureScreen, line, ScriptedApp } from './helpers/scripted-claude';

// アプリを起動し直したとき、前のアプリが起動して動き続けている claude を引き継ぐ（adopt）。アプリの終了（closeAll）

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// pty ホストが持っている pty
const hosted = (tag: string, patch: Partial<HostedPtyInfo> = {}): HostedPtyInfo => ({
  id: `pty-${tag}`,
  tag,
  pid: 100,
  startedAt: Date.now() - 60_000,
  cols: DEFAULT_PTY_SIZE.cols,
  rows: DEFAULT_PTY_SIZE.rows,
  exitCode: null,
  screen: '',
  ...patch,
});

// 前のアプリで起動していた（今のアプリでは動いていない）セッション。会話ログを書いておく
async function previous(...entries: Record<string, unknown>[]): Promise<string> {
  const { id, pty } = app.create();
  if (entries.length > 0) {
    const file = app.transcript(id);
    mkdirSync(dirname(file), { recursive: true });
    const claudeId = pty.arg('--session-id');
    writeFileSync(file, entries.map((e) => JSON.stringify({ sessionId: claudeId, cwd: app.cwd, ...e })).join('\n') + '\n');
  }
  pty.exit(0);
  await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
  return id;
}

// Remote Control のつながりの行。Claude Code はこの行に時刻を書かない（引き継いだ claude が書いたものか分からない）
const bridgeSession = (bridgeSessionId: string) => ({ ...line.turnEnd(), type: 'bridge-session', subtype: undefined, timestamp: undefined, bridgeSessionId });

const attached = (id: string) => app.host.attached.find((p) => p.request.tag === id);

describe('adopt', () => {
  it('終わった pty は記録を捨て、知らない・アーカイブした・もう動いているセッションの pty は止め、ほかは起動し直さずに引き継ぐ', async () => {
    const adopted = await previous(line.user('はじめ'), line.text('はい'), line.turnEnd());
    const archived = await previous();
    await app.manager.archive(archived);
    const running = app.create().id;
    app.host.hosted = [hosted('exited', { exitCode: 0 }), hosted('unknown'), hosted(archived), hosted(running), hosted(adopted)];
    const spawned = app.host.spawned.length;
    await app.manager.adopt();
    expect(app.host.forgotten).toEqual(['pty-exited']);
    expect(attached('unknown')?.killed).toBe(true);
    expect(attached(archived)?.killed).toBe(true);
    expect(attached(running)?.killed).toBe(true);
    expect(attached(adopted)?.killed).toBe(false);
    expect(app.host.spawned).toHaveLength(spawned);
    expect(app.manager.summary(adopted)?.running).toBe(true);
    // 打った文字は、引き継いだ claude に届く
    app.manager.write(adopted, 'x');
    expect(attached(adopted)?.writes).toEqual(['x']);
  });

  it('引き継いだ claude の今の画面を描き直し、アプリの大きさに合わせる', async () => {
    const id = await previous(line.user('はじめ'), line.text('はい'), line.turnEnd());
    app.host.hosted = [hosted(id, { cols: 100, rows: 30, screen: fixtureScreen('prompt') })];
    await app.manager.adopt();
    expect(attached(id)?.resizes).toEqual([[DEFAULT_PTY_SIZE.cols, DEFAULT_PTY_SIZE.rows]]);
    await app.waitFor('画面', () => app.manager.screen(id)?.state.kind === 'prompt');
    await app.waitFor('読み直し', () => app.manager.stateOf(id) === 'idle');
  });

  it('会話があれば、入力欄が読めるのを待たずに起動済みとする。会話が無ければ、入力欄が出るまで起動中', async () => {
    const talked = await previous(line.user('はじめ'), line.text('はい'), line.turnEnd());
    const fresh = await previous();
    // 画面は何も描かれていない（読み取りがずれたまま、Claude Code が何も描かずに待っている）
    app.host.hosted = [hosted(talked), hosted(fresh)];
    await app.manager.adopt();
    await app.waitFor('起動済み', () => app.manager.stateOf(talked) === 'idle');
    expect(app.manager.snapshot(talked).events.some((e) => e.type === 'ready')).toBe(true);
    await sleep(500);
    expect(app.manager.stateOf(fresh)).toBe('starting');
  });

  it('引き継いだ claude が起動してから書いた行は、読み直した履歴でも今のもの（作業中・順番待ち）として扱う', async () => {
    const startedAt = Date.now() - 10_000;
    const at = (ms: number) => new Date(startedAt + ms).toISOString();
    const id = await previous(
      { ...line.user('前の起動の発言'), timestamp: at(-5000) },
      { ...line.text('はい'), timestamp: at(-4000) },
      { ...line.turnEnd(), timestamp: at(-3000) },
      // ここから、今も動いている claude が書いた
      { ...line.user('今の作業'), timestamp: at(1000) },
      { ...line.turnEnd(), type: 'queue-operation', subtype: undefined, operation: 'enqueue', content: 'あとで', timestamp: at(2000) },
    );
    app.host.hosted = [hosted(id, { startedAt, screen: fixtureScreen('prompt') })];
    await app.manager.adopt();
    await app.waitFor('順番待ち', () => app.manager.snapshot(id).events.some((e) => e.type === 'queue'));
    expect(app.manager.snapshot(id).events.find((e) => e.type === 'queue')).toEqual({ type: 'queue', prompts: ['あとで'] });
    await sleep(300);
    // ターンの途中なので、読み終えてもターンを終えない
    expect(app.manager.stateOf(id)).toBe('working');
  });

  it('読み直した会話ログの最後のつながり（bridge-session）を、今の Remote Control のつながりとして出す', async () => {
    const id = await previous(line.user('はじめ'), bridgeSession('cse_abc'), line.turnEnd());
    app.host.hosted = [hosted(id, { screen: fixtureScreen('prompt') })];
    await app.manager.adopt();
    await app.waitFor('つながり', () => app.manager.snapshot(id).events.some((e) => e.type === 'remote-control'));
    expect(app.manager.snapshot(id).events.filter((e) => e.type === 'remote-control')).toEqual([
      { type: 'remote-control', url: 'https://claude.ai/code/session_abc' },
    ]);
  });

  it('切れていた（空の bridge-session）なら、つながっていないと出す', async () => {
    const id = await previous(line.user('はじめ'), bridgeSession(''), line.turnEnd());
    app.host.hosted = [hosted(id, { screen: fixtureScreen('prompt') })];
    await app.manager.adopt();
    await app.waitFor('つながり', () => app.manager.snapshot(id).events.some((e) => e.type === 'remote-control'));
    expect(app.manager.snapshot(id).events.filter((e) => e.type === 'remote-control')).toEqual([{ type: 'remote-control', url: null }]);
  });

  it('アプリが止まっている間に書かれた statusLine を読む（次の応答を待たない）', async () => {
    const id = await previous(line.user('はじめ'), line.turnEnd());
    writeFileSync(app.statusLines.fileFor(id), JSON.stringify({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, version: '2.1.292' }));
    app.host.hosted = [hosted(id)];
    await app.manager.adopt();
    await app.waitFor('statusLine', () => app.manager.statusLine(id) !== null);
    expect(app.manager.statusLine(id)).toMatchObject({ model: { id: 'claude-opus-5-5', name: 'Opus 5.5' }, version: '2.1.292' });
    expect(app.statusLineInfos.get(id)).toEqual(app.manager.statusLine(id));
  });
});

describe('closeAll', () => {
  it('アプリの終了では claude を止めずに見るのをやめる（次のアプリが引き継ぐ）。2 回目は何もしない', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    app.manager.closeAll(false);
    expect(pty.detached).toBe(true);
    expect(pty.killed).toBe(false);
    app.manager.closeAll(true);
    expect(pty.killed).toBe(false);
  });
});
