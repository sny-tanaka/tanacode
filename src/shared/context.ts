// コンテキストの中身。本体の会話ログから、今のコンテキストに入っているものを並べる（main の ContextTracker が作る）

// file: 読んだ・書いたファイル / tool: 大きなツールの結果 / image: 画像 / agent: サブエージェントの結果 /
// topic: 発言ごとのやりとり（発言・応答・小さなツールの結果） / summary: 前回の圧縮の要約
export type ContextItemKind = 'file' | 'tool' | 'image' | 'agent' | 'topic' | 'summary';

export type ContextItem = {
  // 行の鍵。同じものは、読み直しても同じ鍵になる
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

// 1 行にして、長ければ末尾を「…」にする
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
