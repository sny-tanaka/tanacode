import { createHash } from 'node:crypto';
import { t } from '@shared/i18n';
import { READ_DEFAULT_LINES, READ_MAX_LINES, readTypeInput, terminalLabel, terminalTool, typedPreview, type TerminalKey, type TypeInput } from '@shared/terminal-tools';
import { textResult, type ToolResult } from './mcp-bridge';
import type { ShellTerminals, TerminalInfo } from './shell-terminals';
import { TERMINAL_GATE_REQUEST } from './terminal-bridge';

// Claude による人のターミナルの読み書き（MCP サーバー tanacode-terminal のツールの実行）。中継からの呼び出しを、ソケットで受けて答える。
// 呼び出し元のセッションは中継の env で渡ってくるので、親子の関係はアプリの記録（SessionManager）で判断する。
// - 読む（list_terminals・read_terminal）: 自分のセッションのパネルのターミナルと、自分の子のもの（session_id）
// - 打つ（type_in_terminal）: 自分のセッションのパネルのターミナルにだけ。子セッションからは打てない。
//   打つ前の確認のフック（terminal-bridge.ts）が控えさせた「確認済みの印」（入力のハッシュ。1 回だけ使え、15 分で失効）が無ければ断る。
//   打ったあと、出力が 0.5 秒止まるか 3 秒たつまで待って、そのあいだに出た行を返す
// Claude に返す結果とエラーは英語（画面の項目の名前とタブの名前だけ、画面の言語で入れる）

// SessionManager のうち、使うもの
export type TerminalSessions = {
  // tanacode のセッションか
  exists(id: string): boolean;
  // セッションのフォルダ（新しいタブを開く場所）
  cwdOf(id: string): string;
  parentOf(id: string): string | null;
  childrenOf(id: string): string[];
};

// ShellTerminals のうち、使うもの
export type TerminalsApi = Pick<ShellTerminals, 'list' | 'info' | 'flush' | 'tail' | 'cursorLine' | 'markCursor' | 'applicationCursor' | 'write' | 'openShell'>;

type Deps = {
  terminals: TerminalsApi;
  sessions: TerminalSessions;
  // メニューの「MCP → ターミナル」
  enabled: () => boolean;
  clock?: () => number;
  // 打ったあと、出力が止まったとみなすまでの間と、待つ上限（テストでは短くする）
  quietMs?: number;
  maxWaitMs?: number;
};

// 打ったあとに返す行数の上限と、read_terminal で返す文字数の上限
const TYPE_RESULT_LINES = 50;
const MAX_READ_CHARS = 30_000;
// 確認済みの印が使えるあいだ（人が確認に答えるまでの時間を含む）
const MARK_TTL_MS = 15 * 60_000;
// 打ったあと、出力が止まったとみなすまでの間と、待つ上限
const QUIET_MS = 500;
const MAX_WAIT_MS = 3000;
// 新しいタブのシェルが、最初のプロンプトを出し終えるのを待つ（出力が止まるまで）上限
const START_QUIET_MS = 300;
const START_WAIT_MS = 5000;
const POLL_MS = 50;

// 特別なキーで送るもの。矢印は、前面のプログラムが求めるモード（vim・less など）に合わせる
function keySequence(key: TerminalKey, applicationCursor: boolean): string {
  switch (key) {
    case 'ctrl-c':
      return '\x03';
    case 'ctrl-d':
      return '\x04';
    case 'escape':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'up':
      return applicationCursor ? '\x1bOA' : '\x1b[A';
    case 'down':
      return applicationCursor ? '\x1bOB' : '\x1b[B';
  }
}

class ToolError extends Error {}

export class TerminalControl {
  // 確認済みの印（入力のハッシュ → 失効する時刻。同じ入力が続けて確かめられたら、その数だけ）
  private readonly marks = new Map<string, number[]>();

  constructor(private readonly deps: Deps) {}

  // 中継から届いた呼び出し。signal: Claude Code が呼び出しを取り消した（中継がソケットを閉じた）
  async handle(caller: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    try {
      if (name === TERMINAL_GATE_REQUEST) return this.gate(caller, args);
      if (!terminalTool(name)) return textResult(`Unknown tool: ${name}`, true);
      this.check(caller);
      return await this.run(caller, name, args, signal);
    } catch (error) {
      if (error instanceof ToolError) return textResult(error.message, true);
      throw error;
    }
  }

  private check(caller: string): void {
    if (!this.deps.enabled()) throw new ToolError(`The user has turned off the tanacode MCP "${t('tools.server.terminal')}" in tanacode > ${t('main.menu.mcpSettings')}.`);
    if (!this.deps.sessions.exists(caller)) throw new ToolError('This session is not in tanacode.');
  }

