import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// アプリが起動する claude に渡す設定（--settings）と MCP サーバー（--mcp-config）は、中身を起動の引数に載せず、ファイルに書いてパスだけを渡す。
// 引数は ps で誰からも見え、pkill -f のような「引数のどこかに含む文字」での指定にも当たる。設定にはフックのプログラム（worktree-guard.ts の
// awk など）がまるごと入るので、Claude が自分の裏の処理を止めるつもりで実行した pkill -f p.sh が、設定の中の pushd に当たり、
// アプリの claude がすべて止まったことがある。引数には短いパスだけを載せて、そうした指定に当たりにくくする。
// 中身は、登録した設定ファイル（API キーが入りうる）や中継のソケットのパスを含むので、自分だけが読み書きできるファイルにする。
//
// ファイルの名前は <セッション ID>.<中身の hash>.json（MCP は .mcp.json）。
// - 起動のたびに、今のアプリの中身から作り直す（アプリを更新したあとの起動・--resume には、新しい中身が渡る）
// - 動いている claude が使っているファイルは書き換えない。中身が変われば名前も変わるので、新しい起動は別のファイルを使う
//   （更新の前から動いていて、次のアプリが引き継ぐ claude に、新しいアプリにしか無いスクリプトの場所などを途中から混ぜない。
//   Claude Code 2.1.323 は --settings のファイルを書き換えても読み直さなかったが、プロジェクトの設定は読み直すので、先のバージョンで
//   変わっても困らないようにする）。同じ名前があれば中身も同じなので、書かずにそのまま使う
// - セッションごとに分ける（MCP の env にセッション ID が入り、足すフックもサーバーの有無で変わる。片付けもセッションで決められる）
// - 置くのは 1 つのフォルダ（userData/session-settings）だけ。片付けはこのフォルダを見て消すので、アプリが落ちても次の起動で片付く
// - そのセッションの claude が終わった・アーカイブした・アプリが claude ごと終えたら、そのセッションのものを消す。アプリだけ終えて
//   claude を動かしたままにするときは残す（次のアプリが引き継ぐ claude が使う）。次のアプリは、引き継いだあと、動いている claude が
//   使っているもの（セッションの記録の launchFiles）のほかを消す

// 起動の前に用意したもの
export type PreparedLaunch = {
  // --settings に渡すファイル（アプリの設定。登録した設定ファイルを選んでいれば、それと合わせたもの）
  settingsFile: string;
  // --mcp-config に渡すファイル。足す MCP サーバーが無ければ null（--mcp-config を付けない）
  mcpConfigFile: string | null;
  // 登録した設定ファイルの model。--model が設定の model を上書きするので、モデルを選んでいないときはこれを渡す
  model: string | null;
  // 登録した設定ファイルを合わせたか（Claude Code が設定の読めない項目を知らせたとき、登録した設定のものかを見分ける）
  registered: boolean;
};

const SETTINGS_SUFFIX = '.json';
const MCP_SUFFIX = '.mcp.json';

export class LaunchFiles {
  constructor(readonly dir: string) {}

  // 起動の前に書く。mcpConfig が null なら MCP のファイルは作らない
  write(sessionId: string, settings: Record<string, unknown>, mcpConfig: Record<string, unknown> | null): { settingsFile: string; mcpConfigFile: string | null } {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const settingsFile = this.put(sessionId, JSON.stringify(settings), SETTINGS_SUFFIX);
    const mcpConfigFile = mcpConfig ? this.put(sessionId, JSON.stringify(mcpConfig), MCP_SUFFIX) : null;
    return { settingsFile, mcpConfigFile };
  }

  // そのセッションのものを、すべて消す（そのセッションの claude が終わった・アーカイブした・止めて終えた）
  release(sessionId: string): void {
    for (const name of this.names()) if (sessionOf(name) === sessionId) rmSync(join(this.dir, name), { force: true });
  }

  // 動いている claude が使っているもの（keep が true）を残して、ほかを消す（アプリが落ちている間に終わった claude のもの・
  // 片付けの途中で止まって残ったもの・書きかけ・前のバージョンの名前のものなど）。keep にはセッション ID とファイルの名前を渡す
  sweep(keep: (sessionId: string, name: string) => boolean): void {
    for (const name of this.names()) {
      const sessionId = sessionOf(name);
      if (sessionId && !keep(sessionId, name)) rmSync(join(this.dir, name), { force: true });
    }
  }

  // 中身の hash を名前に入れて書く。同じ名前があれば中身も同じなので書かない（動いている claude が使っていても触らない）
  private put(sessionId: string, text: string, suffix: string): string {
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const file = join(this.dir, `${sessionId}.${hash}${suffix}`);
    if (existsSync(file) && (statSync(file).mode & 0o777) === 0o600) return file;
    // 書きかけを読ませないよう、別の名前に書いてから置き換える
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    // 前に書いたファイルがあると mode は効かないので、あらためて絞る
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    return file;
  }

  private names(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }
}

// ファイルの名前のセッション ID（<セッション ID>.<hash>.json・前のバージョンの <セッション ID>.json・書きかけの .tmp）。知らない名前なら null
function sessionOf(name: string): string | null {
  if (!name.endsWith(SETTINGS_SUFFIX) && !name.endsWith('.tmp')) return null;
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : null;
}
