import { isAbsolute, relative, sep } from 'node:path';
import type { FileKnowledge, SessionKnowledge } from '@shared/knowledge';
import { parseInstructions, parseParentRole } from '@shared/project-instructions';
import type { ConversationEntry } from '@shared/transcript-line';

export const READ_TOOLS = new Set(['Read']);
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// 再開時は過去の会話を 1 行ずつ読み直すので、知らせるのはまとめて行う
const EMIT_DELAY_MS = 100;

type Attachment = { type?: string; filename?: string; path?: string; content?: unknown; prompt?: unknown };
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
    // ワークスペースに追加したフォルダ。その中のファイルは、絶対パスのまま覚える（エクスプローラーが、追加したフォルダの行を絶対パスで持つため）
    private readonly addedFolders: () => readonly string[] = () => [],
    // それより外のファイル（絶対パス）を、エクスプローラーに出すものとして覚えているか。discover: Claude が道具で読んだ・書いたもので、
    // まだ覚えていなければ覚える（at: その行の時刻。ミリ秒、無ければ 0）。true のものは絶対パスのまま覚える
    private readonly outside: (path: string, at: number, discover: boolean) => boolean = () => false,
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

  // 会話の行（@shared/transcript-line）だけを受け取る
  handle(entry: ConversationEntry): void {
    if (entry.isSidechain) return;
    let changed = false;
    const at = entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0;
    // discover: Claude が道具で読んだ・書いたもの（外のファイルを、エクスプローラーに出すものとして覚える）。
    // 添付（CLAUDE.md の自動の読み込みなど）は、Claude が自分から触れたものではないので、覚えているものに印を付けるだけ
    const mark = (path: unknown, knowledge: FileKnowledge, discover = false) => {
      const rel = typeof path === 'string' ? this.relative(path, at, discover) : null;
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
      // 作業の途中に届いた「親にする」の発言（TANACODE_PARENT.md の中身が丸ごと入っている）
      if (a?.type === 'queued_command' && typeof a.prompt === 'string') for (const file of parseParentRole(a.prompt)?.files ?? []) mark(file.path, 'read');
      // アプリのフックが渡した TANACODE.md（中身が丸ごと Claude に渡っている。長すぎて中身を入れなかったものは、Claude が読んだときに付く）
      if (a?.type === 'hook_additional_context' && Array.isArray(a.content)) {
        for (const text of a.content) {
          for (const block of typeof text === 'string' ? parseInstructions(text) : []) if (block.full) mark(block.path, 'read');
        }
      }
    }
    // 「親にする」の発言（TANACODE_PARENT.md の中身が丸ごと入っている）
    if (entry.type === 'user' && !entry.isMeta) {
      const content = entry.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('') : '';
      for (const file of text ? (parseParentRole(text)?.files ?? []) : []) mark(file.path, 'read');
    }
    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== 'tool_use' || !block.name) continue;
        if (READ_TOOLS.has(block.name)) mark(block.input?.file_path, 'read', true);
        if (EDIT_TOOLS.has(block.name)) mark(block.input?.file_path ?? block.input?.notebook_path, 'edited', true);
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

  private relative(path: string, at: number, discover: boolean): string | null {
    if (!isAbsolute(path)) return null;
    const rel = relative(this.cwd, path);
    if (inside(rel)) return rel;
    if (this.addedFolders().some((folder) => inside(relative(folder, path)))) return path;
    return this.outside(path, at, discover) ? path : null;
  }
}

// relative() の結果が、そのフォルダの中のもの（フォルダそのものは除く）
function inside(rel: string): boolean {
  return !!rel && !rel.startsWith(`..${sep}`) && rel !== '..';
}
