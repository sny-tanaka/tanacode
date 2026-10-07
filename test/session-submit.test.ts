import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parentMessageText } from '@shared/session-tools';
import type { PtyHandle, PtyHostApi } from '../src/main/pty-host-client';
import type { HostedPtyInfo } from '../src/main/pty-host-protocol';
import { SessionManager, typedShown } from '../src/main/session-manager';
import { SessionStore } from '../src/main/session-store';
import { StatusLineWatcher } from '../src/main/statusline';
import { WorkspaceWatchers } from '../src/main/workspace-watcher';

// Claude Code の入力欄に打って送る（SessionManager.submit）。子セッションへの最初の指示が、入力欄に残ったまま送られなかった件。
// Claude Code は、stdin に溜まっていた分をまとめて 1 度に読む。長い文字と Enter（\r）が 1 度に届くと、貼り付けとみなし、
// Enter は改行として入力欄に入る（2.1.292 で実測。親からの指示は囲みと session の ID で 100 文字を超える）。
// 打ってから決まった時間（50ms）だけ待って Enter を送ると、Claude Code が忙しくて読むのが遅れたとき（起動の直後に MCP サーバーが
// つながる間。CI の macOS で 10 回に 4〜5 回）に、文字と Enter が 1 度に届いてしまう。打った文字が入力欄に出てから Enter を送れば、別々に届く

const RULE = '─'.repeat(120);
// これより長い文字と Enter が 1 度に届くと、貼り付けとみなす（偽物の決まり。本物のしきい値は分からないが、親からの指示はこれを超える）
const BURST_CHARS = 100;
const PARENT = '11111111-0000-4000-8000-000000000001';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Claude Code の代わり（pty の先）。入力欄を描き、届いた文字を読んで入力欄に入れ、Enter で送る（submitted に残す）。
// stall(ms): 次に文字が届いたとき、ms の間は忙しくて読まない（その間に届いたものは、あとで 1 度に読む）
class FakeClaude implements PtyHandle {
  readonly submitted: string[] = [];
  draft = '';
  private pending = '';
  private busyUntil = 0;
  private stallMs = 0;
  private reading: NodeJS.Timeout | null = null;
  private readonly dataListeners: ((data: string) => void)[] = [];
  private readonly exitListeners: ((exitCode: number) => void)[] = [];
  private readonly started = setTimeout(() => this.paint(), 10);

  stall(ms: number): void {
    this.stallMs = ms;
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (exitCode: number) => void): void {
    this.exitListeners.push(listener);
  }

  resize(): void {}
  detach(): void {}

  kill(): void {
    clearTimeout(this.started);
    if (this.reading) clearTimeout(this.reading);
    this.exitListeners.forEach((l) => l(0));
  }

  write(data: string): void {
    this.pending += data;
    if (this.stallMs > 0) {
      this.busyUntil = Date.now() + this.stallMs;
      this.stallMs = 0;
    }
    if (!this.reading) this.reading = setTimeout(() => this.read(), Math.max(0, this.busyUntil - Date.now()));
  }

