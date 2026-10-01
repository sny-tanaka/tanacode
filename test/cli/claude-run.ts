import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import * as pty from 'node-pty';
import { ASK_FILE_ENV, isTranscriptEntry, type TranscriptEntry } from '@shared/chat';
import type { ScreenInfo, ScreenLine } from '@shared/screen';
import { claudeArgs, transcriptPath } from '../../src/main/claude-session';
import { askQuestionsOf } from '../../src/main/screen-parser';
import { ScreenTracker } from '../../src/main/screen-tracker';
import { STATUS_FILE_ENV } from '../../src/main/statusline';
import { TranscriptTail } from '../../src/main/transcript-tail';
import { FIXTURE_ROOT, type ScreenName } from '../scenario';

// アプリと同じ端末の大きさ（Claude Code のタブを開いていないとき）
const COLS = 120;
const ROWS = 40;
// API キーでログインしたことにする（モックの API にしか送らない）
const API_KEY = 'sk-ant-api03-tanacode-cli-check-00000000000000000000';

// 控えの会話ログに残さない行（attachment の type）。システムプロンプトの全文やツール・スキルの一覧、
// 動かした環境ごとの情報で、アプリは読まない
const DROPPED_ATTACHMENTS = ['prompt_snapshot', 'skill_listing', 'agent_listing_delta', 'remote_session_change'];

// 確かめる claude。TANACODE_CLAUDE_BIN が無ければ PATH の claude
export const CLAUDE_BIN = process.env.TANACODE_CLAUDE_BIN || 'claude';

export function claudeVersion(): string {
  return execFileSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)?.[0] ?? '';
}

// 本物の claude を pty で起動し、アプリと同じ部品（ScreenTracker・TranscriptTail）で読む。
// HOME は使い捨てのフォルダにするので、ふだんの ~/.claude には触らない
export class ClaudeRun {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-cli-')));
  readonly home = join(this.root, 'home');
  readonly cwd = join(this.root, 'work');
  readonly claudeSessionId = randomUUID();
  readonly statusFile = join(this.root, 'status.json');
  readonly askFile = join(this.root, 'ask.json');
  readonly entries: TranscriptEntry[] = [];
  private readonly screens = new Map<ScreenName, ScreenLine[]>();
  readonly screen: ScreenTracker;
  private readonly term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  private proc: pty.IPty | null = null;
  private tail: TranscriptTail | null = null;
  private askToolId: string | null = null;
  private exited: number | null = null;
  private readonly oldHome = process.env.HOME;

