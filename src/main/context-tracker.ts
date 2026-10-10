import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { toolTarget, type TranscriptEntry } from '@shared/chat';
import { clip, type ContextItem, type ContextItemKind, type SessionContext } from '@shared/context';
import { t } from '@shared/i18n';
import { branchCut, readEntries, type ChainEntry } from './chat-log';
import { EDIT_TOOLS, READ_TOOLS } from './knowledge-tracker';

// これより小さいツールの結果は、1 つの行にせず、発言ごとのやりとりにまとめる
const ITEM_TOKENS = 1000;
// ツールの結果 1 つに付く、中身のほかの分（実測で 30〜50）
const RESULT_OVERHEAD = 40;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
// モデルに渡らない attachment（控え・記録・ファイル名だけの知らせなど）
const HIDDEN_ATTACHMENTS = new Set([
  'prompt_snapshot',
  'deferred_tools_record',
  'edited_image_file',
  'credential_org',
  'compact_file_reference',
  'thinking_drop',
  'thinking_stripped',
]);
// 発言の冒頭として出す長さ
const LABEL_CHARS = 80;
// 応答の間に増えた量で、文字数からの見積もりを直す範囲（外れたら、ツールの定義の読み込みなど会話ログに無いものが混ざったとみなして直さない）
const CALIBRATE_MIN = 0.25;
const CALIBRATE_MAX = 4;

// 会話ログの 1 行から取り出した、コンテキストに入るものの断片。同じ key の断片を足して 1 行にする
type Piece = {
  // 出どころの行（圧縮のときにそのまま残された行かを見る）
  uuid: string;
  key: string;
  kind: ContextItemKind;
  label: string;
  tool?: string;
  edited?: boolean;
  tokens: number;
  // 入力として増えたもの（ツールの結果・発言・添付）。Claude の応答（出力）でないもの
  input: boolean;
  // 一覧に出さないもの（Claude Code が足す一覧や環境の知らせ）。/compact の指示では消せないので、「そのほか」に入る。
  // 見積もりの直し（calibrate）には入れる
  hidden?: boolean;
};
// 圧縮の境目。preserved: 境目より前で、要約せずにそのまま残された行
type Boundary = { uuid: string; boundary: true; preserved: ReadonlySet<string> };

type ToolUse = { name: string; label: string; filePath: string | null };
// 応答の usage（at: 出力トークン数を足した断片の位置。remaining: 出力のうち、書いたファイルの行にまだ移していない分）
type Usage = { at: number; input: number; output: number; remaining: number };
type Topic = { key: string; label: string };
type ResponseUsage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };

// 最初の発言より前に入るもの（SessionStart の hooks が足した文など）。名前は作るときの言語で選ぶので、関数にする
const conversationStart = (): Topic => ({ key: 'topic:start', label: t('main.context.start') });

// 本体の会話ログから、今のコンテキストに入っているもの（読んだファイル・大きなツールの結果・画像・サブエージェントの結果・
// 発言ごとのやりとり）を集める。サブエージェントの会話は本体のコンテキストに入らないので数えない。
// 大きさは見積もり。文章は文字数から、Claude の応答は usage の出力トークン数から（思考は会話ログに中身が残らないため）。
// 巻き戻した（/rewind）発言から後ろは、チャットと同じく branchCut で捨てる
export class ContextTracker {
  private pieces: (Piece | Boundary)[] = [];
  private chain: ChainEntry[] = [];
  private uuids = new Set<string>();
  private tools = new Map<string, ToolUse>();
  // サブエージェントの ID → 起動した Agent の tool_use の ID（報告を、起動したときの行にまとめる）
  private agents = new Map<string, string>();
  // 1 行にしたツールの結果（同じツールの続きは、小さくても同じ行に足す）
  private listed = new Set<string>();
  // 数えた応答（message.id）。同じ応答は中身のブロックごとに別の行に書かれるので、1 回だけ数える
  private responses = new Map<string, Usage>();
  // いちばん新しい応答と、見積もりを直し終えた断片の位置（巻き戻しで、同じ断片を 2 回直さないため）
  private last: Usage | null = null;
  private calibrated = 0;
  // 今読んでいる行が、Claude の応答（出力）か
  private output = false;
  // 今のやりとり。小さな断片はここに足す
  private topic: Topic = conversationStart();

