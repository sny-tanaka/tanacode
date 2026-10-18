import type { PartialBlock, TranscriptEntry } from '@shared/chat';
import { CHECKLIST_UNCHANGED_MARK } from '@shared/checklist-tools';
import type { StreamEventMessage } from './protocol';

// 書いている途中の応答（stream_event。--include-partial-messages）から、チャットの最後に出す途中の文と思考を組み立てる。
// 応答（message.id）ごと・ブロック（index）ごとに文をため、そのブロックが会話ログに出たら（同じ message.id と apiBlockIndex の
// 応答の行。会話ログは 1 行に 1 ブロック）外す。会話ログの応答と同じ配信で外すので、チャットでは同じ場所で入れ替わる（決めたこと）。
// 応答の始まり（message_start）を見ていない応答（引き継いだときに書いている途中だったもの）は、頭が欠けるので出さない（決めたこと。
// 書き終わって会話ログに出たときに出る）。サブエージェントの行は渡さない（SessionManager が捨てる。Claude Code 2.1.302 は、
// サブエージェントの書いている途中の行を出さない。実測）
// 取り消されて会話ログに出ない応答のブロックは、次のどれかで外す（#233）: 書き終わらないまま次の応答が始まった /
// 取り直すために捨てたと知らされた（abandoned_blocks）/ あとから始まった応答の行が会話ログに出た（abandoned_blocks の付かない取り消し）

type Block = { index: number; kind: PartialBlock['kind']; text: string; done: boolean };
// started: 応答の始まり（message_start）を見た順。会話ログの行だけで知った応答には無い
type Message = { id: string; blocks: Block[]; covered: Set<number>; seen: number; started?: number };

// 覚えておく応答の数（会話ログに出るのを待っている前の応答と、今の応答）
const MAX_MESSAGES = 4;

export class PartialText {
  private messages: Message[] = [];
  // 今書いている応答（message_start を見たもの）
  private current: Message | null = null;
  // 応答の始まりを見た数（started を付ける）
  private starts = 0;
  // 最後に渡した途中の文の印（ブロックの ID と文の長さ。文は足されるだけなので、これで変わったかが分かる）
  private sent = '';

  // 書いている途中の行。出す文が変わったかもしれなければ true
  event(line: StreamEventMessage): boolean {
    const event = line.event;
    switch (event.type) {
      case 'message_start': {
        const id = event.message?.id;
        // 書き終わらないまま次の応答が始まったブロック（再試行で捨てられたもの）は、会話ログに出ないので外す
        for (const message of this.messages) message.blocks = message.blocks.filter((b) => b.done);
        this.current = typeof id === 'string' && id ? this.message(id) : null;
        if (this.current) this.current.started ??= ++this.starts;
        this.settle();
        return true;
      }
      case 'content_block_start': {
        const block = event.content_block;
        const kind = block?.type === 'text' ? 'text' : block?.type === 'thinking' ? 'thinking' : null;
        if (!this.current || !kind || typeof event.index !== 'number') return false;
        const text = kind === 'text' ? block?.text : block?.thinking;
        this.current.blocks.push({ index: event.index, kind, text: typeof text === 'string' ? text : '', done: false });
        return !!text;
      }
      case 'content_block_delta': {
        const block = this.block(event.index);
        const delta = event.delta;
        const text = block?.kind === 'text' && delta?.type === 'text_delta' ? delta.text : block?.kind === 'thinking' && delta?.type === 'thinking_delta' ? delta.thinking : undefined;
        if (!block || typeof text !== 'string' || !text) return false;
        block.text += text;
        return true;
      }
      case 'content_block_stop': {
        const block = this.block(event.index);
        if (block) block.done = true;
        return false;
      }
      case 'message_stop': {
        // 取り直すために捨てたブロック（接続が途中で切れたときなど）は、書き終わっていても会話ログに出ないので外す。
        // Claude Code は捨てる前に、書きかけのブロックを content_block_stop で閉じる（2.1.302 で実測）
        const abandoned = line.abandoned_blocks;
        const from = abandoned?.from_block_index;
        const message = this.messages.find((m) => m.id === abandoned?.api_message_id);
        if (!message || typeof from !== 'number') return false;
        message.blocks = message.blocks.filter((b) => b.index < from);
        return true;
      }
      default:
        return false;
    }
  }

