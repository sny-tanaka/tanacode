import { parseAuthRequest, type AuthReplies, type AuthRequest, type RemoteCredential } from './remote-auth';
import type { Language } from './i18n';

// main と遠隔サーバー（utilityProcess。src/main/remote-server.ts）の間の伝文（Issue #464）。
// main は遠隔サーバーを信じきらない。遠隔サーバーから届いた伝文は、どれも parseServerMessage で形を確かめてから使い、
// 呼び出し元（Caller）は、伝文の中のプロファイルではなく、main が持つ接続の控えから組み立てる

// 1 つの伝文の大きさの上限（遠隔サーバーの WebSocket。画像の添付を送れる大きさ）
export const REMOTE_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
// スマホから送る添付の大きさの上限。伝文ではバイト列を base64 にする（4/3 倍になる）ので、伝文の上限に収まる大きさ
export const REMOTE_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// 待ち受けの設定。port: 127.0.0.1 で待ち受けるポート / publicOrigin: スマホが開く URL の origin（例: https://mac.example.ts.net）。
// Host と Origin は、これと完全に一致しなければ断る
// language: 遠隔の画面（ログイン・登録と、ログインしたあとの画面）の言語（Mac の tanacode の画面の言語にそろえる。握手の返事でも渡す）
export type RemoteListenConfig = { port: number; publicOrigin: string; language: Language };

// 遠隔の接続のセッション（③ で、本人確認を通ったときに main が作る）。tokenHash: Cookie の秘密の SHA-256（hex。秘密そのものは渡さない）/
// registrationId: どの登録から入ったか / profileIds: その登録に許したプロファイル / expiresAt: 長くても使える期限（エポックのミリ秒）。
// 使わない時間の期限（30 分）は、遠隔サーバーが人の操作の頼みで数える
// lastActive: 最後に人の操作の頼みが届いた時刻（main が控え、待ち受けを始め直したときに渡す。使わない時間の期限を延ばさないため）
export type RemoteSession = { sessionId: string; tokenHash: string; registrationId: string; profileIds: string[]; expiresAt: number; lastActive: number };

// main → 遠隔サーバー
export type HostMessage =
  | { type: 'listen'; config: RemoteListenConfig }
  | { type: 'close' }
  | { type: 'session-add'; session: RemoteSession }
  | { type: 'session-remove'; sessionId: string }
  | { type: 'result'; id: number; clientId: string; ok: true; value: unknown }
  | { type: 'result'; id: number; clientId: string; ok: false; error: string }
  // profileId: どのプロファイルの知らせか（アプリ全体の知らせには無い）
  | { type: 'event'; clientIds: string[]; channel: string; payload: unknown; profileId?: string }
  | { type: 'disconnect'; clientId: string }
  // 登録したパスキーの公開の部分（登録・取り消しのたびに、全部を送り直す）
  | { type: 'credentials'; credentials: RemoteCredential[] }
  // 本人確認の頼みの返事
  | { type: 'auth-result'; id: number; ok: true; value: AuthReplies[keyof AuthReplies] }
  | { type: 'auth-result'; id: number; ok: false; error: string };

// 遠隔サーバー → main
// listening: 待ち受けを始めた / listen-failed: 始められなかった（in-use: ポートが使われている）/ closed: 待ち受けをやめた /
// connected・disconnected: 接続ができた・切れた（sessionId のセッションで入った）/ call: 頼み（kind: invoke は返事を待つ・send は待たない。
// profileId: スマホの画面が選んでいるプロファイル。main が、そのセッションに許したものかを確かめる）/
// subscribe: subscribe の知らせのうち、その接続に送るもの（今の全部を送る。空なら送らない）
export type ServerMessage =
  | { type: 'listening'; port: number }
  | { type: 'listen-failed'; reason: 'in-use' | 'other'; message: string }
  | { type: 'closed' }
  // ticket: 握手に使った券（main が出した券かを、main が確かめる）
  | { type: 'connected'; clientId: string; sessionId: string; ticket: string }
  | { type: 'disconnected'; clientId: string }
  // 使わない時間・期限でセッションを捨てた（main も控えから消す）
  | { type: 'session-expired'; sessionId: string }
  // active: 人が押した・打ったことで送った頼み（スマホの画面が付ける）。これだけで、使わない時間を数え直す
  //（画面を開いただけで送る読み取りでは延ばさない。置いたままのスマホが切れるように）
  | { type: 'call'; id: number; clientId: string; profileId: string; kind: 'invoke' | 'send'; channel: string; args: unknown[]; active: boolean }
  | { type: 'subscribe'; clientId: string; channels: string[] }
  // その登録のパスキーで、ログインに続けて失敗した（待たせ始めた）。main は Mac に知らせる
  | { type: 'login-failures'; registrationId: string }
  // 本人確認の頼み（remote-auth.ts）。main は auth-result で返す
  | { type: 'auth'; id: number; request: AuthRequest };

// WebSocket の券の期限（main が出し、遠隔サーバーと main の両方が控える）と、1 つのセッションが同時に持てる券の数（古いものから捨てる）
export const REMOTE_TICKET_MS = 30 * 1000;
export const REMOTE_TICKETS_PER_SESSION = 4;

// 使わない時間でセッションを捨てるまで（人の操作の頼み（active）で延ばす）。遠隔サーバーと main の両方が、この長さで確かめる
export const REMOTE_IDLE_MS = 30 * 60 * 1000;

// 接続の id・セッションの id・チャンネルの名前の上限（ふつうはずっと短い）
const MAX_ID = 128;
const MAX_CHANNELS = 64;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;
const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// 遠隔サーバーから届いた伝文の形を確かめる。違えば null（main は使わない）
export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'listening':
      return isSeq(value.port) ? { type: 'listening', port: value.port } : null;
    case 'listen-failed':
      return (value.reason === 'in-use' || value.reason === 'other') && typeof value.message === 'string'
        ? { type: 'listen-failed', reason: value.reason, message: value.message.slice(0, 500) }
        : null;
    case 'closed':
      return { type: 'closed' };
    case 'connected':
      return isId(value.clientId) && isId(value.sessionId) && isId(value.ticket) ? { type: 'connected', clientId: value.clientId, sessionId: value.sessionId, ticket: value.ticket } : null;
    case 'disconnected':
      return isId(value.clientId) ? { type: 'disconnected', clientId: value.clientId } : null;
    case 'session-expired':
      return isId(value.sessionId) ? { type: 'session-expired', sessionId: value.sessionId } : null;
    case 'call':
      return isSeq(value.id) && isId(value.clientId) && isId(value.profileId) && (value.kind === 'invoke' || value.kind === 'send') && isId(value.channel) && Array.isArray(value.args)
        ? { type: 'call', id: value.id, clientId: value.clientId, profileId: value.profileId, kind: value.kind, channel: value.channel, args: value.args, active: value.active === true }
        : null;
    case 'subscribe':
      return isId(value.clientId) && Array.isArray(value.channels) && value.channels.length <= MAX_CHANNELS && value.channels.every(isId)
        ? { type: 'subscribe', clientId: value.clientId, channels: value.channels as string[] }
        : null;
    case 'login-failures':
      return isId(value.registrationId) ? { type: 'login-failures', registrationId: value.registrationId } : null;
    case 'auth': {
      const request = parseAuthRequest(value.request);
      return isSeq(value.id) && request ? { type: 'auth', id: value.id, request } : null;
    }
    default:
      return null;
  }
}

// 公開する URL を、待ち受けの設定に使える origin にする。https で、パス・クエリ・利用者名の無いものだけ。違えば null
export function publicOriginOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  return parsed.origin;
}
