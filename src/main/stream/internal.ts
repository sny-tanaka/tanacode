import { ControlError, type StreamClient } from './client';

// 文書（公開の Agent SDK の型）に無い、Claude Code の内部の制御の要求。バージョンで変わる・消えるおそれがいちばん大きいので、
// ここに閉じ込める（設計書 6・14 節）。どれも Claude Code 2.1.296・2.1.301 で動かして確かめた形。
// 失敗（error の返事・知らない要求・時間切れ）は ControlError で返す。受け口が無いときは、理由が「Unsupported control request subtype」になる

// Remote Control をつなぐのは時間がかかる（claude.ai に登録する）
const REMOTE_CONTROL_TIMEOUT_MS = 60_000;

// 受け口が無い（このバージョンの Claude Code に、その内部の要求が無い）
export function unsupported(error: unknown): boolean {
  return error instanceof ControlError && /Unsupported control request subtype/i.test(error.reason);
}

// sessionUrl: スマホ・claude.ai から開く URL / bridgeSessionId: Remote Control のセッションの ID（切り替えのあとに付け直すときに渡す）
export type RemoteControlSession = { sessionUrl: string | null; bridgeSessionId: string | null };

// Remote Control をつなぐ（メニューを出さない）。reattach: 前につないでいたセッションの ID（ターミナルモードから戻ったとき、同じセッションに付け直す）。
// つないだかは、返事と system/bridge_state（connected）で分かる
export async function enableRemoteControl(client: StreamClient, name: string, reattach: string | null = null): Promise<RemoteControlSession> {
  const response = await client.request<{ session_url?: unknown; bridge_session_id?: unknown }>(
    'remote_control',
    { enabled: true, name, ...(reattach ? { reattach_session_id: reattach } : {}) },
    REMOTE_CONTROL_TIMEOUT_MS,
  );
  return {
    sessionUrl: typeof response.session_url === 'string' ? response.session_url : null,
    bridgeSessionId: typeof response.bridge_session_id === 'string' ? response.bridge_session_id : null,
  };
}

export async function disableRemoteControl(client: StreamClient): Promise<void> {
  await client.request('remote_control', { enabled: false }, REMOTE_CONTROL_TIMEOUT_MS);
}

// 会話を巻き戻す。target: 戻す先の発言の uuid / lastSeen: アプリが知っている最後の発言の uuid（無いと stale_target で断られる。実測）。
// prefillText: 戻した発言の文（チャットの入力欄に入れる）。会話ログは消されず、次の発言から枝分かれする。
// reason: 断られた理由の識別子（turn_running など）/ error: Claude Code が付けた英語の説明（turn running など）
export type RewindResult = { rewound: boolean; prefillText: string | null; reason: string | null; error: string | null };

export async function rewindConversation(client: StreamClient, target: string, lastSeen: string): Promise<RewindResult> {
  const response = await client.request<{ rewound?: unknown; prefillText?: unknown; reason?: unknown; error?: unknown }>('rewind_conversation', {
    target_message_uuid: target,
    last_seen_user_message_uuid: lastSeen,
  });
  return {
    rewound: response.rewound === true,
    prefillText: typeof response.prefillText === 'string' ? response.prefillText : null,
    reason: typeof response.reason === 'string' ? response.reason : null,
    error: typeof response.error === 'string' ? response.error : null,
  };
}

// セッションを終える。裏のタスクを待たずに、0.1〜0.2 秒で終わる（作業中でも終わり、裏の Bash も止まる。実測）
export async function endSession(client: StreamClient): Promise<void> {
  await client.request('end_session', { reason: 'tanacode' }, 5000);
}

// 会話のタイトルを作らせ、会話ログに ai-title として書かせる（-p は自動ではタイトルを作らないため。実測）。
// description: 最初の発言など、タイトルの元にする文。作れなければ null（失敗は呼ぶ側で黙って捨てる）
export async function generateTitle(client: StreamClient, description: string): Promise<string | null> {
  const response = await client.request<{ title?: unknown }>('generate_session_title', { description, persist: true });
  return typeof response.title === 'string' && response.title.trim() ? response.title.trim() : null;
}
