import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { INSTRUCTIONS_FILE, instructionsContext, INSTRUCTIONS_TAG, parseInstructions } from '@shared/project-instructions';

// TANACODE.md・TANACODE_PARENT.md（@shared/project-instructions）を探して読む。
// TANACODE.md は、アプリが起動する Claude Code に足す SessionStart のフック（instructions-hook.ts）が、その都度読んで渡す

// 読むファイルの大きさの上限。これより大きいものは読まない（指示のファイルとして置くものではないので、渡さない）
const MAX_FILE_BYTES = 1024 * 1024;

// セッションで探すフォルダ。セッションのフォルダ、worktree のセッションなら元のリポジトリ（いちばん上）の順
export function instructionDirs(cwd: string, worktreeRoot: string | null | undefined): string[] {
  return worktreeRoot && worktreeRoot !== cwd ? [cwd, worktreeRoot] : [cwd];
}

// dirs の順に、そのフォルダの直下の name を探す。見つかったファイルのパスと中身（無い・読めない・大きすぎる・空なら次へ。どこにも無ければ null）
export function readInstructions(name: string, dirs: readonly string[]): { path: string; content: string } | null {
  for (const dir of dirs) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const content = readFileSync(path, 'utf8');
      if (content.trim()) return { path, content };
    } catch {
      // 無い・読めない
    }
  }
  return null;
}

// 中身の印（会話ログに残った、最後に渡したものと比べる）
export function instructionsSum(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

// 会話ログを後ろから読むときの 1 回の大きさ
const CHUNK_BYTES = 1024 * 1024;
const MARK = `<${INSTRUCTIONS_TAG} `;
const BOUNDARY = '"subtype":"compact_boundary"';

// 会話ログで、今の会話に最後に渡した TANACODE.md の印。それより後に圧縮の境目があれば（要約に置き換わった）、渡していないとして null。
// 会話ログは大きいことがあるので、後ろから少しずつ読み、囲みか圧縮の境目の、いちばん後ろの行だけを読む
// chunkBytes: 1 回に読む大きさ（テストでは小さくして、行が読む部分の境目をまたぐときを確かめる）
export function lastDeliveredSum(transcript: string, chunkBytes = CHUNK_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(transcript, 'r');
    let end = fstatSync(fd).size;
    // 前に読んだ部分の頭（行の途中で切れたもの）。次に読む部分のうしろにつなぐ
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const data = Buffer.concat([chunk, carry]);
      // 頭の行は、前の部分に続いているかもしれないので、まだ読まない（ファイルの頭まで読んだときは読む）。
      // 改行が無ければ、全部が 1 行の途中なので、まるごと次へ持ち越す
      const firstBreak = start > 0 ? data.indexOf(0x0a) : -1;
      if (start > 0 && firstBreak < 0) {
        carry = data;
        end = start;
        continue;
      }
      const lines = data.subarray(firstBreak + 1).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        // 文字で当たりを付けてから、行を読む（ほとんどの行は読まずに済む）
        const sum = line.includes(MARK) ? sumOfLine(line) : null;
        if (sum) return sum;
        if (line.includes(BOUNDARY) && isBoundary(line)) return null;
      }
      carry = data.subarray(0, firstBreak + 1);
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// 会話ログの 1 行が、Claude に TANACODE.md を渡した記録（hook_additional_context の attachment）なら、その囲みの印。
// 同じ文は、フックの記録（hook_success の stdout）・リクエストの控え（api-request-blob）や、Claude が読んだファイルの中にも出るが、
// Claude に渡ったのはこの記録なので、ほかは読まない
function sumOfLine(line: string): string | null {
  let value: { type?: unknown; attachment?: { type?: unknown; content?: unknown } };
  try {
    value = JSON.parse(line) as typeof value;
  } catch {
    return null;
  }
  const { attachment } = value;
  if (value.type !== 'attachment' || attachment?.type !== 'hook_additional_context' || !Array.isArray(attachment.content)) return null;
  for (const text of attachment.content) {
    const found = typeof text === 'string' ? parseInstructions(text) : null;
    if (found) return found.sum;
  }
  return null;
}

// 圧縮の境目の行か
function isBoundary(line: string): boolean {
  try {
    const value = JSON.parse(line) as { type?: unknown; subtype?: unknown };
    return value.type === 'system' && value.subtype === 'compact_boundary';
  } catch {
    return false;
  }
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
  const found = readInstructions(INSTRUCTIONS_FILE, dirs);
  if (!found) return '';
  const sum = instructionsSum(found.content);
  if (input.source === 'resume' && input.transcript_path && lastDeliveredSum(input.transcript_path) === sum) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: instructionsContext(found.path, found.content, sum) } });
}