  private async run(caller: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    switch (name) {
      case 'list_terminals':
        return this.list(this.owner(caller, args.session_id));
      case 'read_terminal':
        return this.read(this.owner(caller, args.session_id), args.id, args.lines);
      case 'type_in_terminal':
        return this.type(caller, args, signal);
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  }

  // --- 読む

  // 読むターミナルの持ち主。省けば自分、渡されたら自分の子だけ（ID のはじめの 8 文字以上）
  private owner(caller: string, raw: unknown): string {
    if (raw === undefined || raw === null || raw === '') return caller;
    const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (id.length < 8) throw new ToolError('Pass a session ID (at least its first 8 characters) as session_id, or omit it for this session.');
    if (caller.startsWith(id)) return caller;
    const matches = this.deps.sessions.childrenOf(caller).filter((child) => child.startsWith(id));
    if (matches.length === 0) throw new ToolError(`${id} is not a child session of this session. You can read only the terminals of this session and of its children.`);
    if (matches.length > 1) throw new ToolError(`More than one child session has an ID starting with ${id}. Pass a longer ID.`);
    return matches[0];
  }

  private list(owner: string): ToolResult {
    const terminals = this.deps.terminals.list(owner).map((info) => ({
      id: info.id,
      tab: info.tab,
      kind: info.kind,
      label: labelOf(info),
      title: info.title,
      command: info.command,
      cwd: info.cwd,
      running: info.running,
      exit_code: info.exitCode,
      foreground: info.foreground,
      last_output_at: info.lastOutputAt === null ? null : new Date(info.lastOutputAt).toISOString(),
    }));
    const note = terminals.length === 0 ? { note: "No terminal is open in this session's terminal panel." } : {};
    return textResult(JSON.stringify({ session_id: owner, terminals, ...note }, null, 2));
  }

  private async read(owner: string, rawId: unknown, rawLines: unknown): Promise<ToolResult> {
    const info = this.terminalOf(owner, rawId);
    const count = typeof rawLines === 'number' && Number.isFinite(rawLines) ? Math.min(Math.max(Math.floor(rawLines), 1), READ_MAX_LINES) : READ_DEFAULT_LINES;
    await this.deps.terminals.flush(info.id);
    const lines = this.deps.terminals.tail(info.id, count) ?? [];
    let text = lines.join('\n');
    let cut = '';
    if (text.length > MAX_READ_CHARS) {
      // 後ろを残す。行の途中から始めない
      text = text.slice(-MAX_READ_CHARS);
      text = text.slice(text.indexOf('\n') + 1);
      cut = ` (cut to the last ${MAX_READ_CHARS} characters)`;
    }
    return textResult(
      [
        `${terminalName(info)}: ${stateOf(info)}.`,
        lines.length === 0 ? 'The terminal shows nothing yet.' : `Last ${text.split('\n').length} lines${cut}:`,
        ...(lines.length === 0 ? [] : [fence(text)]),
      ].join('\n'),
    );
  }

  // 持ち主のパネルのターミナル
  private terminalOf(owner: string, rawId: unknown): TerminalInfo {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) throw new ToolError('Pass the ID of a terminal (from list_terminals) as id.');
    const info = this.deps.terminals.info(id);
    if (!info || info.owner !== owner) throw new ToolError(`No terminal ${id} is in the terminal panel (check with list_terminals).`);
    return info;
  }

  // --- 打つ

  // 打つ前の確認のフックから。打つものを確かめて、確認済みの印を控え、タブの名前と打つものを返す（フックは確認の理由に入れる）
  private gate(caller: string, args: Record<string, unknown>): ToolResult {
    this.check(caller);
    const input = this.typeInput(caller, args);
    const tab = input.newTab ? t('terminal.tabs.new') : labelOf(this.typeTarget(caller, input.id!));
    const key = markKey(caller, input);
    const now = this.now();
    this.marks.set(key, [...this.live(key, now), now + MARK_TTL_MS]);
    return textResult(JSON.stringify({ tab, typed: typedPreview(input) }));
  }

