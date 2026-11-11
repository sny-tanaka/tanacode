// サイトごとに控える 1Password のアイテムのリンク（fill_credential で、Claude がリンクを書かなくても、そのサイトのアイテムを使えるように）。
// 控えるのはリンクだけ（秘密は控えない）。足すのは人だけ（MCP の設定の画面・入れる前の確認のダイアログのチェック）。
// site: ホスト名（ポートを付けたときは host:port。localhost の開発サーバーを分けるため）。ページのホスト名（とポート）がそのまま合うものを使う
export type CredentialLink = { site: string; link: string };

// 1Password のアイテムのリンク（「プライベートリンクをコピー」）の形。SDK はアカウント・保管庫・アイテムの ID で引くので、この形だけを控える
const ID = '[a-z0-9]{26}';
const LINK = new RegExp(`^https://([a-z0-9-]+\\.)*1password\\.(com|ca|eu)/open/i(?=\\?)(?=.*[?&]a=${ID}(&|$))(?=.*[?&]v=${ID}(&|$))(?=.*[?&]i=${ID}(&|$))\\?.*$`, 'i');

export function isItemLink(text: string): boolean {
  return LINK.test(text.trim());
}

// サイトの書き方をそろえる。example.com・https://example.com/login・localhost:3000 → ホスト名（とポート）だけ。書き方が違えば null
export function normalizeSite(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) && !/^\[[0-9a-f:.]+\]$/.test(host)) return null;
  return url.port ? `${host}:${url.port}` : host;
}

// ページの URL に合う、控えたリンク（無ければ null）。ポートを付けて控えたものを先に見る
export function linkForPage(links: readonly CredentialLink[], pageUrl: string): CredentialLink | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const withPort = url.port ? `${host}:${url.port}` : null;
  return (withPort ? links.find((l) => l.site === withPort) : undefined) ?? links.find((l) => l.site === host) ?? null;
}

// 控えたリンクの一覧をそろえる（形の違うものを除き、同じサイトは後のものを残す）
export function cleanLinks(value: unknown): CredentialLink[] {
  if (!Array.isArray(value)) return [];
  const bySite = new Map<string, CredentialLink>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { site, link } = entry as { site?: unknown; link?: unknown };
    if (typeof site !== 'string' || typeof link !== 'string') continue;
    const normalized = normalizeSite(site);
    if (!normalized || !isItemLink(link)) continue;
    bySite.set(normalized, { site: normalized, link: link.trim() });
  }
  return [...bySite.values()];
}
