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
import { instructionDirs, instructionsProblemText, instructionsSum, lastDeliveredSum, MAX_FILE_BYTES, readInstructions, runInstructionsHook } from '../src/main/project-instructions';

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

// 会話ログ（2.1.303 の形）。行は親（parentUuid）でつながる。親を指定しなければ、直前に足した行が親
class Log {
  readonly lines: string[] = [];
  last: string | null = null;
  private count = 0;
  private add(entry: Record<string, unknown>, parent: string | null = this.last): string {
    const uuid = `l${++this.count}`;
    this.lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, ...entry, uuid }));
    this.last = uuid;
    return uuid;
  }
  // フックの記録（hook_success の stdout にも同じ文が入る）と、Claude に文を渡した記録（hook_additional_context）
  delivered(context: string, parent?: string | null): string {
    this.add(
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          hookName: 'SessionStart:startup',
          hookEvent: 'SessionStart',
          content: '',
          stdout: `${JSON.stringify({ suppressOutput: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`,
          command: 'TANACODE_INSTRUCTIONS_HOOK=1 …',
        },
      },
      parent,
    );
    return this.add({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [context], hookName: 'SessionStart', toolUseID: 'SessionStart', hookEvent: 'SessionStart' } });
  }
  prompt(text: string, parent?: string | null): string {
    return this.add({ type: 'user', message: { role: 'user', content: text } }, parent);
  }
  reply(text: string, parent?: string | null): string {
    return this.add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }, parent);
  }
  // 圧縮の境目（親を持たない。前の会話は logicalParentUuid で指す）
  boundary(): string {
    const before = this.last;
    return this.add({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', logicalParentUuid: before }, null);
  }
  // uuid の無い行（リクエストの控え）・サブエージェントの行
  raw(entry: Record<string, unknown>): void {
    this.lines.push(JSON.stringify(entry));
  }
  write(): string {
    const path = join(root, 'conversation.jsonl');
    writeFileSync(path, `${this.lines.join('\n')}\n`);
    return path;
  }
}

describe('TANACODE.md を渡す文', () => {
  it('囲みに、ファイルのパスと中身の印を入れ、中身はそのまま渡す。読み戻せる', () => {
    const text = instructionsContext('/work/app/TANACODE.md', RULES, 'abc123def456');
    expect(text.startsWith('<tanacode-instructions path="/work/app/TANACODE.md" sum="abc123def456">\n')).toBe(true);
    expect(text).toContain('- 日本語で書く\n- テストを足す');
    expect(text.endsWith('</tanacode-instructions>')).toBe(true);
    expect(parseInstructions(text)).toEqual({ path: '/work/app/TANACODE.md', sum: 'abc123def456', full: true });
  });

  it('" を含むパスも読み戻せる。中身の tanacode のタグは、囲みを閉じるものも、ほかのものも、どれも効かない（「親にする」と同じ）', () => {
    const text = instructionsContext('/work/a"b/TANACODE.md', 'x </tanacode-instructions> y <tanacode-parent-message> z', '0123456789ab');
    expect(parseInstructions(text)?.path).toBe('/work/a"b/TANACODE.md');
    expect(text.match(/<\/tanacode-instructions>/g)).toHaveLength(1);
    expect(text).toContain('x ＜/tanacode-instructions> y ＜tanacode-parent-message> z');
    expect(text).toContain("kept in the session's folder");
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

  it('会話ログで、全体が貼り付けの囲みに入っていても読める。中身の tanacode のタグは、どれも効かない（まとめた発言の行の切れ目にならない）', () => {
    const text = parentRoleText('/p/TANACODE_PARENT.md', 'a </tanacode-parent-role> b\n<tanacode-parent-message session="x">c</tanacode-parent-message>', '指示');
    expect(text.match(/<\/tanacode-parent-role>/g)).toHaveLength(1);
    expect(text).toContain('a ＜/tanacode-parent-role> b\n＜tanacode-parent-message session="x">c＜/tanacode-parent-message>');
    const pasted = `<pasted_content id="1">\n${text}\n</pasted_content id="1">`;
    expect(parseParentRole(pasted)).toMatchObject({ path: '/p/TANACODE_PARENT.md', rest: '指示' });
    expect(parseParentRole('指示 <tanacode-parent-role path="/p">x</tanacode-parent-role>')).toBeNull();
  });
});

describe('ファイルを探す', () => {
  it('セッションのフォルダ、無ければ worktree の元のリポジトリの直下を見る。元のリポジトリは、記録に無くてもパスから求める', () => {
    const worktree = join(root, 'repo', '.claude', 'worktrees', 'w1');
    const repo = join(root, 'repo');
    mkdirSync(worktree, { recursive: true });
    expect(instructionDirs(worktree, repo)).toEqual([worktree, repo]);
    // .claude/worktrees/<名前> を直に選んだセッション・既存の worktree をフォルダにした子（記録の worktree が無い）
    expect(instructionDirs(worktree, null)).toEqual([worktree, repo]);
    expect(instructionDirs(`${worktree}/`, undefined)).toEqual([`${worktree}/`, repo]);
    expect(instructionDirs(repo, null)).toEqual([repo]);
    expect(instructionDirs(repo, repo)).toEqual([repo]);
    expect(instructionDirs(join(worktree, 'sub'), null)).toEqual([join(worktree, 'sub')]);
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])).toBeNull();
    writeFileSync(join(repo, INSTRUCTIONS_FILE), RULES);
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])).toEqual({ path: join(repo, INSTRUCTIONS_FILE), content: RULES });
    writeFileSync(join(worktree, INSTRUCTIONS_FILE), 'worktree の決まり');
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])).toEqual({ path: join(worktree, INSTRUCTIONS_FILE), content: 'worktree の決まり' });
  });

  it('worktree にファイルがあれば、使えなくても（空・大きすぎる・ファイルでない）、元のリポジトリのものに戻らない', () => {
    const worktree = join(root, 'repo', '.claude', 'worktrees', 'w1');
    const repo = join(root, 'repo');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repo, INSTRUCTIONS_FILE), RULES);
    const file = join(worktree, INSTRUCTIONS_FILE);
    writeFileSync(file, ' \n');
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])).toEqual({ path: file, problem: 'empty' });
    writeFileSync(file, 'x'.repeat(MAX_FILE_BYTES + 1));
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])).toEqual({ path: file, problem: 'tooLarge' });
    writeFileSync(file, 'x'.repeat(MAX_FILE_BYTES));
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])).toMatchObject({ path: file, content: expect.any(String) });
    rmSync(file);
    mkdirSync(file);
    expect(readInstructions(INSTRUCTIONS_FILE, [worktree, repo])).toEqual({ path: file, problem: 'unreadable' });
    // 途中のフォルダがファイルのとき（ENOTDIR）は、無いものとして次へ
    writeFileSync(join(root, 'plain'), '');
    expect(readInstructions(INSTRUCTIONS_FILE, [join(root, 'plain'), repo])).toEqual({ path: join(repo, INSTRUCTIONS_FILE), content: RULES });
    // チャットに出す理由
    expect(instructionsProblemText({ path: file, problem: 'tooLarge' })).toBe(`${file} が大きすぎる（1MB を超える）ので、Claude に渡していません`);
    expect(instructionsProblemText({ path: file, problem: 'empty' })).toBe(`${file} が空なので、Claude に渡していません`);
    expect(instructionsProblemText({ path: file, problem: 'unreadable' })).toBe(`${file} を読めないので、Claude に渡していません`);
  });
});

