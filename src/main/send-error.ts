import { t } from '@shared/i18n';

// 発言を送れなかった（SessionManager.submit・submitWhenReady）。message は画面の言語の文（画面に出す）。
// reason は、Claude に返すとき（sessions-control.ts の send_message）に英語の文を作るために使う
export type SendFailure = 'notRunning' | 'exited' | 'terminalMode' | 'notReady' | 'busy' | 'cancelled';

export class SendError extends Error {
  constructor(readonly reason: SendFailure) {
    super(t(`main.send.${reason}`));
  }
}