  constructor(private readonly cwd: string) {}

  // 起動し直すと過去の会話を読み直す。/clear では会話が変わる
  reset(): void {
    this.pieces = [];
    this.chain = [];
    this.uuids = new Set();
    this.tools = new Map();
    this.agents = new Map();
    this.listed = new Set();
    this.responses = new Map();
    this.last = null;
    this.calibrated = 0;
    this.topic = conversationStart();
  }

  handle(entry: TranscriptEntry): void {
    if (entry.isSidechain) return;
    const uuid = entry.uuid ?? '';
    if (uuid) {
      // 同じ行が 2 回書かれることがある（デスクトップ版の会話ログは圧縮のたびに最初から書き直す・圧縮でそのまま残した行の書き直し。
      // 書き直した応答の usage は 0）。前のものを使う。巻き戻したあとの発言は新しい uuid なので、巻き戻しの検出は変わらない
      if (this.uuids.has(uuid)) return;
      const cut = branchCut(this.chain, entry);
      if (cut) this.cut(cut.eventCut, cut.chainCut);
      this.chain.push({ uuid, type: entry.type, eventStart: this.pieces.length });
      this.uuids.add(uuid);
    }
    this.read(entry, uuid);
  }

  current(): SessionContext {
    let last = -1;
    this.pieces.forEach((p, i) => {
      if ('boundary' in p) last = i;
    });
    const preserved = last === -1 ? new Set<string>() : (this.pieces[last] as Boundary).preserved;
    const items = new Map<string, ContextItem>();
    this.pieces.forEach((p, order) => {
      if ('boundary' in p || p.hidden) return;
      const compacted = order < last && !preserved.has(p.uuid);
      const id = compacted ? `compacted:${p.key}` : p.key;
      const item = items.get(id);
      if (item) {
        item.tokens += p.tokens;
        item.edited ||= p.edited;
        // ファイルは最後に読んだ・書いた時点、ほかは始まりの時点で並べる
        if (p.kind === 'file') item.order = order;
        return;
      }
      items.set(id, { id, kind: p.kind, label: p.label, tool: p.tool, edited: p.edited, tokens: p.tokens, order, compacted });
    });
    return { items: [...items.values()].map((i) => ({ ...i, tokens: Math.max(0, Math.round(i.tokens)) })) };
  }

  private cut(eventCut: number, chainCut: number): void {
    this.pieces = this.pieces.slice(0, eventCut);
    this.chain = this.chain.slice(0, chainCut);
    this.uuids = new Set(this.chain.map((c) => c.uuid));
    for (const [id, usage] of this.responses) if (usage.at >= eventCut) this.responses.delete(id);
    this.last = null;
    for (const usage of this.responses.values()) if (!this.last || usage.at > this.last.at) this.last = usage;
    this.calibrated = Math.min(this.calibrated, eventCut);
    // 今のやりとりも、残った中の最後のものに戻す
    const topic = [...this.pieces].reverse().find((p): p is Piece => !('boundary' in p) && (p.kind === 'topic' || p.kind === 'summary'));
    this.topic = topic ? { key: topic.key, label: topic.label } : conversationStart();
  }

  private add(uuid: string, piece: Omit<Piece, 'uuid' | 'input'>): void {
    this.pieces.push({ ...piece, uuid, input: !this.output });
  }

  // 今のやりとりに足す
  private addToTopic(uuid: string, tokens: number): void {
    if (tokens !== 0) this.add(uuid, { key: this.topic.key, kind: 'topic', label: this.topic.label, tokens });
  }

  private startTopic(uuid: string, label: string, tokens: number): void {
    this.topic = { key: `topic:${uuid}`, label };
    this.add(uuid, { key: this.topic.key, kind: 'topic', label, tokens });
  }

