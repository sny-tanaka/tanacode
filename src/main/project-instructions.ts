import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { INSTRUCTIONS_FILE, instructionsContext, parseInstructions } from '@shared/project-instructions';
import { t } from '@shared/i18n';
import { projectRootOf } from '@shared/session-tools';

// TANACODE.md・TANACODE_PARENT.md（@shared/project-instructions）を探して読む。
// TANACODE.md は、アプリが起動する Claude Code に足す SessionStart のフック（instructions-hook.ts）が、その都度読んで渡す

// 読むファイルの大きさの上限。これより大きいものは読まない（指示のファイルとして置くものではないので、渡さない）
export const MAX_FILE_BYTES = 1024 * 1024;

// セッションで探すフォルダ。セッションのフォルダ、worktree のセッションなら元のリポジトリ（いちばん上）の順。
// 元のリポジトリは、記録の worktree が無くても、パスから求める（.claude/worktrees/<名前> を直に選んだセッション・既存の worktree を
// フォルダにした子。@shared/session-tools の projectRootOf と同じ）
export function instructionDirs(cwd: string, worktreeRoot: string | null | undefined): string[] {
  const root = projectRootOf({ cwd, worktree: worktreeRoot ? { root: worktreeRoot } : null });
  return root !== cwd ? [cwd, root] : [cwd];
}

// 見つけたファイル。content: 中身 / problem: あるが使えない（empty: 空白だけ・tooLarge: MAX_FILE_BYTES より大きい・unreadable: 読めない・ファイルでない）
export type InstructionsFile = { path: string; content: string } | { path: string; problem: 'empty' | 'tooLarge' | 'unreadable' };

// dirs の順に、そのフォルダの直下の name を探す。無ければ次へ（どこにも無ければ null）。あれば、使えなくても次へは行かない
// （worktree に置いたものが使えないのに、黙って元のリポジトリのものを渡さない）
export function readInstructions(name: string, dirs: readonly string[]): InstructionsFile | null {
  for (const dir of dirs) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return { path, problem: 'unreadable' };
    }
    if (!stat.isFile()) return { path, problem: 'unreadable' };
    if (stat.size > MAX_FILE_BYTES) return { path, problem: 'tooLarge' };
    try {
      const content = readFileSync(path, 'utf8');
      return content.trim() ? { path, content } : { path, problem: 'empty' };
    } catch {
      return { path, problem: 'unreadable' };
    }
  }
  return null;
}

// 使えないファイルの、チャットに出す理由（画面の言語）
export function instructionsProblemText(file: { path: string; problem: 'empty' | 'tooLarge' | 'unreadable' }): string {
  const key = file.problem === 'empty' ? 'main.instructions.empty' : file.problem === 'tooLarge' ? 'main.instructions.tooLarge' : 'main.instructions.unreadable';
  return t(key, { path: file.path });
}

// 中身の印（会話ログに残った、最後に渡したものと比べる）
export function instructionsSum(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

// これより大きい会話ログは読まない（同じ中身でも渡し直す側に倒す）
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

// 会話ログの行のうち、今の枝をたどるのに使うもの。sum: TANACODE.md を渡した記録なら、その囲みの印 / boundary: 圧縮の境目
type Node = { parent: string | null; sum: string | null; boundary: boolean };
type Line = { uuid?: unknown; parentUuid?: unknown; isSidechain?: unknown; type?: unknown; subtype?: unknown; attachment?: { type?: unknown; content?: unknown } };

// 会話ログで、今の会話（今の枝）に最後に渡した TANACODE.md の印。渡していない・それより後に圧縮の境目がある（要約に置き換わった）なら null。
// 会話ログは、巻き戻し（「ここまで戻す」）のあとの発言から同じファイルの中で枝分かれするので、ファイルの後ろから探すのではなく、
// いちばん後ろの行から親（parentUuid）をたどる（@main/chat-log の branchCut と同じ見方）。外れた枝に渡したものは数えない。
// 圧縮の境目は親を持たない（parentUuid が null）ので、たどるのもそこで止まる
export function lastDeliveredSum(transcript: string): string | null {
  let text: string;
  try {
    if (statSync(transcript).size > MAX_TRANSCRIPT_BYTES) return null;
    text = readFileSync(transcript, 'utf8');
  } catch {
    return null;
  }
  const nodes = new Map<string, Node>();
  let leaf: string | null = null;
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      // 書きかけの行
      continue;
    }
    if (typeof line?.uuid !== 'string' || !('parentUuid' in line) || line.isSidechain === true) continue;
    nodes.set(line.uuid, {
      parent: typeof line.parentUuid === 'string' ? line.parentUuid : null,
      sum: sumOf(line),
      boundary: line.type === 'system' && line.subtype === 'compact_boundary',
    });
    leaf = line.uuid;
  }
  const seen = new Set<string>();
  for (let id = leaf; id !== null && !seen.has(id); ) {
    seen.add(id);
    const node = nodes.get(id);
    if (!node) return null;
    if (node.sum) return node.sum;
    if (node.boundary) return null;
    id = node.parent;
  }
  return null;
}

// Claude に TANACODE.md を渡した記録（hook_additional_context の attachment）なら、その囲みの印。
// 同じ文は、フックの記録（hook_success の stdout）・リクエストの控え（api-request-blob）や、Claude が読んだファイルの中にも出るが、
// Claude に渡ったのはこの記録なので、ほかは読まない
function sumOf(line: Line): string | null {
  const { attachment } = line;
  if (line.type !== 'attachment' || attachment?.type !== 'hook_additional_context' || !Array.isArray(attachment.content)) return null;
  for (const text of attachment.content) {
    const found = typeof text === 'string' ? parseInstructions(text) : null;
    if (found) return found.sum;
  }
  return null;
}

// Claude Code がフックの標準入力に渡す JSON のうち、使うもの。source: startup・resume・clear・compact
type HookInput = { hook_event_name?: string; source?: string; transcript_path?: string };

// SessionStart のフックの本体。標準入力の JSON と、探すフォルダから、標準出力に書く答え（JSON）を返す。何も渡さないときは空。
// 会話を再開したとき（resume。起動し直し・チャットとターミナルモードの切り替え・モデルの切り替えでも起きる）は、今の会話に最後に渡した
// ものと同じなら渡し直さない（Claude Code は resume でもフックの文を会話に足すので、同じものが重なる）。書き換えていれば、新しい中身を渡す。
// 新しい会話・/clear・圧縮のあとは、いつも渡す（会話が消えても、決まりが落ちないように）
export function runInstructionsHook(stdin: string, dirs: readonly string[]): string {
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return '';
  }
  if (input.hook_event_name !== 'SessionStart') return '';
  // 使えないもの（空・大きすぎる・読めない）は渡さない（アプリが、起動したときにチャットで知らせる。SessionManager.start）
  const found = readInstructions(INSTRUCTIONS_FILE, dirs);
  if (!found || !('content' in found)) return '';
  const sum = instructionsSum(found.content);
  if (input.source === 'resume' && input.transcript_path && lastDeliveredSum(input.transcript_path) === sum) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: instructionsContext(found.path, found.content, sum) } });
}
