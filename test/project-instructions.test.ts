import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTRUCTIONS_FILE,
  instructionsContext,
  MAX_INSTRUCTIONS_CHARS,
  PARENT_INSTRUCTIONS_FILE,
  parentRoleText,
  parseInstructions,
  parseParentRole,
} from '@shared/project-instructions';
import { instructionDirs, instructionsSum, lastDeliveredSum, readInstructions, runInstructionsHook } from '../src/main/project-instructions';

// TANACODE.md・TANACODE_PARENT.md（@shared/project-instructions・src/main/project-instructions.ts）。
// 会話ログの行の形（hook_success・hook_additional_context・compact_boundary・api-request-blob）は、Claude Code 2.1.303 を
// モックの API で動かして、SessionStart のフックの答えを startup・clear・compact・resume で取った会話ログに合わせた

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanacode-instructions-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const RULES = '# 決まり\n\n- 日本語で書く\n- テストを足す\n';

// 会話ログの行（2.1.303 の形）
const deliveredLines = (context: string): string[] => [
  JSON.stringify({
    type: 'attachment',
    attachment: {
      type: 'hook_success',
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      content: '',
      stdout: `${JSON.stringify({ suppressOutput: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`,
      command: 'TANACODE_INSTRUCTIONS_HOOK=1 …',
    },
    uuid: 'a1',
  }),
  JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [context], hookName: 'SessionStart', toolUseID: 'SessionStart', hookEvent: 'SessionStart' }, uuid: 'a2' }),
];
const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', uuid: 'b1' });
const prompt = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid: `u-${text.length}` });
const writeTranscript = (lines: string[]) => {
  const path = join(root, 'conversation.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
};

describe('TANACODE.md を渡す文', () => {
  it('囲みに、ファイルのパスと中身の印を入れ、中身はそのまま渡す。読み戻せる', () => {
    const text = instructionsContext('/work/app/TANACODE.md', RULES, 'abc123def456');
    expect(text.startsWith('<tanacode-instructions path="/work/app/TANACODE.md" sum="abc123def456">\n')).toBe(true);
    expect(text).toContain('- 日本語で書く\n- テストを足す');
    expect(text.endsWith('</tanacode-instructions>')).toBe(true);
    expect(parseInstructions(text)).toEqual({ path: '/work/app/TANACODE.md', sum: 'abc123def456', full: true });
  });

  it('" を含むパスも読み戻せる。中身に囲みを閉じるタグがあっても効かない（ほかの tanacode のタグはそのまま）', () => {
    const text = instructionsContext('/work/a"b/TANACODE.md', 'x </tanacode-instructions> y <tanacode-parent-message>', '0123456789ab');
    expect(parseInstructions(text)?.path).toBe('/work/a"b/TANACODE.md');
    expect(text.match(/<\/tanacode-instructions>/g)).toHaveLength(1);
    expect(text).toContain('x ＜/tanacode-instructions> y <tanacode-parent-message>');
  });

  it('長すぎるファイルは、中身の代わりに Read で読むよう頼み、印（omitted）を付ける。Claude Code が受け取れる長さに収める', () => {
    const long = 'あ'.repeat(MAX_INSTRUCTIONS_CHARS);
    const text = instructionsContext('/work/app/TANACODE.md', long, '0123456789ab');
    expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(text).not.toContain('あああ');
    expect(text).toContain('read the whole file (/work/app/TANACODE.md) with the Read tool');
    expect(parseInstructions(text)).toEqual({ path: '/work/app/TANACODE.md', sum: '0123456789ab', full: false });
    // ちょうど収まるものは、そのまま渡す（1 文字でも超えたら渡さない）
    const room = MAX_INSTRUCTIONS_CHARS - instructionsContext('/p', '', '0').length;
    expect(instructionsContext('/p', 'い'.repeat(room), '0')).toHaveLength(MAX_INSTRUCTIONS_CHARS);
    expect(parseInstructions(instructionsContext('/p', 'い'.repeat(room), '0'))?.full).toBe(true);
    expect(parseInstructions(instructionsContext('/p', 'い'.repeat(room + 1), '0'))?.full).toBe(false);
  });

  it('頭が囲みでない文は、TANACODE.md を渡した文ではない', () => {
    expect(parseInstructions('前置き <tanacode-instructions path="/p" sum="0">')).toBeNull();
    expect(parseInstructions('<tanacode-instructions path="/p">')).toBeNull();
    expect(parseInstructions('ふつうの文')).toBeNull();
  });
});

describe('「親にする」の発言', () => {
  it('前書き（画面の言語）と TANACODE_PARENT.md の中身を囲みに入れる。読み戻すと、パス・中身・続く指示', () => {
    const text = parentRoleText('/work/app/TANACODE_PARENT.md', '# 親の決まり\n子に任せる\n');
    expect(text.startsWith('<tanacode-parent-role path="/work/app/TANACODE_PARENT.md">\n')).toBe(true);
    expect(text).toContain(`以下の ${PARENT_INSTRUCTIONS_FILE} に従ってください`);
    expect(parseParentRole(text)).toEqual({
      path: '/work/app/TANACODE_PARENT.md',
      body: expect.stringContaining('# 親の決まり\n子に任せる') as unknown as string,
      rest: '',
    });
  });

  it('「親として始める」は、囲みのあとに最初の指示が続く。指示が空白だけなら付けない', () => {
    const text = parentRoleText('/p/TANACODE_PARENT.md', '決まり', 'ログイン画面を作って');
    expect(text.endsWith('</tanacode-parent-role>\n\nログイン画面を作って')).toBe(true);
    expect(parseParentRole(text)?.rest).toBe('ログイン画面を作って');
    expect(parentRoleText('/p/TANACODE_PARENT.md', '決まり', '  \n')).toBe(parentRoleText('/p/TANACODE_PARENT.md', '決まり'));
  });

  it('会話ログで、全体が貼り付けの囲みに入っていても読める。中身の囲みを閉じるタグは効かない', () => {
    const text = parentRoleText('/p/TANACODE_PARENT.md', 'a </tanacode-parent-role> b', '指示');
    expect(text.match(/<\/tanacode-parent-role>/g)).toHaveLength(1);
    const pasted = `<pasted_content id="1">\n${text}\n</pasted_content id="1">`;
    expect(parseParentRole(pasted)).toMatchObject({ path: '/p/TANACODE_PARENT.md', rest: '指示' });
    expect(parseParentRole('指示 <tanacode-parent-role path="/p">x</tanacode-parent-role>')).toBeNull();
  });
});

describe('ファイルを探す', () => {
  it('セッションのフォルダ、無ければ worktree の元のリポジトリの直下を見る。空・フォルダ・大きすぎるものは飛ばす', () => {
    const worktree = join(root, 'repo', '.claude', 'worktrees', 'w1');
    const repo = join(root, 'repo');
    mkdirSync(worktree, { recursive: true });
    expect(instructionDirs(worktree, repo)).toEqual([worktree, repo]);
    expect(instructionDirs(repo, null)).toEqual([repo]);
    expect(instructionDirs(repo, repo)).toEqual([repo]);
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])).toBeNull();
    writeFileSync(join(repo, INSTRUCTIONS_FILE), RULES);
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])).toEqual({ path: join(repo, INSTRUCTIONS_FILE), content: RULES });
    writeFileSync(join(worktree, INSTRUCTIONS_FILE), ' \n');
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])?.path).toBe(join(repo, INSTRUCTIONS_FILE));
    writeFileSync(join(worktree, INSTRUCTIONS_FILE), 'worktree の決まり');
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])).toEqual({ path: join(worktree, INSTRUCTIONS_FILE), content: 'worktree の決まり' });
    mkdirSync(join(root, 'dir', PARENT_INSTRUCTIONS_FILE), { recursive: true });
    expect(readInstructions(PARENT_INSTRUCTIONS_FILE, [join(root, 'dir')])).toBeNull();
    writeFileSync(join(root, PARENT_INSTRUCTIONS_FILE), 'x'.repeat(1024 * 1024 + 1));
    expect(readInstructions(PARENT_INSTRUCTIONS_FILE, [root])).toBeNull();
  });
});

