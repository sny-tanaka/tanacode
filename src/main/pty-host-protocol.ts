// アプリと pty ホスト（claude を持っておく常駐プロセス）のやりとり。Unix ソケットに JSON を 1 行ずつ書く。
// ホストはアプリを起動し直しても古いまま動き続けるので、形を変えたら PROTOCOL を上げる（違えばホストを入れ替える）。
// ホストの動かし方を変えて、古いホストを入れ替えたいときも上げる
// 2: Dock に出ない Helper.app で動かす
export const PROTOCOL = 2;

export type SpawnRequest = {
  id: string;
  // アプリのセッション ID。起動し直したアプリが、どのセッションの pty かを知るのに使う
  tag: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
};

// ホストが持っている pty
export type HostedPtyInfo = {
  id: string;
  tag: string;
  pid: number;
  // 起動した時刻（ms）。これ以降の会話ログの行は、今も動いている claude が書いたもの
  startedAt: number;
  cols: number;
  rows: number;
  // 終わっていれば終了コード
  exitCode: number | null;
  // 今の画面を描き直すための文字列（@xterm/addon-serialize）
  screen: string;
};

export type ClientMessage =
  | { t: 'hello'; protocol: number }
  | ({ t: 'spawn' } & SpawnRequest)
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; id: string }
  // 終わった pty の記録を捨てる
  | { t: 'forget'; id: string }
  | { t: 'list'; req: number }
  // すべての pty を止めてホストも終わる。形が変わっても使えるよう、これだけは変えない
  | { t: 'shutdown' };

export type HostMessage =
  | { t: 'hello'; protocol: number; pid: number }
  | { t: 'data'; id: string; data: string }
  | { t: 'exit'; id: string; exitCode: number }
  | { t: 'list'; req: number; ptys: HostedPtyInfo[] };
