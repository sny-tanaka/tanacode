import { isAbsolute, relative, sep } from 'node:path';
import type { TranscriptEntry } from '@shared/chat';
import type { FileKnowledge, SessionKnowledge } from '@shared/knowledge';

export const READ_TOOLS = new Set(['Read']);
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// 再開時は過去の会話を 1 行ずつ読み直すので、知らせるのはまとめて行う
const EMIT_DELAY_MS = 100;

type Attachment = { type?: string; filename?: string; path?: string };
type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };

// 本体の会話ログから、Claude が読んだ・書いたファイルと、コンテキストの使用量を集める。
// サブエージェントが読んだものは本体のコンテキストに入らないので数えない
export class KnowledgeTracker {
  private files = new Map<string, FileKnowledge>();
  private contextTokens: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cwd: string,
    private readonly onChange: (knowledge: SessionKnowledge) => void,
  ) {}

  current(): SessionKnowledge {
    return { files: Object.fromEntries(this.files), contextTokens: this.contextTokens };
  }

  // 起動し直すと過去の会話を読み直す。/clear では会話が変わる
  reset(): void {
    this.files = new Map();
    this.contextTokens = null;
    this.emit();
  }

  handle(entry: TranscriptEntry): void {
    if (entry.isSidechain) return;
    let changed = false;
    const mark = (path: unknown, knowledge: FileKnowledge) => {
      const rel = typeof path === 'string' ? this.relative(path) : null;
      // 書いたことは、あとで読んだだけの印で上書きしない
      if (!rel || this.files.get(rel) === knowledge || (knowledge === 'read' && this.files.get(rel) === 'edited')) return;
      this.files.set(rel, knowledge);
      changed = true;
    };

    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      // 圧縮すると読んだ内容は要約に置き換わる。圧縮後に添付し直されたものは下の attachment で戻る
      for (const path of this.files.keys()) this.files.set(path, 'stale');
      // 次の応答まで使用量が分からないので、圧縮後の量を使う
      const post = (entry as { compactMetadata?: { postTokens?: number } }).compactMetadata?.postTokens;
      if (typeof post === 'number') this.contextTokens = post;
      changed = true;
    }
    if (entry.type === 'attachment') {
      const a = (entry as { attachment?: Attachment }).attachment;
      if (a?.type === 'file' || a?.type === 'edited_text_file') mark(a.filename, 'read');
      if (a?.type === 'nested_memory') mark(a.path, 'read');
      if (a?.type === 'compact_file_reference') mark(a.filename, 'stale');
    }
    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== 'tool_use' || !block.name) continue;
        if (READ_TOOLS.has(block.name)) mark(block.input?.file_path, 'read');
        if (EDIT_TOOLS.has(block.name)) mark(block.input?.file_path ?? block.input?.notebook_path, 'edited');
      }
      const usage = (entry.message as { usage?: Usage } | undefined)?.usage;
      if (usage) {
        const tokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        if (tokens > 0 && tokens !== this.contextTokens) {
          this.contextTokens = tokens;
          changed = true;
        }
      }
    }
    if (changed) this.emit();
  }

  private emit(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.onChange(this.current());
    }, EMIT_DELAY_MS);
  }

  private relative(path: string): string | null {
    if (!isAbsolute(path)) return null;
    const rel = relative(this.cwd, path);
    return rel && !rel.startsWith(`..${sep}`) && rel !== '..' ? rel : null;
  }
}
