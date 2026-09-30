// Claude（本体）が今の会話で知っている範囲

// read: 読んだ・渡された / edited: 書いた（内容を知っている）/ stale: 圧縮より前に読んだだけ（今は中身を覚えていない）
export type FileKnowledge = 'read' | 'edited' | 'stale';

export type SessionKnowledge = {
  // フォルダからの相対パス
  files: Record<string, FileKnowledge>;
  // 直近の応答で使ったコンテキストのトークン数（入力 + キャッシュ）。応答がまだ無ければ null
  contextTokens: number | null;
};
