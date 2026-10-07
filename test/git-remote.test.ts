import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, gitRemote } from '../src/main/git';
import { SourceControl } from '../src/main/source-control';

// リモートと話す git（fetch・pull・push・remote set-head）は、リモートが応答しないとき、いつまでも待たずに止める。
// 応答しないリモートは、つないでも何も返さない HTTP サーバーで作る

let root: string;
let repo: string;
let silent: Server;
// 応答しないリモートにつながっている接続（止めたら git-remote-http も止まって、切れるはず）
let sockets: Set<Socket>;
let silentUrl: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-git-remote-'));
  repo = join(root, 'repo');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first']);
  sockets = new Set();
  silent = createServer(() => {});
  silent.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/silent.git`;
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => silent.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

const waitUntil = async (what: string, check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`${what}を待ちきれませんでした`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('gitRemote', () => {
  it('リモートが応答しなければ、決めた時間で止めて理由を返す。git が起動したもの（git-remote-http）も止まり、接続が切れる', async () => {
    await git(repo, ['remote', 'add', 'origin', silentUrl]);
    const started = Date.now();
    await expect(gitRemote(repo, ['fetch', 'origin'], 500)).rejects.toThrow('リモートから 1 秒応答が無いため、止めました（git fetch）');
    expect(Date.now() - started).toBeLessThan(5000);
    // つないでいた接続が、止めたことで切れる（git だけ止めて、子が待ち続けていない）
    await waitUntil('応答しないリモートへの接続が切れる', () => sockets.size === 0);
  });

  it('remote set-head --auto も、応答しなければ止める', async () => {
    await git(repo, ['remote', 'add', 'origin', silentUrl]);
    await expect(gitRemote(repo, ['remote', 'set-head', 'origin', '--auto'], 500)).rejects.toThrow('応答が無い');
  });

  it('つながるリモートなら、そのまま終わる。失敗したら git のメッセージを返す（進み具合の行は除く）', async () => {
    const bare = join(root, 'remote.git');
    await git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    await git(repo, ['remote', 'add', 'origin', bare]);
    await gitRemote(repo, ['push', '-u', 'origin', 'main']);
    await gitRemote(repo, ['fetch', '--prune', 'origin']);
    expect((await git(repo, ['rev-parse', 'origin/main'])).trim()).toBe((await git(repo, ['rev-parse', 'main'])).trim());
    const error = await gitRemote(repo, ['fetch', join(root, 'missing.git')]).then(
      () => null,
      (err: Error) => err.message,
    );
    expect(error).toMatch(/does not appear to be a git repository|not found|missing\.git/);
    expect(error).not.toMatch(/Enumerating|Counting|Receiving/);
  });

  it('switchToLatestDefault（新規セッションの画面のボタン）・fetch・pull・push も、応答しないリモートならエラーで終わる', async () => {
    await git(repo, ['remote', 'add', 'origin', silentUrl]);
    const scm = new SourceControl(repo, 500);
    await expect(scm.switchToLatestDefault()).rejects.toThrow('応答が無い');
    await expect(scm.fetch()).rejects.toThrow('応答が無い');
    await expect(scm.pull()).rejects.toThrow('応答が無い');
    await expect(scm.push()).rejects.toThrow('応答が無い');
    await waitUntil('応答しないリモートへの接続が切れる', () => sockets.size === 0);
  });
});
