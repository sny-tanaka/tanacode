// Claude Code の新しいバージョンを見張り、出たら claude-code-check.yml を、そのバージョンを指定して手動の実行で起こす（Cloudflare Workers の Cron Triggers で 10 分おき）。
// GitHub の定期の実行は数時間遅れるので、その代わり。仕組みと置き方は CONTRIBUTING.md の「Claude Code との互換性の確かめ方」
// - 送ったことがあるかは、claude-code-check の手動の実行の名前（run-name に入れたバージョン）で調べる。Worker には何も覚えさせない
//   （確認が失敗して Issue が立っていても、同じバージョンでは送り直さない。手で動かした実行も、送ったものとして数える）
// - 古いバージョンに戻ったとき（npm の latest が下がったとき）も送る。確かめたあと、動作確認済のバージョンを下げることはない（scripts/update-verified-version.mjs）

const REPO = 'sny-tanaka/tanacode';
const WORKFLOW = 'claude-code-check.yml';
const BRANCH = 'develop';
const PACKAGE_LATEST = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';

export default {
  async scheduled(_controller, env) {
    await watch(env, fetch);
  },
};

/**
 * @param {{ GITHUB_TOKEN: string }} env
 * @param {typeof fetch} fetchFn
 * @returns {Promise<'dispatched' | 'seen'>}
 */
export async function watch(env, fetchFn) {
  const latest = await latestVersion(fetchFn);
  const github = (path, init = {}) =>
    fetchFn(`https://api.github.com/repos/${REPO}/actions/${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'user-agent': 'tanacode-claude-code-watch',
        'x-github-api-version': '2022-11-28',
        ...init.headers,
      },
    });

  // ワークフローの run-name と同じ形
  const title = `Claude Code ${latest} を確かめる`;
  const runs = await github(`workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=100`);
  if (!runs.ok) throw new Error(`Failed to list the runs: ${runs.status} ${await runs.text()}`);
  const { workflow_runs } = await runs.json();
  if (workflow_runs.some((run) => run.display_title === title)) return 'seen';

  const res = await github(`workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: BRANCH, inputs: { version: latest } }),
  });
  if (!res.ok) throw new Error(`Failed to dispatch ${WORKFLOW}: ${res.status} ${await res.text()}`);
  console.log(`Dispatched ${WORKFLOW} for Claude Code ${latest}`);
  return 'dispatched';
}

/** @param {typeof fetch} fetchFn */
async function latestVersion(fetchFn) {
  // 全バージョンの一覧（数 MB）ではなく、最新の 1 つだけ（数 KB）を読む。無料プランの CPU 時間（1 回 10 ms）に収めるため
  const res = await fetchFn(PACKAGE_LATEST, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Failed to read the latest Claude Code: ${res.status}`);
  const { version } = await res.json();
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`Unexpected version: ${version}`);
  return version;
}