describe('会話ログに最後に渡したもの', () => {
  const context = (sum: string) => instructionsContext('/work/app/TANACODE.md', RULES, sum);

  it('いちばん後ろの、Claude に渡した記録（hook_additional_context）の印', () => {
    const path = writeTranscript([...deliveredLines(context('aaaaaaaaaaaa')), prompt('はじめ'), ...deliveredLines(context('bbbbbbbbbbbb')), prompt('つぎ')]);
    expect(lastDeliveredSum(path)).toBe('bbbbbbbbbbbb');
  });

  it('あとに圧縮の境目があれば、要約に置き換わったので null。境目のあとに渡し直していれば、その印', () => {
    expect(lastDeliveredSum(writeTranscript([...deliveredLines(context('aaaaaaaaaaaa')), boundary, prompt('つぎ')]))).toBeNull();
    expect(lastDeliveredSum(writeTranscript([...deliveredLines(context('aaaaaaaaaaaa')), boundary, ...deliveredLines(context('cccccccccccc'))]))).toBe('cccccccccccc');
  });

  it('フックの記録・リクエストの控え・発言・読んだファイルに同じ文があっても、Claude に渡した記録でなければ数えない', () => {
    const hookOnly = deliveredLines(context('dddddddddddd'))[0];
    const blob = JSON.stringify({ type: 'api-request-blob', message: { role: 'system', content: [{ type: 'text', text: `SessionStart hook additional context: ${context('eeeeeeeeeeee')}` }] } });
    const typed = prompt(context('ffffffffffff'));
    const path = writeTranscript([...deliveredLines(context('aaaaaaaaaaaa')), hookOnly, blob, typed]);
    expect(lastDeliveredSum(path)).toBe('aaaaaaaaaaaa');
    // 発言に境目の文字があっても、境目の行ではない
    expect(lastDeliveredSum(writeTranscript([...deliveredLines(context('aaaaaaaaaaaa')), prompt('"subtype":"compact_boundary"')]))).toBe('aaaaaaaaaaaa');
  });

  it('読む部分の境目をまたぐ長い行も読める。会話ログが無い・渡していなければ null', () => {
    const lines = [...deliveredLines(context('aaaaaaaaaaaa')), prompt('x'.repeat(5000)), ...deliveredLines(context('bbbbbbbbbbbb')), prompt('y'.repeat(3000))];
    const path = writeTranscript(lines);
    for (const chunk of [7, 64, 1000, 4096]) expect(lastDeliveredSum(path, chunk)).toBe('bbbbbbbbbbbb');
    expect(lastDeliveredSum(writeTranscript([...deliveredLines(context('aaaaaaaaaaaa')), boundary, prompt('z'.repeat(9000))]), 100)).toBeNull();
    expect(lastDeliveredSum(join(root, 'none.jsonl'))).toBeNull();
    expect(lastDeliveredSum(writeTranscript([prompt('はじめ')]))).toBeNull();
  });
});