  private async type(caller: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const input = this.typeInput(caller, args);
    // 打つ先を確かめてから、印を使う（打てなかった呼び出しで、印を使い切らない）
    if (!input.newTab) this.typeTarget(caller, input.id!);
    if (!this.useMark(caller, input)) {
      throw new ToolError(
        "Nothing was typed: the user's confirmation for this input was not found. tanacode asks the user before every input to a terminal, through a hook that did not run for this call. Tell the user that the confirmation did not appear.",
      );
    }
    const { terminals } = this.deps;
    let id = input.id!;
    if (input.newTab) {
      id = terminals.openShell(caller, this.deps.sessions.cwdOf(caller)).id;
      await this.waitQuiet(id, this.now(), START_QUIET_MS, START_WAIT_MS, signal, true);
    }
    const data = input.key ? keySequence(input.key, terminals.applicationCursor(id)) : `${input.text}${input.enter ? '\r' : ''}`;
    await terminals.flush(id);
    const before = terminals.cursorLine(id) ?? '';
    const since = terminals.markCursor(id);
    const typedAt = this.now();
    terminals.write(id, data);
    await this.waitQuiet(id, typedAt, this.deps.quietMs ?? QUIET_MS, this.deps.maxWaitMs ?? MAX_WAIT_MS, signal, false);
    await terminals.flush(id);
    const printed = since?.() ?? [];
    const shown = printed.slice(-TYPE_RESULT_LINES);
    const info = terminals.info(id);
    return textResult(
      [
        `Typed ${input.key ? `the key ${input.key}` : `${JSON.stringify(input.text)}${input.enter ? ' and Enter' : ' (without Enter)'}`} into ${info ? terminalName(info) : `terminal ${id}`}${input.newTab ? ', a new shell tab' : ''}.`,
        `Line the cursor was on before typing: ${JSON.stringify(before.trimEnd())}`,
        `Output until it paused for ${(this.deps.quietMs ?? QUIET_MS) / 1000} seconds (at most ${(this.deps.maxWaitMs ?? MAX_WAIT_MS) / 1000} seconds)${printed.length > shown.length ? `, the last ${TYPE_RESULT_LINES} lines` : ''}:`,
        shown.length === 0 ? '(nothing)' : fence(shown.join('\n')),
        info ? `Now: ${stateOf(info)}. Read what follows with read_terminal.` : 'The terminal has closed.',
      ].join('\n'),
    );
  }

  // 打つものを読む。子セッションからは打てない
  private typeInput(caller: string, args: Record<string, unknown>): TypeInput {
    if (this.deps.sessions.parentOf(caller) !== null) throw new ToolError("Child sessions cannot type into the user's terminal.");
    const input = readTypeInput(args);
    if (typeof input === 'string') throw new ToolError(input);
    return input;
  }

  // 打つ先。自分のパネルの、動いているターミナルだけ（画面に出していないコマンドには、人が見えないので打たない）
  private typeTarget(caller: string, id: string): TerminalInfo {
    const info = this.terminalOf(caller, id);
    if (info.tab === null) throw new ToolError(`Terminal ${id} is a command tanacode runs without showing it in the terminal panel; it cannot take input.`);
    if (!info.running) throw new ToolError(`Terminal ${id} has exited${info.exitCode === null ? '' : ` with code ${info.exitCode}`}; it cannot take input. Use new_tab to open a new shell.`);
    return info;
  }

  private useMark(caller: string, input: TypeInput): boolean {
    const key = markKey(caller, input);
    const live = this.live(key, this.now());
    if (live.length === 0) {
      this.marks.delete(key);
      return false;
    }
    if (live.length === 1) this.marks.delete(key);
    else this.marks.set(key, live.slice(1));
    return true;
  }

  // 失効していない印（ついでに、失効した印を捨てる）
  private live(key: string, now: number): number[] {
    for (const [k, times] of this.marks) {
      const kept = times.filter((until) => until > now);
      if (kept.length === 0) this.marks.delete(k);
      else if (kept.length !== times.length) this.marks.set(k, kept);
    }
    return this.marks.get(key) ?? [];
  }

  // 出力が quietMs のあいだ止まるか、maxMs たつか、終わるまで待つ。needOutput: 何か出るまでは止まったとみなさない（シェルの起動）
  private async waitQuiet(id: string, since: number, quietMs: number, maxMs: number, signal: AbortSignal | undefined, needOutput: boolean): Promise<void> {
    while (!signal?.aborted) {
      const now = this.now();
      if (now - since >= maxMs) return;
      const info = this.deps.terminals.info(id);
      if (!info?.running) return;
      const last = info.lastOutputAt !== null && info.lastOutputAt >= since ? info.lastOutputAt : null;
      if ((last !== null || !needOutput) && now - (last ?? since) >= quietMs) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private now(): number {
    return (this.deps.clock ?? Date.now)();
  }
}

// 確認済みの印の鍵。呼び出し元と、打つものにそろえた入力のハッシュ
function markKey(caller: string, input: TypeInput): string {
  return createHash('sha256').update(JSON.stringify([caller, input.id, input.newTab, input.text, input.enter, input.key])).digest('hex');
}

// 画面に出していないコマンド（tab が null）にはタブの番号が無いが、名前はコマンドから作るので番号を使わない
function labelOf(info: TerminalInfo): string {
  return terminalLabel({ task: info.kind === 'command', name: info.name, title: info.title, exitCode: info.exitCode, position: info.tab ?? 0 });
}

function terminalName(info: TerminalInfo): string {
  return `terminal ${info.id} (${info.tab === null ? 'not shown in the terminal panel' : `tab ${info.tab}`}, ${JSON.stringify(labelOf(info))})`;
}

function stateOf(info: TerminalInfo): string {
  if (!info.running) return `exited with code ${info.exitCode}`;
  return info.foreground ? `running (foreground: ${info.foreground})` : 'running';
}

// 中に ``` があってもコードブロックから抜けないよう、フェンスは中身より長くする
function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const mark = '`'.repeat(longest + 1);
  return `${mark}\n${text}\n${mark}`;
}
