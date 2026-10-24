import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GUARD_HOOK_ENV } from '@shared/chat';
import { t } from '@shared/i18n';
import { SUPPRESS_OUTPUT } from './hook-output';
import { hostExecutable } from './pty-host-client';

// Claude が worktree やブランチを消す操作の歯止め。アプリが起動する Claude Code に、--settings で Bash の PreToolUse のフックとして足す。
// 次のものは、権限モード（auto・bypassPermissions を含む）にかかわらず、Claude Code の許可の確認を出させる（permissionDecision: ask）。
// - git worktree remove の --force（-f。長いオプションの省略形も）
// - git branch -D（--delete --force も）
// - worktree の rm -r（パスの区切りの 1 つがちょうど worktrees のもの。グロブ・中括弧・変数を含み、worktrees の入る区切りも。.claude ごと
//   消すものも。worktree の中では . や .. や * も）
// - 消す先や消し方を awk で確かめられない形で、コマンドのどこかに worktree か .claude の文字があるもの（loose）。引数に $ ` \ や
//   グロブ・中括弧のある rm（rm の名前に付いたものも）・xargs の後の rm・find -delete・前に cd のある rm -r・git のサブコマンド
//   （-C などのグローバルオプションを飛ばした先）が確かめられないもの・削除の指定のある git branch で引数が確かめられないもの
//   （オプションになりうる引数が確かめられないものも）・git worktree remove で引数が確かめられないもの。
//   worktree の中（.claude/worktrees/<名前> かその下）への cd は、片付けでよく使うので、前の cd にも、worktree か .claude の文字にも
//   数えない。代わりに、そのあとの rm -r の . .. ../ * は、worktree か .claude の文字が無くても確認を出させる。
//   worktree か .claude の文字の無いもの（前のコマンドで変数に入れたパスを消すものなど）は見分けられない（ふだんの rm -rf "$tmp"
//   のたびに確認が出ないよう、今のフォルダが worktree の中かは見ない）
// ただし、git の 2 つは、消して失うものが無いと確かめられたら確認を出させない（何も決めず、Claude Code のふだんの許可の決まりに任せる）。
// 止めはしない。ユーザーが確認して許せば、そのまま動く。
// 2 段で見る。
// 1. awk でざっと見る。Bash のたびに動くので速いものにする。Claude Code の hooks には JSON が標準入力で届く。Node が入っているとは
//    限らないので、macOS に必ずある awk で読む。コマンドは ; && || | などで区切り、区切りごとに見る（$(...) やクォートの中も、
//    区切りとしてざっと見る）。シェルの \ は、JSON の \\ を先に \001 に置き換えて見分ける（\n などの JSON の書き方と取り違えない
//    ように）。ここで何も無ければ、それで終わり
// 2. awk が確認を出させると決めたときだけ、tanacode 本体を Node として、確かめの入り口（worktree-guard-hook.js）を動かす。シェルの
//    文法で読み直し、すべてが許す形でできていて、消す操作に失うものが無いと git で確かめられたときだけ pass と答える
//    （worktree-guard-check.ts）。pass と答えたときだけ、確認を出させない。それ以外は、awk の決めたとおり確認を出させる
// reason は確認の理由（Claude Code の許可の確認に出る）。awk の文字列と JSON とシェルの単一引用符に埋め込むので、' " \ を含めない
const program = (reason: string) => String.raw`
function unq(v) { sub(/^"[a-z_]*"[[:space:]]*:[[:space:]]*"/, "", v); sub(/"$/, "", v); return v }
function flag(a, c) { return a ~ "^-[a-zA-Z]*" c "[a-zA-Z]*$" }
function long(a, full) { return length(a) > 2 && index(full, a) == 1 }
function rmword(a) { gsub(/\001/, "", a); sub(/^[(!]+/, "", a); return a == "rm" || a ~ /\/rm$/ || a ~ /^rm[{$` + '`' + String.raw`]/ }
function opaque(a) { return a ~ /[$` + '`' + String.raw`\001*?{}]/ || index(a, "[") > 0 }
function risky(p, d,   t, m, k, j, a, git, rm, r, del, force, ns, seg, q) {
  m = split(p, t, /[[:space:]]+/)
  for (k = 1; k <= m; k++) {
    a = t[k]
    if (a == "git" || a ~ /\/git$/) git = 1
    if (git && a == "worktree" && t[k + 1] == "remove")
      for (j = k + 2; j <= m; j++) if (long(t[j], "--force") || flag(t[j], "f")) return 1
    if (git && a == "branch") {
      for (j = k + 1; j <= m; j++) {
        if (flag(t[j], "D")) return 1
        if (long(t[j], "--delete") || flag(t[j], "d")) del = 1
        if (long(t[j], "--force") || flag(t[j], "f")) force = 1
      }
      if (del && force) return 1
    }
    if (a == "rm" || a ~ /\/rm$/) rm = k
  }
  if (!rm) return 0
  for (j = rm + 1; j <= m; j++) if (long(t[j], "--recursive") || flag(t[j], "[rR]")) r = 1
  if (!r) return 0
  for (j = rm + 1; j <= m; j++) {
    a = t[j]
    if (a == "" || a ~ /^-/) continue
    ns = split(a, seg, "/")
    for (q = 1; q <= ns; q++) if (seg[q] == "worktrees" || (seg[q] ~ /worktrees/ && (seg[q] ~ /[*?{}$]/ || index(seg[q], "[") > 0))) return 1
    sub(/\/+$/, "", a)
    if (a ~ /(^|\/)\.claude$/) return 1
    if (d ~ /\/\.claude\/worktrees\// && (a ~ /^\.\.?\/?$/ || a ~ /^\.\.\// || a ~ /^(\.\/)?\*$/ || a == d)) return 1
  }
  return 0
}
function inside(a) { return !opaque(a) && a ~ /(^|\/)\.claude\/worktrees\/[^\/]/ && a !~ /(^|\/)\.\.(\/|$)/ }
function hides(a) { return opaque(a) && a ~ /^[-$` + '`' + String.raw`]/ }
function gitloose(t, m, k,   j, s, del) {
  for (j = k + 1; j <= m; j++) {
    if (t[j] == "") continue
    if (t[j] == "-C" || t[j] == "-c" || t[j] == "--git-dir" || t[j] == "--work-tree" || t[j] == "--namespace") { j++; continue }
    if (t[j] !~ /^-/) break
  }
  s = t[j]
  if (opaque(s)) return 1
  if (s == "branch") {
    for (k = j + 1; k <= m; k++) if (long(t[k], "--delete") || flag(t[k], "[dD]")) del = 1
    for (k = j + 1; k <= m; k++) if (hides(t[k]) || (del && opaque(t[k]))) return 1
  }
  if (s == "worktree") {
    for (j++; j <= m && (t[j] == "" || t[j] ~ /^-/); j++) if (opaque(t[j])) return 1
    if (opaque(t[j])) return 1
    if (t[j] == "remove") for (k = j + 1; k <= m; k++) if (opaque(t[k])) return 1
  }
  return 0
}
function loose(p,   t, m, k, j, a, xargs, rm, r, hidden, up, v) {
  m = split(p, t, /[[:space:]]+/)
  for (k = 1; k <= m; k++) {
    a = t[k]
    sub(/^[(!{]+/, "", a)
    if ((a == "cd" || a == "pushd") && inside(t[k + 1])) { inwt = 1; k++; continue }
    if (t[k] ~ /worktree|\.claude/) hint = 1
    if (a == "cd" || a == "pushd") moved = 1
    if (a == "xargs") xargs = 1
    if (a == "find") for (j = k + 1; j <= m; j++) if (t[j] == "-delete") v = 1
    if ((a == "git" || a ~ /\/git$/) && gitloose(t, m, k)) v = 1
    if (!rm && rmword(t[k])) { rm = k; if (xargs || opaque(t[k])) v = 1 }
  }
  if (!rm) return v
  for (j = rm + 1; j <= m; j++) {
    a = t[j]
    if (opaque(a)) hidden = 1
    if (long(a, "--recursive") || flag(a, "[rR]")) r = 1
    if (inwt && a !~ /^-/ && (a ~ /^\.\.?\/?$/ || a ~ /^\.\.\// || a ~ /^(\.\/)?\*$/)) up = 1
  }
  if (r && up) return 2
  return v || hidden || (r && moved)
}
function ask() {
  print "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"${reason}\"},\"suppressOutput\":true}"
  exit 0
}
{ s = s $0 " " }
END {
  if (!match(s, /"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) { print "{\"suppressOutput\":true}"; exit 0 }
  c = unq(substr(s, RSTART, RLENGTH))
  d = ""
  if (match(s, /"cwd"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) d = unq(substr(s, RSTART, RLENGTH))
  gsub(/\\\\/, "\001", c)
  gsub(/\\[nr]/, ";", c)
  gsub(/\\t/, " ", c)
  gsub(/\\"|\047/, "", c)
  e = c
  gsub(/\001/, "", e)
  n = split(e, parts, /&&|\|\||[;|&()` + '`' + String.raw`]|\$\(/)
  for (i = 1; i <= n; i++) if (risky(parts[i], d)) ask()
  if (c !~ /worktree|\.claude/) { print "{\"suppressOutput\":true}"; exit 0 }
  n = split(c, parts, /&&|\|\||[;|&]/)
  for (i = 1; i <= n; i++) { v = loose(parts[i]); if (v == 2) ask(); if (v) found = 1 }
  if (found && hint) ask()
  print "{\"suppressOutput\":true}"
}
`;

