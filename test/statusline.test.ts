import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_FILE_ENV } from '@shared/chat';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import type { StatusLineInfo } from '@shared/statusline';
import { STATUS_FILE_ENV, StatusLineWatcher, ownSettings, parseStatusLine, sessionSettings, userStatusLineCommand } from '../src/main/statusline';

// statusLine の JSON の読み取り・アプリが Claude Code に渡す設定・セッションごとのファイルの見張り（statusline.ts）。
// JSON の形は、動作確認済の Claude Code の控え（test/fixtures/claude-code/<バージョン>/statusline.json・ask.json）を使う。
// 利用枠（rate_limits）は、控えを取るときの API キーでのログインでは出ないので、src の読み取り（five_hour・seven_day）に合わせて組み立てた

const FIXTURE = join('test', 'fixtures', 'claude-code', VERIFIED_CLAUDE_CODE_VERSION);
const statusJson = readFileSync(join(FIXTURE, 'statusline.json'), 'utf8');
const askJson = readFileSync(join(FIXTURE, 'ask.json'), 'utf8');

describe('parseStatusLine', () => {
  it('控えの statusLine から、モデル・バージョン・コンテキスト・料金・会話ログを読む', () => {
    expect(parseStatusLine(statusJson, 123)).toEqual({
      model: { id: 'claude-opus-5-5', name: 'Opus 5.5' },
      version: VERIFIED_CLAUDE_CODE_VERSION,
      context: { size: 1_000_000, usedPercent: 0, tokens: 100 },
      rateLimits: null,
      costUsd: 0.0026,
      transcriptPath: JSON.parse(statusJson).transcript_path,
      updatedAt: 123,
    });
  });

  it('利用枠は、5 時間と 7 日の使った割合と、戻る時刻（秒からミリ秒に）を読む。分からないものは null', () => {
    const raw = JSON.parse(statusJson);
    const info = parseStatusLine(
      JSON.stringify({ ...raw, rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_791_400_000 }, seven_day: { used_percentage: 7 } } }),
      1,
    );
    expect(info?.rateLimits).toEqual({ fiveHour: { percent: 42, resetsAt: 1_791_400_000_000 }, sevenDay: { percent: 7, resetsAt: null } });
    expect(parseStatusLine(JSON.stringify({ rate_limits: { five_hour: {} } }), 1)?.rateLimits).toEqual({ fiveHour: null, sevenDay: null });
  });

  it('項目が欠けていれば null・0 にする。JSON でなければ null', () => {
    expect(parseStatusLine('{}', 5)).toEqual({ model: null, version: null, context: null, rateLimits: null, costUsd: null, transcriptPath: null, updatedAt: 5 });
    // モデルの表示名が無ければ ID。使った量の内訳が無ければ 0
    const partial = parseStatusLine(JSON.stringify({ model: { id: 'claude-x' }, context_window: { context_window_size: 200_000, used_percentage: 12 } }), 5);
    expect(partial).toMatchObject({ model: { id: 'claude-x', name: 'claude-x' }, context: { size: 200_000, usedPercent: 12, tokens: 0 } });
    // 内訳の一部だけ
    const cache = parseStatusLine(JSON.stringify({ context_window: { context_window_size: 10, used_percentage: 1, current_usage: { cache_read_input_tokens: 7 } } }), 5);
    expect(cache?.context?.tokens).toBe(7);
    // 割合の無いコンテキスト・ID の無いモデルは読まない
    expect(parseStatusLine(JSON.stringify({ model: { display_name: 'X' }, context_window: { context_window_size: 10 } }), 5)).toMatchObject({ model: null, context: null });
    expect(parseStatusLine('{"model":', 5)).toBeNull();
  });
});

