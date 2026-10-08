import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareVersions } from '@shared/claude-code';
import type { HomebrewUpdate } from '@shared/app-update';

// Homebrew で入れた tanacode の更新。
// 新しいバージョンが出たら、裏で brew update と brew fetch だけを済ませる（キャッシュに落とすだけで、/Applications の .app には触らない）。
// 入れ替え（brew upgrade）は、tanacode が終わってから、切り離したシェルで行う。動いているアプリの中身を入れ替えると、
// あとから起動する Electron の補助プロセスだけが新しいバージョンになり、古い本体と混ざるため

// tap の cask。Homebrew の公式の cask に同じ名前ができても取り違えないよう、tap ごと指す
export const CASK = 'sny-tanaka/tanacode/tanacode';
const TAP = 'sny-tanaka/tanacode';
// cask が入れる先
export const APP_BUNDLE = '/Applications/tanacode.app';
// brew の置き場所（Apple Silicon・Intel）
const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
// HOMEBREW_NO_ASK: brew upgrade の確認（y/n）を出さない。HOMEBREW_NO_AUTO_UPDATE: brew update は先に済ませてあるので、upgrade の前にもう一度しない
export const BREW_ENV = { HOMEBREW_NO_ASK: '1', HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' };
// tap の cask が新しいバージョンになるのは、公開の数分あと。それまでは短い間隔で確かめ直す。失敗したとき（オフラインなど）は 1 時間あける
const TAP_BEHIND_RETRY_MS = 10 * 60_000;
const FAILED_RETRY_MS = 60 * 60_000;
const TIMEOUT_MS = 10 * 60_000;

// brew を動かして、標準出力を返す。失敗したら例外
export type BrewRunner = (args: string[]) => Promise<string>;

export function findBrew(exists: (path: string) => boolean = existsSync): string | null {
  return BREW_PATHS.find((path) => exists(path)) ?? null;
}

export function brewRunner(brew: string): BrewRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(brew, args, { env: { ...process.env, ...BREW_ENV }, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
}

// brew info --cask --json=v2 の返事から、tap の cask の今のバージョンと、入っているバージョンを取り出す。形が違えば null
export function parseCaskInfo(stdout: string): { version: string; installed: string | null } | null {
  try {
    const casks = (JSON.parse(stdout) as { casks?: unknown }).casks;
    const cask = Array.isArray(casks) ? (casks[0] as { tap?: unknown; version?: unknown; installed?: unknown } | undefined) : undefined;
    if (cask?.tap !== TAP || typeof cask.version !== 'string') return null;
    return { version: cask.version, installed: typeof cask.installed === 'string' ? cask.installed : null };
  } catch {
    return null;
  }
}

// 終わるのを待ってから brew upgrade し、終わったら（relaunch が 1 なら）起動し直すシェル。
// 引数: 1 待つプロセス 2 brew 3 cask 4 起動し直すアプリ 5 ログ 6 結果（brew upgrade の終了コード）7 起動し直すか 8 open
// 入力をつながないので、brew が何かを聞いても（sudo のパスワードなど）待たずに失敗する。1 分待っても終わらなければ、入れ替えずにやめる
export const UPGRADE_SCRIPT = `
pid=$1 brew=$2 cask=$3 app=$4 log=$5 result=$6 relaunch=$7 opener=$8
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then
    echo "tanacode が終わらないので、更新をやめました" >>"$log"
    echo 1 >"$result"
    exit 1
  fi
  sleep 0.1
done
"$brew" upgrade --cask "$cask" </dev/null >>"$log" 2>&1
echo $? >"$result"
if [ "$relaunch" = 1 ]; then "$opener" "$app"; fi
`;

export type UpgradeOptions = { pid: number; log: string; result: string; relaunch: boolean; opener?: string };

type Options = {
  brew: string;
  run: BrewRunner;
  // 動いているアプリのバージョン
  current: string;
  onChange: () => void;
  // テストで差し替える
  spawnShell?: (args: string[], env: NodeJS.ProcessEnv) => void;
};

type DetectOptions = Omit<Options, 'brew' | 'run'> & { bundle: string; brew?: string | null; run?: BrewRunner };

// Homebrew で入れたアプリの、新しいバージョンの用意。Homebrew で入れていなければ作らない（detect が null を返す）
export class HomebrewUpdater {
  private state: HomebrewUpdate | null = null;
  // 用意している途中（同時に何度も brew を動かさない）
  private preparing: Promise<void> | null = null;
  private retry: NodeJS.Timeout | null = null;
  private wanted: string | null = null;
  private upgrading = false;

  constructor(private readonly options: Options) {}

  // Homebrew で入れたか。動いているのが /Applications/tanacode.app で、brew の記録で、この tap の cask が、動いているのと同じバージョンで入っているとき。
  // 同じバージョンかを見るのは、brew で入れたあとに pkg・zip・ソースのビルドで上書きした場合を除くため（brew の記録は残る）
  static async detect({ bundle, current, onChange, brew = findBrew(), run, spawnShell }: DetectOptions): Promise<HomebrewUpdater | null> {
    if (bundle !== APP_BUNDLE || !brew) return null;
    run ??= brewRunner(brew);
    const info = await run(['info', '--cask', '--json=v2', CASK]).then(parseCaskInfo, () => null);
    if (info?.installed !== current) return null;
    return new HomebrewUpdater({ brew, run, current, onChange, spawnShell });
  }

  get(): HomebrewUpdate | null {
    return this.state;
  }

  // GitHub の Releases の最新バージョン。今より新しければ用意を始める（そのバージョンまで用意できていれば何もしない）
  want(latest: string | null): void {
    this.wanted = latest && compareVersions(latest, this.options.current) > 0 ? latest : null;
    if (this.needed()) void this.prepare();
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  // 用意する。用意している途中なら、それを待つ。用意できていれば何もしない
  prepare(): Promise<void> {
    if (!this.preparing && !this.needed()) return Promise.resolve();
    this.preparing ??= this.doPrepare().finally(() => {
      this.preparing = null;
    });
    return this.preparing;
  }

  // 用意が要るか。用意できていても、そのあとにさらに新しいバージョンが出ていれば、それを用意する
  private needed(): boolean {
    if (!this.wanted) return false;
    return this.state?.status !== 'ready' || compareVersions(this.wanted, this.state.version) > 0;
  }

  // 用意できているものがあれば、新しいものを用意するあいだも、失敗したときも、それを入れられるようにしておく
  private async doPrepare(): Promise<void> {
    this.stop();
    const ready = this.state?.status === 'ready' ? this.state : null;
    if (!ready) this.set({ status: 'downloading' });
    const { run, current } = this.options;
    try {
      await run(['update']);
      const info = parseCaskInfo(await run(['info', '--cask', '--json=v2', CASK]));
      if (!info) throw new Error('cask を読めません');
      // tap の cask がまだ新しくなっていない。少しあとに確かめ直す
      if (compareVersions(info.version, ready?.version ?? current) <= 0) return this.later(TAP_BEHIND_RETRY_MS);
      await run(['fetch', '--cask', CASK]);
      this.set({ status: 'ready', version: info.version });
    } catch {
      if (!ready) this.set({ status: 'failed' });
      this.later(FAILED_RETRY_MS);
    }
  }

  private later(ms: number): void {
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.needed()) void this.prepare();
    }, ms);
  }

  // 用意できていれば、このプロセスが終わるのを待って brew upgrade する、切り離したシェルを起動する。起動したら true。
  // 終了の片付けの途中で呼ぶので、ログを書けないなどで失敗しても投げない（入れ替えずに終わる）
  upgradeAfterExit({ pid, log, result, relaunch, opener = '/usr/bin/open' }: UpgradeOptions): boolean {
    if (this.state?.status !== 'ready' || this.upgrading) return false;
    try {
      // ログは、この更新の分だけにする
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, `${new Date().toISOString()} v${this.state.version} に更新します\n`);
      rmSync(result, { force: true });
    } catch {
      return false;
    }
    this.upgrading = true;
    const args = [String(pid), this.options.brew, CASK, APP_BUNDLE, log, result, relaunch ? '1' : '0', opener];
    const env = { ...process.env, ...BREW_ENV };
    (this.options.spawnShell ?? spawnDetached)(args, env);
    return true;
  }

  private set(state: HomebrewUpdate): void {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.options.onChange();
  }
}

// アプリが終わっても動き続けるよう、切り離して起動する
function spawnDetached(args: string[], env: NodeJS.ProcessEnv): void {
  const child = spawn('/bin/sh', ['-c', UPGRADE_SCRIPT, 'tanacode-update', ...args], { detached: true, stdio: 'ignore', env });
  // 起動できなくても、終了の流れを止めない（入れ替えずに終わる）
  child.on('error', () => {});
  child.unref();
}
