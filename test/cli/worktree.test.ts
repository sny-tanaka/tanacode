import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeRun, claudeVersion, menuOf, shown } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、worktree のセッション（claude --worktree）をアプリと同じ部品で扱えるかを確かめる。
// worktree を作る（.worktreeinclude の写し・ロック）→ 会話ログ → 消す操作の確認（hooks）→ --resume で worktree に戻る →
// 削除してアーカイブ（控えの ref）→ 戻すと作り直して再開。信頼していないフォルダでは始まらない

const HELLO = 'worktree で動いていますか';
const GUARD = 'ブランチを消してください';

const version = claudeVersion();
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe(`Claude Code ${version} の worktree のセッション`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  let path = '';
  let branch = '';
  const summary = () => run.summary()!;
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  const prompt = () => run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready, 30_000);

  beforeAll(async () => {
    api = new MockApi();
    // 台本は会話のはじめの発言で選ぶので、続きの発言（GUARD）への応答も同じ会話の続きに置く
    api.conversations = [
      {
        match: HELLO,
        steps: [
          [{ type: 'text', text: 'はい、worktree です' }],
          [{ type: 'tool_use', id: 'toolu_guard', name: 'Bash', input: { command: 'git branch -D worktree-old', description: 'ブランチを消す' } }],
        ],
      },
    ];
    run = new ClaudeRun(await api.start(), {
      git: true,
      trusted: true,
      files: { 'a.txt': 'a\n', '.gitignore': '.env\n', '.env': 'SECRET=1\n', '.worktreeinclude': '.env\n' },
    });
    await run.startInWorktree();
    path = summary().cwd;
    branch = summary().worktree!.branch;
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('リポジトリの .claude/worktrees/<名前> に worktree ができ、セッションのフォルダになる', async () => {
    // startInWorktree は、worktree の .git ができた時点で返る。Claude Code はそのあとでロックを付け、.worktreeinclude のファイルを写し、
    // 作り終えてから入力欄を出す。入力欄を待たずに読むと、遅いマシンではロックがまだ無い
    await prompt();
    const { name, root } = summary().worktree!;
    expect(root).toBe(run.cwd);
    expect(path).toBe(join(run.cwd, '.claude', 'worktrees', name));
    expect(branch).toBe(`worktree-${name}`);
    const list = git(run.cwd, 'worktree', 'list', '--porcelain');
    expect(list).toContain(`worktree ${path}\n`);
    expect(list).toContain(`branch refs/heads/${branch}`);
    // Claude Code は、自分の印のロックを付ける（プロセスを止めても残る）
    expect(list).toMatch(new RegExp(`locked claude session ${name} `));
    // gitignore されたファイルは、リポジトリの .worktreeinclude で Claude Code が写す（アプリは何もしない）
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1\n');
    // 元のフォルダのソース管理に、worktree が未追跡として出ない
    expect(git(run.cwd, 'status', '--porcelain')).toBe('');
  });

  it('準備が終わってから入力を受け付け、会話ログは worktree の側に書かれる', async () => {
    // 入力欄が出てから準備（node_modules）を始め、終わってから ready を配信する
    await run.waitFor('準備の終わり', () => run.chatEvents.some((e) => e.type === 'ready'), 30_000);
    const kinds = run.chatEvents.map((e) => e.type);
    // 準備の知らせ（worktree で始めた）は、ready より先
    expect(kinds.indexOf('info')).toBeGreaterThan(-1);
    expect(kinds.indexOf('info')).toBeLessThan(kinds.indexOf('ready'));
    expect(run.chatEvents.find((e) => e.type === 'info')).toMatchObject({ text: expect.stringContaining(`worktree .claude/worktrees/${summary().worktree!.name}`) });
    await run.send(HELLO);
    await run.waitFor('返事', replied('はい、worktree です'));
    expect(run.transcript().startsWith(join(homedir(), '.claude', 'projects', path.replace(/[^a-zA-Z0-9]/g, '-')))).toBe(true);
    expect(existsSync(run.transcript())).toBe(true);
  });

  it('worktree やブランチを消す操作は、アプリが足した hooks で確認が出る', async () => {
    await run.send(GUARD);
    const menu = await run.waitFor('許可の確認', menuOf('permission'));
    expect(run.dump()).toContain('tanacode が確認を求めています');
    // 断ると、Claude Code はツールを止めて、次の指示を待つ
    await run.answer(menu.title, menu.options.find((o) => /^No/.test(o.label))!.id);
    await prompt();
    // アプリが足したフックは、チャットのフックの一覧に出さない
    expect(run.chatEvents.some((e) => e.type === 'hook' && e.run.command?.includes('TANACODE_WORKTREE_GUARD'))).toBe(false);
  });

  it('止めてから --resume すると、worktree のフォルダで会話に戻る', async () => {
    await prompt();
    run.stopClaude();
    await run.waitFor('終了', () => !summary().running || null).catch(() => undefined);
    run.start({ resume: true });
    await prompt();
    run.type('!pwd');
    await run.waitFor('入力欄に入る', (info) => info.draft === '!pwd');
    run.type('\r');
    await run.waitFor('コマンドの出力', () => run.entries.some((e) => typeof e.message?.content === 'string' && e.message.content.includes(`<bash-stdout>${path}`)));
  });

  it('worktree を削除してアーカイブすると、未追跡のファイルの控えを残して消す。戻すと作り直して再開する', async () => {
    writeFileSync(join(path, 'note.txt'), 'メモ\n');
    const removal = await run.manager.archive(run.sessionId!, { removeWorktree: true });
    expect(removal).toEqual({ backupRef: `refs/tanacode/backup/${summary().worktree!.name}`, branch, branchKept: false });
    expect(existsSync(path)).toBe(false);
    expect(git(run.cwd, 'worktree', 'list')).not.toContain(path);
    expect(git(run.cwd, 'show', `${removal!.backupRef}:note.txt`)).toBe('メモ');

    await run.reopen();
    expect(existsSync(join(path, '.git'))).toBe(true);
    await run.waitFor('準備の終わり', () => run.chatEvents.some((e) => e.type === 'info' && e.text.includes('作り直しました')), 30_000);
    await prompt();
    // 作り直した worktree で、前の会話を読み直している
    expect(shown(run.chat()).some((e) => e.type === 'user' && e.text === HELLO)).toBe(true);
  });
});

