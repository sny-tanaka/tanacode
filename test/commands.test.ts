import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlashCommand } from '@shared/ipc';
import { listCommands } from '../src/main/commands';

// / で始まる入力の補完候補（src/main/commands.ts）。作業フォルダとホームフォルダ（HOME）を使い捨てのフォルダにして、
// カスタムコマンド（.claude/commands）・スキル（.claude/skills）・会話ログのスキルの一覧（skill_listing）・組み込みコマンドを並べる。
// 本物の Claude Code の会話ログから借りるところは、test/cli/basic.test.ts でも確かめる

let root: string;
let home: string;
let cwd: string;
const oldHome = process.env.HOME;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-commands-')));
  home = join(root, 'home');
  cwd = join(root, 'work', 'cafe.app');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
// 会話ログのスキルの一覧の行（Claude Code が書く形。1 行 1 つの JSON）
const listing = (content: unknown) => JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content } });
const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
// Claude Code が作業フォルダごとに会話ログを置くフォルダ（英数字以外は - にする）
const projectLogs = () => join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const custom = (list: SlashCommand[]) => list.filter((c) => c.source !== 'builtin');
const byName = (list: SlashCommand[], name: string) => list.filter((c) => c.name === name);

describe('組み込みコマンド', () => {
  it('何も無いフォルダでは、組み込みコマンドだけを並べる。別名のあるものは別名も付ける', async () => {
    const list = await listCommands(cwd, null);
    expect(list.length).toBeGreaterThan(90);
    expect(list.every((c) => c.source === 'builtin')).toBe(true);
    expect(list[0]).toEqual({ name: 'add-dir', description: '作業フォルダを追加する', aliases: undefined, source: 'builtin' });
    expect(byName(list, 'rewind')).toEqual([{ name: 'rewind', description: '会話やコードを以前の時点に戻す', aliases: ['checkpoint'], source: 'builtin' }]);
    expect(byName(list, 'doctor')[0].aliases).toEqual(['checkup']);
    // 名前は重ならない
    expect(new Set(list.map((c) => c.name)).size).toBe(list.length);
  });
});

describe('カスタムコマンド（.claude/commands）', () => {
  it('作業フォルダの .md を、ファイル名で並べる。説明は frontmatter の description、無ければ本文の 1 行目', async () => {
    write(join(cwd, '.claude/commands/deploy.md'), '---\ndescription: 本番に出す\nallowed-tools: Bash\n---\n\n手順を書く\n');
    write(join(cwd, '.claude/commands/review.md'), '---\nallowed-tools: Read\n---\n\n  差分をレビューする\n2 行目\n');
    write(join(cwd, '.claude/commands/plain.md'), `${'あ'.repeat(120)}\n`);
    write(join(cwd, '.claude/commands/empty.md'), '');
    // .md でないものは使わない
    write(join(cwd, '.claude/commands/notes.txt'), 'メモ');
    const list = custom(await listCommands(cwd, null));
    expect([...list].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'deploy', description: '本番に出す', source: 'project' },
      { name: 'empty', description: '', source: 'project' },
      // 1 行目は 100 文字まで
      { name: 'plain', description: 'あ'.repeat(100), source: 'project' },
      { name: 'review', description: '差分をレビューする', source: 'project' },
    ]);
  });

  it('説明を引用符で囲んでいれば外す。空の description は無いものとして本文を使う', async () => {
    write(join(cwd, '.claude/commands/a.md'), '---\ndescription: "二重引用符"\n---\n本文 a\n');
    write(join(cwd, '.claude/commands/b.md'), "---\ndescription: '一重引用符'\n---\n本文 b\n");
    write(join(cwd, '.claude/commands/c.md'), '---\ndescription:   \n---\n本文 c\n');
    write(join(cwd, '.claude/commands/d.md'), '---\ndescription: "片側だけ\n---\n本文 d\n');
    const list = custom(await listCommands(cwd, null));
    expect(Object.fromEntries(list.map((c) => [c.name, c.description]))).toEqual({ a: '二重引用符', b: '一重引用符', c: '本文 c', d: '"片側だけ' });
  });

  it('サブフォルダのものは「フォルダ:名前」。深さ 3 のフォルダまで探す', async () => {
    write(join(cwd, '.claude/commands/frontend/test.md'), 'テストを流す');
    write(join(cwd, '.claude/commands/a/b/c/deep.md'), '深さ 3');
    write(join(cwd, '.claude/commands/a/b/c/d/deeper.md'), '深さ 4');
    const list = custom(await listCommands(cwd, null));
    expect(list.map((c) => c.name).sort()).toEqual(['a:b:c:deep', 'frontend:test']);
    expect(byName(list, 'frontend:test')[0].description).toBe('テストを流す');
  });

  it('シンボリックリンクの .md も読む。読めないもの（リンク切れ）があっても、一覧づくりは止めない（説明は空）', async () => {
    write(join(root, 'dotfiles/fix.md'), '---\ndescription: 直す\n---\n');
    mkdirSync(join(cwd, '.claude/commands'), { recursive: true });
    symlinkSync(join(root, 'dotfiles/fix.md'), join(cwd, '.claude/commands/fix.md'));
    symlinkSync(join(root, 'dotfiles/missing.md'), join(cwd, '.claude/commands/broken.md'));
    const list = custom(await listCommands(cwd, null));
    expect([...list].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'broken', description: '', source: 'project' },
      { name: 'fix', description: '直す', source: 'project' },
    ]);
  });

  it('ホームフォルダのものは source が user。作業フォルダのものと名前が同じなら、作業フォルダのものを使う', async () => {
    write(join(cwd, '.claude/commands/review.md'), 'このリポジトリのレビュー');
    write(join(home, '.claude/commands/review.md'), 'いつものレビュー');
    write(join(home, '.claude/commands/standup.md'), '朝会のメモ');
    const list = custom(await listCommands(cwd, null));
    expect(list).toEqual([
      { name: 'review', description: 'このリポジトリのレビュー', source: 'project' },
      { name: 'standup', description: '朝会のメモ', source: 'user' },
    ]);
  });

  it('組み込みコマンドと名前が同じなら、カスタムのものだけを出す', async () => {
    write(join(cwd, '.claude/commands/help.md'), '---\ndescription: このリポジトリのヘルプ\n---\n');
    const list = await listCommands(cwd, null);
    expect(byName(list, 'help')).toEqual([{ name: 'help', description: 'このリポジトリのヘルプ', source: 'project' }]);
    expect(list[0].name).toBe('help');
  });
});

