import { lineChatEvents, type TranscriptEntry } from '@shared/chat';
import { classifyLine } from '@shared/transcript-line';

// Claude Code が書いた行の目録: 行の種類ごとに、出たフィールドの名前。互換性の確認（test/cli）が、台本で出た行（本体の会話ログ・
// サブエージェントとワークフローのエージェントの会話ログ・stream-json の行）から作り、バージョンごとの控え
// （test/fixtures/claude-code/<バージョン>/inventory.json）に残す。毎日の確認で、動作確認済のバージョンの目録と比べる
// （scripts/inventory-diff.mjs）。差があれば、バージョンを上げる PR を自動ではマージしない
//
// 会話ログの種類の名前:
// - 行: user・assistant・system/<subtype>・attachment/<type>・ほかの種類はその名前（@shared/transcript-line の分け方の、どの行も）
// - 発言と応答の content のブロック: user.content/<type>・assistant.content/<type>
// - ツールの結果（user の行の toolUseResult）: toolUseResult/<ツールの名前>（ツールの名前は、同じ会話ログの呼び出しから引く）
// フィールド: 行のいちばん上のキーと、message・attachment の中のキー（message.content など）。ブロックはブロックのキー、
// ツールの結果はそのキー（オブジェクトでなければ (string)・(array) など）。意図して捨てる行（API の要求の控えなど）は、
// 種類だけを載せる（中身は読まないので、フィールドが変わっても困らない。新しい種類が増えたことには気づける）
// stream-json の種類の名前: type・system/<subtype>・result/<subtype>・control_request/<subtype>・control_response/<subtype>・
// stream_event/<event の type>。フィールドは、いちばん上のキーと、message・request・event の中のキー。
// sources: その種類が出た台本（test/cli のファイルの名前）。比べるものではなく、差分を仕分けるときの手がかり（台本の揺れを見分ける）
export type Inventory = {
  transcript: Record<string, string[]>;
  stream: Record<string, string[]>;
  sources?: { transcript: Record<string, string[]>; stream: Record<string, string[]> };
};

type Kinds = Map<string, Set<string>>;

export class InventoryBuilder {
  private readonly transcript: Kinds = new Map();
  private readonly stream: Kinds = new Map();
  // 会話ログの、知らない種類（@shared/transcript-line の分け方と、チャットの組み立てで知らないもの。名前 → 数）
  readonly unknown = new Map<string, number>();

  // 1 つの会話ログの行（ツールの結果の名前を、同じ会話ログの呼び出しから引くので、ファイルごとに渡す）。cwd: チャットを組み立てるときの作業フォルダ
  addTranscript(entries: TranscriptEntry[], cwd: string): void {
    const toolNames = new Map<string, string>();
    for (const entry of entries) {
      const line = classifyLine(entry);
      // 知らないものは、チャットの組み立て（アプリと同じ）で見る。本体の会話ログのサブエージェントの行も見る
      for (const event of lineChatEvents(line, cwd, true)) {
        if (event.type === 'unknown-event') this.unknown.set(event.name, (this.unknown.get(event.name) ?? 0) + 1);
      }
      const kind = line.kind === 'unknown' ? line.name || '(no type)' : transcriptKind(entry);
      if (line.kind === 'ignored' || line.kind === 'unknown') {
        fields(this.transcript, kind);
        continue;
      }
      fields(this.transcript, kind, keysOf(entry), prefixed('message', entry.message), prefixed('attachment', entry.attachment));
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
      for (const block of blocks) {
        fields(this.transcript, `${entry.type}.content/${typeof block?.type === 'string' ? block.type : '(no type)'}`, keysOf(block));
        if (block?.type === 'tool_use' && block.id && block.name) toolNames.set(block.id, block.name);
      }
      const result = blocks.find((b) => b?.type === 'tool_result');
      if (result && entry.toolUseResult !== undefined) {
        const name = (result.tool_use_id && toolNames.get(result.tool_use_id)) || '(unknown tool)';
        fields(this.transcript, `toolUseResult/${name}`, shapeKeys(entry.toolUseResult));
      }
    }
  }

