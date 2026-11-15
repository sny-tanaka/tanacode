import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { availableAgents, parseAvailableAgents, type RunClaude } from '../src/main/claude-agents';
import { fakeClaudeOnPath } from './helpers/fake-claude';

// 2.1.325 の claude -p --agent <無い名前> が標準エラーに出す知らせ
const NOT_FOUND = "--agent 'tanacode-probe-x' not found. Available agents: claude, Explore, game-producer, game-qa-tester, general-purpose, Plan\n";

describe('使える役（エージェント定義）の名前', () => {
  it('Claude Code の「not found」の知らせから、使える名前の一覧を読む', () => {
    expect(parseAvailableAgents(NOT_FOUND)).toEqual(['claude', 'Explore', 'game-producer', 'game-qa-tester', 'general-purpose', 'Plan']);
  });

  it('知らせの形でなければ null（書き方が変わった・別の理由で失敗した）', () => {
    expect(parseAvailableAgents('error: unknown option --agent')).toBeNull();
    expect(parseAvailableAgents('')).toBeNull();
  });

  it('無い名前を --agent に渡し、会話を残さずに、セッションのフォルダで Claude Code に断らせる', async () => {
    const calls: { args: string[]; cwd: string; env: Record<string, string> }[] = [];
    const run: RunClaude = async (args, cwd, env) => {
      calls.push({ args, cwd, env });
      return { code: 1, stdout: '', stderr: NOT_FOUND };
    };
    expect(await availableAgents('/work/game', '/profiles/work', run)).toContain('game-qa-tester');
    expect(calls[0].cwd).toBe('/work/game');
    expect(calls[0].args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence']));
    expect(calls[0].args[calls[0].args.indexOf('--agent') + 1]).toMatch(/^tanacode-probe-/);
    // プロファイルの設定のフォルダの役も読むように
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe('/profiles/work');
  });

  it('起動できなければ null', async () => {
    expect(await availableAgents('/work', null, () => Promise.reject(new Error('ENOENT')))).toBeNull();
  });
});

describe('使える役の名前（claude を起動して調べる）', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('PATH の claude を、無い名前の --agent で起動し、断りの知らせ（標準エラー・終了コード 1）から読む', async () => {
    restore = fakeClaudeOnPath(`echo "--agent '$3' not found. Available agents: claude, game-qa-tester" >&2\nexit 1`);
    expect(await availableAgents(tmpdir())).toEqual(['claude', 'game-qa-tester']);
  });

  it('断らずに終わったら null（確かめずに渡す）', async () => {
    restore = fakeClaudeOnPath('exit 0');
    expect(await availableAgents(tmpdir())).toBeNull();
  });

  it('claude が見つからなければ null', async () => {
    const before = process.env.PATH;
    restore = () => {
      process.env.PATH = before;
    };
    process.env.PATH = '/nonexistent';
    expect(await availableAgents(tmpdir())).toBeNull();
  });
});