describe('アプリが Claude Code に渡す設定', () => {
  const home = mkdtempSync(join(tmpdir(), 'tanacode-statusline-home-'));
  const oldHome = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = oldHome;
    rmSync(join(home, '.claude'), { recursive: true, force: true });
  });
  const writeSettings = (settings: unknown) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  };

  it('ユーザーの statusLine が無ければ、JSON をファイルに書くだけ。あれば同じ JSON をそのコマンドにも渡す', () => {
    expect(userStatusLineCommand()).toBeNull();
    const plain = JSON.parse(sessionSettings()) as { statusLine: { type: string; command: string } };
    expect(plain.statusLine).toEqual({ type: 'command', command: `cat > "$${STATUS_FILE_ENV}"` });
    writeSettings({ statusLine: { type: 'command', command: 'runcat-statusline' } });
    expect(userStatusLineCommand()).toBe('runcat-statusline');
    const withUser = JSON.parse(sessionSettings()) as { statusLine: { command: string } };
    expect(withUser.statusLine.command).toBe(`tee "$${STATUS_FILE_ENV}" | runcat-statusline`);
  });

  it('コマンドでない statusLine・コマンドが空のもの・読めない設定は使わない', () => {
    writeSettings({ statusLine: { type: 'static', command: 'x' } });
    expect(userStatusLineCommand()).toBeNull();
    writeSettings({ statusLine: { type: 'command', command: '' } });
    expect(userStatusLineCommand()).toBeNull();
    writeSettings({});
    expect(userStatusLineCommand()).toBeNull();
    writeSettings('{壊れた');
    expect(userStatusLineCommand()).toBeNull();
  });

  it('AskUserQuestion と Bash の前のフックはいつも、ブラウザ・セッションのフックは使うときだけ足す', () => {
    const matchers = (s: Record<string, unknown>) => (s as { hooks: { PreToolUse: { matcher: string }[] } }).hooks.PreToolUse.map((h) => h.matcher);
    const base = ownSettings(null) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
    expect(base.hooks.PreToolUse[0]).toEqual({ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `cat > "$${ASK_FILE_ENV}"` }] });
    expect(matchers(base)).toEqual(['AskUserQuestion', 'Bash']);
    expect(matchers(ownSettings(null, true, true))).toHaveLength(4);
    expect(matchers(ownSettings(null, false, true))).toEqual(['AskUserQuestion', 'Bash', expect.any(String)]);
    expect(JSON.parse(sessionSettings(true, false)).hooks.PreToolUse).toHaveLength(3);
  });
});

