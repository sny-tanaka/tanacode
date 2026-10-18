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
// 「Watching for changes in skill/command directories: …」と書き、chokidar（ポーリング 2 秒・ignoreInitial）で見張り始める
// （Claude Code 2.1.302 の本体）。それより前に足したファイルは、見張りの最初の走査に「はじめからあったもの」として入り、
// 変化として知らされない（遅いマシンでは、起動した直後に足すと落ちた）。なので、デバッグの記録でこの行が出たのを見届けてから足す。
// chokidar の走査が終わったこと（ready）は記録に出ないが、この台本の見張るフォルダは小さく、走査はすぐ終わる

const version = claudeVersion();

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`;

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
      files: { '.claude/skills/first/SKILL.md': skill('first', 'The first skill') },
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

  it('起動したときの候補は、initialize の返事の一覧', () => {
    expect(names()).toContain('first');
    expect(names()).not.toContain('second');
  });

  it('プロジェクトのスキルのファイルを足すと、Claude Code が commands_changed を出し、候補に入る', async () => {
    // Claude Code がスキルのフォルダを見張り始めてから足す（上の説明）
    await run.waitUntil('スキルのフォルダの見張りの始まり', () => debugLines(/Watching for changes in skill\/command directories: .*\.claude\/skills/).length > 0, 30_000);
    mkdirSync(join(run.cwd, '.claude', 'skills', 'second'), { recursive: true });
    writeFileSync(join(run.cwd, '.claude', 'skills', 'second', 'SKILL.md'), skill('second', 'The second skill'));
    await run.waitUntil('候補に入る', () => names().includes('second'), 30_000).catch((error: Error) => {
      // 落ちたときの手がかり: Claude Code が変化に気づいたか（デバッグの記録）と、commands_changed が届いたか
      const changed = run.streamLines().filter((line) => line.includes('"commands_changed"')).length;
      throw new Error(`${error.message}\ncommands_changed の行: ${changed}\n${debugLines(/Watching for changes in skill|Detected skill change|getSkills returning/).join('\n')}`);
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