  private read(entry: TranscriptEntry, uuid: string): void {
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const meta = (entry as { compactMetadata?: { preservedMessages?: { allUuids?: unknown } } }).compactMetadata;
      const all = meta?.preservedMessages?.allUuids;
      this.pieces.push({ uuid, boundary: true, preserved: new Set(Array.isArray(all) ? all.filter((u) => typeof u === 'string') : []) });
      return;
    }
    this.output = entry.type === 'assistant';
    if (entry.type === 'attachment') this.readAttachment(entry, uuid);
    else if (entry.type === 'assistant') this.readAssistant(entry, uuid);
    else if (entry.type === 'user') this.readUser(entry, uuid);
  }

  // 応答の入力トークン数は、前の応答の入力と出力に、その間に増えた中身を足したもの。
  // その差で、間に増えた中身（ツールの結果・発言・添付）の文字数からの見積もりを直す（多くは結果が 1 つなので、ほぼその大きさになる）。
  // 巻き戻したあとは、切られた応答で直し終えた断片を、差から引いて残りだけを直す
  private calibrate(usage: Usage): void {
    const previous = this.last;
    const from = this.calibrated;
    this.calibrated = this.pieces.length;
    // 圧縮の境目をまたぐときは、要約に置き換わって減るので比べられない
    if (!previous || this.pieces.slice(previous.at).some((p) => 'boundary' in p)) return;
    let fixed = 0;
    const fresh: Piece[] = [];
    this.pieces.forEach((p, i) => {
      if (i <= previous.at || 'boundary' in p || !p.input) return;
      if (i < from) fixed += p.tokens;
      else fresh.push(p);
    });
    const estimated = fresh.reduce((sum, p) => sum + p.tokens, 0);
    const ratio = (usage.input - previous.input - previous.output - fixed) / estimated;
    if (!(estimated > 0) || ratio < CALIBRATE_MIN || ratio > CALIBRATE_MAX) return;
    for (const p of fresh) p.tokens *= ratio;
  }

  private readAssistant(entry: TranscriptEntry, uuid: string): void {
    // 再開時に Claude Code が差し込む埋め合わせや、API エラーの知らせはモデルに送られない
    const message = entry.message as (TranscriptEntry['message'] & { id?: string; usage?: ResponseUsage }) | undefined;
    if (!message || message.model === '<synthetic>' || entry.isApiErrorMessage) return;
    // 思考は会話ログに中身が残らないので、応答の大きさは出力トークン数を使う。無ければ文字数から
    const u = message.usage;
    const output = u?.output_tokens;
    const id = message.id;
    const counted = typeof output === 'number' && output > 0 && !!id;
    if (counted && !this.responses.has(id)) {
      const input = (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
      const usage = { at: this.pieces.length, input, output, remaining: output };
      if (input > 0) {
        this.calibrate(usage);
        this.last = usage;
      }
      this.responses.set(id, usage);
      this.addToTopic(uuid, output);
    }
    const usage = counted ? this.responses.get(id) : undefined;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!counted && block.type === 'text') this.addToTopic(uuid, estimateTokens(block.text ?? ''));
      if (block.type !== 'tool_use' || !block.id || !block.name) continue;
      const input = block.input ?? {};
      const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
      this.tools.set(block.id, { name: block.name, label: toolTarget(input, this.cwd), filePath: path });
      const tokens = estimateTokens(JSON.stringify(input));
      // 書いた中身は、応答からそのファイルの行に移す（応答の出力より多くは移さない）
      if (EDIT_TOOLS.has(block.name) && path) {
        const moved = usage ? Math.min(tokens, usage.remaining) : tokens;
        if (usage) usage.remaining -= moved;
        this.addFile(uuid, path, true, moved);
        if (usage) this.addToTopic(uuid, -moved);
      } else if (!counted) {
        this.addToTopic(uuid, tokens);
      }
    }
  }

  private readUser(entry: TranscriptEntry, uuid: string): void {
    const content = entry.message?.content;
    if (entry.isCompactSummary) {
      this.topic = { key: `summary:${uuid}`, label: t('main.context.compactSummary') };
      this.add(uuid, { key: this.topic.key, kind: 'summary', label: this.topic.label, tokens: estimateTokens(textOf(content)) });
      return;
    }
    const blocks = Array.isArray(content) ? content : [];
    if (blocks.some((b) => b.type === 'tool_result')) {
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id) this.readToolResult(entry, block.tool_use_id, block.content, uuid);
        else if (block.type === 'text') this.addToTopic(uuid, estimateTokens(block.text ?? ''));
      }
      return;
    }
    const text = textOf(content);
    // スキルの本文（Skill のツールのすぐあとの isMeta の行）は、そのツールの行に入れる
    const source = (entry as { sourceToolUseID?: unknown }).sourceToolUseID;
    const tool = typeof source === 'string' ? this.tools.get(source) : undefined;
    if (entry.isMeta && tool) this.addResult(uuid, source as string, tool, estimateTokens(text));
    else this.readMessage(entry, text, uuid, { kind: entry.origin?.kind ?? 'human', meta: !!entry.isMeta, queued: false });
    // 発言に添付した画像。指示の文でどれか分かるよう、発言の冒頭と何枚目かを名前に入れる
    const images = blocks.filter((b) => b.type === 'image');
    images.forEach((b, i) => {
      const topic = clip(this.topic.label, 24);
      const label = images.length > 1 ? t('main.context.imageNth', { topic, index: i + 1 }) : t('main.context.image', { topic });
      this.add(uuid, { key: `image:${uuid}:${i}`, kind: 'image', label, tokens: imageTokens(b) });
    });
  }

  // 発言の行・作業の途中に届いた発言。origin.kind: 出どころ（human・task-notification・peer など）、
  // meta: isMeta の行（スキルの本文など）、queued: 作業の途中に届いたもの（知らせでは、新しいやりとりにしない。人の発言では区切る）
  private readMessage(entry: TranscriptEntry, text: string, uuid: string, origin: { kind: string; meta: boolean; queued: boolean }): void {
    const tokens = estimateTokens(text);
    if (origin.kind === 'task-notification' || text.trimStart().startsWith('<task-notification>')) {
      return this.readNotification(text, tokens, uuid, !origin.queued);
    }
    // 別の Claude（サブエージェント・ほかのセッション）からの知らせ。サブエージェントの報告は、起動したときの行にまとめる
    const from = /<agent-message from="([^"]+)"/.exec(text)?.[1];
    if (origin.kind === 'peer' || from) {
      const toolUseId = from ? this.agents.get(from) : undefined;
      const tool = toolUseId ? this.tools.get(toolUseId) : undefined;
      // 待機中に届いたものは、Claude Code がそれを受けて作業を始めるので、新しいやりとりにする
      if (!origin.queued) this.startTopic(uuid, tool ? t('main.context.subagentReport', { name: clip(tool.label, LABEL_CHARS) }) : t('main.context.peerNotice'), 0);
      if (toolUseId && tool) return this.addResult(uuid, toolUseId, tool, tokens);
      return this.addToTopic(uuid, tokens);
    }
    const prompt = !origin.meta && !entry.interruptedMessageId ? promptLabel(text.trimStart()) : null;
    if (prompt) return this.startTopic(uuid, prompt, tokens);
    // 圧縮のコマンドの記録・コマンドの出力・メタの行・中断の知らせなどは、今のやりとりに足す
    this.addToTopic(uuid, tokens);
  }

  // バックグラウンドのタスクの完了の知らせ。サブエージェントの結果は、起動したときの行にまとめる。
  // 待機中に届いたものは、Claude Code がそれを受けて作業を始めるので、新しいやりとりにする
  private readNotification(text: string, tokens: number, uuid: string, starts: boolean): void {
    const summary = /<summary>(.*?)<\/summary>/s.exec(text)?.[1]?.trim() ?? '';
    const toolUseId = /<tool-use-id>(.*?)<\/tool-use-id>/s.exec(text)?.[1]?.trim();
    const tool = toolUseId ? this.tools.get(toolUseId) : undefined;
    if (starts) this.startTopic(uuid, t('main.context.notice', { summary: clip(summary || t('main.context.taskFinished'), LABEL_CHARS) }), 0);
    if (toolUseId && tool) this.addResult(uuid, toolUseId, tool, tokens);
    else if (tokens >= ITEM_TOKENS) this.add(uuid, { key: `tool:${uuid}`, kind: 'tool', tool: '', label: summary, tokens });
    else this.addToTopic(uuid, tokens);
  }

  private readToolResult(entry: TranscriptEntry, toolUseId: string, content: unknown, uuid: string): void {
    const tool = this.tools.get(toolUseId);
    const blocks = Array.isArray(content) ? (content as { type?: string }[]) : [];
    const tokens = estimateTokens(textOf(content)) + RESULT_OVERHEAD;
    const images = blocks.filter((b) => b.type === 'image');
    // 画像のファイルを読んだときは、画像もそのファイルの行に入れる
    if (tool && (READ_TOOLS.has(tool.name) || EDIT_TOOLS.has(tool.name)) && tool.filePath) {
      const imageTotal = images.reduce((sum, b) => sum + imageTokens(b), 0);
      return this.addFile(uuid, tool.filePath, EDIT_TOOLS.has(tool.name), tokens + imageTotal);
    }
    images.forEach((b, i) => {
      this.add(uuid, { key: `image:${toolUseId}:${i}`, kind: 'image', tool: tool?.name ?? '', label: tool?.label ?? '', tokens: imageTokens(b) });
    });
    if (!tool) return this.addToTopic(uuid, tokens);
    const agentId = (entry.toolUseResult as { agentId?: unknown } | undefined)?.agentId;
    if (AGENT_TOOLS.has(tool.name) && typeof agentId === 'string') this.agents.set(agentId, toolUseId);
    // 質問への答えは、人が決めたことなので、新しいやりとりにする
    if (tool.name === 'AskUserQuestion') return this.startTopic(uuid, answerLabel(entry.toolUseResult), tokens);
    this.addResult(uuid, toolUseId, tool, tokens);
  }

  // ツールの結果。サブエージェントはいつも 1 行に、ほかは大きいものだけ 1 行にする
  private addResult(uuid: string, toolUseId: string, tool: ToolUse, tokens: number): void {
    if (AGENT_TOOLS.has(tool.name)) return this.add(uuid, { key: `agent:${toolUseId}`, kind: 'agent', label: tool.label, tokens });
    const key = `tool:${toolUseId}`;
    if (!this.listed.has(key) && tokens < ITEM_TOKENS) return this.addToTopic(uuid, tokens);
    this.listed.add(key);
    this.add(uuid, { key, kind: 'tool', tool: tool.name, label: tool.label, tokens });
  }

  private readAttachment(entry: TranscriptEntry, uuid: string): void {
    const a = (entry as { attachment?: Record<string, unknown> }).attachment;
    if (!a || HIDDEN_ATTACHMENTS.has(String(a.type))) return;
    // CLAUDE.md・AGENTS.md・記憶（会話の始まりと圧縮のあと）
    if (a.type === 'instructions' && Array.isArray(a.files)) {
      for (const f of a.files as { path?: unknown; content?: unknown }[]) {
        if (typeof f?.path === 'string') this.addFile(uuid, f.path, false, estimateTokens(typeof f.content === 'string' ? f.content : ''));
      }
      return;
    }
    // 発言で @ を付けたファイル・圧縮のあとに添付し直されたファイル・変更に気づいたファイル・サブフォルダの CLAUDE.md（前の Claude Code）
    const path = a.type === 'file' || a.type === 'edited_text_file' ? a.filename : a.type === 'nested_memory' ? a.path : null;
    if (typeof path === 'string') return this.addFile(uuid, path, false, estimateTokens(attachmentText(a)));
    // 作業の途中に届いた発言・完了の知らせ（順番待ちから差し込まれたもの）
    if (a.type === 'queued_command' && typeof a.prompt === 'string') {
      const kind = (a.origin as { kind?: unknown } | undefined)?.kind;
      return this.readMessage(entry, a.prompt, uuid, {
        kind: typeof kind === 'string' ? kind : a.commandMode === 'prompt' ? 'human' : 'task-notification',
        meta: false,
        queued: true,
      });
    }
    const tokens = estimateTokens(attachmentText(a));
    // hooks が足した文は、そのやりとりに入れる
    if (String(a.type).startsWith('hook_')) return this.addToTopic(uuid, tokens);
    // ほかは、Claude Code が足す一覧や環境の知らせ（skill_listing・*_delta・environment・total_tokens_reminder など）。
    // 圧縮のあとにも送り直されて、指示では消せないので、一覧に出さず「そのほか」に入れる
    if (tokens > 0) this.add(uuid, { key: 'claude-code', kind: 'topic', label: '', tokens, hidden: true });
  }

  private addFile(uuid: string, path: string, edited: boolean, tokens: number): void {
    const label = this.display(path);
    this.add(uuid, { key: `file:${label}`, kind: 'file', label, edited, tokens });
  }

  // フォルダの中ならフォルダからの相対パス、ホームの中なら ~ から
  private display(path: string): string {
    if (!isAbsolute(path)) return path;
    const rel = relative(this.cwd, path);
    if (rel && !rel.startsWith(`..${sep}`) && rel !== '..') return rel;
    const home = homedir();
    return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
  }
}

