import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { optimizerArgs, parseMarks, runClaude } from '../../src/main/compact-optimizer';
import { CLAUDE_BIN, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 最適化圧縮で起動する使い捨ての claude（optimizerArgs）が、今の Claude Code で通るか。
// モックの API で動かし、--json-schema の答え（StructuredOutput のツールの入力）が structured_output に入って返るかを確かめる

const PROMPT = 'Context items (oldest first):\n\n<item id="1" kind="topic" label="ログインを直して" tokens="10">\nログインを直して\n</item>';

describe(`Claude Code ${claudeVersion()}（最適化圧縮）`, () => {
  const api = new MockApi();
  let baseUrl = '';
  let home = '';
  beforeAll(async () => {
    baseUrl = await api.start();
    home = mkdtempSync(join(tmpdir(), 'tanacode-cli-optimizer-'));
    // 使う人の設定の hooks（発言のたびに動くもの）。最適化圧縮では動かさない
    mkdirSync(join(home, '.claude'));
    const hook = (name: string) => [{ hooks: [{ type: 'command', command: `touch "${join(home, name)}"` }] }];
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: hook('session-start'), UserPromptSubmit: hook('prompt-submit') } }));
  });
  afterAll(async () => {
    await api.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('標準入力の会話を Haiku に渡し、決めた形の答えを返す。ツール・MCP・hooks は使わず、指示はシステムの文に入る', async () => {
    api.conversations = [
      {
        match: 'Context items (oldest first)',
        steps: [[{ type: 'tool_use', id: 'toolu_marks', name: 'StructuredOutput', input: { marks: [{ id: '1', mark: 'keep' }] } }], [{ type: 'text', text: 'done' }]],
      },
    ];
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      LANG: 'en_US.UTF-8',
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: 'sk-ant-api03-tanacode-cli-check-00000000000000000000',
      NO_PROXY: '127.0.0.1,localhost',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const output = await runClaude(null, env, CLAUDE_BIN)(optimizerArgs(), PROMPT);
    const item = { id: 'topic:u1', kind: 'topic' as const, label: 'ログインを直して', tokens: 10, order: 0, compacted: false };
    expect([...parseMarks(output, [item])]).toEqual([['topic:u1', 'keep']]);
    // 答えの形のツールだけで、ほかのツール（Bash など）や MCP のツールは渡らない
    expect([...api.tools]).toEqual(['StructuredOutput']);
    expect(api.systems.some((s) => s.includes("You decide what a coding agent's context keeps"))).toBe(true);
    expect(existsSync(join(home, 'session-start'))).toBe(false);
    expect(existsSync(join(home, 'prompt-submit'))).toBe(false);
  });
});
