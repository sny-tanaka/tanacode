import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { childEnv } from './claude-session';

// Claude Code が --agent で使えるエージェント定義（役）の名前を調べる。
// `claude agents` は今のバージョンでは裏のセッションの一覧で、役の一覧を出さない（2.1.325 で確認）。定義のファイルを自分で読むと、
// ユーザー（~/.claude/agents）・プロジェクト（.claude/agents）・プラグイン・管理者の設定・組み込み（Explore など）の読み方を真似ることになり、
// ずれる。そこで、無い名前を --agent に渡して Claude Code 自身に断らせ、その知らせ（「--agent 'x' not found. Available agents: a, b」）
// から一覧を読む。断るのはモデルを呼ぶ前なので、利用枠は使わない（実測で 0.1 秒ほど）

const TIMEOUT_MS = 15_000;

// 起動の手段。テストでは差し替える
export type RunClaude = (args: string[], cwd: string, env: Record<string, string>) => Promise<{ code: number | null; stderr: string; stdout: string }>;

const runClaude: RunClaude = (args, cwd, env) =>
  new Promise((resolve) => {
    execFile('claude', args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

// 知らせから名前の一覧を読む。読めなければ null（知らせの書き方が変わった・別の理由で失敗した）
export function parseAvailableAgents(output: string): string[] | null {
  const match = /--agent '[^']*' not found\. Available agents: (.*)$/m.exec(output);
  if (!match) return null;
  return match[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

// cwd で起動した Claude Code が使える役の名前。調べられなければ null（呼び出し側は、確かめずに起動する）。
// claudeDir: プロファイルの設定のフォルダ（null は既定のプロファイル）
export async function availableAgents(cwd: string, claudeDir: string | null = null, run: RunClaude = runClaude): Promise<string[] | null> {
  // 無いはずの名前。万一あっても会話を残さず、最大でも 1 ターンで終わるように
  const probe = `tanacode-probe-${randomUUID()}`;
  const result = await run(['-p', '--agent', probe, '--no-session-persistence', '--max-turns', '1', 'x'], cwd, childEnv(claudeDir)).catch(() => null);
  if (!result) return null;
  return parseAvailableAgents(`${result.stderr}\n${result.stdout}`);
}