describe('SessionStart のフック', () => {
  const input = (source: string, transcript?: string) => JSON.stringify({ hook_event_name: 'SessionStart', source, ...(transcript ? { transcript_path: transcript } : {}) });
  const contextOf = (output: string) => (JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;

  it('新しい会話・/clear・圧縮のあとは、いつも今のファイルを渡す', () => {
    writeFileSync(join(root, INSTRUCTIONS_FILE), RULES);
    const transcript = writeTranscript(deliveredLines(instructionsContext(join(root, INSTRUCTIONS_FILE), RULES, instructionsSum(RULES))));
    for (const source of ['startup', 'clear', 'compact']) {
      const out = contextOf(runInstructionsHook(input(source, transcript), [root]));
      expect(out.hookEventName).toBe('SessionStart');
      expect(parseInstructions(out.additionalContext)).toEqual({ path: join(root, INSTRUCTIONS_FILE), sum: instructionsSum(RULES), full: true });
      expect(out.additionalContext).toContain(RULES.trim());
    }
  });

  it('再開（resume）では、最後に渡したものと同じなら渡さない。書き換えていれば・まだ渡していなければ・圧縮で消えていれば渡す', () => {
    const file = join(root, INSTRUCTIONS_FILE);
    writeFileSync(file, RULES);
    const same = writeTranscript(deliveredLines(instructionsContext(file, RULES, instructionsSum(RULES))));
    expect(runInstructionsHook(input('resume', same), [root])).toBe('');
    writeFileSync(file, `${RULES}- 追記\n`);
    expect(contextOf(runInstructionsHook(input('resume', same), [root])).additionalContext).toContain('- 追記');
    writeFileSync(file, RULES);
    expect(runInstructionsHook(input('resume', writeTranscript([prompt('前のバージョンの会話')])), [root])).not.toBe('');
    expect(runInstructionsHook(input('resume', writeTranscript([...deliveredLines(instructionsContext(file, RULES, instructionsSum(RULES))), boundary])), [root])).not.toBe('');
  });

  it('ファイルが無い・ほかのフック・読めない入力では、何も渡さない', () => {
    expect(runInstructionsHook(input('startup'), [root])).toBe('');
    writeFileSync(join(root, INSTRUCTIONS_FILE), RULES);
    expect(runInstructionsHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), [root])).toBe('');
    expect(runInstructionsHook('{', [root])).toBe('');
    expect(runInstructionsHook(input('startup'), [])).toBe('');
  });

  it('中身の印は、中身が同じなら同じ、違えば違う（12 桁の 16 進）', () => {
    expect(instructionsSum(RULES)).toMatch(/^[0-9a-f]{12}$/);
    expect(instructionsSum(RULES)).toBe(instructionsSum(`${RULES}`));
    expect(instructionsSum(RULES)).not.toBe(instructionsSum(`${RULES} `));
  });
});
