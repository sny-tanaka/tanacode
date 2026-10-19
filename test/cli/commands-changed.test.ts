import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unreadableStreamLines } from '../scenario';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、セッションの途中で / のコマンドの一覧が変わったとき（system/commands_changed）に、
// 入力欄の / の候補（commandsOf）が、起動し直さなくても新しくなるかを確かめる。
// Claude Code はスキルのフォルダを見張っていて、スキルのファイルを足すと、一覧を作り直して commands_changed を出す。
// 見張りは、起動の途中で裏で始まる（initialize の返事を待たない）。スキルを読み直して控えを取ってから、デバッグの記録に
// 「Watching for changes in skill/command directories: …」と書き、そのあとで chokidar（ポーリング 2 秒・ignoreInitial・
// 書き終わりを 1 秒待つ awaitWriteFinish）を作って、初めの走査が終わる（ready）のを待つ（Claude Code 2.1.302 の本体）。
// 初めの走査が終わる前に足したファイルは、「はじめからあったもの」として入り、変化として知らされない。ready は記録に出ないので、
// 「Watching …」の行を見てすぐに足すと、混んだマシンでは走査より先になって落ちた（CI）。
// そこで、はじめから置いておく .md（スキルの本文でないもの。書き換えても一覧は変わらない）を書き換え、Claude Code が変化に
// 気づいた（Detected skill change）のを見届けてから足す。気づいたなら、見張りは初めの走査を終えて動いている

const version = claudeVersion();

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`;
// 見張りが動いているかを確かめるために書き換える .md（スキルの本文ではない）
const PROBE = '.claude/skills/first/notes.md';

describe(`Claude Code ${version} の / のコマンドの一覧の変化`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  // Claude Code のデバッグの記録（DEBUG_SDK で有効にし、CLAUDE_CODE_DEBUG_LOGS_DIR のファイルに書かせる）
  const debugDir = mkdtempSync(join(tmpdir(), 'tanacode-cli-debug-'));
  const debugLog = join(debugDir, 'claude-debug.txt');
  const debugLines = (pattern: RegExp) => (existsSync(debugLog) ? readFileSync(debugLog, 'utf8').split('\n').filter((l) => pattern.test(l)) : []);

  beforeAll(async () => {
    api = new MockApi();
    run = new ClaudeRun(await api.start(), {
      files: { '.claude/skills/first/SKILL.md': skill('first', 'The first skill'), [PROBE]: 'probe 0\n' },
      env: { DEBUG_SDK: '1', CLAUDE_CODE_DEBUG_LOGS_DIR: debugLog },
    });
    await run.open();
  }, 60_000);

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    rmSync(debugDir, { recursive: true, force: true });
  });

  const names = () => run.manager.commandsOf(run.sessionId!)?.map((c) => c.name) ?? [];
  const watcherLines = () => debugLines(/Watching for changes in skill|Detected skill change|\[skills\]|getSkills returning/).join('\n');

  // 見張りが初めの走査を終えて動いているのを見届ける（上の説明）。書き換えは、Claude Code が気づくまで 5 秒ごと
  // （ポーリングの 2 秒と、書き終わりを待つ 1 秒より長く空ける。続けて書くと、書き終わりを待ち続けて知らされない）
  async function untilWatched(): Promise<void> {
    const until = Date.now() + 30_000;
    for (let n = 1; ; n++) {
      writeFileSync(join(run.cwd, PROBE), `probe ${n}\n`);
      const next = Date.now() + 5_000;
      while (Date.now() < next) {
        if (debugLines(/Detected skill change: .*notes\.md/).length > 0) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (Date.now() > until) throw new Error(`見張りが動き出さない: 時間切れ（書き換え ${n} 回）\n${watcherLines()}`);
    }
  }

  it('起動したときの候補は、initialize の返事の一覧', () => {
    expect(names()).toContain('first');
    expect(names()).not.toContain('second');
  });

  it('プロジェクトのスキルのファイルを足すと、Claude Code が commands_changed を出し、候補に入る', async () => {
    // Claude Code がスキルのフォルダを見張り始め、初めの走査を終えてから足す（上の説明）
    await run.waitUntil('スキルのフォルダの見張りの始まり', () => debugLines(/Watching for changes in skill\/command directories: .*\.claude\/skills/).length > 0, 30_000);
    await untilWatched();
    mkdirSync(join(run.cwd, '.claude', 'skills', 'second'), { recursive: true });
    writeFileSync(join(run.cwd, '.claude', 'skills', 'second', 'SKILL.md'), skill('second', 'The second skill'));
    const added = new Date().toISOString();
    await run.waitUntil('候補に入る', () => names().includes('second'), 30_000).catch((error: Error) => {
      // 落ちたときの手がかり: 足した時刻・Claude Code が変化に気づいたか（デバッグの記録）・commands_changed が届いたか
      const changed = run.streamLines().filter((line) => line.includes('"commands_changed"')).length;
      throw new Error(`${error.message}\n足した時刻: ${added}\ncommands_changed の行: ${changed}\n${watcherLines()}`);
    });
    const changed = run
      .streamLines()
      .map((line) => JSON.parse(line) as { type?: string; subtype?: string; commands?: { name: string }[] })
      .filter((m) => m.type === 'system' && m.subtype === 'commands_changed');
    expect(changed.at(-1)?.commands?.map((c) => c.name)).toEqual(expect.arrayContaining(['first', 'second']));
    expect(run.manager.commandsOf(run.sessionId!)?.find((c) => c.name === 'second')).toMatchObject({ description: expect.stringContaining('The second skill'), source: 'skill' });
  });

  it('アプリの読み取りで、読めない行・知らない種類の行が出ない', () => {
    expect(unreadableStreamLines(run.streamLines())).toEqual({ malformed: 0, unknown: {} });
  });
});
