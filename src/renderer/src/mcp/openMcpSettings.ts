// 画面のどこからでも、MCP の設定のダイアログを開くよう頼む（App が受けて開く。メニューから開くのと同じダイアログ）。
// 使うところ: アプリ内ブラウザの帯の 1Password の案内（「サイトごとのリンクを控える…」）

const listeners = new Set<() => void>();

export function openMcpSettings(): void {
  for (const listener of listeners) listener();
}

// 頼まれたら呼ぶ。外す関数を返す
export function onOpenMcpSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
