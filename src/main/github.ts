import { execFile } from 'node:child_process';

// GitHub の PR。gh pr list --json の形のまま
export type PullRequest = {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headRefOid: string;
  baseRefName: string;
  url: string;
};

// gh の返事を待つ上限（ミリ秒）
const GH_TIMEOUT = 10_000;

// cwd のリポジトリで、branch を head にした PR（新しい順）。gh が無い・ログインしていない・GitHub のリポジトリでないなど、
// 調べられなければ null。gh は、起動時に取り込んだログインシェルの PATH から探す（Finder から起動しても Homebrew の gh が見つかる）
export function pullRequestsOf(cwd: string, branch: string): Promise<PullRequest[] | null> {
  const args = ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '20', '--json', 'number,state,headRefOid,baseRefName,url'];
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: GH_TIMEOUT, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const list: unknown = JSON.parse(stdout);
        resolve(Array.isArray(list) ? (list as PullRequest[]) : null);
      } catch {
        resolve(null);
      }
    });
  });
}