// 会話ログ全体から集める（動いていないセッション・アーカイブ済みのセッション）
export async function readContext(file: string, cwd: string): Promise<SessionContext> {
  const tracker = new ContextTracker(cwd);
  for (const entry of await readEntries(file)) tracker.handle(entry);
  return tracker.current();
}

// 発言の冒頭（やりとりの名前）。発言でないもの（コマンドの出力・中断の知らせ・! のコマンドの出力など）は null
function promptLabel(text: string): string | null {
  if (!text || /^<(local-command-|bash-stdout>|bash-stderr>)/.test(text) || text.startsWith('[Request interrupted by user')) return null;
  // 圧縮を送った時点の発言（/compact と指示）。要約に置き換わるので、やりとりにしない
  if (/^\/compact(\s|$)/.test(text)) return null;
  const command = /<command-name>(.*?)<\/command-name>/s.exec(text)?.[1]?.trim();
  if (command) {
    // 圧縮のコマンドの記録は、要約に付ける
    if (command === '/compact') return null;
    const args = /<command-args>(.*?)<\/command-args>/s.exec(text)?.[1]?.trim();
    return clip(args ? `${command} ${args}` : command, LABEL_CHARS);
  }
  const shell = /^<bash-input>(.*?)<\/bash-input>/s.exec(text)?.[1]?.trim();
  if (shell !== undefined) return clip(`!${shell}`, LABEL_CHARS);
  const body = text.replace(/<\/?pasted_content[^>]*>/g, '').trim();
  return body ? clip(body, LABEL_CHARS) : null;
}