  constructor(private readonly baseUrl: string) {
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
    // 最初の案内（テーマの選択）・API キーの確認・フォルダの信頼の確認は済んだことにする
    writeFileSync(
      join(this.home, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        theme: 'dark',
        customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
        projects: { [this.cwd]: { hasTrustDialogAccepted: true } },
      }),
    );
    this.screen = new ScreenTracker(COLS, ROWS, (data) => this.proc?.write(data), () => {});
  }

  start(): void {
    // sessionSettings（ユーザーの statusLine を探す）と transcriptPath は homedir() を見るので、このプロセスの HOME も差し替える
    process.env.HOME = this.home;
    const args = claudeArgs({
      claudeSessionId: this.claudeSessionId,
      resume: false,
      remoteControlName: null,
      model: null,
      effort: null,
      // 許可の確認を出させる（API キーでは既定が auto になり、確認が出ない）
      permissionMode: 'manual',
    });
    // 環境変数は最小限にする（Claude Code の中から動かしたときの子セッションの印などを持ち込まない）
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: this.home,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ANTHROPIC_BASE_URL: this.baseUrl,
      ANTHROPIC_API_KEY: API_KEY,
      NO_PROXY: '127.0.0.1,localhost',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      [STATUS_FILE_ENV]: this.statusFile,
      [ASK_FILE_ENV]: this.askFile,
    };
    this.proc = pty.spawn(CLAUDE_BIN, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: this.cwd, env });
    this.proc.onData((data) => {
      this.term.write(data);
      this.screen.feed(data);
    });
    this.proc.onExit(({ exitCode }) => (this.exited = exitCode));
    this.tail = new TranscriptTail(transcriptPath(this.cwd, this.claudeSessionId), (entry) => this.onEntry(entry));
    this.tail.start();
  }

  // session-manager と同じく、会話ログの AskUserQuestion で質問を渡し、答えが書かれたら閉じる
  private onEntry(entry: unknown): void {
    if (!isTranscriptEntry(entry)) return;
    this.entries.push(entry);
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.id) {
        this.askToolId = block.id;
        this.screen.setQuestions(askQuestionsOf(block.input));
      }
      if (block.type === 'tool_result' && block.tool_use_id && block.tool_use_id === this.askToolId) {
        this.askToolId = null;
        this.screen.setQuestions(null);
      }
    }
  }

  // フックが書いた AskUserQuestion の入力（statusline.ts の StatusLineWatcher と同じ読み方）
  askInput(): unknown {
    try {
      return (JSON.parse(readFileSync(this.askFile, 'utf8')) as { tool_input?: unknown }).tool_input;
    } catch {
      return null;
    }
  }

  statusLineText(): string | null {
    return readOrNull(this.statusFile);
  }

  type(text: string): void {
    this.proc?.write(text);
  }

  // メニューで選ぶ。Claude Code は許可の確認を出した直後の入力を受け付けない（うっかり押しを防ぐ）ので、
  // 人が読んでから押すのと同じく少し待ち、メニューが閉じなければもう一度送る
  async answer(title: string, optionId: string): Promise<void> {
    const shown = () => {
      const state = this.screen.current.state;
      return state.kind === 'menu' && state.menu.title === title;
    };
    for (let attempt = 0; attempt < 3 && shown(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await this.screen.choose(optionId, 'enter');
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (shown()) throw new Error(`「${title}」で選んでもメニューが閉じません\n${this.dump()}`);
  }

  // 条件が満たされるまで待つ。時間切れのときは、そのときの画面を付けて失敗させる
  async waitFor<T>(label: string, check: (info: ScreenInfo) => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const value = check(this.screen.current);
      if (value) return value;
      if (this.exited !== null) throw new Error(`${label}: claude が終了しました（${this.exited}）\n${this.dump()}`);
      if (Date.now() > until) throw new Error(`${label}: 時間切れ\n状態: ${JSON.stringify(this.screen.current)}\n${this.dump()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // 今の画面を控えとして取っておく（ScreenTracker と同じ形の行）
  capture(name: ScreenName): void {
    this.screens.set(name, this.lines());
  }

  // 取っておいた画面と、会話ログ・statusLine・フックが書いた質問を dir に書き出す。
  // 使い捨てのフォルダのパスは、決まったパス（FIXTURE_ROOT）に置き換える。
  // 途中で失敗したときは、そこまでにできたものだけを書く（失敗の手がかりにする）
  record(dir: string): void {
    // 会話ログのフォルダ名（パスの英数字以外を - にしたもの）も置き換える
    const dashed = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');
    const fixed = (text: string) => text.replaceAll(this.root, FIXTURE_ROOT).replaceAll(dashed(this.root), dashed(FIXTURE_ROOT));
    mkdirSync(join(dir, 'screens'), { recursive: true });
    for (const [name, lines] of this.screens) writeFileSync(join(dir, 'screens', `${name}.json`), fixed(`${JSON.stringify(lines, null, 1)}\n`));
    const transcript = readOrNull(transcriptPath(this.cwd, this.claudeSessionId))
      ?.split('\n')
      .filter((line) => line && !DROPPED_ATTACHMENTS.includes((JSON.parse(line) as TranscriptEntry).attachment?.type as string))
      .join('\n');
    const files = { 'transcript.jsonl': transcript && `${transcript}\n`, 'statusline.json': this.statusLineText(), 'ask.json': readOrNull(this.askFile) };
    for (const [name, text] of Object.entries(files)) if (text) writeFileSync(join(dir, name), fixed(text));
  }

  private lines(): ScreenLine[] {
    const buf = this.term.buffer.active;
    const lines: ScreenLine[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push({ text: line?.translateToString(true) ?? '', full: !!line && (line.getCell(this.term.cols - 1)?.getChars() ?? '') !== '' });
    }
    return lines;
  }

  // 今の画面の文字（失敗したときの手がかり）
  dump(): string {
    const rows = this.lines().map((l) => l.text);
    return `---- 画面 ----\n${rows.join('\n').replace(/\n+$/, '')}\n--------------`;
  }

  stop(): void {
    this.tail?.stop();
    this.proc?.kill();
    this.screen.dispose();
    this.term.dispose();
    process.env.HOME = this.oldHome;
    rmSync(this.root, { recursive: true, force: true });
  }
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