  // 会話ログの行。本体の応答の行なら、そのブロックを途中の文から外す（外したら true）。apiBlockIndex の無い行は、
  // 同じ応答の行の数から位置を決める（会話ログは、ブロックの順に 1 行ずつ書かれる）
  cover(entry: TranscriptEntry): boolean {
    const id = entry.message?.id;
    if (entry.type !== 'assistant' || entry.isSidechain || typeof id !== 'string' || !id) return false;
    // 会話ログの行が、stream の始まりより先に読めたときも外せるよう、知らない応答なら控えを作る
    const message = this.message(id);
    const count = Array.isArray(entry.message?.content) ? entry.message.content.length : 1;
    const first = typeof entry.apiBlockIndex === 'number' ? entry.apiBlockIndex : message.seen;
    message.seen = Math.max(message.seen, first + count);
    const visible = this.key();
    for (let i = first; i < first + count; i++) message.covered.add(i);
    message.blocks = message.blocks.filter((b) => !message.covered.has(b.index));
    this.settle();
    return this.key() !== visible;
  }

  // 今出す途中の文（会話ログにまだ出ていないブロックの、空でないもの）
  view(): PartialBlock[] {
    return this.messages.flatMap((message) =>
      message.blocks
        .filter((b) => visible(b))
        .sort((a, b) => a.index - b.index)
        .map((b) => ({ id: `${message.id}:${b.index}`, kind: b.kind, text: b.text.trim() })),
    );
  }

  // 前に渡したときから変わっていれば、今出す途中の文。変わっていなければ null
  take(): PartialBlock[] | null {
    const key = this.key();
    if (key === this.sent) return null;
    this.sent = key;
    return this.view();
  }

  // 途中の文をすべて捨てる（ターンの終わり・起動し直し・/clear）。今の応答も忘れる（このあとの行は、次の message_start まで出さない）
  clear(): void {
    this.messages = [];
    this.current = null;
  }

  private message(id: string): Message {
    let message = this.messages.find((m) => m.id === id);
    if (!message) {
      message = { id, blocks: [], covered: new Set(), seen: 0 };
      this.messages.push(message);
      // 古いものから忘れる（今の応答は残す）
      if (this.messages.length > MAX_MESSAGES) this.messages.splice(this.messages.findIndex((m) => m !== this.current), 1);
    }
    return message;
  }

  // 会話ログは応答の順に書かれる。あとから始まった応答の行が会話ログに出たら、それより前に始まった応答の残りのブロックは、
  // もう会話ログに出ない（abandoned_blocks を付けずに取り消された応答。ツールの呼び出しの形が壊れた応答の取り直しなど。
  // 2.1.302 で実測）ので外す
  private settle(): void {
    const latest = Math.max(0, ...this.messages.map((m) => (m.started && m.covered.size > 0 ? m.started : 0)));
    for (const message of this.messages) if (message.started && message.started < latest) message.blocks = [];
  }

  // 今の応答の、まだ会話ログに出ていないブロック
  private block(index: unknown): Block | undefined {
    return typeof index === 'number' && !this.current?.covered.has(index) ? this.current?.blocks.find((b) => b.index === index) : undefined;
  }

  private key(): string {
    return this.messages.map((m) => m.blocks.filter((b) => visible(b)).map((b) => `${m.id}:${b.index}:${b.text.length}`).join(' ')).join(' ');
  }
}

// 出すブロックか。空白だけのものと、チェックリストの「直すものは無い」の目印（書き終わっても出さない。shared/chat.ts）の書きかけは出さない
function visible(block: Block): boolean {
  const text = block.text.trim();
  return !!text && !(block.kind === 'text' && CHECKLIST_UNCHANGED_MARK.startsWith(text));
}
