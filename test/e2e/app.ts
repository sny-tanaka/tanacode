import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';
import type { PermissionMode } from '@shared/screen';
import { type HostMessage, PROTOCOL } from '../../src/main/pty-host-protocol';
import { socketPathIn } from '../../src/main/socket-path';
import { type Conversation, MockApi } from '../cli/mock-api';

// アプリ本体を通しで動かす（E2E）。ビルドしたアプリ（out/）か、パッケージした .app（TANACODE_E2E_APP）を Playwright で起動し、
// 画面を人と同じように操作する。claude は本物（TANACODE_CLAUDE_BIN、無ければ PATH の claude）で、API はモック（test/cli/mock-api.ts）。
// userData と HOME は使い捨てのフォルダにするので、ふだんのアプリの設定や ~/.claude には触らない

const REPO = resolve(__dirname, '..', '..');
// API キーでログインしたことにする（モックの API にしか送らない）
const API_KEY = 'sk-ant-api03-tanacode-e2e-check-00000000000000000000';
// 失敗したときの画面の写しと記録を置く場所
export const RESULTS = join(REPO, 'test-results', 'e2e');
// 画面の操作・表示を待つ時間の上限（claude の起動とモックの API の応答を含む）
const TIMEOUT_MS = 30_000;
// カバレッジを集めるか（npm run coverage:e2e）。集めたものは scripts/e2e-coverage.mjs が src の行に戻す
const COVERAGE = process.env.TANACODE_E2E_COVERAGE === '1';
export const COVERAGE_RAW = join(REPO, 'coverage', 'e2e-raw');

type Options = {
  // モックの API の台本。作業フォルダのパスを入れるため、フォルダを受け取って返す
  conversations?: (work: string) => Conversation[];
  // ユーザーの設定（~/.claude/settings.json）
  claudeSettings?: Record<string, unknown>;
  // アプリの設定（userData/settings.json）に重ねるもの。既定では通知と更新の確認を切る
  appSettings?: Record<string, unknown>;
  // 作業フォルダに置いておくファイル（パス → 中身）
  files?: Record<string, string>;
  // 作業フォルダを git のリポジトリにする（files をはじめのコミットにする）
  git?: boolean;
  // フォルダの信頼の確認を済ませておく
  trusted?: boolean;
};

export class E2EApp {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-e2e-')));
  readonly home = join(this.root, 'home');
  readonly work = join(this.root, 'work');
  readonly userData = join(this.root, 'userData');
  readonly api = new MockApi();
  // 画面（レンダラー）のコンソールに出たエラー
  readonly consoleErrors: string[] = [];
  // メインプロセスの出力（失敗したときの手がかり）
  private readonly output: string[] = [];
  // アプリに渡す環境変数（prepare で決める）
  private env: Record<string, string> = {};
  private electronApp: ElectronApplication | null = null;
  private window: Page | null = null;

  private constructor(private readonly options: Options) {}

  static async launch(options: Options = {}): Promise<E2EApp> {
    const app = new E2EApp(options);
    await app.prepare();
    await app.start();
    return app;
  }

  get app(): ElectronApplication {
    if (!this.electronApp) throw new Error('アプリを起動していません');
    return this.electronApp;
  }

  get page(): Page {
    if (!this.window) throw new Error('アプリを起動していません');
    return this.window;
  }