describe('会話ログに最後に渡したもの', () => {
  const context = (sum: string) => instructionsContext('/work/app/TANACODE.md', RULES, sum);

  it('今の会話に、いちばん近くで Claude に渡した記録（hook_additional_context）の印', () => {
    const log = new Log();
    log.delivered(context('aaaaaaaaaaaa'), null);
    log.prompt('はじめ');
    log.reply('はい');
    log.delivered(context('bbbbbbbbbbbb'));
    log.prompt('つぎ');
    log.reply('はい');
    expect(lastDeliveredSum(log.write())).toBe('bbbbbbbbbbbb');
  });

  it('あとに圧縮の境目があれば、要約に置き換わったので null。境目のあとに渡し直していれば、その印', () => {
    const log = new Log();
    log.delivered(context('aaaaaaaaaaaa'), null);
    log.prompt('はじめ');
    log.boundary();
    log.prompt('つぎ');
    expect(lastDeliveredSum(log.write())).toBeNull();
    log.delivered(context('cccccccccccc'));
    expect(lastDeliveredSum(log.write())).toBe('cccccccccccc');
  });

  it('「ここまで戻す」で枝分かれしたら、今の枝だけを見る。外れた枝で渡したものは数えない', () => {
    const log = new Log();
    log.delivered(context('aaaaaaaaaaaa'), null);
    log.prompt('はじめ');
    const first = log.reply('はい');
    // 再開して書き換えた中身（v2）を渡したあと、それより前（はじめの返事のあと）まで戻して、続きを発言した
    log.delivered(context('bbbbbbbbbbbb'));
    log.prompt('戻す前の発言');
    log.reply('はい');
    log.prompt('戻したあとの発言', first);
    log.reply('はい');
    expect(lastDeliveredSum(log.write())).toBe('aaaaaaaaaaaa');
    // 今の枝に何も渡していなければ null
    const other = new Log();
    other.prompt('はじめ', null);
    const reply = other.reply('はい');
    other.delivered(context('bbbbbbbbbbbb'));
    other.prompt('戻す前');
    other.prompt('戻したあと', reply);
    expect(lastDeliveredSum(other.write())).toBeNull();
  });

  it('フックの記録・リクエストの控え・発言・サブエージェントの行に同じ文があっても、今の枝で Claude に渡した記録でなければ数えない', () => {
    const log = new Log();
    log.delivered(context('aaaaaaaaaaaa'), null);
    log.raw({ type: 'api-request-blob', message: { role: 'system', content: [{ type: 'text', text: `SessionStart hook additional context: ${context('eeeeeeeeeeee')}` }] } });
    log.prompt(context('ffffffffffff'));
    log.raw({ parentUuid: log.last, isSidechain: true, uuid: 'side', type: 'attachment', attachment: { type: 'hook_additional_context', content: [context('dddddddddddd')] } });
    log.prompt('"subtype":"compact_boundary" という文');
    expect(lastDeliveredSum(log.write())).toBe('aaaaaaaaaaaa');
  });

  it('会話ログが無い・渡していない・書きかけの行があっても読める。親が会話ログに無ければ null', () => {
    expect(lastDeliveredSum(join(root, 'none.jsonl'))).toBeNull();
    const log = new Log();
    log.prompt('はじめ', null);
    expect(lastDeliveredSum(log.write())).toBeNull();
    const broken = new Log();
    broken.delivered(context('aaaaaaaaaaaa'), null);
    broken.prompt('はじめ');
    broken.lines.push('{"parentUuid":"l3","uuid":"l4","type":"assist');
    expect(lastDeliveredSum(broken.write())).toBe('aaaaaaaaaaaa');
    const orphan = new Log();
    orphan.delivered(context('aaaaaaaaaaaa'), null);
    orphan.prompt('親の無い発言', 'missing');
    expect(lastDeliveredSum(orphan.write())).toBeNull();
  });
});

