// 未知のイベント: tanacode が知らない、Claude Code からの行。捨てずにチャットへ出して、対応を足す手がかりにする（CONTRIBUTING.md の
// 「未知のイベント」）。stream-json の行（main の stream/client.ts）と会話ログの行（chat.ts の toChatEvents）から作る

// stream: stream-json の行 / transcript: 会話ログの行 / request: Claude Code からの制御の要求（使わない種類は error で返している）
export type UnknownSource = 'stream' | 'transcript' | 'request';

// unknown: 知らない種類 / malformed: 知っている種類だが、使う項目の形が違う（種類の欄が無いものも）/ unparsable: JSON として読めない
export type UnknownProblem = 'unknown' | 'malformed' | 'unparsable';

// name: 種類の名前（system/turn_preempted・attachment/foo・assistant/server_tool_use・control_request/elicitation など。分からなければ空）/
// version: Claude Code のバージョン（分かれば）/ raw: 生の行（整形した JSON。読めない行は、その文字のまま）/
// truncated: 長くて切ったときの、元のバイト数。id: 行の uuid から作る（stream と会話ログの両方に同じ行が出たら、画面で 1 つに寄せる）
export type UnknownEvent = {
  type: 'unknown-event';
  id: string;
  name: string;
  problem: UnknownProblem;
  source: UnknownSource;
  version?: string;
  raw: string;
  truncated?: number;
};

// 生の行を載せる上限（UTF-8 のバイト数）。会話ログの大きな行（画像の入った発言など）でも、チャットの配信と画面を重くしない
export const UNKNOWN_RAW_BYTES = 64 * 1024;

// uuid の無い行の ID の連番（プロセスの中で重ならなければよい）
let serial = 0;

// value: JSON として読めた値か、読めなかった行の文字。key: 行の uuid（制御の要求なら request_id）。無ければ連番で ID を作る
export function unknownEvent(
  name: string,
  problem: UnknownProblem,
  source: UnknownSource,
  value: unknown,
  { key, version }: { key?: string; version?: string } = {},
): UnknownEvent {
  const text = problem === 'unparsable' && typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const { raw, truncated } = clipRaw(text);
  return {
    type: 'unknown-event',
    id: `unknown:${source === 'request' ? 'request:' : ''}${key || `n${++serial}`}`,
    name,
    problem,
    source,
    ...(version ? { version } : {}),
    raw,
    ...(truncated === undefined ? {} : { truncated }),
  };
}

const encoder = new TextEncoder();

// 上限で切る。切った境目で壊れた文字（置き換え文字）は落とす
function clipRaw(text: string): { raw: string; truncated?: number } {
  // UTF-16 の 1 つは、UTF-8 で 3 バイトまで。それで収まる長さなら数えない
  if (text.length * 3 <= UNKNOWN_RAW_BYTES) return { raw: text };
  const bytes = encoder.encode(text);
  if (bytes.length <= UNKNOWN_RAW_BYTES) return { raw: text };
  return { raw: new TextDecoder().decode(bytes.subarray(0, UNKNOWN_RAW_BYTES)).replace(/�$/, ''), truncated: bytes.length };
}
