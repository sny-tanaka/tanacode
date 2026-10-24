import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sessionToolId } from '@shared/session-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// 子が worktree の中で git switch -c で作ったブランチで PR を出し、親が end_session で終える。PR がマージ済み（update-branch で
// PR の head が手元より先に進んでいても）なら、そのブランチも起動したときのブランチも消える。PR のあとに手元だけのコミットがあれば、
// そのブランチは残る。PR（gh）は PATH の先頭に置いた偽物が返す（GitHub には問い合わせない）。ほかは本物（アプリ・Claude Code・git）

const PARENT = '二人の子に、それぞれブランチを作って作業させてください';
const MERGED_CHILD = 'マージされる側の作業です';
const OPEN_CHILD = 'マージされない側の作業です';
const MERGED_BRANCH = 'fix/e2e-merged';
const OPEN_BRANCH = 'fix/e2e-open';
const END = '二人の子を片付けてください';
const ENDED = '片付けました';

// gh pr list --head <ブランチ> の代わり。MERGED_BRANCH は、update-branch のマージのコミット（手元に無い）を head にした、マージ済みの PR。
// PR のコミットに、手元の先頭が入っている。OPEN_BRANCH は、手元の 1 つ前のコミットまでの、開いている PR
const GH = `#!/bin/sh
head=""; prev=""
for a in "$@"; do [ "$prev" = "--head" ] && head="$a"; prev="$a"; done
pr() { printf '[{"number":%s,"state":"%s","headRefOid":"%s","baseRefName":"main","url":"https://example.test/pr/%s","commits":[{"oid":"%s"}]}]' "$1" "$2" "$3" "$1" "$4"; }
case "$head" in
  ${MERGED_BRANCH}) mine=$(git rev-parse "refs/heads/$head"); pr 5 MERGED ffffffffffffffffffffffffffffffffffffffff "$mine" ;;
  ${OPEN_BRANCH}) older=$(git rev-parse "refs/heads/$head~1"); pr 6 OPEN "$older" "$older" ;;
  *) echo '[]' ;;
esac
`;

// 子の作業: ブランチを作ってコミットする（OPEN_CHILD は、PR のあとにもう 1 つコミットする）
const work = (branch: string, extra: boolean): Block[] => [
  {
    type: 'tool_use',
    id: `toolu_${branch.replace(/\W/g, '_')}`,
    name: 'Bash',
    input: {
      command: [`git switch -q -c ${branch}`, 'echo one > one.txt', 'git add one.txt', 'git commit -qm one', ...(extra ? ['echo two > two.txt', 'git add two.txt', 'git commit -qm two'] : [])].join(' && '),
      description: 'ブランチを作ってコミットする',
    },
  },
];

describe('子が worktree の中で作ったブランチも、end_session で片付ける', () => {
  let app: E2EApp;
  const branches = () => execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: app.work, encoding: 'utf8' }).trim().split('\n');

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      git: true,
      files: { 'a.txt': 'a\n' },
      commands: { gh: GH },
      claudeSettings: { permissions: { allow: ['Bash'] } },
      conversations: () => [
        {
          match: PARENT,
          steps: [
            [
              { type: 'tool_use', id: 'toolu_merged', name: sessionToolId('start_session'), input: { prompt: MERGED_CHILD, worktree: true, name: 'マージされる子' } },
              { type: 'tool_use', id: 'toolu_open', name: sessionToolId('start_session'), input: { prompt: OPEN_CHILD, worktree: true, name: 'マージされない子' } },
            ],
          ],
        },
        { match: MERGED_CHILD, steps: [work(MERGED_BRANCH, false), [{ type: 'text', text: 'コミットしました' }]] },
        { match: OPEN_CHILD, steps: [work(OPEN_BRANCH, true), [{ type: 'text', text: 'コミットしました' }]] },
      ],
    });
    // 親への 2 回めの頼み（子の知らせが挟まっても、頼みの文で決める）で、2 人の子を end_session で終える（子の ID は、一覧から読む）。
    // その結果を受け取ったら、終わりの返事をする
    app.api.intercept = (prompt, results) => {
      if (results.length > 0 && results.every((r) => r.includes('already_archived'))) return [{ type: 'text', text: ENDED }];
      if (!prompt.includes(END)) return null;
      return children.map((id, i) => ({ type: 'tool_use', id: `toolu_end_${i}`, name: sessionToolId('end_session'), input: { session_id: id } }));
    };
  });

  let children: string[] = [];

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`worktree-end-branch-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('子は worktree の中で git switch -c でブランチを作ってコミットする', async () => {
    await app.startSession(PARENT, { mode: 'manual' });
    // 子の起動の確認に答える（子の Bash は、Claude Code の設定の allow で確認なしに動く）
    for (let i = 0; i < 2; i++) await app.choose(await app.menuCard('permission'), /^許可する/);
    await vi.waitFor(() => expect(branches()).toEqual(expect.arrayContaining([MERGED_BRANCH, OPEN_BRANCH])), { timeout: 120_000, interval: 500 });
    const list = await app.page.evaluate(() =>
      (window as unknown as { tanacode: { sessions: { list(): Promise<{ id: string; parentId: string | null; worktree: unknown }[]> } } }).tanacode.sessions.list(),
    );
    children = list.filter((s) => s.parentId && s.worktree).map((s) => s.id);
    expect(children).toHaveLength(2);
    // 子の手が空くまで待つ（作業中の子は end_session が断る。コミットのあとも、チェックリストの確かめでターンが続くことがある）
    await vi.waitFor(
      async () => {
        const states = await app.page.evaluate(
          (ids) =>
            (window as unknown as { tanacode: { sessions: { list(): Promise<{ id: string; state: string | null }[]> } } }).tanacode.sessions
              .list()
              .then((list) => list.filter((s) => ids.includes(s.id)).map((s) => s.state)),
          children,
        );
        expect(states).toEqual(['idle', 'idle']);
      },
      { timeout: 120_000, interval: 500 },
    );
  });

  it('end_session で、マージ済みの PR のブランチと起動したときのブランチは消え、手元だけのコミットのあるブランチは残る', async () => {
    const before = branches().filter((b) => b.startsWith('worktree-'));
    expect(before).toHaveLength(2);
    await app.send(END);
    await app.byText('.chat-list', ENDED).waitFor({ timeout: 120_000 });
    const after = branches();
    expect(after).not.toContain(MERGED_BRANCH);
    expect(after).toContain(OPEN_BRANCH);
    // 起動したときのブランチは、どちらも手元だけのコミットが無いので消える
    expect(after.filter((b) => b.startsWith('worktree-'))).toEqual([]);
    const results = app.api.toolResults.filter((r) => r.includes('"archived"'));
    expect(results.some((r) => r.includes(`Deleted the branches ${MERGED_BRANCH}, worktree-`))).toBe(true);
    expect(results.some((r) => r.includes(`Kept the branch ${OPEN_BRANCH} because it has commits that exist only locally.`))).toBe(true);
  });
});
