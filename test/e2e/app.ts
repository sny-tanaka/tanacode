import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';
import type { PermissionMode } from '@shared/screen';
import { type HostMessage, PROTOCOL } from '../../src/main/pty-host-protocol';
import { socketPathIn } from '../../src/main/socket-path';
import { type Conversation, MockApi } from '../cli/mock-api';
import { backgroundElectron } from '../../scripts/background-electron';

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
// カードの選択肢が Claude Code に届かなかったときの知らせ（MenuCard）と、そのとき人と同じく押し直す回数の上限（はじめの 1 回を含む）
const NOT_ACCEPTED = 'Claude Code が受け付けませんでした';
const PRESSES = 3;
// カバレッジを集めるか（npm run coverage:e2e）。集めたものは scripts/e2e-coverage.mjs が src の行に戻す
const COVERAGE = process.env.TANACODE_E2E_COVERAGE === '1';
export const COVERAGE_RAW = join(REPO, 'coverage', 'e2e-raw');
// 手元の Mac では、アプリを裏で起動する（TANACODE_BACKGROUND=1。ウインドウを画面に出さない）。前に出すと、起動のたびに
// 作業中のアプリから前面を奪う。画面を見ながら確かめるときは TANACODE_E2E_SHOW=1。CI では、配る形のまま前に出す
// （テストからも読む。前に出して流すときは、別ウインドウなども画面に出るため）
export const BACKGROUND = process.platform === 'darwin' && !process.env.CI && process.env.TANACODE_E2E_SHOW !== '1';
// 裏で起動するときの Electron（ビルドしたアプリを起動するとき）。LSUIElement を足した写しにして、起動の直後も Dock に出さず、前面を奪わない
// （scripts/background-electron.ts）。パッケージした .app（TANACODE_E2E_APP）は写さない
const ELECTRON_BIN = (BACKGROUND && !process.env.TANACODE_E2E_APP ? backgroundElectron(REPO) : null) ?? (createRequire(join(REPO, 'package.json'))('electron') as string);

type Options = {
  // モックの API の台本。作業フォルダのパスを入れるため、フォルダを受け取って返す
  conversations?: (work: string) => Conversation[];
  // ユーザーの設定（~/.claude/settings.json）
  claudeSettings?: Record<string, unknown>;
  // アプリの設定（userData/settings.json）に重ねるもの。既定では通知と更新の確認を切り、言語を日本語にする（画面の文言で確かめるため。CI の Mac は英語）
  appSettings?: Record<string, unknown>;
  // 作業フォルダに置いておくファイル（パス → 中身）
  files?: Record<string, string>;
  // 作業フォルダを git のリポジトリにする（files をはじめのコミットにする）
  git?: boolean;
  // フォルダの信頼の確認を済ませておく
  trusted?: boolean;
  // PATH の先頭に置くコマンド（名前 → スクリプトの中身）。gh など、外とやりとりするコマンドの代わり
  commands?: Record<string, string>;
  // アプリ（と Claude Code）の一時フォルダ（TMPDIR）を、試しのフォルダの中の tmp にする。試しのフォルダは一時フォルダの中にあるので、
  // 一時フォルダの中を扱わないもの（Claude がフォルダの外で読んだもの）を、試しのフォルダの中のファイルで確かめるとき
  ownTmp?: boolean;
  // アプリに足す環境変数（確かめやすくするための切り替え。TANACODE_AWAY_WAIT_SECONDS など）
  env?: Record<string, string>;
};

