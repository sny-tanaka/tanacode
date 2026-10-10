import { readFile } from 'node:fs/promises';
import type { ClaudeAccount } from '@shared/account';
import { claudeJsonPath } from './claude-config';

// /login したアカウント（.claude.json の oauthAccount）。プランは、planDisplayName があればそれ、無ければ組織の種類から作る（planOf）。
//Claude Code の内部の形式なので、無い項目は null にし、メールアドレスが無ければ null（ログインしていない）を返す。
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
    return email ? { email, organization: text('organizationName'), plan: namedPlan(text('planDisplayName')) ?? planOf(text('organizationType'), text('organizationRateLimitTier')) } : null;
  } catch {
    return null;
  }
}

// プランの表示名を、組織の種類（organizationType。claude_max・claude_team・claude_pro など）から作る（claude_team → Claude Team）。
// Claude Code（2.1.296）は、planDisplayName を一部のアカウントにしか書かない（機能の切り替えが入ったときだけ。手元の Max と Team の
// .claude.json には無い）ので、こちらが主になる。Claude Code 自身も、無いときはプランの種類から「Claude Max」のように作る。
// Max は、利用枠の段（organizationRateLimitTier。default_claude_max_20x など）から倍率も付ける（Claude Max 20x）。
// claude_ で始まらない種類は、プランとして読めないので出さない
function planOf(type: string | null, tier: string | null): string | null {
  if (!type?.startsWith('claude_')) return null;
  const words = type.split('_').filter(Boolean);
  if (words.length < 2) return null;
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
  const times = type === 'claude_max' ? /_max_(\d+x)$/.exec(tier ?? '')?.[1] : null;
  return times ? `${name} ${times}` : name;
}

// planDisplayName から作るプランの表示名。Claude Code は「Claude <planDisplayName>」と出す（2.1.296 の本体で確かめた。値の実物は見ていない）
function namedPlan(name: string | null): string | null {
  if (!name) return null;
  return /^claude\b/i.test(name) ? name : `Claude ${name}`;
}
