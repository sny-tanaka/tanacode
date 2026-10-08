import * as childProcess from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commentOnPullRequest, pullRequestsOf, type PullRequest } from '../src/main/github';

// GitHub の PR を gh で調べる・コメントを書く（src/main/github.ts）。PATH の先頭に偽の gh（シェルスクリプト）を置いて、
// 本物の execFile で起動する。偽の gh は、呼ばれ方（作業フォルダ・引数・環境変数・標準入力）を控え、決めた出力と終了コードを返す。
// 待つ上限（timeout）は、待って確かめると遅いので、execFile に渡した値で確かめる（execFile は本物のまま呼ぶ）

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
const execFile = vi.mocked(childProcess.execFile);

const FAKE_GH = `#!/bin/sh
{
  printf 'cwd=%s\\n' "$(pwd -P)"
  printf 'prompt=%s\\n' "$GH_PROMPT_DISABLED"
  for a in "$@"; do printf 'arg=%s\\n' "$a"; done
} >> "$GH_FAKE_DIR/calls"
# 標準入力は、コメント（本文を --body-file - で渡す）のときだけ読む
if [ "$2" = "comment" ]; then cat > "$GH_FAKE_DIR/stdin"; fi
[ -f "$GH_FAKE_DIR/stdout" ] && cat "$GH_FAKE_DIR/stdout"
[ -f "$GH_FAKE_DIR/stderr" ] && cat "$GH_FAKE_DIR/stderr" >&2
exit "\${GH_FAKE_EXIT:-0}"
`;

let root: string;
let fake: string;
let repo: string;
const oldPath = process.env.PATH;

beforeEach(() => {
  execFile.mockClear();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-github-')));
  const bin = join(root, 'bin');
  fake = join(root, 'fake');
  repo = join(root, 'repo');
  mkdirSync(bin);
  mkdirSync(fake);
  mkdirSync(repo);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.GH_FAKE_DIR = fake;
  delete process.env.GH_FAKE_EXIT;
  delete process.env.GH_PROMPT_DISABLED;
});

afterEach(() => {
  process.env.PATH = oldPath;
  delete process.env.GH_FAKE_DIR;
  delete process.env.GH_FAKE_EXIT;
  rmSync(root, { recursive: true, force: true });
});

// 偽の gh が返すもの
const replyWith = (o: { stdout?: string; stderr?: string; exit?: number }) => {
  if (o.stdout !== undefined) writeFileSync(join(fake, 'stdout'), o.stdout);
  if (o.stderr !== undefined) writeFileSync(join(fake, 'stderr'), o.stderr);
  if (o.exit !== undefined) process.env.GH_FAKE_EXIT = String(o.exit);
};
// 偽の gh の呼ばれ方（呼ばれた順。1 回分ずつ）
const calls = () => {
  const file = join(fake, 'calls');
  if (!existsSync(file)) return [];
  const out: { cwd: string; prompt: string; args: string[] }[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('cwd=')) out.push({ cwd: line.slice(4), prompt: '', args: [] });
    else if (line.startsWith('prompt=')) out[out.length - 1].prompt = line.slice(7);
    else if (line.startsWith('arg=')) out[out.length - 1].args.push(line.slice(4));
  }
  return out;
};
const optionsOfLastCall = () => execFile.mock.calls.at(-1)?.[2] as { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv };

const PR: PullRequest = { number: 12, state: 'OPEN', headRefOid: 'abc123', baseRefName: 'main', url: 'https://github.com/me/cafe/pull/12' };

