import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isTranscriptEntry } from '@shared/chat';
import { checkTranscript, type NumberedEntry, type TranscriptCheck } from '../transcript-checks';

// 手元の本物の会話ログで、Claude Code のあるバージョンが書いた行を、アプリの読み取りに流して決まりを確かめる（npm run check:transcripts）。
// モックの API（test/cli）では出ない、本物のモデルの出し方（並べた呼び出し・タイミング）まで見られるのはこれだけ。
// 動作確認済のバージョンを上げる PR をマージする前に流す（CONTRIBUTING.md の「Claude Code との互換性の確かめ方」）。
// 会話ログは読むだけ。中身はどこにも書き出さない（決まりを破った行は、ファイルと行の番号だけを出す）
//   TANACODE_CHECK_VERSION: 確かめるバージョン（無ければ、入っている claude のバージョン）
//   TANACODE_CHECK_DAYS: この日数のうちに書き換わった会話ログだけを見る（無ければ 14）
//   TANACODE_CHECK_PROJECTS: 会話ログのフォルダ（: で区切る。無ければ ~/.claude*/projects）

const VERSION = process.env.TANACODE_CHECK_VERSION || installedVersion();
const DAYS = Number(process.env.TANACODE_CHECK_DAYS || 14);
const ROOTS = process.env.TANACODE_CHECK_PROJECTS?.split(':').filter(Boolean) ?? defaultRoots();
// 決まりを破ったものを、1 つの決まりにつき出す数の上限
const SAMPLES = 20;
// バージョンを見る、ファイルの頭と末尾の大きさ（会話の行には、書いた Claude Code のバージョンが入る）
const PEEK_BYTES = 256 * 1024;

type FileCheck = { file: string; check: TranscriptCheck };

describe(`Claude Code ${VERSION} が書いた手元の会話ログ（${DAYS} 日のうちに書き換わったもの）`, () => {
  const checks = collect();
  const where = (file: string, line: number) => `${file.replace(homedir(), '~')}:${line}`;
  const samples = (items: string[]) => (items.length > SAMPLES ? [...items.slice(0, SAMPLES), `…ほか ${items.length - SAMPLES} 件`] : items);

  afterAll(() => {
    const lines = checks.reduce((sum, c) => sum + c.check.lines, 0);
    const agents = checks.filter((c) => isAgentLog(c.file)).length;
    console.log(`見た会話ログ: ${checks.length} ファイル（本体 ${checks.length - agents}・エージェント ${agents}）・${lines} 行。フォルダ: ${ROOTS.join('、')}`);
    // 未知のイベントは、種類ごとの数と、出たファイルの数もまとめる（下の失敗には、ファイルごとに出る）
    const unknown = new Map<string, { count: number; files: number }>();
    for (const { check } of checks) {
      for (const [name, { count }] of check.unknown) unknown.set(name, { count: (unknown.get(name)?.count ?? 0) + count, files: (unknown.get(name)?.files ?? 0) + 1 });
    }
    for (const [name, { count, files }] of unknown) console.log(`未知のイベント: ${name}（${files} ファイル・${count} 回）`);
    // 意図して捨てる行のツールの写し（API の要求の控えなど）は、読み手に渡らないので困らない。数だけを知らせる
    const ignored = new Map<string, number>();
    for (const { check } of checks) for (const [kind, found] of check.toolBlocksOutside) if (found.ignored) ignored.set(kind, (ignored.get(kind) ?? 0) + found.count);
    for (const [kind, count] of ignored) console.log(`知らせ: 意図して捨てる行（${kind}）に、ツールの呼び出し・結果の写しが ${count} 行あります（読み手には渡していません）`);
  });

  it('会話ログが見つかる', () => {
    expect(checks.length, `${VERSION} が書いた会話ログが、${ROOTS.join('、')} に見つかりません（そのバージョンの Claude Code をしばらく使ってから流す）`).toBeGreaterThan(0);
  });

  it('チャットに未知のイベントが出ない', () => {
    const found = checks.flatMap(({ file, check }) => [...check.unknown].map(([name, { count, line }]) => `${name}（${count} 回）: ${where(file, line)}`));
    expect(samples(found)).toEqual([]);
  });

  it('会話の行でない行のツールの呼び出し・結果は、意図して捨てる種類の行にだけある', () => {
    const found = checks.flatMap(({ file, check }) => [...check.toolBlocksOutside].filter(([, f]) => !f.ignored).map(([kind, { count, line }]) => `${kind}（${count} 行）: ${where(file, line)}`));
    expect(samples(found)).toEqual([]);
  });

  it('1 つの呼び出しに、会話の行の結果は 1 つまで', () => {
    const found = checks.flatMap(({ file, check }) => check.duplicateResults.map((d) => `${d.toolUseId}: ${d.lines.map((line) => where(file, line)).join('、')}`));
    expect(samples(found)).toEqual([]);
  });

  it('裏で起動したもの（サブエージェント・Bash・ワークフロー）は、完了の知らせまで実行中のまま', () => {
    const found = checks.flatMap(({ file, check }) => check.earlyFinish.map((e) => `${e.kind} ${e.toolUseId}（${e.state}）: ${where(file, e.line)}`));
    expect(samples(found)).toEqual([]);
  });
});

