// Claude Code に /login したアカウント（~/.claude.json の oauthAccount から読む）

export type ClaudeAccount = {
  email: string;
  // 組織の名前。個人のプランでは「<メールアドレス>'s Organization」のような名前になる
  organization: string | null;
  // プランの表示名（例: Claude Max・Claude Team）
  plan: string | null;
};

// 欄にいつも出してよい組織の名前。メールアドレスを含む名前（個人のプランの組織）は、メールアドレスと同じく出さない
export function visibleOrganization(account: ClaudeAccount): string | null {
  const name = account.organization;
  return name && !name.includes('@') ? name : null;
}
