// アプリと常駐のホスト（claude を持っておくプロセス）のやりとり。Unix ソケットに JSON を 1 行ずつ書く。
// ホストはアプリを起動し直しても古いまま動き続けるので、形を変えたら PROTOCOL を上げる（違えばホストを入れ替える）。
// ホストの動かし方を変えて、古いホストを入れ替えたいときも上げる
// 2: Dock に出ない Helper.app で動かす
// 3: パイプでつながるプロセス（stream-json の claude）を持つ。行に通し番号を付けて控え、引き継いだアプリが送り直しを頼める
export const PROTOCOL = 3;

// pty: ターミナルモードの claude（TUI）。画面を仮想の端末で持つ /
// pipe: チャットの claude（stream-json）。標準入出力をパイプでつなぎ、出力の行を控える
export type HostedKind = 'pty' | 'pipe';

// 行の種類（type と subtype の組。subtype を省くと、その type のすべて）。
// where: 項目の値の条件（項目の名前 → 当たる値の一覧。値の一覧が空なら、その項目がある（null でない）こと）。
// 項目の名前は、"patch.status" のように . でつないで入れ子の項目も指せる
export type LineKind = { type: string; subtype?: string; where?: Record<string, unknown[]> };

// 残している行を捨てる行。key があれば、その項目の値が残している行の key の値と同じものだけを捨てる。無ければ、その決まりの行をすべて捨てる
export type UntilRule = LineKind & { key?: string };

// 控えの上限と別に持ち、捨てない行の決まり（pipe）。何を残すかはアプリがデータとして渡す（ホストのコードを直すたびに PROTOCOL を
// 上げると、動いている claude が止まるため。あとで決まりを足せるよう、条件・入れ子の項目・捨てる行の一覧を書ける形にしてある）。
// key が無ければ、その種類の最新の 1 行。key があれば、その項目の値ごとに最新の 1 行。until のどれかに当たる行が来たら捨てる（終わった task_*）
export type RetainRule = LineKind & { key?: string; until?: UntilRule[] };

type SpawnBase = {
  id: string;
  // アプリのセッション ID。起動し直したアプリが、どのセッションのプロセスかを知るのに使う
  tag: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export type PtySpawnRequest = SpawnBase & { kind: 'pty'; cols: number; rows: number };

export type PipeSpawnRequest = SpawnBase & {
  kind: 'pipe';
  // 種類ごとの最新として控える行
  retain: RetainRule[];
  // 控えない行（書いている途中の stream_event）。アプリへは送るが、送り直しには入らない
  transient: LineKind[];
};

export type SpawnRequest = PtySpawnRequest | PipeSpawnRequest;

type HostedBase = {
  id: string;
  tag: string;
  pid: number;
  // 起動した時刻（ms）。これ以降の会話ログの行は、今も動いている claude が書いたもの
  startedAt: number;
  // 終わっていれば終了コード
  exitCode: number | null;
};

// ホストが持っている pty
export type HostedPtyInfo = HostedBase & {
  kind: 'pty';
  cols: number;
  rows: number;
  // 今の画面を描き直すための文字列（@xterm/addon-serialize）
  screen: string;
};

// ホストが持っているパイプのプロセス
export type HostedPipeInfo = HostedBase & {
  kind: 'pipe';
  // 最後の行の通し番号（まだ無ければ 0）。通し番号は 1 から
  lastSeq: number;
  // 控えに残っているいちばん古い行の通し番号（控えが空なら lastSeq + 1）
  firstSeq: number;
  // 種類ごとの最新の行（RetainRule。古い順）。控えの頭が欠けても、状態を組み立て直せるように
  retained: HostedLine[];
  // claude が送って、まだ答えも取り消しも無い制御の要求（control_request の行。来た順）
  pending: HostedLine[];
  // 入力を閉じた（end）
  ended: boolean;
  // 標準エラーの末尾
  stderr: string;
};

export type HostedInfo = HostedPtyInfo | HostedPipeInfo;

// 通し番号付きの出力の 1 行（改行を除いた JSON の文字列のまま）
export type HostedLine = { seq: number; line: string };

export type ClientMessage =
  | { t: 'hello'; protocol: number }
  | ({ t: 'spawn' } & SpawnRequest)
  // pty に打つ
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  // パイプの入力に 1 行書く（改行はホストが足す）
  | { t: 'send'; id: string; line: string }
  // パイプの入力を閉じる
  | { t: 'end'; id: string }
  // この通し番号から、控えている行を送り直す（line の知らせで届く）
  | { t: 'replay'; id: string; from: number }
  // 止める。signal を省くと、pty は既定の止め方（SIGHUP）、パイプは SIGTERM。パイプはプロセスグループごと止める
  | { t: 'kill'; id: string; signal?: 'SIGTERM' | 'SIGKILL' }
  // 終わったプロセスの記録を捨てる
  | { t: 'forget'; id: string }
  | { t: 'list'; req: number }
  // すべてのプロセスを止めてホストも終わる。形が変わっても使えるよう、これだけは変えない
  | { t: 'shutdown' };

export type HostMessage =
  | { t: 'hello'; protocol: number; pid: number }
  // pty の出力
  | { t: 'data'; id: string; data: string }
  // パイプの出力の 1 行。replay: replay の頼みで送り直した控えの行（終わりは replayed で知らせる）
  | { t: 'line'; id: string; seq: number; line: string; replay?: true }
  // replay の頼みで送り直す行を、送り終えた
  | { t: 'replayed'; id: string }
  // stderr: パイプのときの標準エラーの末尾（起動できなかった理由など）。もう記録を捨てたプロセスへの replay にも返す（exitCode は -1）
  | { t: 'exit'; id: string; exitCode: number; stderr?: string }
  | { t: 'list'; req: number; hosted: HostedInfo[] };

// 1 行の上限（mcp-bridge.ts の MAX_LINE と同じ）。超えた行は捨ててログに残す
export const MAX_LINE_BYTES = 32 * 1024 * 1024;
// 控える行の合計の上限（目安）。超えたら古い行から捨てる（チャットの中身は会話ログから追いつける）
export const BACKLOG_BYTES = 8 * 1024 * 1024;
// 控える標準エラーの末尾の長さ
export const STDERR_TAIL = 8 * 1024;

// 行の種類が kind に当たるか（行は読めた JSON）
export function matchesKind(value: Record<string, unknown>, kind: LineKind): boolean {
  if (value.type !== kind.type || (kind.subtype !== undefined && value.subtype !== kind.subtype)) return false;
  return Object.entries(kind.where ?? {}).every(([path, values]) => {
    const found = valueAt(value, path);
    return values.length === 0 ? found !== undefined && found !== null : values.includes(found);
  });
}

// 項目の値。path は . でつないだ入れ子の名前（"patch.status"）。無ければ undefined
export function valueAt(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const name of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[name];
  }
  return current;
}
