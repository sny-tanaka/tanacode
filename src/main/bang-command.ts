import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// 入力欄の「!」のコマンド。アプリがシェルで動かし、TUI の「!」（Claude Code の Bash ツール）と同じ形で会話に足す（実測 2.1.301）:
// - $SHELL -c で、Claude Code が起動のたびに作るシェルのスナップショット（.zshrc・.bashrc の別名・関数・オプション）を読んでから eval する。
//   標準入力は /dev/null。標準出力と標準エラーは 1 つのファイルにまとめる
// - 終わったら pwd -P を書く。次の「!」は、そのフォルダで動かす（cd が続く）
// - 会話ログには <bash-input> と <bash-stdout>・<bash-stderr> の 2 行。出力の <・>・& はエスケープする。成功したら末尾の改行を落とし、
//   失敗したら（終了コードが 0 でない）出力を全部 <bash-stderr> に入れる（終了コードは書かない）

// Claude に渡す出力の長さ（Claude Code の bashOutputMaxChars の既定）。超えた分は捨てて、そう書く
export const BANG_OUTPUT_CHARS = 30_000;
// 止めるとき、SIGTERM のあと SIGKILL を送るまでの時間
const KILL_GRACE_MS = 2000;

export type BangRun = {
  // 標準出力と標準エラーをまとめたもの
  output: string;
  // 終了コード。シグナルで終わった・起動できなかったときは null
  exitCode: number | null;
  // 止めた（stop）
  interrupted: boolean;
  // 終わったときの作業フォルダ（成功したときだけ分かる）
  cwd: string | null;
  // 起動できなかった理由
  error?: string;
};

export type BangOptions = {
  command: string;
  shell: string;
  cwd: string;
  env: Record<string, string>;
  // シェルのスナップショット（findShellSnapshot）。無ければ読まない
  snapshot: string | null;
  signal?: AbortSignal;
};

// シングルクォートで囲む（中の ' は '\'' にする）
function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// シェルに渡す文。Claude Code の Bash ツールと同じ並び（スナップショット → glob の設定 → unsetenv の別名を外す → eval → pwd -P）
export function shellScript(command: string, shell: string, snapshot: string | null, cwdFile: string): string {
  const name = basename(shell);
  const glob = name.includes('bash') ? 'shopt -u extglob 2>/dev/null || true' : name.includes('zsh') ? 'setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true' : null;
  return [
    ...(snapshot ? [`source ${quote(snapshot)} 2>/dev/null || true`] : []),
    ...(glob ? [glob] : []),
    "{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true",
    `eval ${quote(command)} < /dev/null && pwd -P >| ${quote(cwdFile)}`,
  ].join(' && ');
}

// Claude Code のシェルのスナップショット（<設定のフォルダ>/shell-snapshots/snapshot-<シェル>-<作った時刻>-<乱数>.sh）。
// 動いている Claude Code が起動のときに作ったもの（since より後のうち、いちばん早いもの。あとから起動したほかのセッションのものは、
// そのセッションが終わると消える）。無ければ、ほかのセッションのもののうちいちばん新しいもの（同じ人の同じシェルの設定なので、
// 中身は同じ）。Claude Code は終わるときに自分のものを消す。どれも無ければ null
export function findShellSnapshot(configDir: string, shell: string, since: number | null): string | null {
  const dir = join(configDir, 'shell-snapshots');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = `snapshot-${basename(shell)}-`;
  const found = names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.sh'))
    .map((name) => ({ name, at: Number(name.slice(prefix.length).split('-')[0]) }))
    .filter((s) => Number.isFinite(s.at))
    .sort((a, b) => b.at - a.at);
  const own = since === null ? undefined : found.filter((s) => s.at >= since).at(-1);
  const chosen = own ?? found[0];
  return chosen ? join(dir, chosen.name) : null;
}

// 動かす。止めたら（signal）、プロセスのグループに SIGTERM、待っても終わらなければ SIGKILL
export function runBang(options: BangOptions): Promise<BangRun> {
  const id = randomUUID();
  const outFile = join(tmpdir(), `tanacode-bang-${id}.out`);
  const cwdFile = join(tmpdir(), `tanacode-bang-${id}.cwd`);
  const cleanup = () => {
    rmSync(outFile, { force: true });
    rmSync(cwdFile, { force: true });
  };
  return new Promise((resolve) => {
    let fd: number;
    try {
      fd = openSync(outFile, 'w', 0o600);
    } catch (error) {
      resolve({ output: '', exitCode: null, interrupted: false, cwd: null, error: errorText(error) });
      return;
    }
    let interrupted = false;
    let killTimer: NodeJS.Timeout | null = null;
    const child = spawn(options.shell, ['-c', shellScript(options.command, options.shell, options.snapshot, cwdFile)], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    closeSync(fd);
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // もう終わっている
      }
    };
    const stop = () => {
      interrupted = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
    };
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });
    const finish = (run: BangRun) => {
      options.signal?.removeEventListener('abort', stop);
      if (killTimer) clearTimeout(killTimer);
      cleanup();
      resolve(run);
    };
    child.once('error', (error) => finish({ output: readText(outFile), exitCode: null, interrupted, cwd: null, error: errorText(error) }));
    child.once('exit', (code) => {
      const cwd = readText(cwdFile).trim() || null;
      finish({ output: readText(outFile), exitCode: code, interrupted, cwd: code === 0 ? cwd : null });
    });
  });
}

// 会話ログに足す 2 行（TUI の「!」と同じ形）
export function bangLines(command: string, run: BangRun): [string, string] {
  const input = `<bash-input>${command}</bash-input>`;
  if (run.error !== undefined) return [input, `<bash-stderr>Command failed: ${escapeXml(run.error)}</bash-stderr>`];
  const output = clip(run.output);
  if (run.exitCode === 0) return [input, `<bash-stdout>${escapeXml(output.replace(/\n+$/, ''))}</bash-stdout><bash-stderr></bash-stderr>`];
  return [input, `<bash-stdout></bash-stdout><bash-stderr>${escapeXml(output)}</bash-stderr>`];
}

function clip(output: string): string {
  if (output.length <= BANG_OUTPUT_CHARS) return output;
  return `${output.slice(0, BANG_OUTPUT_CHARS)}\n[Output truncated: showing the first ${BANG_OUTPUT_CHARS} of ${output.length} characters]`;
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
