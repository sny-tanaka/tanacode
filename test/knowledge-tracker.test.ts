import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import type { ConversationEntry } from '@shared/transcript-line';
import type { SessionKnowledge } from '@shared/knowledge';
import { KnowledgeTracker } from '../src/main/knowledge-tracker';
import { instructionsContext, parentRoleText } from '@shared/project-instructions';

// 本体の会話ログから、Claude が読んだ・書いたファイルと、コンテキストの使用量を集める（KnowledgeTracker）。
// 行の形は、Claude Code 2.1.292 をモックの API で動かして取った会話ログ（@ の添付・Read・Edit・Write・サブフォルダの CLAUDE.md・/compact）に合わせた。
// edited_text_file と compact_file_reference の attachment は、その会話ログに出なかったので、src の読み取りに合わせて組み立てた

const CWD = '/work/app';
const file = (path: string): ConversationEntry => ({
  type: 'attachment',
  attachment: { type: 'file', filename: path, content: { type: 'text', file: { filePath: path, content: 'メモ\n' } }, displayPath: path.slice(CWD.length + 1) },
});
const nested = (path: string): ConversationEntry => ({
  type: 'attachment',
  attachment: { type: 'nested_memory', path, content: { path, type: 'Project', content: '# 決まり\n' }, displayPath: path.slice(CWD.length + 1) },
});
const reply = (blocks: unknown[], usage?: Record<string, number>, extra: Partial<TranscriptEntry> = {}): ConversationEntry =>
  ({ type: 'assistant', message: { content: blocks, ...(usage ? { usage } : {}) }, ...extra }) as ConversationEntry;
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `toolu_${name}`, name, input });

let changes: SessionKnowledge[];
let tracker: KnowledgeTracker;