// 確かめるバージョンが書いた会話ログを、1 つずつ読んで確かめる
function collect(): FileCheck[] {
  const since = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  return ROOTS.flatMap(transcriptFiles)
    .filter((file) => statSync(file).mtimeMs >= since && writtenBy(file, VERSION))
    .map((file) => {
      const entries = readEntries(file);
      const cwd = entries.map((e) => (e.entry as { cwd?: unknown }).cwd).find((c): c is string => typeof c === 'string') ?? homedir();
      return { file, check: checkTranscript(entries, { cwd, agentLog: isAgentLog(file) }) };
    });
}

// フォルダの下の会話ログ（本体の <プロジェクト>/<会話の ID>.jsonl と、エージェントの agent-<ID>.jsonl。ワークフローの journal.jsonl などは除く）
function transcriptFiles(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  return names.filter((name) => /^[^/]+\/[^/]+\.jsonl$/.test(name) || /\/agent-[^/]+\.jsonl$/.test(name)).map((name) => join(root, name));
}

function isAgentLog(file: string): boolean {
  return basename(file).startsWith('agent-');
}

// そのバージョンが書いた会話ログか。ファイルの頭と末尾だけを見る（会話を再開したファイルは、末尾に新しいバージョンの行がある）
function writtenBy(file: string, version: string): boolean {
  const mark = `"version":"${version}"`;
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const peek = (position: number) => {
      const buffer = Buffer.alloc(Math.min(PEEK_BYTES, size - position));
      readSync(fd, buffer, 0, buffer.length, position);
      return buffer.toString('utf8').includes(mark);
    };
    return peek(0) || (size > PEEK_BYTES && peek(size - PEEK_BYTES));
  } finally {
    closeSync(fd);
  }
}

// 会話ログの行と、その行の番号（読めない行・書きかけの行は飛ばす）
function readEntries(file: string): NumberedEntry[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((text, i) => {
      if (!text.trim()) return [];
      try {
        const entry: unknown = JSON.parse(text);
        return isTranscriptEntry(entry) ? [{ entry, line: i + 1 }] : [];
      } catch {
        return [];
      }
    });
}

// ~/.claude・~/.claude-personal など、設定のフォルダの下の projects
function defaultRoots(): string[] {
  return readdirSync(homedir())
    .filter((name) => name.startsWith('.claude'))
    .map((name) => join(homedir(), name, 'projects'))
    .filter((dir) => existsSync(dir));
}

function installedVersion(): string {
  try {
    return execFileSync(process.env.TANACODE_CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)?.[0] ?? '';
  } catch {
    return '';
  }
}
