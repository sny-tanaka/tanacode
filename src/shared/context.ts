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
export function compactInstructions(items: ContextItem[], marks: ReadonlyMap<string, CompactMark>): string {
  const marked = (mark: CompactMark) =>
    items
      .filter((i) => !i.compacted && marks.get(i.id) === mark)
      .sort((a, b) => a.order - b.order)
      .map(phraseOf);
  const keep = marked('keep');
  const drop = marked('drop');
  return [keep.length > 0 ? `${list(keep)}は詳しく残す。` : '', drop.length > 0 ? `${list(drop)}は捨ててよい。` : ''].join('');
}

// 「A と、B」「A、B、C」
function list(phrases: string[]): string {
  return phrases.length === 2 ? `${phrases[0]}と、${phrases[1]}` : phrases.join('、');
}

function phraseOf(item: ContextItem): string {
  const label = shorten(item.label);
  switch (item.kind) {
    case 'file':
      return `\`${label}\` の${item.edited ? '内容と変更' : '内容'}`;
    case 'summary':
      return '前回の圧縮の要約';
    case 'topic':
      return topicPhrase(label);
    case 'agent':
      return `サブエージェント「${label}」の結果`;
    case 'image':
      return item.tool ? `${toolDisplayName(item.tool)} の画像${label ? `（${label}）` : ''}` : label;
    case 'tool':
      return toolPhrase(item.tool ?? '', label);
  }
}

// やりとりの名前は、発言の冒頭か、区切りになった出来事（ContextTracker が付ける。質問への答え・知らせ・会話の始まり）
function topicPhrase(label: string): string {
  const answer = /^質問への答え: (.*)$/.exec(label)?.[1];
  if (answer !== undefined) return `質問に「${answer}」と答えたあとのやりとり`;
  const notice = /^知らせ: (.*)$/.exec(label)?.[1];
  if (notice !== undefined) return `「${notice}」の知らせのあとのやりとり`;
  if (label === '別の Claude からの知らせ' || label === '会話の始まり') return `${label}のやりとり`;
  return `「${label}」から始まるやりとり`;
}

function toolPhrase(tool: string, label: string): string {
  // 起動した行が分からないバックグラウンドのタスクの完了の知らせ（名前は知らせの要約）
  if (!tool) return `「${label}」の知らせ`;
  if (tool === 'Bash') return `\`${label}\` の出力`;
  if (tool === 'Grep' || tool === 'WebSearch') return `「${label}」の検索結果`;
  if (tool === 'Glob') return `「${label}」に合うファイルの一覧`;
  if (tool === 'WebFetch') return `${label} のページの内容`;
  if (tool === 'Skill') return `スキル「${label}」の内容`;
  const name = toolDisplayName(tool);
  return label ? `${name}（${label}）の結果` : `${name} の結果`;
}

// MCP のツール（mcp__<サーバー>__<ツール>）は「<サーバー> の <ツール>」
export function toolDisplayName(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return mcp ? `${mcp[1]} の ${mcp[2]}` : tool;
}

function shorten(text: string): string {
  return clip(text, LABEL_CHARS);
}

// 1 行にして、長ければ末尾を「…」にする
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
