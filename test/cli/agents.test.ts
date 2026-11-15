import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { availableAgents, type RunClaude } from '../../src/main/claude-agents';
import { CLAUDE_BIN, ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、役（エージェント定義。start_session の agent）を確かめる。
// - 使える役の名前を、無い名前を --agent に渡したときの Claude Code の断りの知らせから読める（claude-agents.ts。知らせの形が変わったら失敗する）
// - 役で始めたセッションは、役のシステムプロンプトで動き、モデルを選んでいなければ役の定義の model を使う（--model を付けない）。
//   --resume で起動し直しても同じ

const version = claudeVersion();
// 役のシステムプロンプトの目印（Claude に渡ったかを確かめる）
const ROLE_MARK = 'tanacode の役の確かめ: いつも「点検しました」と答える';
const PROMPT = '役の確かめを始めます';
const AFTER_RESUME = '起動し直したあとの発言です';

describe(`Claude Code ${version} の役（--agent）`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [{ match: PROMPT, steps: [[{ type: 'text', text: 'はじめの返事' }], [{ type: 'text', text: '起動し直したあとの返事' }]] }];
    run = new ClaudeRun(await api.start(), {
      agent: 'cli-reviewer',
      // プロジェクトの役
      files: { '.claude/agents/cli-reviewer.md': `---\nname: cli-reviewer\ndescription: 確かめ用の役\nmodel: haiku\n---\n\n${ROLE_MARK}\n` },
    });
    // ユーザーの役
    mkdirSync(join(run.home, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(run.home, '.claude', 'agents', 'user-role.md'), '---\nname: user-role\ndescription: ユーザーの役\n---\n\nユーザーの役です\n');
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('使える役の名前（ユーザー・プロジェクト・組み込み）を、Claude Code の断りの知らせから読める', async () => {
    const runClaude: RunClaude = (args, cwd, env) =>
      new Promise((resolve) => {
        const { CLAUDE_CONFIG_DIR: _config, ...rest } = env;
        execFile(CLAUDE_BIN, args, { cwd, env: { ...rest, HOME: run.home }, timeout: 15_000 }, (error, stdout, stderr) =>
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout), stderr: String(stderr) }),
        );
      });
    const names = await availableAgents(run.cwd, null, runClaude);
    expect(names).toEqual(expect.arrayContaining(['cli-reviewer', 'user-role', 'general-purpose']));
  });

  it('役で始めると、役のシステムプロンプトと役の定義のモデルで動く。--resume で起動し直しても同じ', async () => {
    await run.open();
    await run.send(PROMPT);
    await run.waitUntil('はじめの返事', replied('はじめの返事'));
    expect(api.systems.at(-1)).toContain(ROLE_MARK);
    expect(api.calls.at(-1)?.model).toMatch(/haiku/);
    run.stopClaude();
    run.start({ resume: true });
    await run.untilState('起動し直し', (state) => state === 'idle');
    await run.send(AFTER_RESUME);
    await run.waitUntil('起動し直したあとの返事', replied('起動し直したあとの返事'));
    expect(api.systems.at(-1)).toContain(ROLE_MARK);
    expect(api.calls.at(-1)?.model).toMatch(/haiku/);
  });
});