export class E2EApp {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-e2e-')));
  readonly home = join(this.root, 'home');
  readonly work = join(this.root, 'work');
  readonly userData = join(this.root, 'userData');
  readonly api = new MockApi();
  // 画面（レンダラー）のコンソールに出たエラー
  readonly consoleErrors: string[] = [];
  // 画面のコンソールに出た警告（失敗したときの手がかり。コピーできなかったわけなど、画面がエラーにしないもの）
  private readonly consoleWarnings: string[] = [];
  // メインプロセスの出力（失敗したときの手がかり）
  private readonly output: string[] = [];
  // アプリに渡す環境変数（prepare で決める）
  private env: Record<string, string> = {};
  // choose・pressHolding で押したときに画面に届いたイベントの記録（押した回ごと。keepEvidence に残す）
  private readonly presses: string[][] = [];
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
    if (this.options.ownTmp) mkdirSync(join(this.root, 'tmp'));
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
      JSON.stringify({ version: 1, notifications: false, updateCheck: false, language: 'ja', ...this.options.appSettings }),
    );
    for (const [path, text] of Object.entries(this.options.files ?? {})) {
      mkdirSync(dirname(join(this.work, path)), { recursive: true });
      writeFileSync(join(this.work, path), text);
    }
    if (this.options.git) {
      this.git('init', '-q', '-b', 'main');
      // コミットのあとに git が裏で片付け（gc --auto）を始めると、終わりに一時フォルダを消すのとぶつかるので動かさない
      this.git('config', 'gc.auto', '0');
      this.git('add', '-A');
      this.git('commit', '-qm', 'init', '--allow-empty');
    }
    // 確かめる claude（と、渡されたコマンド）だけを PATH の先頭に置く
    const bin = join(this.root, 'bin');
    mkdirSync(bin);
    execFileSync('ln', ['-s', claudePath(), join(bin, 'claude')]);
    for (const [name, script] of Object.entries(this.options.commands ?? {})) writeFileSync(join(bin, name), script, { mode: 0o755 });
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
      ...(BACKGROUND ? { TANACODE_BACKGROUND: '1' } : {}),
      ...(this.options.ownTmp ? { TMPDIR: `${join(this.root, 'tmp')}/` } : {}),
      ...this.options.env,
      // メインプロセス・pty ホスト・MCP の中継（どれも Node）は、終わるときにカバレッジをここに書く
      ...(COVERAGE ? { NODE_V8_COVERAGE: join(COVERAGE_RAW, 'v8') } : {}),
    };
  }

  // 起動の引数（アプリの外から渡すもの）
  private launchArgs(): string[] {
    // Linux の root ではサンドボックスを使えない。macOS では、Cookie の暗号化の鍵をキーチェーンに取りに行かない（CI で確認が出て止まらないように）
    const platformArgs = process.platform === 'linux' ? ['--no-sandbox'] : process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
    return [...platformArgs, `--user-data-dir=${this.userData}`];
  }

  // 同じ userData で、もう 1 つアプリを起動する（二重起動の確かめ）。終わったときの終了コードを返す。
  // timeoutMs のうちに終わらなければ、止めて null を返す
  async launchAgain(timeoutMs = TIMEOUT_MS): Promise<number | null> {
    const packaged = process.env.TANACODE_E2E_APP;
    const bin = packaged ?? ELECTRON_BIN;
    const child = spawn(bin, packaged ? this.launchArgs() : [...this.launchArgs(), REPO], { cwd: this.root, env: this.env, stdio: 'ignore' });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, timeoutMs);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  // アプリを起動して、最初のウインドウを待つ
  private async start(): Promise<void> {
    const packaged = process.env.TANACODE_E2E_APP;
    // TANACODE_E2E_SCALE: 画面の画素密度を決めて起動する（Chromium の --force-device-scale-factor）。手元の Retina（2）で、CI の Mac（1）と同じ画素密度で確かめるとき
    const scale = process.env.TANACODE_E2E_SCALE;
    const args = [...this.launchArgs(), ...(scale ? [`--force-device-scale-factor=${scale}`] : [])];
    this.electronApp = await electron.launch({
      // ビルドしたアプリは、リポジトリのフォルダを渡して起動する（package.json の main から out/main/index.js を読む。npm run dev と同じ）。
      // out/main/index.js を直に渡すと、アプリのフォルダ（app.getAppPath()）が out/main になり、macOS では開発中のアイコン
      // （build/icon.png）を読めずに起動が止まる
      ...(packaged ? { executablePath: packaged, args } : { executablePath: ELECTRON_BIN, args: [...args, REPO] }),
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
      else if (message.type() === 'warning') this.consoleWarnings.push(message.text());
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

  // アプリを終えて、起動し直す。終了の確認では「動かしたまま終了」を選ぶので、Claude Code は動き続け、次のアプリが引き継ぐ。
  // whileClosed: アプリを閉じている間に待つこと（閉じている間に Claude Code が作業を終えるのを待つなど）
  async restart(whileClosed?: () => Promise<void>): Promise<void> {
    await this.quit(0);
    await whileClosed?.();
    await this.start();
  }

  // アプリが自分で終わるのを待って、起動し直す（Claude が restart_app で頼んだ再起動。アプリは TANACODE_E2E_NO_RELAUNCH=1 で、
  // 終えるだけで起動し直さない。Playwright は自分で起動したアプリしか扱えないため）。whileClosed: 閉じている間に確かめること。
  // 画面のカバレッジは残さない（いつ閉じるかをアプリが決めるので、写す前に閉じることがある）
  async relaunchAfterExit(whileClosed?: () => Promise<void>): Promise<void> {
    const child = this.app.process();
    this.electronApp = null;
    this.window = null;
    await new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())));
    await whileClosed?.();
    await this.start();
  }

  // pty ホストで動いている Claude Code の pid（起動し直したことを確かめるため）
  claudePids(): Promise<number[]> {
    return ptyPids(socketPathIn(this.userData, 'pty-host', 'pty'));
  }

  // pty ホストで動いている Claude Code の、起動の引数（1 つの文字列）。起動し直したときに渡した引数を確かめるため
  async claudeArgs(): Promise<string[]> {
    const pids = await ptyPids(socketPathIn(this.userData, 'pty-host', 'pty'));
    return pids.map((pid) => {
      try {
        return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      } catch {
        // 調べている間に終わった
        return '';
      }
    });
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
  // セッションの一覧（状態・操作待ち）と、選んでいるセッションの Claude Code の画面（ターミナルモードにして読む）・
  // セッションごとのチャットのイベント・stream-json の控え・会話ログ
  async keepEvidence(name: string): Promise<void> {
    mkdirSync(RESULTS, { recursive: true });
    const base = join(RESULTS, name.replace(/[^\p{L}\p{N}_-]+/gu, '-'));
    const page = this.window;
    await page?.screenshot({ path: `${base}.png` }).catch(() => {});
    const sessions = await page
      ?.evaluate(() => (window as unknown as { tanacode: { sessions: { list(): Promise<unknown> } } }).tanacode.sessions.list())
      .catch((error: unknown) => String(error));
    // ターミナルモードのセッションなら、Claude Code の画面も残す（チャットのセッションを切り替えると Claude Code を開き直すので、
    // 切り替えはしない）。落ちたときの手がかりに残すだけで、確かめには使わない（TUI の画面はテストで読まない。決めたこと）
    // 画面の文書にフォーカスがあるか（Clipboard API など、フォーカスの無い文書からは断られるものがある）
    const focused = await page?.evaluate(() => document.hasFocus()).catch((error: unknown) => String(error));
    let screen = '';
    if (page) {
      try {
        const rows = page.locator('.claude-screen .terminal-instance .xterm-rows');
        if ((await rows.count()) > 0) screen = await rows.innerText();
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
        '# 画面のコンソールの警告',
        ...this.consoleWarnings,
        `# 画面の文書にフォーカスがあるか: ${String(focused)}`,
        '# モックの API の呼び出し',
        ...this.api.requests,
        '# セッションの一覧',
        JSON.stringify(sessions, null, 2),
        '# 選んでいるセッションの Claude Code の画面',
        screen,
        '# 押したときに画面に届いたイベント（choose・pressHolding。押した回ごと）',
        ...this.presses.flatMap((lines, i) => [`## ${i + 1} 回目`, ...lines]),
      ].join('\n'),
    );
    // セッションごとに、main が画面に配ったチャットのイベント（sessions.snapshot。何も変えない）。stream の行と会話ログの行が
    // どの順でチャットに並んだか（ターンの終わりと発言の前後など）を、あとで確かめるため
    const events = await page
      ?.evaluate(async () => {
        const api = (window as unknown as { tanacode: { sessions: { list(): Promise<{ id: string }[]>; snapshot(id: string): Promise<unknown> } } }).tanacode.sessions;
        const list = await api.list();
        return Object.fromEntries(await Promise.all(list.map(async (s) => [s.id, await api.snapshot(s.id)])));
      })
      .catch((error: unknown) => String(error));
    if (events !== undefined) writeFileSync(`${base}.events.json`, JSON.stringify(events, null, 2));
    // stream-json の送受信の控え（userData の stream-logs）と、Claude Code の会話ログ（HOME の .claude/projects）の写し。
    // close() は使い捨てのフォルダごと消すので、ここで写しておく
    copyMatching(this.userData, (path) => path.split(sep).includes('stream-logs') && path.endsWith('.log'), `${base}.stream`);
    copyMatching(join(this.home, '.claude', 'projects'), (path) => path.endsWith('.jsonl'), `${base}.transcript`);
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

  // 新しいセッションを、作業フォルダで始める（最初の指示を送る）。mode: 新規セッションの画面で選ぶ権限モード /
  // asParent: 「親として始める」を選ぶ（作業フォルダに TANACODE_PARENT.md を置いておく）
  async startSession(prompt: string, { mode, asParent = false }: { mode?: PermissionMode; asParent?: boolean } = {}): Promise<void> {
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
    if (asParent) await page.getByRole('checkbox', { name: '親として始める' }).check();
    // Remote Control は使わない（パッケージしたアプリでは既定でオン。モックの API ではつながらない）
    const remote = page.locator('.claude-header [role="switch"][aria-label="Remote Control"]');
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

  // チャットに出たカード（permission は許可の確認・プランの承認、question は質問）
  async menuCard(kind: 'permission' | 'question'): Promise<Locator> {
    const card = this.page.locator(`.chat-list .menu-card.${kind}`);
    await card.waitFor();
    return card;
  }

  // カードの選択肢を選んで、カードが閉じるのを待つ。カードに「受け付けませんでした」と出たときだけ、人と同じく押し直す
  // （黙って何度も押し直すことはしない）。それ以外の知らせが出たら、失敗にする。
  // 押したクリックが選択肢に届いたかは、押す間に画面に届いたイベントで確かめる。Playwright の click は、画面にイベントが 1 つも
  // 届かなくても、押し始め（pointerdown）だけが選択肢に当たって離した所が外れても、成功で返す。届かなかったら、閉じるのを待たずに失敗にする
  async choose(card: Locator, option: string | RegExp): Promise<void> {
    const handle = await card.elementHandle();
    for (let attempt = 1; ; attempt++) {
      const button = card.locator('.menu-option', { hasText: option }).first();
      const press = await this.recordPress(button, () => button.click());
      if (!press.reached) throw new Error(`カードの選択肢にクリックが届きませんでした（${attempt} 回目）\n${press.lines.join('\n')}`);
      const outcome = await this.page.waitForFunction(
        (element) => (!element?.isConnected ? 'closed' : (element.querySelector('.menu-card-error')?.textContent ?? false)),
        handle,
      );
      const result = await outcome.jsonValue();
      if (result === 'closed') return;
      if (!String(result).includes(NOT_ACCEPTED) || attempt >= PRESSES) throw new Error(`カードで選べません（${attempt} 回目）: ${String(result)}`);
    }
  }

  // target を押す。押したクリックが target に届かなければ、押す間に画面に届いたイベントを添えて失敗にする（押し直さない）。
  // カードを閉じない押し方（フォームの入力の誤りを出すなど）に使う。閉じるものは choose
  async press(target: Locator): Promise<void> {
    const press = await this.recordPress(target, () => target.click());
    if (!press.reached) throw new Error(`クリックが届きませんでした\n${press.lines.join('\n')}`);
  }

  // 画面を 2 回描かせる。直前の変化（中身の大きさが変わって、チャットの一覧が最下部へ追いかけるなど）を、押す前に描き終えさせる
  async rendered(): Promise<void> {
    await this.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }

  // target の真ん中を押し、離す前に during を動かしてから離す（押して離す間に画面が変わったときの確かめ）。
  // 離したクリックが target に届いたかと、押す間に画面に届いたイベントの記録を返す。
  // 押す前に hover で、位置が止まって押せるのを確かめてから、真ん中にマウスを置く（click と同じ確かめ）。target は見えているものに限る。
  // hover にはスクロールさせない（scroll: 'none'。人と同じく、見えている所を押す）。hover は位置が止まっていないと確かめ直し、そのときは
  // 見えている要素でもスクロールで送ってから位置を測る（Playwright 1.64 は 2 回目に block: 'end'）。チャットの一覧は、人の操作でない上への
  // スクロールを最下部へ戻すので、マウスは送った先の位置（target の下）に残り、そこを押してしまう（CI で、カードの選択肢の 200px 下を押した）。
  // click は、押した所に target が無ければ確かめ直すが、ここでは hover と押すのを分けているので、その確かめが効かない
  async pressHolding(target: Locator, during: () => Promise<void>): Promise<{ reached: boolean; lines: string[] }> {
    return this.recordPress(target, async () => {
      await target.hover({ scroll: 'none' });
      await this.page.mouse.down();
      await during();
      await this.page.mouse.up();
    });
  }

  // target を押す（press）間に、画面に届いたマウスのイベント（pointerdown・pointerup・mousedown・mouseup・click）を capture で記録する。
  // 種類・届いた要素・位置と、そのときの target の位置・チャットの一覧のスクロール。reached: click が target（の中）に届いた。
  // 記録は keepEvidence にも残す（落ちたときに、押した所からカードが動いたのか、画面にイベントが届かなかったのかを見分けるため）
  private async recordPress(target: Locator, press: () => Promise<void>): Promise<{ reached: boolean; lines: string[] }> {
    const element = await target.elementHandle();
    await this.page.evaluate((el) => {
      type Entry = Record<string, string | number | boolean>;
      const w = window as unknown as { __e2ePress?: { entries: Entry[]; stop: () => void } };
      w.__e2ePress?.stop();
      const entries: Entry[] = [];
      const rect = () => {
        const r = el?.getBoundingClientRect();
        return r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : '-';
      };
      const list = () => {
        const l = document.querySelector('.chat-list');
        return l ? `${Math.round(l.scrollTop)}/${l.scrollHeight}/${l.clientHeight}` : '-';
      };
      const describe = (node: EventTarget | null) => {
        if (!(node instanceof Element)) return String(node);
        const classes = [...node.classList].slice(0, 2).join('.');
        return `${node.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`;
      };
      const snapshot = (type: string, e?: MouseEvent): Entry => ({
        t: Math.round(performance.now()),
        type,
        ...(e ? { target: describe(e.target), inTarget: !!el && e.target instanceof Node && el.contains(e.target), at: `${e.clientX},${e.clientY}`, trusted: e.isTrusted } : {}),
        rect: rect(),
        connected: !!el?.isConnected,
        list: list(),
      });
      const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'];
      const listener = (e: Event) => entries.push(snapshot(e.type, e as MouseEvent));
      for (const type of types) window.addEventListener(type, listener, true);
      // チャットの一覧が押している間に動いたとき、いつ・どれだけ動いたか（スクロールは泡立たないので、捕まえる側で受ける）。
      // 一覧の子の数も残す（描き直しで一覧が作り直されたかを見分ける）
      const scrolled = (e: Event) => {
        if (!(e.target instanceof Element) || !e.target.classList.contains('chat-list')) return;
        entries.push({ ...snapshot('scroll'), children: e.target.childElementCount });
      };
      document.addEventListener('scroll', scrolled, true);
      entries.push(snapshot('start'));
      w.__e2ePress = {
        entries,
        stop: () => {
          types.forEach((type) => window.removeEventListener(type, listener, true));
          document.removeEventListener('scroll', scrolled, true);
        },
      };
    }, element);
    let entries: Record<string, string | number | boolean>[] = [];
    try {
      await press();
    } finally {
      entries = await this.page
        .evaluate(() => {
          const w = window as unknown as { __e2ePress?: { entries: Record<string, string | number | boolean>[]; stop: () => void } };
          w.__e2ePress?.stop();
          const found = w.__e2ePress?.entries ?? [];
          w.__e2ePress = undefined;
          return found;
        })
        .catch(() => []);
      this.presses.push(entries.map((entry) => Object.entries(entry).map(([key, value]) => `${key}=${value}`).join(' ')));
    }
    return { reached: entries.some((entry) => entry.type === 'click' && entry.inTarget === true), lines: this.presses.at(-1) ?? [] };
  }
}

// 画面（と、画面の側で動く preload）のカバレッジを coverage/e2e-raw/renderer-*.json に書く（アプリのスクリプトの分だけ。中身は手元の out/ から読むので残さない）
async function saveRendererCoverage(page: Page): Promise<void> {
  const entries = await page.coverage.stopJSCoverage().catch(() => []);
  const scripts = entries.filter((e) => /\/out\/(renderer|preload)\//.test(e.url)).map(({ url, functions }) => ({ url, functions }));
  mkdirSync(COVERAGE_RAW, { recursive: true });
  writeFileSync(join(COVERAGE_RAW, `renderer-${randomUUID()}.json`), JSON.stringify(scripts));
}

// root の下（入れ子も）の、match に合うファイルを、prefix-<root からのパス（/ は _ に）> に写す。root が無ければ何もしない
function copyMatching(root: string, match: (path: string) => boolean, prefix: string): void {
  let paths: string[];
  try {
    paths = readdirSync(root, { recursive: true, encoding: 'utf8' });
  } catch {
    return;
  }
  for (const path of paths.filter(match)) {
    try {
      copyFileSync(join(root, path), `${prefix}-${path.replaceAll(sep, '_')}`);
    } catch {
      // 写している間に消えた
    }
  }
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
        if (message.t === 'list') finish(message.hosted.filter((p) => p.exitCode === null).map((p) => p.pid));
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
