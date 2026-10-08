import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import type { SessionKnowledge } from '@shared/knowledge';
import { KnowledgeTracker } from '../src/main/knowledge-tracker';

// 本体の会話ログから、Claude が読んだ・書いたファイルと、コンテキストの使用量を集める（KnowledgeTracker）。
// 行の形は、Claude Code 2.1.292 をモックの API で動かして取った会話ログ（@ の添付・Read・Edit・Write・サブフォルダの CLAUDE.md・/compact）に合わせた。
// edited_text_file と compact_file_reference の attachment は、その会話ログに出なかったので、src の読み取りに合わせて組み立てた

const CWD = '/work/app';
const file = (path: string): TranscriptEntry => ({
  type: 'attachment',
  attachment: { type: 'file', filename: path, content: { type: 'text', file: { filePath: path, content: 'メモ\n' } }, displayPath: path.slice(CWD.length + 1) },
});
const nested = (path: string): TranscriptEntry => ({
  type: 'attachment',
  attachment: { type: 'nested_memory', path, content: { path, type: 'Project', content: '# 決まり\n' }, displayPath: path.slice(CWD.length + 1) },
});
const reply = (blocks: unknown[], usage?: Record<string, number>, extra: Partial<TranscriptEntry> = {}): TranscriptEntry =>
  ({ type: 'assistant', message: { content: blocks, ...(usage ? { usage } : {}) }, ...extra }) as TranscriptEntry;
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