describe('PR を調べる（pullRequestsOf）', () => {
  it('作業フォルダで gh pr list を、ブランチを head に、全部の状態・20 件まで・必要な項目だけで呼び、返した一覧をそのまま返す', async () => {
    const merged: PullRequest = { ...PR, number: 9, state: 'MERGED', headRefOid: 'def456' };
    replyWith({ stdout: JSON.stringify([PR, merged]) });
    await expect(pullRequestsOf(repo, 'feature/メニュー')).resolves.toEqual([PR, merged]);
    expect(calls()).toEqual([
      {
        cwd: repo,
        // 確認を出させない（アプリから動かすので、答えられない）
        prompt: '1',
        args: ['pr', 'list', '--head', 'feature/メニュー', '--state', 'all', '--limit', '20', '--json', 'number,state,headRefOid,baseRefName,url'],
      },
    ]);
  });

  it('返事は 10 秒まで待つ。ほかの環境変数（PATH など）は、そのまま gh に渡す', async () => {
    replyWith({ stdout: '[]' });
    await expect(pullRequestsOf(repo, 'main')).resolves.toEqual([]);
    const options = optionsOfLastCall();
    expect(execFile.mock.calls.at(-1)?.[0]).toBe('gh');
    expect(options.cwd).toBe(repo);
    expect(options.timeout).toBe(10_000);
    expect(options.env?.GH_PROMPT_DISABLED).toBe('1');
    expect(options.env?.PATH).toBe(process.env.PATH);
    // アプリ自身の環境変数は書き換えない
    expect(process.env.GH_PROMPT_DISABLED).toBeUndefined();
  });

  it('gh が失敗した（ログインしていない・GitHub のリポジトリでないなど）ときは null', async () => {
    replyWith({ stdout: '[]', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n', exit: 4 });
    await expect(pullRequestsOf(repo, 'main')).resolves.toBeNull();
    expect(calls()).toHaveLength(1);
  });

  it('gh が無いときは null', async () => {
    process.env.PATH = join(root, 'empty');
    await expect(pullRequestsOf(repo, 'main')).resolves.toBeNull();
    expect(calls()).toEqual([]);
  });

  it('返事が JSON でない・一覧でないときは null', async () => {
    replyWith({ stdout: 'not json' });
    await expect(pullRequestsOf(repo, 'main')).resolves.toBeNull();
    replyWith({ stdout: JSON.stringify({ number: 12 }) });
    await expect(pullRequestsOf(repo, 'main')).resolves.toBeNull();
    replyWith({ stdout: 'null' });
    await expect(pullRequestsOf(repo, 'main')).resolves.toBeNull();
  });
});

describe('PR にコメントを書く（commentOnPullRequest）', () => {
  it('作業フォルダで gh pr comment <番号> --body-file - を呼び、本文を標準入力で渡す。書いたコメントの URL（出力の最後の行）を返す', async () => {
    const url = 'https://github.com/me/cafe/pull/12#issuecomment-1';
    replyWith({ stdout: `Adding comment...\n${url}\n` });
    const body = '## ウォークスルー\n\n- 1 行目\n- `--body` のような文字も、そのまま渡す\n';
    await expect(commentOnPullRequest(repo, 12, body)).resolves.toBe(url);
    expect(calls()).toEqual([{ cwd: repo, prompt: '1', args: ['pr', 'comment', '12', '--body-file', '-'] }]);
    expect(readFileSync(join(fake, 'stdin'), 'utf8')).toBe(body);
  });

  it('書き込みは、通信が遅くても 60 秒まで待つ', async () => {
    replyWith({ stdout: 'https://github.com/me/cafe/pull/3#issuecomment-2\n' });
    await commentOnPullRequest(repo, 3, '本文');
    const options = optionsOfLastCall();
    expect(options.timeout).toBe(60_000);
    expect(options.cwd).toBe(repo);
    expect(options.env?.GH_PROMPT_DISABLED).toBe('1');
  });

  it('gh が URL を出さなければ、空の文字を返す', async () => {
    await expect(commentOnPullRequest(repo, 12, '本文')).resolves.toBe('');
    replyWith({ stdout: '\n  \n' });
    await expect(commentOnPullRequest(repo, 12, '本文')).resolves.toBe('');
  });

  it('書けなければ、gh のエラーの文（前後の空白を除く）で失敗する', async () => {
    replyWith({ stdout: '', stderr: '  GraphQL: Could not resolve to a PullRequest with the number of 99.\n', exit: 1 });
    await expect(commentOnPullRequest(repo, 99, '本文')).rejects.toThrow(/^GraphQL: Could not resolve to a PullRequest with the number of 99\.$/);
  });

  it('gh がエラーの文を出さずに失敗したら、起動の失敗の文で失敗する（gh が無いときも）', async () => {
    replyWith({ exit: 2 });
    await expect(commentOnPullRequest(repo, 12, '本文')).rejects.toThrow(/Command failed: gh pr comment 12 --body-file -/);
    process.env.PATH = join(root, 'empty');
    await expect(commentOnPullRequest(repo, 12, '本文')).rejects.toThrow(/ENOENT/);
  });
});