// 質問（AskUserQuestion）への答え
function answerLabel(result: unknown): string {
  const answers = (result as { answers?: Record<string, unknown> } | null)?.answers;
  const values = answers && typeof answers === 'object' ? Object.values(answers).filter((v): v is string => typeof v === 'string') : [];
  return t('main.context.answer', { answer: clip(values.join(' / ') || t('main.context.noAnswer'), LABEL_CHARS) });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b: { type?: string; text?: string }) => (b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

// attachment のうち、モデルに渡る文章（ファイルの中身・発言・指示など）。キーの名前で拾う（hooks のコマンドなどは拾わない）
const TEXT_KEYS = new Set(['content', 'prompt', 'snippet', 'addedLines', 'addedBlocks', 'text']);
function attachmentText(value: unknown, wanted = false): string {
  if (typeof value === 'string') return wanted ? value : '';
  if (Array.isArray(value)) return value.map((v) => attachmentText(v, wanted)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => attachmentText(v, TEXT_KEYS.has(k)))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// 文字数からのトークン数の見積もり（実測）。日本語はおよそ 1 文字で 1.07 トークン、
// ほかの文字（英数字・記号・空白。コードやコマンドの出力が多い）はおよそ 2.2 文字で 1 トークン
export function estimateTokens(text: string): number {
  let japanese = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // CJK の記号・ひらがな・カタカナ・漢字・全角
    if ((c >= 0x3000 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) japanese++;
  }
  return (text.length - japanese) / 2.2 + japanese * 1.07;
}

// 画像のトークン数。幅 × 高さ ÷ 750（実測との差は 5% ほど）。大きさが読めない画像は 1600 とみなす
const UNKNOWN_IMAGE_TOKENS = 1600;
export function imageTokens(block: unknown): number {
  const source = (block as { source?: { type?: string; data?: unknown } })?.source;
  if (source?.type !== 'base64' || typeof source.data !== 'string') return UNKNOWN_IMAGE_TOKENS;
  const size = imageSize(Buffer.from(source.data.slice(0, 65_536), 'base64'));
  return size ? Math.ceil((size.width * size.height) / 750) : UNKNOWN_IMAGE_TOKENS;
}

// PNG・JPEG・GIF の幅と高さ（ファイルの頭から読む）
function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length && b[i] === 0xff) {
      const marker = b[i + 1];
      // SOF0〜SOF15（DHT・JPG・DAC を除く）に大きさがある
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
