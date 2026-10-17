import { t } from '@shared/i18n';

// 発言を送れなかった（SessionManager.submit・submitWhenReady）。message は画面の言語の文（画面に出す）。
// reason は、Claude に返すとき（sessions-control.ts の send_message・list_wakeups）に英語の文を作るために使う
export type SendFailure = 'notRunning' | 'exited' | 'terminalMode' | 'notReady' | 'busy' | 'cancelled';

export class SendError extends Error {
  constructor(readonly reason: SendFailure) {
    super(t(`main.send.${reason}`));
  }
}

// 送れなかった理由の、Claude に返す英語の文（主語は、送ろうとした先のセッション）
export const SEND_FAILURE: Record<SendFailure, string> = {
  notRunning: 'its Claude Code is not running',
  exited: 'its Claude Code exited before the message could be sent',
  terminalMode: 'it is in terminal mode (or being switched to it), where only the user can type',
  notReady: 'its Claude Code did not become ready to accept messages in time',
  busy: 'it did not become idle in time',
  cancelled: 'sending was cancelled',
};

// 送れなかった理由として読めるものか（保存した予約を読むとき）
export function isSendFailure(value: unknown): value is SendFailure {
  return typeof value === 'string' && Object.hasOwn(SEND_FAILURE, value);
}