describe(`Claude Code ${version} の worktree のセッション（信頼していないフォルダ）`, () => {
  it('claude --worktree は始まらないので、理由を添えて断り、一覧に残さない', async () => {
    const api = new MockApi();
    const run = new ClaudeRun(await api.start(), { git: true, files: { 'a.txt': 'a\n' } });
    try {
      await expect(run.startInWorktree()).rejects.toThrow('信頼');
      expect(run.manager.list()).toEqual([]);
    } finally {
      await run.stop();
      await api.stop();
    }
  });
});

describe(`Claude Code ${version} の worktree のセッション（大きなモノレポ）`, () => {
  // git worktree add は .git を先に書き、そのあとでファイルを書き出す。大きなリポジトリでは、.git ができた時点で
  // git ls-files が空になる（実測）。入力欄が出るのを待ってから用意するので、サブフォルダの node_modules も見つかる
  it('workspaces の各パッケージの node_modules も、元のフォルダから用意する', async () => {
    const files: Record<string, string> = { '.gitignore': 'node_modules/\n', 'package.json': '{}', 'package-lock.json': '{}', 'node_modules/y/index.js': '' };
    for (const name of ['web', 'api']) {
      files[`packages/${name}/package.json`] = '{}';
      files[`packages/${name}/node_modules/x/index.js`] = '';
    }
    for (let i = 0; i < 40_000; i++) files[`src/d${i % 400}/f${i}.txt`] = `${i}\n`;
    const api = new MockApi();
    const run = new ClaudeRun(await api.start(), { git: true, trusted: true, files });
    try {
      await run.startInWorktree();
      await run.waitFor('準備の終わり', () => run.chatEvents.some((e) => e.type === 'ready'), 120_000);
      const note = run.chatEvents.find((e) => e.type === 'info');
      // macOS 以外では APFS のクローンができないので「複製できませんでした」になり、いちばん上で npm install する。どちらでも場所は並ぶ
      for (const dir of ['packages/web/node_modules', 'packages/api/node_modules']) expect(note).toMatchObject({ text: expect.stringContaining(dir) });
    } finally {
      await run.stop();
      await api.stop();
    }
  }, 180_000);
});
