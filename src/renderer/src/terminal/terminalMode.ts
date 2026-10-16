import { t } from '@shared/i18n';
import type { SessionSummary } from '@shared/ipc';
import { errorMessage } from '../errorMessage';

// ターミナルモード（Claude Code ペインに、チャットの代わりに Claude Code そのものの画面を出す）は、セッションごと（設計書 9 節）。
// 切り替えると、main が今の Claude Code を止めて、もう片方（チャットは stream-json、ターミナルモードは TUI）で --resume する。
// 裏のタスクは止まるので、動いていれば確かめる。チャットに戻すときは、TUI の入力欄の書きかけが消えることを確かめる
// （画面を読まないので、書きかけがあるかは分からない）。切り替えられなければ、わけを出す
export async function switchTerminalMode(session: SessionSummary, tasksRunning: boolean): Promise<void> {
  const on = !session.terminal;
  if (tasksRunning && !window.confirm(t('chat.pane.terminalStopsTasks'))) return;
  if (!on && !window.confirm(t('chat.pane.leaveTerminal'))) return;
  try {
    await window.tanacode.sessions.setTerminalMode(session.id, on, { stopTasks: tasksRunning });
  } catch (error) {
    window.alert(t('chat.pane.terminalFailed', { error: errorMessage(error) }));
  }
}
