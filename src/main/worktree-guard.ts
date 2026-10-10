import { GUARD_HOOK_ENV } from '@shared/chat';
import { t } from '@shared/i18n';

// Claude が worktree やブランチを消す操作の歯止め。アプリが起動する Claude Code に、--settings で Bash の PreToolUse のフックとして足す。
// 次の 3 つだけは、権限モード（auto・bypassPermissions を含む）にかかわらず、Claude Code の許可の確認を出させる（permissionDecision: ask）。
// - git worktree remove の --force（-f）
// - git branch -D（--delete --force も）
// - worktree の rm -rf（.claude/worktrees を指すもの。worktree の中では . や .. や * も）
// 止めはしない。ユーザーが確認して許せば、そのまま動く。
// Claude Code の hooks には JSON が標準入力で届く。Node が入っているとは限らないので、macOS に必ずある awk で読む。
// コマンドは ; && || | などで区切り、区切りごとに見る（$(...) やクォートの中も、区切りとしてざっと見る）。
// reason は確認の理由（Claude Code の許可の確認に出る）。awk の文字列と JSON とシェルの単一引用符に埋め込むので、' " \ を含めない
const program = (reason: string) => String.raw`
function unq(v) { sub(/^"[a-z_]*"[[:space:]]*:[[:space:]]*"/, "", v); sub(/"$/, "", v); return v }
function flag(a, c) { return a ~ "^-[a-zA-Z]*" c "[a-zA-Z]*$" }
function risky(p, d,   t, m, k, j, a, git, rm, r, f, del, force) {
  m = split(p, t, /[[:space:]]+/)
  for (k = 1; k <= m; k++) {
    a = t[k]
    if (a == "git" || a ~ /\/git$/) git = 1
    if (git && a == "worktree" && t[k + 1] == "remove")
      for (j = k + 2; j <= m; j++) if (t[j] == "--force" || flag(t[j], "f")) return 1
    if (git && a == "branch") {
      for (j = k + 1; j <= m; j++) {
        if (flag(t[j], "D")) return 1
        if (t[j] == "--delete" || flag(t[j], "d")) del = 1
        if (t[j] == "--force" || flag(t[j], "f")) force = 1
      }
      if (del && force) return 1
    }
    if (a == "rm" || a ~ /\/rm$/) rm = k
  }
  if (!rm) return 0
  for (j = rm + 1; j <= m; j++) {
    a = t[j]
    if (a == "--recursive" || flag(a, "[rR]")) r = 1
    if (a == "--force" || flag(a, "f")) f = 1
  }
  if (!r || !f) return 0
  for (j = rm + 1; j <= m; j++) {
    a = t[j]
    if (a == "" || a ~ /^-/) continue
    if (a ~ /worktrees/) return 1
    if (d ~ /\/\.claude\/worktrees\// && (a ~ /^\.\.?\/?$/ || a ~ /^\.\.\// || a ~ /^(\.\/)?\*$/ || a == d)) return 1
  }
  return 0
}
{ s = s $0 " " }
END {
  if (!match(s, /"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) exit 0
  c = unq(substr(s, RSTART, RLENGTH))
  d = ""
  if (match(s, /"cwd"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) d = unq(substr(s, RSTART, RLENGTH))
  gsub(/\\[nr]/, ";", c)
  gsub(/\\t/, " ", c)
  gsub(/\\"|\047|\\\\/, "", c)
  n = split(c, parts, /&&|\|\||[;|&()` + '`' + String.raw`]|\$\(/)
  for (i = 1; i <= n; i++) if (risky(parts[i], d)) {
    print "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"${reason}\"}}"
    exit 0
  }
}
`;

// フックのコマンド。理由は、Claude Code を起動するときの言語で書く。目印の環境変数（GUARD_HOOK_ENV）は、チャットのフックの一覧に出さないためのもの
export function worktreeGuardCommand(): string {
  return `${GUARD_HOOK_ENV}=1 awk '${program(t('main.hooks.worktreeGuard')).trim()}'`;
}