describe('スキル（.claude/skills）', () => {
  it('フォルダごとの SKILL.md から、名前（無ければフォルダ名）と説明を読む。SKILL.md の無いフォルダ・ファイルは使わない', async () => {
    write(join(cwd, '.claude/skills/deploy-check/SKILL.md'), '---\nname: release-check\ndescription: 出す前に確かめる\n---\n本文\n');
    write(join(cwd, '.claude/skills/notes/SKILL.md'), '# 説明の無いスキル\n');
    mkdirSync(join(cwd, '.claude/skills/empty'), { recursive: true });
    write(join(cwd, '.claude/skills/README.md'), 'フォルダでないもの');
    const list = custom(await listCommands(cwd, null));
    expect([...list].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'notes', description: '', source: 'project' },
      { name: 'release-check', description: '出す前に確かめる', source: 'project' },
    ]);
  });

  it('シンボリックリンクにしたスキルのフォルダも読む。ホームフォルダのものは source が user', async () => {
    write(join(root, 'shared-skills/lint/SKILL.md'), '---\ndescription: 整形と静的解析\n---\n');
    mkdirSync(join(home, '.claude/skills'), { recursive: true });
    symlinkSync(join(root, 'shared-skills/lint'), join(home, '.claude/skills/lint'));
    const list = custom(await listCommands(cwd, null));
    expect(list).toEqual([{ name: 'lint', description: '整形と静的解析', source: 'user' }]);
  });

  it('並びは、作業フォルダのコマンド・ホームのコマンド・作業フォルダのスキル・ホームのスキル・会話ログのスキル・組み込み', async () => {
    write(join(cwd, '.claude/commands/p-cmd.md'), 'p');
    write(join(home, '.claude/commands/u-cmd.md'), 'u');
    write(join(cwd, '.claude/skills/p-skill/SKILL.md'), '---\ndescription: ps\n---\n');
    write(join(home, '.claude/skills/u-skill/SKILL.md'), '---\ndescription: us\n---\n');
    const transcript = join(root, 'log.jsonl');
    write(transcript, `${listing('- listed: 会話ログから')}\n`);
    const list = await listCommands(cwd, transcript);
    expect(list.slice(0, 6).map((c) => [c.name, c.source])).toEqual([
      ['p-cmd', 'project'],
      ['u-cmd', 'user'],
      ['p-skill', 'project'],
      ['u-skill', 'user'],
      ['listed', 'skill'],
      ['add-dir', 'builtin'],
    ]);
  });
});