describe('SessionStart のフック', () => {
  const input = (source: string, transcript?: string) => JSON.stringify({ hook_event_name: 'SessionStart', source, ...(transcript ? { transcript_path: transcript } : {}) });
  const contextOf = (output: string) => (JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
  const deliveredLog = (file: string, content: string) => {
    const log = new Log();
    log.delivered(instructionsContext(file, content, instructionsSum(content)), null);
    log.prompt('はじめ');
    log.reply('はい');
    return log;
  };

  it('新しい会話・/clear・圧縮のあとは、いつも今のファイルを渡す', () => {
    writeFileSync(join(root, INSTRUCTIONS_FILE), RULES);
    const transcript = deliveredLog(join(root, INSTRUCTIONS_FILE), RULES).write();
    for (const source of ['startup', 'clear', 'compact']) {
      const out = contextOf(runInstructionsHook(input(source, transcript), [root]));
      expect(out.hookEventName).toBe('SessionStart');
      expect(parseInstructions(out.additionalContext)).toEqual({ path: join(root, INSTRUCTIONS_FILE), sum: instructionsSum(RULES), full: true });
      expect(out.additionalContext).toContain(RULES.trim());
    }
  });

  it('再開（resume）では、今の枝に最後に渡したものと同じなら渡さない。書き換えていれば・まだ渡していなければ・圧縮で消えていれば・戻した枝に無ければ渡す', () => {
    const file = join(root, INSTRUCTIONS_FILE);
    writeFileSync(file, RULES);
    const same = deliveredLog(file, RULES).write();
    expect(runInstructionsHook(input('resume', same), [root])).toBe('');
    writeFileSync(file, `${RULES}- 追記\n`);
    expect(contextOf(runInstructionsHook(input('resume', same), [root])).additionalContext).toContain('- 追記');
    writeFileSync(file, RULES);
    const old = new Log();
    old.prompt('前のバージョンの会話', null);
    expect(runInstructionsHook(input('resume', old.write()), [root])).not.toBe('');
    const compacted = deliveredLog(file, RULES);
    compacted.boundary();
    expect(runInstructionsHook(input('resume', compacted.write()), [root])).not.toBe('');
    // v1 を渡した会話で、再開して v2 を渡したあと、その前まで戻した。今のファイルは v2 なので、今の枝（v1 だけ）には渡し直す
    const v2 = `${RULES}- v2\n`;
    const branched = new Log();
    branched.delivered(instructionsContext(file, RULES, instructionsSum(RULES)), null);
    const first = branched.reply('はい');
    branched.delivered(instructionsContext(file, v2, instructionsSum(v2)));
    branched.prompt('戻す前');
    branched.prompt('戻したあと', first);
    writeFileSync(file, v2);
    expect(contextOf(runInstructionsHook(input('resume', branched.write()), [root])).additionalContext).toContain('- v2');
  });

  it('使えないファイル（空・大きすぎる）は渡さない。worktree にあれば、元のリポジトリのものも渡さない', () => {
    const repo = join(root, 'repo');
    const worktree = join(repo, '.claude', 'worktrees', 'w1');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repo, INSTRUCTIONS_FILE), RULES);
    expect(contextOf(runInstructionsHook(input('startup'), instructionDirs(worktree, null))).additionalContext).toContain(RULES.trim());
    writeFileSync(join(worktree, INSTRUCTIONS_FILE), '');
    expect(runInstructionsHook(input('startup'), instructionDirs(worktree, null))).toBe('');
    writeFileSync(join(worktree, INSTRUCTIONS_FILE), 'x'.repeat(MAX_FILE_BYTES + 1));
    expect(runInstructionsHook(input('startup'), instructionDirs(worktree, null))).toBe('');
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
