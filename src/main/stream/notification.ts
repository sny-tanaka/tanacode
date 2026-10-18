import { randomUUID } from 'node:crypto';
import type { ChatEvent } from '@shared/chat';
import type { NotificationMessage } from './protocol';

// Claude Code の警告（system/notification）を、チャットのお知らせにする。stream-json にだけ出て、会話ログに残らないので、
// 起動し直すと消える（api_retry と同じ）。文は Claude Code のもの（英語）をそのまま出す（informational と同じ）。
// 出るもの（2.1.302 の本体）: 起動時のエフォートやコンテキストの上限（model-effort-cap・model-context-window）・メモリの停止
// （memory-paused・session-auto-memory-off）・plan を抜けたら auto が使えなかった（auto-mode-gate-plan-exit-fallback）・
// 組織の方針でモデルが使えない（session-model-restricted・agent-model-restricted-…）・圧縮しなかった（compaction-skipped）など。
// 知らない key も出す（新しい警告を見落とさない）

// 出さない key と、そのわけ
const SKIPPED_KEYS = new Set([
  // Stop フックの失敗。会話ログの stop_hook_summary（hookErrors）から、フックの表示で出している
  'stop-hook-error',
  // Stop フックがターンの終わりを止めすぎた。同じ文が会話ログの informational にも書かれ、そちらから出している
  'stop-hook-block-cap',
  // 圧縮の失敗。同じときに出る system/status の compact_error（くわしい理由つき）から出す
  'error-compacting-conversation',
  // PreCompact フックが圧縮を止めた。止めるのは tanacode 自身（最適化圧縮を自動にしたとき。src/main/auto-compact.ts）
  'compaction-blocked-by-hook',
]);
// 出さない key の頭。remote-tool-status-…・remote-tool-notice-…: ツールのホストの経過の、一時的な知らせ（timeout_ms で消える）
const SKIPPED_PREFIXES = ['remote-tool-'];

// お知らせにするなら、その info のイベント。出さないものは null
export function notificationEvent(message: NotificationMessage): Extract<ChatEvent, { type: 'info' }> | null {
  const text = message.text.trim();
  if (!text || SKIPPED_KEYS.has(message.key) || SKIPPED_PREFIXES.some((prefix) => message.key.startsWith(prefix))) return null;
  return {
    type: 'info',
    id: `notification:${message.uuid ?? randomUUID()}`,
    text,
    ...(message.color === 'warning' || message.color === 'error' ? { warning: true as const } : {}),
  };
}
