import { t } from './i18n';

// コンテキストの中身。本体の会話ログから、今のコンテキストに入っているものを並べる（main の ContextTracker が作る）。
// 圧縮で残すもの・捨てるものの印から、/compact に添える指示の文を組み立てる（compactInstructions）

// file: 読んだ・書いたファイル / tool: 大きなツールの結果 / image: 画像 / agent: サブエージェントの結果 /
// topic: 発言ごとのやりとり（発言・応答・小さなツールの結果） / summary: 前回の圧縮の要約
export type ContextItemKind = 'file' | 'tool' | 'image' | 'agent' | 'topic' | 'summary';

export type ContextItem = {
  // 印を覚える鍵。同じものは、読み直しても同じ鍵になる
  id: string;
  kind: ContextItemKind;
  // 名前（ファイルの相対パス・コマンド・検索の文字・サブエージェントの説明・発言の冒頭など）。ツールの画像では、ツールの対象（無ければ空）
  label: string;
  // ツールの名前（tool・image）。tool で空なら、起動した行が分からないタスクの完了の知らせ
  tool?: string;
  // ファイルを書いた（file）
  edited?: boolean;
  // およそのトークン数（文字数などからの見積もり。正確な数ではない）
  tokens: number;
  // 会話の中の順番（時間順に並べる。ファイルは最後に読んだ・書いた時点）
  order: number;
  // 前回の圧縮より前のもの（もう要約に置き換わっている）
  compacted: boolean;
};

export type SessionContext = { items: ContextItem[] };

export type CompactMark = 'keep' | 'drop';

// ラベルが長いときの上限（指示の文が長くなりすぎないように）
const LABEL_CHARS = 60;

// 印から /compact に添える指示の文を組み立てる。印が無ければ空。
// 例: 「`src/main/session-manager.ts` の内容と、「親子の記録」から始まるやりとりは詳しく残す。`npm install` の出力は捨ててよい。」
// 人が直してから、人の発言として送るので、画面の言語の文言から作る
export function compactInstructions(items: ContextItem[], marks: ReadonlyMap<string, CompactMark>): string {
  const marked = (mark: CompactMark) =>
    items
      .filter((i) => !i.compacted && marks.get(i.id) === mark)
      .sort((a, b) => a.order - b.order)
      .map(phraseOf);
  const keep = marked('keep');
  const drop = marked('drop');
  return [keep.length > 0 ? t('context.compact.keep', { items: list(keep) }) : '', drop.length > 0 ? t('context.compact.drop', { items: list(drop) }) : ''].join('');
}

// 「A と、B」「A、B、C」
function list(phrases: string[]): string {
  return phrases.length === 2 ? t('context.compact.listTwo', { first: phrases[0], second: phrases[1] }) : phrases.join(t('context.compact.separator'));
}

function phraseOf(item: ContextItem): string {
  const label = shorten(item.label);
  switch (item.kind) {
    case 'file':
      return t(item.edited ? 'context.compact.fileEdited' : 'context.compact.file', { label });
    case 'summary':
      return t('context.compact.summary');
    case 'topic':
      return topicPhrase(label);
    case 'agent':
      return t('context.compact.agent', { label });
    case 'image':
      if (!item.tool) return label;
      return label ? t('context.compact.imageWithLabel', { tool: toolDisplayName(item.tool), label }) : t('context.compact.image', { tool: toolDisplayName(item.tool) });
    case 'tool':
      return toolPhrase(item.tool ?? '', label);
  }
}

// やりとりの名前は、発言の冒頭か、区切りになった出来事（ContextTracker が付ける。質問への答え・知らせ・会話の始まり）。
// 区切りの出来事は、ContextTracker が付けた日本語の名前を読んで見分ける（名前を言語ごとにするなら、見分け方も変える）
function topicPhrase(label: string): string {
  const answer = /^質問への答え: (.*)$/.exec(label)?.[1];
  if (answer !== undefined) return t('context.compact.topicAnswer', { answer });
  const notice = /^知らせ: (.*)$/.exec(label)?.[1];
  if (notice !== undefined) return t('context.compact.topicNotice', { notice });
  if (label === '別の Claude からの知らせ' || label === '会話の始まり') return t('context.compact.topicEvent', { label });
  return t('context.compact.topic', { label });
}

function toolPhrase(tool: string, label: string): string {
  // 起動した行が分からないバックグラウンドのタスクの完了の知らせ（名前は知らせの要約）
  if (!tool) return t('context.compact.notice', { label });
  if (tool === 'Bash') return t('context.compact.bash', { label });
  if (tool === 'Grep' || tool === 'WebSearch') return t('context.compact.search', { label });
  if (tool === 'Glob') return t('context.compact.glob', { label });
  if (tool === 'WebFetch') return t('context.compact.webFetch', { label });
  if (tool === 'Skill') return t('context.compact.skill', { label });
  const name = toolDisplayName(tool);
  return label ? t('context.compact.toolWithLabel', { tool: name, label }) : t('context.compact.tool', { tool: name });
}

// MCP のツール（mcp__<サーバー>__<ツール>）は「<サーバー> の <ツール>」
export function toolDisplayName(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return mcp ? t('context.compact.mcpTool', { server: mcp[1], tool: mcp[2] }) : tool;
}

function shorten(text: string): string {
  return clip(text, LABEL_CHARS);
}

// 1 行にして、長ければ末尾を「…」にする
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
