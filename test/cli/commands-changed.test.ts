import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unreadableStreamLines } from '../scenario';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、セッションの途中で / のコマンドの一覧が変わったとき（system/commands_changed）に、
// 入力欄の / の候補（commandsOf）が、起動し直さなくても新しくなるかを確かめる。
// Claude Code はスキルのフォルダを見張っていて、スキルのファイルを足すと、一覧を作り直して commands_changed を出す

const version = claudeVersion();

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`;

describe(`Claude Code ${version} の / のコマンドの一覧の変化`, () => {
  let api: MockApi;
  let run: ClaudeRun;

  beforeAll(async () => {
    api = new MockApi();
    run = new ClaudeRun(await api.start(), { files: { '.claude/skills/first/SKILL.md': skill('first', 'The first skill') } });
    await run.open();
  }, 60_000);

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  const names = () => run.manager.commandsOf(run.sessionId!)?.map((c) => c.name) ?? [];

  it('起動したときの候補は、initialize の返事の一覧', () => {
    expect(names()).toContain('first');
    expect(names()).not.toContain('second');
  });

  it('プロジェクトのスキルのファイルを足すと、Claude Code が commands_changed を出し、候補に入る', async () => {
    mkdirSync(join(run.cwd, '.claude', 'skills', 'second'), { recursive: true });
    writeFileSync(join(run.cwd, '.claude', 'skills', 'second', 'SKILL.md'), skill('second', 'The second skill'));
    await run.waitUntil('候補に入る', () => names().includes('second'), 30_000);
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
