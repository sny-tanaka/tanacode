import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Walkthrough } from '../src/shared/walkthrough';
import { finalCommentBody, MAX_COMMENT_CHARS, permalink, repoUrlOfPullRequest, walkthroughAttribution, walkthroughCommentBody } from '../src/shared/walkthrough-comment';
import type { PullRequest } from '../src/main/github';
import { draftWalkthroughComment, postWalkthroughComment, type CommentDeps } from '../src/main/walkthrough-github';

// ウォークスルーを GitHub の PR にコメントとして載せる。本文の組み立て（パーマリンク）と、載せられるかの確かめ（PR・HEAD・ファイル）

const REPO = 'https://github.com/me/cafe';

const step = (path: string, startLine: number, endLine: number, title: string, body: string) => ({ path, startLine, endLine, title, body, view: 'file' as const });

const WALK: Walkthrough = {
  id: 'w1',
  title: '税率を可変にした変更',
  open: true,
  steps: [step('src/settings.ts', 1, 3, '税率を設定に持たせる', '管理画面から変えるため。\n'), step('src/tax.ts', 2, 2, '切り捨て', 'レシートと合わせる。')],
  current: 0,
  aside: { path: 'src/other.ts', startLine: 1, endLine: 1, title: '', body: '寄り道', view: 'file' },
  visited: [0],
  movedBy: 'human',
  seq: 3,
  startedAt: 0,
};

describe('本文', () => {
  it('PR の URL からリポジトリの URL を読む', () => {
    expect(repoUrlOfPullRequest('https://github.com/me/cafe/pull/12')).toBe(REPO);
    expect(repoUrlOfPullRequest('https://ghe.example.com/team/app/pull/3#x')).toBe('https://ghe.example.com/team/app');
    expect(repoUrlOfPullRequest('https://github.com/me/cafe/issues/1')).toBeNull();
  });

  it('パーマリンクはコミットに固定し、1 行なら #L だけ。パスの各部分は URL に使える形にする', () => {
    expect(permalink(REPO, 'abc', 'src/tax.ts', 3, 5)).toBe(`${REPO}/blob/abc/src/tax.ts#L3-L5`);
    expect(permalink(REPO, 'abc', 'src/tax.ts', 3, 3)).toBe(`${REPO}/blob/abc/src/tax.ts#L3`);
    expect(permalink(REPO, 'abc', 'docs/設計 メモ.md', 1, 1)).toBe(`${REPO}/blob/abc/docs/${encodeURIComponent('設計 メモ.md')}#L1`);
  });

  it('ステップの順に、見出し・1 行だけのリンク・説明を並べる。寄り道は載せない。フォルダがリポジトリの中ならパスに足す', () => {
    const body = walkthroughCommentBody(WALK, REPO, 'abcdef1234567890', 'app/');
    expect(body).toBe(
      [
        '## ウォークスルー: 税率を可変にした変更',
        '2 ステップ。コミット `abcdef1` の時点のコードです。',
        '### 1/2 税率を設定に持たせる',
        `${REPO}/blob/abcdef1234567890/app/src/settings.ts#L1-L3`,
        '管理画面から変えるため。',
        '### 2/2 切り捨て',
        `${REPO}/blob/abcdef1234567890/app/src/tax.ts#L2`,
        'レシートと合わせる。',
      ].join('\n\n'),
    );
    expect(body).not.toContain('寄り道');
  });

  it('一言は選んだときだけ最後に添える', () => {
    expect(finalCommentBody(' 本文 \n', false)).toBe('本文');
    expect(finalCommentBody('本文', true)).toBe(`本文\n\n---\n${walkthroughAttribution()}`);
  });
});

describe('載せられるかの確かめと投稿', () => {
  let dir: string;
  let repo: string;
  let app: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-walk-comment-'));
    repo = join(dir, 'cafe');
    // セッションのフォルダは、リポジトリの中の app/
    app = join(repo, 'app');
    mkdirSync(join(app, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'me');
    git(repo, 'config', 'user.email', 'me@example.com');
    writeFileSync(join(app, 'src', 'settings.ts'), 'a\nb\nc\n');
    writeFileSync(join(app, 'src', 'tax.ts'), 'x\ny\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'switch', '-qc', 'feature');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    number: 12,
    state: 'OPEN',
    headRefOid: git(repo, 'rev-parse', 'HEAD'),
    baseRefName: 'main',
    url: `${REPO}/pull/12`,
    ...over,
  });
  const deps = (prs: PullRequest[] | null, posted: string[] = []): CommentDeps => ({
    pullRequests: async (_cwd, branch) => (branch === 'feature' ? prs : []),
    comment: async (_cwd, number, body) => {
      posted.push(`${number}:${body}`);
      return `${REPO}/pull/${number}#issuecomment-1\n`;
    },
  });
  const reason = async (prs: PullRequest[] | null) => {
    const d = await draftWalkthroughComment(app, WALK, null, deps(prs));
    return d.ok ? 'ok' : d.reason;
  };

  it('開いている PR があり、HEAD が PR の最新で、ファイルがそのとおりなら下見を返す', async () => {
    const d = await draftWalkthroughComment(app, WALK, 'https://prev', deps([pr()]));
    expect(d).toMatchObject({ ok: true, prNumber: 12, prUrl: `${REPO}/pull/12`, postedUrl: 'https://prev' });
    if (d.ok) expect(d.body).toContain(`${REPO}/blob/${d.sha}/app/src/settings.ts#L1-L3`);
  });

  it('gh が使えない・開いている PR が無い・HEAD が違うときは、理由を返す', async () => {
    expect(await reason(null)).toContain('gh が入っていて');
    expect(await reason([pr({ state: 'MERGED' })])).toContain('開いている PR がありません');
    expect(await reason([pr({ headRefOid: '0123456789abcdef' })])).toContain('プッシュ（かプル）してから');
  });

  it('ステップのファイルにコミットしていない変更がある・コミットに無いときは、理由を返す', async () => {
    writeFileSync(join(app, 'src', 'tax.ts'), 'x\nz\n');
    expect(await reason([pr()])).toContain('コミットしていない変更があるファイルがあります: src/tax.ts。');
    git(repo, 'checkout', '-q', '--', '.');
    const extra = { ...WALK, steps: [...WALK.steps, step('src/new.ts', 1, 1, '新しい', '…')] };
    writeFileSync(join(app, 'src', 'new.ts'), 'n\n');
    const d = await draftWalkthroughComment(app, extra, null, deps([pr()]));
    expect(d.ok ? 'ok' : d.reason).toContain('コミットに入っていないファイルがあります: src/new.ts');
  });

  it('投稿: 確かめ直してから、一言を添えて載せ、コメントの URL を返す。長すぎる本文は断る', async () => {
    const posted: string[] = [];
    const url = await postWalkthroughComment(app, WALK, '直した本文', true, deps([pr()], posted));
    expect(url).toBe(`${REPO}/pull/12#issuecomment-1`);
    expect(posted).toEqual([`12:直した本文\n\n---\n${walkthroughAttribution()}`]);
    await expect(postWalkthroughComment(app, WALK, 'x'.repeat(MAX_COMMENT_CHARS + 1), false, deps([pr()]))).rejects.toThrow('長すぎます');
    await expect(postWalkthroughComment(app, WALK, '本文', false, deps([pr({ headRefOid: 'ffff' })]))).rejects.toThrow('プッシュ');
    expect(posted).toHaveLength(1);
  });
});