describe('会話ログのスキルの一覧（skill_listing）', () => {
  it('会話ログの最後の一覧の「- 名前: 説明」の行を読む。プラグインのもの（プラグイン:名前）も。形の違う行は飛ばす', async () => {
    const transcript = join(root, 'log.jsonl');
    write(
      transcript,
      [
        listing('- old-skill: 前の一覧'),
        userLine('こんにちは'),
        listing(['- code-review: 差分をレビューする', '- anthropic-skills:pdf: PDF を扱う', '- no-description:', '見出しの行', '-missing-space: 飛ばす'].join('\n')),
        userLine('ありがとう'),
      ].join('\n') + '\n',
    );
    const list = custom(await listCommands(cwd, transcript));
    expect(list).toEqual([
      { name: 'code-review', description: '差分をレビューする', source: 'skill' },
      { name: 'anthropic-skills:pdf', description: 'PDF を扱う', source: 'skill' },
      { name: 'no-description', description: '', source: 'skill' },
    ]);
  });

  it('一覧が最後の行（改行で終わっていない）でも読む', async () => {
    const transcript = join(root, 'log.jsonl');
    write(transcript, `${userLine('こんにちは')}\n${listing('- last: 最後の行')}`);
    expect(custom(await listCommands(cwd, transcript))).toEqual([{ name: 'last', description: '最後の行', source: 'skill' }]);
  });

  it('会話ログに一覧が無ければ、同じフォルダの新しい会話ログ 3 つから、一覧のあるいちばん新しいものを借りる', async () => {
    const transcript = join(root, 'log.jsonl');
    write(transcript, `${userLine('まだ一覧が無い')}\n`);
    const logs = projectLogs();
    const at = (name: string, text: string, seconds: number) => {
      write(join(logs, name), text);
      utimesSync(join(logs, name), seconds, seconds);
    };
    at('newest.jsonl', `${userLine('一覧の無い会話')}\n`, 4000);
    at('second.jsonl', `${listing('- from-second: 2 番目に新しい')}\n`, 3000);
    at('third.jsonl', `${listing('- from-third: 3 番目に新しい')}\n`, 2000);
    at('fourth.jsonl', `${listing('- from-fourth: 4 番目')}\n`, 1000);
    // 会話ログでないもの
    at('notes.txt', `${listing('- not-a-log: 使わない')}\n`, 5000);
    expect(custom(await listCommands(cwd, transcript))).toEqual([{ name: 'from-second', description: '2 番目に新しい', source: 'skill' }]);
  });

  it('新しい 3 つに一覧が無ければ、それより古いものからは借りない', async () => {
    const logs = projectLogs();
    const at = (name: string, text: string, seconds: number) => {
      write(join(logs, name), text);
      utimesSync(join(logs, name), seconds, seconds);
    };
    at('a.jsonl', `${userLine('a')}\n`, 4000);
    at('b.jsonl', `${userLine('b')}\n`, 3000);
    at('c.jsonl', `${userLine('c')}\n`, 2000);
    at('d.jsonl', `${listing('- too-old: 古すぎる')}\n`, 1000);
    expect(custom(await listCommands(cwd, null))).toEqual([]);
  });

  it('日時の読めない会話ログ（リンク切れ）は、いちばん古いものとして扱う', async () => {
    const logs = projectLogs();
    const at = (name: string, text: string, seconds: number) => {
      write(join(logs, name), text);
      utimesSync(join(logs, name), seconds, seconds);
    };
    at('a.jsonl', `${userLine('a')}\n`, 3000);
    at('b.jsonl', `${userLine('b')}\n`, 2000);
    at('c.jsonl', `${listing('- from-c: 3 番目に新しい')}\n`, 1000);
    symlinkSync(join(root, 'missing.jsonl'), join(logs, 'broken.jsonl'));
    expect(custom(await listCommands(cwd, null))).toEqual([{ name: 'from-c', description: '3 番目に新しい', source: 'skill' }]);
  });

  it('会話ログに一覧があれば、ほかの会話ログからは借りない', async () => {
    write(join(projectLogs(), 'other.jsonl'), `${listing('- borrowed: 借りたもの')}\n`);
    const transcript = join(root, 'log.jsonl');
    write(transcript, `${listing('- own: 自分の一覧')}\n`);
    expect(custom(await listCommands(cwd, transcript)).map((c) => c.name)).toEqual(['own']);
  });

  it('会話ログが読めない・一覧の行が壊れている・中身が文字でないときは、ほかの会話ログから借りる', async () => {
    write(join(projectLogs(), 'other.jsonl'), `${listing('- borrowed: 借りたもの')}\n`);
    const expected = [{ name: 'borrowed', description: '借りたもの', source: 'skill' }];
    expect(custom(await listCommands(cwd, join(root, 'missing.jsonl')))).toEqual(expected);
    const broken = join(root, 'broken.jsonl');
    write(broken, '{"type":"attachment","attachment":{"type":"skill_listing","content":"- x: 書きかけ\n');
    expect(custom(await listCommands(cwd, broken))).toEqual(expected);
    const notText = join(root, 'not-text.jsonl');
    write(notText, `${listing(['- x: 配列'])}\n`);
    expect(custom(await listCommands(cwd, notText))).toEqual(expected);
    const noAttachment = join(root, 'no-attachment.jsonl');
    write(noAttachment, `${JSON.stringify({ type: 'skill_listing' })}\n`);
    expect(custom(await listCommands(cwd, noAttachment))).toEqual(expected);
  });

  it('作業フォルダのスキルと名前が同じなら、作業フォルダのものを使う', async () => {
    write(join(cwd, '.claude/skills/review/SKILL.md'), '---\ndescription: このリポジトリのレビュー\n---\n');
    const transcript = join(root, 'log.jsonl');
    write(transcript, `${listing('- review: 一覧のレビュー\n- other: ほか')}\n`);
    expect(custom(await listCommands(cwd, transcript))).toEqual([
      { name: 'review', description: 'このリポジトリのレビュー', source: 'project' },
      { name: 'other', description: 'ほか', source: 'skill' },
    ]);
  });
});