  private read(): void {
    this.reading = null;
    const chunk = this.pending.replace(/\x1b\[20[01]~/g, '');
    this.pending = '';
    if (chunk === '\r') {
      if (this.draft) this.submitted.push(this.draft);
      this.draft = '';
    } else if (chunk.length > BURST_CHARS) {
      this.draft += chunk.replace(/\r/g, '\n');
    } else {
      for (const ch of chunk) {
        if (ch !== '\r') this.draft += ch;
        else if (this.draft) {
          this.submitted.push(this.draft);
          this.draft = '';
        }
      }
    }
    this.paint();
  }

  // 入力欄（2 行目からは字下げ）と、その上下の罫線・権限モードの行。長い行は 50 文字で折り返す（全角でも画面の幅に収まるように）
  private paint(): void {
    const rows = this.draft.split('\n').flatMap((line) => line.match(/.{1,50}/gu) ?? ['']);
    const input = rows.map((row, i) => `${i === 0 ? '❯' : ' '} ${row}`).join('\r\n');
    const screen = `\x1b[2J\x1b[H Claude Code\r\n\r\n${RULE}\r\n${input}\r\n${RULE}\r\n  ⏸ manual mode on\r\n`;
    this.dataListeners.forEach((l) => l(screen));
  }
}

class FakeHost implements PtyHostApi {
  readonly spawned: FakeClaude[] = [];
  list(): Promise<HostedPtyInfo[]> {
    return Promise.resolve([]);
  }
  spawn(): PtyHandle {
    const claude = new FakeClaude();
    this.spawned.push(claude);
    return claude;
  }
  attach(): PtyHandle {
    throw new Error('引き継ぐ claude はありません');
  }
  forget(): void {}
}

let root: string;
let host: FakeHost;
let manager: SessionManager;
let statusLines: StatusLineWatcher;
const oldHome = process.env.HOME;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-submit-')));
  // 会話ログの場所（~/.claude/projects）とユーザーの設定は HOME から決まるので、使い捨てのフォルダにする
  process.env.HOME = join(root, 'home');
  mkdirSync(join(root, 'home'), { recursive: true });
  mkdirSync(join(root, 'work'), { recursive: true });
  host = new FakeHost();
  statusLines = new StatusLineWatcher(join(root, 'statusline'), () => {});
  const none = () => {};
  manager = new SessionManager(host, new SessionStore(join(root, 'sessions.json')), new WorkspaceWatchers(none), statusLines, {
    onSessionsChanged: none,
    onChat: none,
    onPtyData: none,
    onTurnCompleted: none,
    onScreen: none,
    onActivity: none,
    onWorkflows: none,
    onSubagents: none,
    onBashTasks: none,
    onKnowledge: none,
    onStatusLine: none,
    onAttention: none,
  });
});

afterEach(() => {
  manager.closeAll(true);
  statusLines.close();
  process.env.HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

function startChild(): { id: string; claude: FakeClaude } {
  const id = manager.create(join(root, 'work'), { model: null, effort: null, settingsFile: null, mode: 'manual', remoteControl: false, worktree: false }, PARENT);
  return { id, claude: host.spawned[host.spawned.length - 1] };
}

it('Claude Code が忙しくて、打った文字を読むのが遅れても、最初の指示は Enter まで届いて送られる（文字が入力欄に出てから Enter を送る）', async () => {
  const { id, claude } = startChild();
  const text = parentMessageText(PARENT, '子の作業として、返事だけしてください');
  expect(text.length).toBeGreaterThan(BURST_CHARS);
  // 打ち始めたところで、Claude Code が 300ms 忙しくなる（MCP サーバーがつながる間など）
  claude.stall(300);
  await manager.submitWhenReady(id, text, 10_000);
  for (let i = 0; i < 40 && claude.submitted.length === 0; i++) await sleep(25);
  expect(claude.submitted).toEqual([text]);
  expect(claude.draft).toBe('');
});

it('忙しくないときは、これまでどおりすぐ送る', async () => {
  const { id, claude } = startChild();
  const text = parentMessageText(PARENT, '続けてください');
  const startedAt = Date.now();
  await manager.submitWhenReady(id, text, 10_000);
  for (let i = 0; i < 40 && claude.submitted.length === 0; i++) await sleep(25);
  expect(claude.submitted).toEqual([text]);
  // 起動（入力欄が出てから 0.3 秒）を待つ分を除けば、打ってから Enter までは画面の読み取り 1 回分
  expect(Date.now() - startedAt).toBeLessThan(2000);
});

it('打った文字が入力欄に出たかは、折り返しの空白を除いて末尾で見る。貼り付けは目印が出たかで見る', () => {
  const text = parentMessageText(PARENT, '子の作業');
  expect(typedShown('', '', text)).toBe(false);
  // 打った文字の途中までしか読めていない
  expect(typedShown(text.slice(0, 40), '', text)).toBe(false);
  // 画面の幅で折り返した
  expect(typedShown(`${text.slice(0, 24)}\n${text.slice(25)}`, '', text)).toBe(true);
  // 先に貼り付けた画像の目印のあとに出た
  expect(typedShown(`[Image #1] ${text}`, '[Image #1]', text)).toBe(true);
  // 複数行は貼り付けとして送るので、目印になる。打つ前から同じ目印だったら、まだ出ていない
  expect(typedShown('[Pasted text #1 +2 lines]', '', '1 行目\n2 行目\n3 行目')).toBe(true);
  expect(typedShown('[Pasted text #1 +2 lines]', '[Pasted text #1 +2 lines]', '1 行目\n2 行目\n3 行目')).toBe(false);
});
