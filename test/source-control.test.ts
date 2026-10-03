import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { git } from '../src/main/git';
import { SourceControl } from '../src/main/source-control';

// 「最新のデフォルトブランチへ切り替える」が、手元の main の状態によらずリモートの最新まで進めるか

let root: string;
// remote: origin（bare） / other: remote に push するための別の clone / local: アプリで開いているリポジトリ
let remote: string;
let other: string;
let local: string;

const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const run = (cwd: string, args: string[]) => git(cwd, args, undefined, env);
const head = async (cwd: string, ref = 'HEAD') => (await run(cwd, ['rev-parse', ref])).trim();

// other でコミットして origin の main を進める
async function advanceRemote(name: string): Promise<string> {
  await writeFile(join(other, name), name);
  await run(other, ['add', name]);
  await run(other, ['commit', '-m', name]);
  await run(other, ['push', 'origin', 'main']);
  return head(other);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tanacode-scm-'));
  remote = join(root, 'remote.git');
  other = join(root, 'other');
  local = join(root, 'local');
  await run(root, ['init', '--bare', '-b', 'main', remote]);
  await run(root, ['clone', remote, other]);
  await run(other, ['switch', '-c', 'main']);
  await advanceRemote('first');
  await run(root, ['clone', remote, local]);
});

afterEach(() => rm(root, { recursive: true, force: true }));

it('別のブランチから main に切り替えて最新まで進める', async () => {
  await run(local, ['switch', '-c', 'feature']);
  const latest = await advanceRemote('second');
  await new SourceControl(local).switchToLatestDefault();
  expect((await run(local, ['branch', '--show-current'])).trim()).toBe('main');
  expect(await head(local)).toBe(latest);
});

it('main にいるときも最新まで進める', async () => {
  const latest = await advanceRemote('second');
  await new SourceControl(local).switchToLatestDefault();
  expect(await head(local)).toBe(latest);
});

it('手元の main に上流が無くても origin の最新まで進め、上流を設定する', async () => {
  await run(local, ['branch', '--unset-upstream', 'main']);
  await run(local, ['switch', '-c', 'feature']);
  const latest = await advanceRemote('second');
  await new SourceControl(local).switchToLatestDefault();
  expect(await head(local)).toBe(latest);
  expect((await run(local, ['rev-parse', '--abbrev-ref', 'main@{u}'])).trim()).toBe('origin/main');
});

it('手元の main が origin 以外を追跡していても origin の最新まで進める', async () => {
  await run(local, ['remote', 'add', 'upstream', remote]);
  await run(local, ['fetch', 'upstream']);
  await run(local, ['branch', '--set-upstream-to=upstream/main', 'main']);
  await run(local, ['switch', '-c', 'feature']);
  const latest = await advanceRemote('second');
  await new SourceControl(local).switchToLatestDefault();
  expect(await head(local)).toBe(latest);
});

it('手元の main が分かれていたら、切り替えたうえで知らせる', async () => {
  await writeFile(join(local, 'mine'), 'mine');
  await run(local, ['add', 'mine']);
  await run(local, ['commit', '-m', 'mine']);
  await run(local, ['switch', '-c', 'feature']);
  await advanceRemote('second');
  await expect(new SourceControl(local).switchToLatestDefault()).rejects.toThrow('最新まで進められませんでした');
  expect((await run(local, ['branch', '--show-current'])).trim()).toBe('main');
});