beforeEach(() => {
  vi.useFakeTimers();
  changes = [];
  tracker = new KnowledgeTracker(CWD, (k) => changes.push(k));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KnowledgeTracker', () => {
  it('@ で添付・Read で読んだ・サブフォルダの CLAUDE.md は read、書いたものは edited。書いたあとに読んでも edited のまま', () => {
    tracker.handle(file(`${CWD}/notes.txt`));
    tracker.handle(nested(`${CWD}/sub/CLAUDE.md`));
    tracker.handle(reply([toolUse('Read', { file_path: `${CWD}/sub/code.txt` })]));
    tracker.handle(reply([toolUse('Edit', { file_path: `${CWD}/sub/code.txt`, old_string: '二行目', new_string: '2 行目' })]));
    tracker.handle(reply([toolUse('Write', { file_path: `${CWD}/new.txt`, content: 'あ\n' })]));
    tracker.handle(reply([toolUse('MultiEdit', { file_path: `${CWD}/multi.ts`, edits: [] })]));
    tracker.handle(reply([toolUse('NotebookEdit', { notebook_path: `${CWD}/book.ipynb`, new_source: 'x' })]));
    // 書いたあとに読んだ・添付し直された
    tracker.handle(reply([toolUse('Read', { file_path: `${CWD}/new.txt` })]));
    tracker.handle(file(`${CWD}/sub/code.txt`));
    expect(tracker.current().files).toEqual({
      'notes.txt': 'read',
      'sub/CLAUDE.md': 'read',
      'sub/code.txt': 'edited',
      'new.txt': 'edited',
      'multi.ts': 'edited',
      'book.ipynb': 'edited',
    });
  });

  it('アプリのフックが渡した TANACODE.md と、「親にする」で読ませた TANACODE_PARENT.md は read。長すぎて中身を渡さなかったものは数えない', () => {
    const context = (content: string) => ({
      type: 'attachment',
      attachment: { type: 'hook_additional_context', hookName: 'SessionStart', content: ['ユーザーのフックの文', instructionsContext([{ path: `${CWD}/TANACODE.md`, content: content, sum: '0123456789ab' }])] },
    }) as ConversationEntry;
    tracker.handle(context('# 決まり'));
    tracker.handle({ type: 'user', message: { content: parentRoleText([{ path: `${CWD}/TANACODE_PARENT.md`, content: '# 親' }], 'はじめて') } } as ConversationEntry);
    expect(tracker.current().files).toEqual({ 'TANACODE.md': 'read', 'TANACODE_PARENT.md': 'read' });
    // 作業の途中に送った（順番待ちから差し込まれた）もの・ブロックの形の発言
    const other = new KnowledgeTracker(CWD, () => {});
    other.handle({ type: 'attachment', attachment: { type: 'queued_command', prompt: parentRoleText([{ path: `${CWD}/a/TANACODE_PARENT.md`, content: '# 親' }]) } } as ConversationEntry);
    other.handle({ type: 'user', message: { content: [{ type: 'text', text: parentRoleText([{ path: `${CWD}/b/TANACODE_PARENT.md`, content: '# 親' }]) }] } } as ConversationEntry);
    // 長すぎて Read で読むよう頼んだもの・ただの発言・Claude Code が足した行
    other.handle(context('あ'.repeat(10_000)));
    other.handle({ type: 'user', message: { content: 'ふつうの発言' } } as ConversationEntry);
    other.handle({ type: 'user', isMeta: true, message: { content: parentRoleText([{ path: `${CWD}/c/TANACODE_PARENT.md`, content: '# 親' }]) } } as ConversationEntry);
    expect(other.current().files).toEqual({ 'a/TANACODE_PARENT.md': 'read', 'b/TANACODE_PARENT.md': 'read' });
  });

  it('プロファイルとフォルダの両方を 1 つの文で渡した・読ませたときは、ファイルごとに印を付ける。フォルダの外のプロファイルのものは数えない', () => {
    tracker.handle({
      type: 'attachment',
      attachment: {
        type: 'hook_additional_context',
        hookName: 'SessionStart',
        content: [
          instructionsContext([
            { path: '/Users/me/.claude/TANACODE.md', content: '# どのセッションでも', sum: '0123456789ab' },
            { path: `${CWD}/TANACODE.md`, content: '# このフォルダでは', sum: 'ba9876543210' },
          ]),
        ],
      },
    } as ConversationEntry);
    const parents = [
      { path: '/Users/me/.claude/TANACODE_PARENT.md', content: '# 親' },
      { path: `${CWD}/sub/TANACODE_PARENT.md`, content: '# 親' },
    ];
    tracker.handle({ type: 'user', message: { content: parentRoleText(parents) } } as ConversationEntry);
    expect(tracker.current().files).toEqual({ 'TANACODE.md': 'read', 'sub/TANACODE_PARENT.md': 'read' });
  });

  it('フォルダの外・相対パス・フォルダそのもの・サブエージェントの行・名前の無いツール・文字列でないパスは数えない', () => {
    tracker.handle(file('/etc/hostname'));
    tracker.handle(file(`${CWD}-other/a.ts`));
    tracker.handle(file('relative/a.ts'));
    tracker.handle(nested(CWD));
    tracker.handle({ ...file(`${CWD}/side.ts`), isSidechain: true });
    tracker.handle(reply([{ type: 'tool_use', id: 't', input: { file_path: `${CWD}/noname.ts` } }, { type: 'text', text: '読みます' }]));
    tracker.handle(reply([toolUse('Read', { file_path: 42 })]));
    tracker.handle(reply([toolUse('Glob', { path: `${CWD}/src` })]));
    tracker.handle({ type: 'assistant', message: { content: 'ただの文字' } });
    tracker.handle({ type: 'attachment' });
    expect(tracker.current().files).toEqual({});
    vi.advanceTimersByTime(200);
    expect(changes).toEqual([]);
    // 相対パスは、アプリの今のフォルダから見たものになってしまうので、フォルダが同じでも数えない
    const here = new KnowledgeTracker(process.cwd(), () => {});
    here.handle(file('relative/a.ts'));
    expect(here.current().files).toEqual({});
  });

  it('ワークスペースに追加したフォルダの中のファイルは、絶対パスのまま数える。追加したフォルダは、そのときのものを聞く', () => {
    let added = ['/work/lib'];
    const withFolders = new KnowledgeTracker(CWD, () => {}, () => added);
    withFolders.handle(file('/work/lib/util.ts'));
    withFolders.handle(reply([toolUse('Edit', { file_path: '/work/lib/src/a.ts' })]));
    // セッションのフォルダの中は、これまでどおり相対パス。追加したフォルダそのもの・その外は数えない
    withFolders.handle(file(`${CWD}/main.ts`));
    withFolders.handle(nested('/work/lib'));
    withFolders.handle(file('/work/library/b.ts'));
    expect(withFolders.current().files).toEqual({ '/work/lib/util.ts': 'read', '/work/lib/src/a.ts': 'edited', 'main.ts': 'read' });
    added = ['/work/other'];
    withFolders.handle(file('/work/other/c.ts'));
    withFolders.handle(file('/work/lib/d.ts'));
    expect(withFolders.current().files['/work/other/c.ts']).toBe('read');
    expect(withFolders.current().files['/work/lib/d.ts']).toBeUndefined();
  });

  it('それより外のファイルは、道具で読んだ・書いたときだけ outside に覚えさせ（行の時刻を添える）、覚えたものは絶対パスのまま数える', () => {
    const calls: [string, number, boolean][] = [];
    const known = new Set<string>();
    const outside = (path: string, at: number, discover: boolean) => {
      calls.push([path, at, discover]);
      if (discover && !path.includes('/skip/')) known.add(path);
      return known.has(path);
    };
    const withOutside = new KnowledgeTracker(CWD, () => {}, () => ['/work/lib'], outside);
    const at = '2026-10-23T01:02:03.000Z';
    withOutside.handle(reply([toolUse('Read', { file_path: '/other/repo/a.ts' })], undefined, { timestamp: at }));
    withOutside.handle(reply([toolUse('Write', { file_path: '/other/memo.txt' })]));
    withOutside.handle(reply([toolUse('NotebookEdit', { notebook_path: '/other/book.ipynb' })]));
    withOutside.handle(reply([toolUse('Read', { file_path: '/skip/x.ts' })]));
    // 添付（@ の添付・CLAUDE.md の自動の読み込み）は、覚えているものに印を付けるだけ
    withOutside.handle(nested('/other/repo/CLAUDE.md'));
    withOutside.handle(file('/other/repo/a.ts'));
    // セッションのフォルダ・追加したフォルダの中のもの、相対パスは聞かない
    withOutside.handle(reply([toolUse('Read', { file_path: `${CWD}/in.ts` })]));
    withOutside.handle(reply([toolUse('Read', { file_path: '/work/lib/in.ts' })]));
    withOutside.handle(reply([toolUse('Read', { file_path: 'rel.ts' })]));
    expect(calls).toEqual([
      ['/other/repo/a.ts', Date.parse(at), true],
      ['/other/memo.txt', 0, true],
      ['/other/book.ipynb', 0, true],
      ['/skip/x.ts', 0, true],
      ['/other/repo/CLAUDE.md', 0, false],
      ['/other/repo/a.ts', 0, false],
    ]);
    expect(withOutside.current().files).toEqual({
      '/other/repo/a.ts': 'read',
      '/other/memo.txt': 'edited',
      '/other/book.ipynb': 'edited',
      'in.ts': 'read',
      '/work/lib/in.ts': 'read',
    });
  });

  it('使用量は、入力・キャッシュの作成・キャッシュの読み込みの合計。0 や同じ量では変えない', () => {
    tracker.handle(reply([{ type: 'text', text: 'はい' }], { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 3, output_tokens: 20 }));
    expect(tracker.current().contextTokens).toBe(123);
    vi.advanceTimersByTime(100);
    expect(changes).toHaveLength(1);
    // 同じ量・0 の応答では知らせない
    tracker.handle(reply([], { input_tokens: 123 }));
    tracker.handle(reply([], { output_tokens: 5 }));
    vi.advanceTimersByTime(100);
    expect(changes).toHaveLength(1);
    expect(tracker.current().contextTokens).toBe(123);
    // 項目の一部だけの usage も読める
    tracker.handle(reply([], { cache_read_input_tokens: 500 }));
    expect(tracker.current().contextTokens).toBe(500);
  });

  it('圧縮すると、読んだ・書いたものは stale に、使用量は圧縮後の量になる。添付し直されたものは read に戻る', () => {
    tracker.handle(file(`${CWD}/notes.txt`));
    tracker.handle(reply([toolUse('Write', { file_path: `${CWD}/new.txt`, content: 'あ\n' })], { input_tokens: 9000 }));
    // 2.1.292 の /compact の区切りの行（compactMetadata の postTokens が圧縮後の量）
    tracker.handle({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      compactMetadata: { trigger: 'manual', preTokens: 9000, postTokens: 1313 } as TranscriptEntry['compactMetadata'],
    });
    expect(tracker.current()).toEqual({ files: { 'notes.txt': 'stale', 'new.txt': 'stale' }, contextTokens: 1313 });
    // 圧縮のあとに添付し直されたファイル
    tracker.handle(file(`${CWD}/new.txt`));
    // 圧縮で名前だけ残ったもの（中身は要約に置き換わった）
    tracker.handle({ type: 'attachment', attachment: { type: 'compact_file_reference', filename: `${CWD}/big.log` } });
    // 変更に気づいた知らせ
    tracker.handle({ type: 'attachment', attachment: { type: 'edited_text_file', filename: `${CWD}/notes.txt`, snippet: '1\tメモ' } });
    expect(tracker.current().files).toEqual({ 'notes.txt': 'read', 'new.txt': 'read', 'big.log': 'stale' });
  });

  it('圧縮後の量が書かれていない区切りでは、使用量はそのまま', () => {
    tracker.handle(reply([], { input_tokens: 777 }));
    tracker.handle({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 777 } });
    expect(tracker.current().contextTokens).toBe(777);
  });

  it('知らせは 100ms まとめて 1 回にし、そのときの全体を渡す。やり直す（reset）と空を知らせる', () => {
    tracker.handle(file(`${CWD}/a.ts`));
    tracker.handle(file(`${CWD}/b.ts`));
    tracker.handle(reply([], { input_tokens: 50 }));
    vi.advanceTimersByTime(99);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([{ files: { 'a.ts': 'read', 'b.ts': 'read' }, contextTokens: 50 }]);
    // 同じ印をもう一度付けても知らせない
    tracker.handle(file(`${CWD}/a.ts`));
    vi.advanceTimersByTime(200);
    expect(changes).toHaveLength(1);
    tracker.reset();
    vi.advanceTimersByTime(100);
    expect(changes.at(-1)).toEqual({ files: {}, contextTokens: null });
  });
});
