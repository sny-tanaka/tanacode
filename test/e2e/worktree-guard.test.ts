import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// worktree やブランチを消す操作の歯止め（worktree-guard）。消して失うものが無いと確かめられたもの（マージ済みの PR のブランチの
// git branch -D）と、文字列の中に出てくるだけのものでは、許可の確認を出さず、手元にしか無いコミットのあるブランチの git branch -D では
// 今までどおり出す。Bash は許可の設定で許してあるので、確認が出るのは歯止めが出させたときだけ。
// PR（gh）は PATH の先頭に置いた偽物が返す（GitHub には問い合わせない）。ほかは本物（アプリ・確かめの入り口・Claude Code・git）

const PROMPT = 'ブランチを片付けてください';
const DONE = '片付けました';
const MERGED = 'fix/e2e-merged';
const LOCAL = 'fix/e2e-local';

// gh pr list --head <ブランチ> の代わり。MERGED は、手元の先頭を head にした、マージ済みの PR（リモートのブランチは消してある）
const GH = `#!/bin/sh
head=""; prev=""
for a in "$@"; do [ "$prev" = "--head" ] && head="$a"; prev="$a"; done
case "$head" in
  ${MERGED}) mine=$(git rev-parse "refs/heads/$head"); printf '[{"number":5,"state":"MERGED","headRefOid":"%s","baseRefName":"main","url":"https://example.test/pr/5","commits":[{"oid":"%s"}]}]' "$mine" "$mine" ;;
  *) echo '[]' ;;
esac
`;

const bash = (id: string, command: string) => [{ type: 'tool_use' as const, id, name: 'Bash', input: { command, description: '片付ける' } }];

describe('worktree やブランチを消す操作の歯止め', () => {
  let app: E2EApp;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: app.work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const branches = () => git('branch', '--format=%(refname:short)').split('\n');

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      git: true,
      files: { 'a.txt': 'a\n' },
      commands: { gh: GH },
      claudeSettings: { permissions: { allow: ['Bash'] } },
      conversations: () => [
        {
          match: PROMPT,
          steps: [
            bash('toolu_merged', `git branch -D ${MERGED}`),
            bash('toolu_text', "echo 'あとで git branch -D foo する' > note.txt"),
            bash('toolu_local', `git branch -D ${LOCAL}`),
            [{ type: 'text', text: DONE }],
          ],
        },
      ],
    });
    // どちらのブランチにも、main に無いコミットを 1 つずつ作る
    for (const branch of [MERGED, LOCAL]) {
      git('switch', '-q', '-c', branch);
      execFileSync('sh', ['-c', `echo ${branch} > b.txt && git add b.txt && git commit -qm ${branch}`], { cwd: app.work });
      git('switch', '-q', 'main');
    }
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`worktree-guard-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('マージ済みの PR のブランチの git branch -D と、文字列の中に出てくるだけのものでは、確認を出さない', async () => {
    await app.startSession(PROMPT, { mode: 'manual' });
    // 最初に出る確認は、手元にしか無いコミットのあるブランチのもの
    const card = await app.menuCard('permission');
    expect(await card.textContent()).toContain(LOCAL);
    expect(branches()).not.toContain(MERGED);
    expect(existsSync(join(app.work, 'note.txt'))).toBe(true);
    expect(app.api.toolResults.some((r) => r.includes(`Deleted branch ${MERGED}`))).toBe(true);
  });

  it('手元にしか無いコミットのあるブランチは、確認に答えてから消える', async () => {
    expect(branches()).toContain(LOCAL);
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', DONE).waitFor();
    expect(branches()).not.toContain(LOCAL);
  });
});
