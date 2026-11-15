import { describe, expect, it } from 'vitest';
import { availableAgents, parseAvailableAgents, type RunClaude } from '../src/main/claude-agents';

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
