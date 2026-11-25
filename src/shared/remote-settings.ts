import { publicOriginOf } from './remote-protocol';

// 遠隔操作（Issue #464）の設定。アプリ全体で 1 つ（既定のプロファイルの設定のファイルに置く）。メニューバーから変える（Mac の設定。スマホに出さない）。
// enabled: 待ち受けるか（既定はオフ）/ port: 127.0.0.1 で待ち受けるポート（取れなければ、別のポートへは逃げずに止める）/
// publicUrl: スマホが開く URL（https。例: tailscale serve が出す https://<Mac の名前>.<tailnet>.ts.net）。Host と Origin は、これと一致しなければ断る
export type RemoteSettings = { enabled: boolean; port: number; publicUrl: string };

export const DEFAULT_REMOTE_PORT = 47413;
export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = { enabled: false, port: DEFAULT_REMOTE_PORT, publicUrl: '' };

// 待ち受けに使えるポート（特権の要らないもの）
export const isRemotePort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535;

// 保存したものを読む。形が違うところは既定に戻す（公開する URL が使えない形なら、待ち受けない）
export function remoteSettingsOf(value: unknown): RemoteSettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_REMOTE_SETTINGS };
  const v = value as Record<string, unknown>;
  const publicUrl = typeof v.publicUrl === 'string' ? v.publicUrl : '';
  const port = isRemotePort(v.port) ? v.port : DEFAULT_REMOTE_PORT;
  return { enabled: v.enabled === true && publicOriginOf(publicUrl) !== null, port, publicUrl };
}

// 待ち受けの様子。off: 止めている / starting: 始めている / listening: 待ち受けている（port）/
// in-use: ポートが使われていて始められない / failed: ほかの理由で始められない・遠隔サーバーが落ちた
export type RemoteStatus = { state: 'off' } | { state: 'starting' } | { state: 'listening'; port: number } | { state: 'in-use'; port: number } | { state: 'failed'; message: string };

// 設定のダイアログに出すもの。connections: つながっている接続の数
export type RemoteSettingsState = { settings: RemoteSettings; status: RemoteStatus; connections: number };

// 設定のダイアログで変えるもの（入り・切りはメニューバーのチェック）
export type RemoteSettingsInput = { port: number; publicUrl: string };

// 登録した端末（Mac のダイアログに出すもの。鍵は出さない）。profileIds: 許したプロファイル
export type RemoteDevice = { id: string; name: string; createdAt: number; lastUsedAt: number | null; profileIds: string[] };

// 承認のときに選べるプロファイル（今開いているもの）
export type RemoteProfileChoice = { id: string; name: string };

// 登録の受付。code: 登録のコード / url: スマホで開く URL（QR にする。コードはフラグメントに入れる）/ until: 期限 / pending: 承認を待っているもの
export type RemotePairing = { code: string; url: string; until: number; pending: { requestId: string; name: string }[] };

// 端末の一覧と登録の受付。problem: 登録の一覧を読めなかった理由（unavailable: 暗号化が使えない・unreadable: 読めない・rolled-back: 古いファイルに戻された）
// profiles: 承認のときに選べるプロファイル
export type RemoteDevicesState = { devices: RemoteDevice[]; pairing: RemotePairing | null; problem: 'unavailable' | 'unreadable' | 'rolled-back' | null; profiles: RemoteProfileChoice[] };
