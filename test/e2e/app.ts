import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';
import type { PermissionMode } from '@shared/screen';
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
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=tanacode', '-c', 'user.email=tanacode@localhost', ...args], { cwd: this.work, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git('commit', '-qm', 'init', '--allow-empty');
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
    };
  }

  // アプリを起動して、最初のウインドウを待つ
  private async start(): Promise<void> {
    const packaged = process.env.TANACODE_E2E_APP;
    const args = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--user-data-dir=${this.userData}`];
    this.electronApp = await electron.launch({
      ...(packaged ? { executablePath: packaged, args } : { args: [...args, join(REPO, 'out', 'main', 'index.js')] }),
      cwd: this.root,
      env: this.env,
      timeout: TIMEOUT_MS,
    });
    const child = this.electronApp.process();
    child.stdout?.on('data', (chunk: Buffer) => this.output.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => this.output.push(chunk.toString()));
    this.window = await this.electronApp.firstWindow({ timeout: TIMEOUT_MS });
    this.window.setDefaultTimeout(TIMEOUT_MS);
    this.window.on('console', (message) => {
      if (message.type() === 'error') this.consoleErrors.push(message.text());
    });
    this.window.on('pageerror', (error) => this.consoleErrors.push(String(error)));
    await this.window.waitForSelector('nav.sidebar');
    // フォルダを選ぶダイアログは、作業フォルダを選んだことにする
    await this.electronApp.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, this.work);
  }

  // 終了する。Claude Code と pty ホストも止める（終了の確認では「Claude Code も止めて終了」を選ぶ）
  async close(): Promise<void> {
    if (this.electronApp) {
      await this.electronApp
        .evaluate(({ dialog }) => {
          dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
        })
        .catch(() => {});
      await this.electronApp.close().catch(() => {});
      this.electronApp = null;
      this.window = null;
    }
    // 終了の確認を通らなかったときも、pty ホスト（と、その中の claude）を残さない
    await shutdownPtyHost(socketPathIn(this.userData, 'pty-host', 'pty'));
    await this.api.stop();
    rmSync(this.root, { recursive: true, force: true });
  }

  // 失敗したときの手がかり（画面の写し・メインプロセスの出力・API の呼び出し）を test-results/e2e に残す
  async keepEvidence(name: string): Promise<void> {
    mkdirSync(RESULTS, { recursive: true });
    const base = join(RESULTS, name.replace(/[^\p{L}\p{N}_-]+/gu, '-'));
    await this.window?.screenshot({ path: `${base}.png` }).catch(() => {});
    writeFileSync(
      `${base}.log`,
      [
        '# メインプロセスの出力',
        this.output.join(''),
        '# 画面のコンソールのエラー',
        ...this.consoleErrors,
        '# モックの API の呼び出し',
        ...this.api.requests,
      ].join('\n'),
    );
  }

  // --- 画面の操作 ---

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