describe('StatusLineWatcher', () => {
  let dir: string;
  let watcher: StatusLineWatcher | null = null;
  let infos: { sessionId: string; info: StatusLineInfo }[];
  let asks: { sessionId: string; input: unknown }[];

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'tanacode-statusline-')), 'statusline');
    infos = [];
    asks = [];
    watcher = new StatusLineWatcher(
      dir,
      (sessionId, info) => infos.push({ sessionId, info }),
      (sessionId, input) => asks.push({ sessionId, input }),
    );
  });

  afterEach(() => {
    watcher?.close();
    rmSync(join(dir, '..'), { recursive: true, force: true });
  });

  // 見張りを始め、変更が届くようになるまで待つ。macOS の fs.watch（FSEvents）は、始めた直後の変更を取りこぼすことがあるので、
  // 関係の無いセッションのファイル（probe.json。読んでも壊れていて知らせない）を書き直しながら、見張りが気づくのを待つ
  async function live(w: StatusLineWatcher) {
    await w.start();
    const timers = (w as unknown as { timers: Map<string, unknown> }).timers;
    for (let wrote = 0, end = Date.now() + 10_000; !timers.has('probe') && Date.now() < end; ) {
      if (Date.now() - wrote >= 50) {
        writeFileSync(join(dir, 'probe.json'), '{');
        wrote = Date.now();
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(timers.has('probe')).toBe(true);
  }

  it('セッションごとのファイルの場所', () => {
    expect(watcher!.fileFor('s1')).toBe(join(dir, 's1.json'));
    expect(watcher!.askFileFor('s1')).toBe(join(dir, 's1.ask.json'));
  });

  it('statusLine のファイルが書かれたら、少し待ってから読んで知らせる。続けて書かれたら最後の 1 回だけ読む', async () => {
    await live(watcher!);
    writeFileSync(watcher!.fileFor('s1'), '{"version":"0.0.1"}');
    writeFileSync(watcher!.fileFor('s1'), statusJson);
    await expect.poll(() => infos.length).toBe(1);
    expect(infos[0]).toMatchObject({ sessionId: 's1', info: { version: VERIFIED_CLAUDE_CODE_VERSION, model: { id: 'claude-opus-5-5' } } });
    expect(infos[0].info.updatedAt).toBeGreaterThan(Date.now() - 5000);
    // 関係の無いファイル（.json でないもの）は読まない
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 's1'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(infos).toHaveLength(1);
  });

  it('AskUserQuestion のフックが書いた入力を読み、tool_input を渡す。書きかけ（壊れた JSON）は渡さない', async () => {
    await live(watcher!);
    writeFileSync(watcher!.askFileFor('s1'), '{"tool_input":');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(asks).toEqual([]);
    writeFileSync(watcher!.askFileFor('s1'), askJson);
    await expect.poll(() => asks.length).toBe(1);
    expect(asks).toEqual([{ sessionId: 's1', input: JSON.parse(askJson).tool_input }]);
    // statusLine のファイルとしては読まない
    expect(infos).toEqual([]);
  });

  it('質問のファイルが続けて書かれたら、読むのは最後の 1 回だけ', async () => {
    // 見張りの知らせは本物のまま、待ち時間（setTimeout）だけを進める
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await live(watcher!);
      const timers = (watcher as unknown as { timers: Map<string, unknown> }).timers;
      const until = async (done: () => boolean) => {
        for (const end = Date.now() + 3000; !done() && Date.now() < end; ) await new Promise((resolve) => setImmediate(resolve));
      };
      writeFileSync(watcher!.askFileFor('s1'), askJson);
      await until(() => timers.has('s1.ask.json'));
      const first = timers.get('s1.ask.json');
      writeFileSync(watcher!.askFileFor('s1'), askJson);
      await until(() => timers.get('s1.ask.json') !== first);
      expect(timers.get('s1.ask.json')).not.toBe(first);
      vi.advanceTimersByTime(50);
      await until(() => asks.length > 0);
      await new Promise((resolve) => setImmediate(resolve));
      await until(() => asks.length > 1);
      expect(asks).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('見張りの知らせのあとにファイルが消えていたら、何も渡さない', async () => {
    await live(watcher!);
    writeFileSync(watcher!.askFileFor('gone'), askJson);
    writeFileSync(watcher!.fileFor('gone'), statusJson);
    rmSync(watcher!.askFileFor('gone'));
    rmSync(watcher!.fileFor('gone'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(asks).toEqual([]);
    expect(infos).toEqual([]);
  });

  it('peek は知らせずに今のファイルを読み、時刻はファイルが書かれた時刻。read は読んで知らせる。無ければどちらも null', async () => {
    mkdirSync(dir, { recursive: true });
    expect(await watcher!.peek('s1')).toBeNull();
    expect(await watcher!.read('s1')).toBeNull();
    writeFileSync(watcher!.fileFor('s1'), statusJson);
    const written = new Date('2026-10-01T00:00:00Z');
    utimesSync(watcher!.fileFor('s1'), written, written);
    const peeked = await watcher!.peek('s1');
    expect(peeked?.version).toBe(VERIFIED_CLAUDE_CODE_VERSION);
    expect(peeked?.updatedAt).toBe(written.getTime());
    expect(infos).toEqual([]);
    const read = await watcher!.read('s1');
    expect(read?.version).toBe(VERIFIED_CLAUDE_CODE_VERSION);
    expect(infos).toHaveLength(1);
    // 壊れたものは null で、知らせない
    writeFileSync(watcher!.fileFor('s2'), '{');
    expect(await watcher!.read('s2')).toBeNull();
    expect(await watcher!.peek('s2')).toBeNull();
    expect(infos).toHaveLength(1);
  });

  it('閉じたら、待っている読み込みもやめる', async () => {
    await live(watcher!);
    writeFileSync(watcher!.fileFor('s1'), statusJson);
    await expect.poll(() => (watcher as unknown as { timers: Map<string, unknown> }).timers.has('s1')).toBe(true);
    watcher!.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(infos).toEqual([]);
    // 始める前に閉じても落ちない
    new StatusLineWatcher(dir, () => {}).close();
  });

  it('質問の受け手を渡さなくても、質問のファイルを読んで落ちない', async () => {
    const plain = new StatusLineWatcher(dir, (sessionId, info) => infos.push({ sessionId, info }));
    await live(plain);
    writeFileSync(plain.askFileFor('s1'), askJson);
    writeFileSync(plain.fileFor('s1'), statusJson);
    await expect.poll(() => infos.length).toBe(1);
    plain.close();
  });
});
