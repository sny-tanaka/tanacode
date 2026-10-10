import { t } from '@shared/i18n';
import { formatScheduleTime, type ScheduledMessage } from '@shared/scheduled';
import type { Menu } from '@shared/screen';

// 通知の本文に出す長さ（これを超えたら切る）
const MAX_LENGTH = 100;

// 通知に出す短い文にする。改行と Markdown の印（`・*・#）を外して 1 行にし、長ければ切る
export function snippet(text: string): string {
  const flat = text.replace(/[`*#]/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LENGTH ? `${flat.slice(0, MAX_LENGTH)}…` : flat;
}

// 確認待ちの通知の本文。質問は質問文、許可は実行しようとしている内容（チャットの確認カードの上の補足）、
// それ以外は画面の見出し。読み取れなかったときは、種類だけを伝える。
// 許可の補足のうち Claude Code の使い方の案内（「Tip: auto mode handles these prompts …」）は、実行する内容ではないので除く
// （長い案内が先にあると、本文の長さの上限で実行するコマンドが切れてしまう）
export function menuNotice(menu: Menu): string {
  if (menu.kind === 'question') return snippet(menu.title) || t('main.notification.question');
  if (menu.kind === 'permission') {
    const detail = snippet(menu.context.filter((line) => !/^Tip:/.test(line)).join(' '));
    return detail ? t('main.notification.permission', { detail }) : t('main.notification.permissionNoDetail');
  }
  const title = snippet(menu.title);
  return title ? t('main.notification.confirm', { title }) : t('main.notification.confirmNoTitle');
}

// 予約したメッセージを送れなかった・時刻に送れなかったときの通知の本文
export function scheduledNotice(message: ScheduledMessage, now: Date = new Date()): string {
  const text = snippet(message.text) || t('main.notification.images', { count: message.attachments.length });
  if (message.state === 'missed') return t('main.notification.scheduledMissed', { time: formatScheduleTime(message.at, now), text });
  return t('main.notification.scheduledFailed', { reason: message.error ?? t('main.notification.unknownReason'), text });
}
