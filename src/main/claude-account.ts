import { readFile } from 'node:fs/promises';
import type { ClaudeAccount } from '@shared/account';
import { claudeJsonPath } from './claude-config';

// /login したアカウント（.claude.json の oauthAccount）。Claude Code の内部の形式なので、無い項目は null にし、メールアドレスが無ければ null（ログインしていない）を返す。
// 読むだけで、認証情報（Keychain）には触れない
export async function readClaudeAccount(file = claudeJsonPath()): Promise<ClaudeAccount | null> {
  try {
    const json = JSON.parse(await readFile(file, 'utf8')) as { oauthAccount?: unknown };
    const account = json.oauthAccount;
    if (!account || typeof account !== 'object') return null;
    const text = (key: string) => {
      const value = (account as Record<string, unknown>)[key];
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };
    const email = text('emailAddress');
    return email ? { email, organization: text('organizationName'), plan: text('planDisplayName') } : null;
  } catch {
    return null;
  }
}