  // stream-json の行（Claude Code が標準出力に書いたもの）。JSON でない行は飛ばす（読めない行は unreadableStreamLines が数える）
  addStream(lines: string[]): void {
    for (const text of lines) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      const nested = (key: string) => prefixed(key, value[key]);
      fields(this.stream, streamKind(value), keysOf(value), nested('message'), nested('request'), nested('event'));
    }
  }

  // source: 台本の名前（あれば、どの種類にも出た台本として添える）
  result(source?: string): Inventory {
    const inventory: Inventory = { transcript: sorted(this.transcript), stream: sorted(this.stream) };
    if (source === undefined) return inventory;
    const from = (kinds: Record<string, string[]>) => Object.fromEntries(Object.keys(kinds).map((kind) => [kind, [source]]));
    return { ...inventory, sources: { transcript: from(inventory.transcript), stream: from(inventory.stream) } };
  }
}

// 目録を合わせる（台本ごとに作ったものを 1 つにする）
export function mergeInventories(inventories: Inventory[]): Inventory {
  const merged = { transcript: new Map(), stream: new Map() } as { transcript: Kinds; stream: Kinds };
  const sources = { transcript: new Map(), stream: new Map() } as { transcript: Kinds; stream: Kinds };
  for (const inventory of inventories) {
    for (const part of ['transcript', 'stream'] as const) {
      for (const [kind, names] of Object.entries(inventory[part])) fields(merged[part], kind, names);
      for (const [kind, names] of Object.entries(inventory.sources?.[part] ?? {})) fields(sources[part], kind, names);
    }
  }
  const result: Inventory = { transcript: sorted(merged.transcript), stream: sorted(merged.stream) };
  if (sources.transcript.size === 0 && sources.stream.size === 0) return result;
  return { ...result, sources: { transcript: sorted(sources.transcript), stream: sorted(sources.stream) } };
}

function transcriptKind(entry: TranscriptEntry): string {
  if (entry.type === 'system') return `system/${typeof entry.subtype === 'string' ? entry.subtype : '(no subtype)'}`;
  if (entry.type === 'attachment') {
    const type = entry.attachment?.type;
    return `attachment/${typeof type === 'string' ? type : '(no type)'}`;
  }
  return String(entry.type);
}

function streamKind(value: Record<string, unknown>): string {
  const type = typeof value.type === 'string' ? value.type : '(no type)';
  const sub = (holder: unknown, key: string) => {
    const name = isRecord(holder) ? holder[key] : undefined;
    return `${type}/${typeof name === 'string' ? name : `(no ${key})`}`;
  };
  if (type === 'system' || type === 'result') return sub(value, 'subtype');
  if (type === 'control_request') return sub(value.request, 'subtype');
  if (type === 'control_response') return sub(value.response, 'subtype');
  if (type === 'stream_event') return sub(value.event, 'type');
  return type;
}

function fields(kinds: Kinds, kind: string, ...lists: string[][]): void {
  const set = kinds.get(kind) ?? new Set<string>();
  kinds.set(kind, set);
  for (const list of lists) for (const name of list) set.add(name);
}

function keysOf(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function prefixed(prefix: string, value: unknown): string[] {
  return keysOf(value).map((key) => `${prefix}.${key}`);
}

// オブジェクトならキー、ほかは形の名前
function shapeKeys(value: unknown): string[] {
  if (isRecord(value)) return Object.keys(value);
  if (Array.isArray(value)) return ['(array)'];
  return [value === null ? '(null)' : `(${typeof value})`];
}

function sorted(kinds: Kinds): Record<string, string[]> {
  return Object.fromEntries([...kinds.keys()].sort().map((kind) => [kind, [...kinds.get(kind)!].sort()]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