  private async prepare(): Promise<void> {
    const baseUrl = await this.api.start();
    this.api.conversations = this.options.conversations?.(this.work) ?? [];
    mkdirSync(join(this.home, '.claude'), { recursive: true });
    mkdirSync(this.work, { recursive: true });
    mkdirSync(this.userData, { recursive: true });
    // 最初の案内（テーマの選択）と API キーの確認は済んだことにする
    writeFileSync(
      join(this.home, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        theme: 'dark',
        customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
        ...(this.options.trusted ? { projects: { [this.work]: { hasTrustDialogAccepted: true } } } : {}),
      }),
    );
    // アプリの画面からコミットするときの名前（HOME を差し替えるので、ふだんの ~/.gitconfig は読まれない）
    writeFileSync(join(this.home, '.gitconfig'), '[user]\n\tname = tanacode\n\temail = tanacode@localhost\n');
    if (this.options.claudeSettings) writeFileSync(join(this.home, '.claude', 'settings.json'), JSON.stringify(this.options.claudeSettings));
    writeFileSync(
      join(this.userData, 'settings.json'),
      JSON.stringify({ version: 1, notifications: false, updateCheck: false, ...this.options.appSettings }),
    );
    for (const [path, text] of Object.entries(this.options.files ?? {})) {
      mkdirSync(dirname(join(this.work, path)), { recursive: true });
      writeFileSync(join(this.work, path), text);
    }
    if (this.options.git) {
      this.git('init', '-q', '-b', 'main');
      this.git('add', '-A');
      this.git('commit', '-qm', 'init', '--allow-empty');
    }
    // 確かめる claude だけを PATH の先頭に置く
    const bin = join(this.root, 'bin');
    mkdirSync(bin);
    execFileSync('ln', ['-s', claudePath(), join(bin, 'claude')]);
    const path = `${bin}:${process.env.PATH ?? ''}`;
    // パッケージしたアプリは、ログインシェルの PATH を使う（useLoginShellPath）。そのシェルにも同じ PATH を渡す
    writeFileSync(join(this.home, '.zshrc'), `export PATH=${JSON.stringify(path)}\n`);
    this.env = {
      ...inherited(),
      HOME: this.home,
      PATH: path,
      SHELL: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: API_KEY,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // メインプロセス・pty ホスト・MCP の中継（どれも Node）は、終わるときにカバレッジをここに書く
      ...(COVERAGE ? { NODE_V8_COVERAGE: join(COVERAGE_RAW, 'v8') } : {}),
    };
  }

  // アプリを起動して、最初のウインドウを待つ
  private async start(): Promise<void> {
    const packaged = process.env.TANACODE_E2E_APP;
    // Linux の root ではサンドボックスを使えない。macOS では、Cookie の暗号化の鍵をキーチェーンに取りに行かない（CI で確認が出て止まらないように）
    const platformArgs = process.platform === 'linux' ? ['--no-sandbox'] : process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
    const args = [...platformArgs, `--user-data-dir=${this.userData}`];
    this.electronApp = await electron.launch({
      // ビルドしたアプリは、リポジトリのフォルダを渡して起動する（package.json の main から out/main/index.js を読む。npm run dev と同じ）。
      // out/main/index.js を直に渡すと、アプリのフォルダ（app.getAppPath()）が out/main になり、macOS では開発中のアイコン
      // （build/icon.png）を読めずに起動が止まる
      ...(packaged ? { executablePath: packaged, args } : { args: [...args, REPO] }),
      cwd: this.root,
      env: this.env,
      timeout: TIMEOUT_MS,
    });
    const child = this.electronApp.process();
    child.stdout?.on('data', (chunk: Buffer) => this.output.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => this.output.push(chunk.toString()));
    this.window = await this.electronApp.firstWindow({ timeout: TIMEOUT_MS }).catch((error: unknown) => {
      // ウインドウが出ないと keepEvidence も画面を写せないので、メインプロセスの出力をエラーに付け、記録にも残す
      // pty ホストを起動できないと、メインプロセスはエラーのダイアログを出したまま止まる。その理由は pty-host.log にある
      const ptyLog = readFileIfAny(join(this.userData, 'pty-host.log'));
      const output = `${this.output.join('')}${ptyLog ? `\n# pty-host.log\n${ptyLog}` : ''}`;
      mkdirSync(RESULTS, { recursive: true });
      writeFileSync(join(RESULTS, `launch-failed-${randomUUID()}.log`), output);
      throw new Error(`${String(error)}\n# メインプロセスの出力（終わりの 4000 文字）\n${output.slice(-4000)}`);
    });
    this.window.setDefaultTimeout(TIMEOUT_MS);
    this.window.on('console', (message) => {
      if (message.type() === 'error') this.consoleErrors.push(message.text());
    });
    this.window.on('pageerror', (error) => this.consoleErrors.push(String(error)));
    if (COVERAGE) {
      // 画面のカバレッジは、測り始めてから読み込んだスクリプトの分だけ取れる。測り始めてから読み込み直す
      await this.window.coverage.startJSCoverage({ resetOnNavigation: false });
      await this.window.reload();
      // MCP の中継は、Claude Code が終わるときにシグナルで止められ、そのままではカバレッジを書かない。
      // 受けたら process.exit で終えるスクリプト（coverage-exit.cjs）を読み込ませる。Playwright は起動するアプリに
      // NODE_OPTIONS を渡さないので、メインプロセスの環境変数に足す（Claude Code はこれを引き継いで起動し、中継に渡す）
      await this.electronApp.evaluate((_, options) => {
        process.env.NODE_OPTIONS = options;
      }, `--require ${JSON.stringify(join(__dirname, 'coverage-exit.cjs'))}`);
    }
    await this.window.waitForSelector('nav.sidebar');
    // フォルダを選ぶダイアログは、作業フォルダを選んだことにする
    await this.electronApp.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, this.work);
  }

  // アプリを終えて、起動し直す。終了の確認では「動かしたまま終了」を選ぶので、Claude Code は動き続け、次のアプリが引き継ぐ
  async restart(): Promise<void> {
    await this.quit(0);
    await this.start();
  }

  // 終了する。Claude Code と pty ホストも止める（終了の確認では「Claude Code も止めて終了」を選ぶ）
  async close(): Promise<void> {
    const socketPath = socketPathIn(this.userData, 'pty-host', 'pty');
    // 止めた claude は、終わるときに ~/.claude に書き込む。終わったのを確かめてから消すため、先に pid を聞いておく
    const pids = await ptyPids(socketPath);
    if (this.electronApp) await this.quit(1).catch(() => {});
    // 終了の確認を通らなかったときも、pty ホスト（と、その中の claude）を残さない
    await shutdownPtyHost(socketPath);
    await waitGone(pids);
    await this.api.stop();
    rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  // 終了の確認で response 番目のボタンを選んだことにして、アプリを終える。
  // 終わるのは、プロセスが終わったことで確かめる（Playwright の close は、標準出力などがすべて閉じるのを待つ。
  // Linux では、アプリの記述子を引き継いだ pty ホストが動き続けるので、Claude Code を動かしたまま終えると戻ってこない）
  private async quit(response: number): Promise<void> {
    const app = this.app;
    const page = this.window;
    this.electronApp = null;
    this.window = null;
    if (COVERAGE && page) await saveRendererCoverage(page);
    const child = app.process();
    const exited = new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())));
    await app
      .evaluate(({ dialog }, button) => {
        dialog.showMessageBox = (async () => ({ response: button, checkboxChecked: false })) as typeof dialog.showMessageBox;
      }, response)
      .catch(() => {});
    void app.close().catch(() => {});
    await exited;
  }

  // 失敗したときの手がかりを test-results/e2e に残す。画面の写し・メインプロセスの出力・モックの API の呼び出し・
  // セッションの一覧（状態・操作待ち）と、選んでいるセッションの Claude Code の画面（ターミナルのパネルを開いて読む）
  async keepEvidence(name: string): Promise<void> {
    mkdirSync(RESULTS, { recursive: true });
    const base = join(RESULTS, name.replace(/[^\p{L}\p{N}_-]+/gu, '-'));
    const page = this.window;
    await page?.screenshot({ path: `${base}.png` }).catch(() => {});
    const sessions = await page
      ?.evaluate(() => (window as unknown as { tanacode: { sessions: { list(): Promise<unknown> } } }).tanacode.sessions.list())
      .catch((error: unknown) => String(error));
    let screen = '';
    if (page) {
      try {
        const button = page.locator('.claude-header [aria-label="Claude Code の画面"]');
        if ((await button.count()) > 0) {
          if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click({ timeout: 2000 });
          const rows = page.locator('.terminal-panel .terminal-instance:not([hidden]) .xterm-rows');
          await rows.waitFor({ timeout: 3000 });
          await page.waitForTimeout(500);
          screen = await rows.innerText();
          await page.screenshot({ path: `${base}-screen.png` });
        }
      } catch (error) {
        screen = `（読めませんでした: ${String(error)}）`;
      }
    }
    writeFileSync(
      `${base}.log`,
      [
        '# メインプロセスの出力',
        this.output.join(''),
        '# 画面のコンソールのエラー',
        ...this.consoleErrors,
        '# モックの API の呼び出し',
        ...this.api.requests,
        '# セッションの一覧',
        JSON.stringify(sessions, null, 2),
        '# 選んでいるセッションの Claude Code の画面',
        screen,
      ].join('\n'),
    );
  }

  // --- 画面の操作 ---

  // 作業フォルダで git を動かして、出力を返す
  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.work, encoding: 'utf8', env: { ...process.env, HOME: this.home } });
  }

  // テストの側の条件（モックの API が受け取ったものなど）がそろうのを待つ
  async waitUntil(what: string, check: () => boolean, timeoutMs = TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`${what}のを待ちましたが、${timeoutMs / 1000} 秒たっても来ません`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // 文字を含む要素
  byText(selector: string, text: string | RegExp): Locator {
    return this.page.locator(selector, { hasText: text });
  }

  // 新しいセッションを、作業フォルダで始める（最初の指示を送る）。mode: 新規セッションの画面で選ぶ権限モード
  async startSession(prompt: string, { mode }: { mode?: PermissionMode } = {}): Promise<void> {
    const page = this.page;
    await page.click('nav.sidebar .new-session-button');
    // 最近のフォルダがあればメニューが開くので「別のフォルダを選ぶ…」を押す。無ければすぐにダイアログを開く
    const chip = page.locator('.new-session-chips .folder-picker > button.new-session-chip');
    const chosen = page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${this.work}"]`);
    const other = this.byText('.folder-menu-item', '別のフォルダを選ぶ…');
    await chip.click();
    await chosen.or(other).first().waitFor();
    if (await other.isVisible()) await other.click();
    await chosen.waitFor();
    if (mode) await page.selectOption('.chat-options select[title^="権限モード"]', mode);
    // Remote Control は使わない（パッケージしたアプリでは既定でオン。モックの API ではつながらない）
    const remote = page.locator('.claude-header [role="switch"]');
    if ((await remote.count()) > 0 && (await remote.getAttribute('aria-checked')) === 'true') await remote.click();
    await this.send(prompt);
  }

  // 入力欄から送る
  async send(text: string): Promise<void> {
    await this.page.fill('.chat-input textarea', text);
    await this.page.click('.chat-input-row [aria-label="送信"]');
  }

  // 差分の画面（変更後の側）で、text を含む行にコメントを書き始める。行番号の横（グリフの余白）を押す。
  // Monaco は描き直すと行の要素を作り直すので、位置が取れてコメント欄が開くまで繰り返す
  async startComment(text: string): Promise<void> {
    const editor = this.page.locator('.diff-pane .modified-in-monaco-diff-editor');
    const draft = this.page.locator('.comment-box.draft textarea');
    for (let i = 0; i < 20; i++) {
      const glyph = await editor.locator('.glyph-margin').boundingBox().catch(() => null);
      const row = await editor.locator('.view-line', { hasText: text }).boundingBox().catch(() => null);
      if (glyph && row) {
        const y = row.y + row.height / 2;
        await this.page.mouse.move(row.x + 40, y);
        await this.page.mouse.click(glyph.x + glyph.width / 2, y);
        if (await draft.waitFor({ timeout: 1000 }).then(() => true, () => false)) return;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(`「${text}」の行にコメントを書き始められません`);
  }

  // チャットに出たメニューのカード（kind: other は信頼の確認など、permission は許可の確認、question は質問）
  async menuCard(kind: 'permission' | 'question' | 'other'): Promise<Locator> {
    const card = this.page.locator(`.chat-list .menu-card.${kind}`);
    await card.waitFor();
    return card;
  }

  // カードの選択肢を選んで、カードが閉じるのを待つ
  async choose(card: Locator, option: string | RegExp): Promise<void> {
    const handle = await card.elementHandle();
    await card.locator('.menu-option', { hasText: option }).first().click();
    await this.page.waitForFunction((element) => !element?.isConnected, handle);
  }
}

// 画面（と、画面の側で動く preload）のカバレッジを coverage/e2e-raw/renderer-*.json に書く（アプリのスクリプトの分だけ。中身は手元の out/ から読むので残さない）
async function saveRendererCoverage(page: Page): Promise<void> {
  const entries = await page.coverage.stopJSCoverage().catch(() => []);
  const scripts = entries.filter((e) => /\/out\/(renderer|preload)\//.test(e.url)).map(({ url, functions }) => ({ url, functions }));
  mkdirSync(COVERAGE_RAW, { recursive: true });
  writeFileSync(join(COVERAGE_RAW, `renderer-${randomUUID()}.json`), JSON.stringify(scripts));
}

// ファイルがあれば中身。無ければ空
function readFileIfAny(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// 確かめる claude のパス
function claudePath(): string {
  const bin = process.env.TANACODE_CLAUDE_BIN || 'claude';
  if (bin.includes('/')) return resolve(bin);
  return execFileSync('which', [bin], { encoding: 'utf8' }).trim();
}

// アプリに渡す環境変数。Claude Code の中から動かしたときの印・ログインの情報などは持ち込まない
function inherited(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(ANTHROPIC_|CLAUDE_|CLAUDECODE|ELECTRON_|TANACODE_)/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

// pty ホストが持っている pty（claude）の pid。ホストがいなければ空
function ptyPids(socketPath: string): Promise<number[]> {
  return new Promise((done) => {
    const socket = connect(socketPath);
    let buffered = '';
    const finish = (pids: number[]) => {
      socket.destroy();
      done(pids);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => finish([]));
    socket.on('error', () => finish([]));
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      for (const line of buffered.split('\n').slice(0, -1)) {
        const message = JSON.parse(line) as HostMessage;
        if (message.t === 'list') finish(message.ptys.filter((p) => p.exitCode === null).map((p) => p.pid));
      }
      buffered = buffered.slice(buffered.lastIndexOf('\n') + 1);
    });
    socket.on('connect', () => socket.write(`${JSON.stringify({ t: 'hello', protocol: PROTOCOL })}\n${JSON.stringify({ t: 'list', req: 1 })}\n`));
  });
}

// プロセスが終わるのを待つ（最大 10 秒）
async function waitGone(pids: number[]): Promise<void> {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 10_000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
}

// pty ホストに、すべての pty を止めて終わるよう頼む。ホストがいなければ何もしない
function shutdownPtyHost(socketPath: string): Promise<void> {
  return new Promise((done) => {
    const socket = connect(socketPath);
    const finish = () => {
      socket.destroy();
      done();
    };
    socket.setTimeout(2000, finish);
    socket.on('error', finish);
    socket.on('close', finish);
    socket.on('connect', () => socket.end(`${JSON.stringify({ t: 'shutdown' })}\n`));
  });
}
