import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outsideReadOf, outsideRules, within, type OutsideRules } from '../src/main/outside-reads';

// Claude がフォルダの外で読んだ・書いたファイルを、エクスプローラーに出す単位と、出さない場所（outside-reads.ts）

let root: string;
let rules: OutsideRules;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-outside-')));
  // 一時フォルダの中で試すので、出さない場所は試しのフォルダの中に作る
  rules = { excluded: [join(root, 'home/.claude'), join(root, 'tmp')], home: join(root, 'home') };
  mkdirSync(join(root, 'home/.claude'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('outsideReadOf', () => {
  it('git のリポジトリの中のファイルは、そのリポジトリのいちばん上（.git がファイルの worktree も）', () => {
    mkdirSync(join(root, 'home/repo/.git'), { recursive: true });
    mkdirSync(join(root, 'home/repo/src/deep'), { recursive: true });
    mkdirSync(join(root, 'home/wt'), { recursive: true });
    writeFileSync(join(root, 'home/wt/.git'), 'gitdir: /somewhere\n');
    expect(outsideReadOf(join(root, 'home/repo/src/deep/a.ts'), rules)).toEqual({ kind: 'folder', path: join(root, 'home/repo') });
    expect(outsideReadOf(join(root, 'home/repo/README.md'), rules)).toEqual({ kind: 'folder', path: join(root, 'home/repo') });
    expect(outsideReadOf(join(root, 'home/wt/a.ts'), rules)).toEqual({ kind: 'folder', path: join(root, 'home/wt') });
    // まだ無いファイル（Write で作る）も、上のフォルダから探す
    expect(outsideReadOf(join(root, 'home/repo/new/dir/b.ts'), rules)).toEqual({ kind: 'folder', path: join(root, 'home/repo') });
  });

  it('どのリポジトリにも入っていないファイルは、ファイルそのもの。ホーム（やその上）がリポジトリでも、ホーム全体は出さない', () => {
    mkdirSync(join(root, 'home/Downloads'), { recursive: true });
    expect(outsideReadOf(join(root, 'home/Downloads/memo.txt'), rules)).toEqual({ kind: 'file', path: join(root, 'home/Downloads/memo.txt') });
    expect(outsideReadOf(join(root, 'home/notes.txt'), rules)).toEqual({ kind: 'file', path: join(root, 'home/notes.txt') });
    mkdirSync(join(root, 'home/.git'));
    expect(outsideReadOf(join(root, 'home/Downloads/memo.txt'), rules)).toEqual({ kind: 'file', path: join(root, 'home/Downloads/memo.txt') });
  });

  it('セッションのフォルダを含むリポジトリ（worktree のときの元のリポジトリ）は、フォルダにせずファイルとして出す', () => {
    const main = join(root, 'home/shop');
    const wt = join(main, '.claude/worktrees/x');
    mkdirSync(join(main, '.git'), { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: ../../../.git/worktrees/x\n');
    expect(outsideReadOf(join(main, 'src/a.ts'), rules, wt)).toEqual({ kind: 'file', path: join(main, 'src/a.ts') });
    // セッションのフォルダを含まないリポジトリは、これまでどおりフォルダ
    mkdirSync(join(root, 'home/other/.git'), { recursive: true });
    expect(outsideReadOf(join(root, 'home/other/b.ts'), rules, wt)).toEqual({ kind: 'folder', path: join(root, 'home/other') });
    // cwd を渡さなければ、元のリポジトリもフォルダ
    expect(outsideReadOf(join(main, 'src/a.ts'), rules)).toEqual({ kind: 'folder', path: main });
  });

  it('Claude Code の設定のフォルダ・一時フォルダの中と、相対パスは出さない', () => {
    expect(outsideReadOf(join(root, 'home/.claude/settings.json'), rules)).toBeNull();
    expect(outsideReadOf(join(root, 'home/.claude/projects/x/log.jsonl'), rules)).toBeNull();
    expect(outsideReadOf(join(root, 'tmp/out.txt'), rules)).toBeNull();
    expect(outsideReadOf('notes.txt', rules)).toBeNull();
    // 名前が似ているだけのフォルダは出す
    expect(outsideReadOf(join(root, 'home/.claude-work/a.md'), rules)).toEqual({ kind: 'file', path: join(root, 'home/.claude-work/a.md') });
  });

  it('パスの .. は解いてから決める', () => {
    expect(outsideReadOf(join(root, 'home/x/../.claude/CLAUDE.md'), rules)).toBeNull();
  });
});

describe('outsideRules', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it('Claude Code の設定のフォルダ（プロファイル・CLAUDE_CONFIG_DIR・~/.claude）と一時フォルダ（リンクの先も）を除き、ホームはリンクを解く', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const r = outsideRules();
    expect(r.excluded).toEqual(expect.arrayContaining([join(homedir(), '.claude'), tmpdir(), realpathSync(tmpdir()), '/tmp', realpathSync('/tmp')]));
    expect(r.home).toBe(realpathSync(homedir()));
    process.env.CLAUDE_CONFIG_DIR = '/elsewhere/claude';
    expect(outsideRules().excluded).toContain('/elsewhere/claude');
    expect(outsideRules('/profiles/work').excluded).toContain('/profiles/work');
    expect(outsideRules('/profiles/work').excluded).not.toContain('/elsewhere/claude');
  });
});

describe('within', () => {
  it('フォルダそのものとその中だけ（名前の頭が同じだけのものは外）', () => {
    expect(within('/a/b', '/a/b')).toBe(true);
    expect(within('/a/b', '/a/b/c')).toBe(true);
    expect(within('/a/b', '/a/bc')).toBe(false);
    expect(within('/a/b', '/a')).toBe(false);
  });
});