// 確かめの入り口を動かす実行ファイル（tanacode 本体の Helper を Node として）と、入り口のスクリプト（worktree-guard-hook.js）
export type WorktreeGuardLaunch = { command: string; script: string };

// アプリのビルドでの入り口（main の index.js の隣）
function defaultLaunch(): WorktreeGuardLaunch {
  return { command: hostExecutable(), script: join(__dirname, 'worktree-guard-hook.js') };
}

// フックのコマンド。理由は、Claude Code を起動するときの言語で書く。目印の環境変数（GUARD_HOOK_ENV）は、チャットのフックの一覧に出さないためのもの。
// 標準入力は awk と確かめの入り口の両方に渡すので、先に読んでおく。
// 入り口の場所は、コマンドの文字列に直に書く（環境変数で渡すと、Claude Code の設定の env で差し替えられる）。Node として動かすので、
// Node の動きを変える環境変数（NODE_OPTIONS など）は消して動かす。入り口が無い・場所を単一引用符で囲めないときは、確かめずに
// awk の決めたとおりにする
export function worktreeGuardCommand(launch: WorktreeGuardLaunch = defaultLaunch()): string {
  const awk = `awk '${program(t('main.hooks.worktreeGuard')).trim()}'`;
  const usable = existsSync(launch.script) && ![launch.command, launch.script].some((p) => p.includes("'"));
  const verify = `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE ELECTRON_RUN_AS_NODE=1 '${launch.command}' '${launch.script}' 2>/dev/null`;
  return [
    `${GUARD_HOOK_ENV}=1 i=$(cat)`,
    `o=$(printf '%s' "$i" | ${awk})`,
    ...(usable ? [`case $o in *'"ask"'*) if [ "$(printf '%s' "$i" | ${verify})" = pass ]; then o='${SUPPRESS_OUTPUT}'; fi;; esac`] : []),
    `printf '%s\\n' "$o"`,
  ].join('; ');
}
