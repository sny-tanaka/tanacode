import { Fragment, type ReactNode } from 'react';
import { message, type MessageKey } from '@shared/i18n';

// 文言の途中に部品（リンク・強調・コードなど）を埋め込む。文言の {name} を parts の部品に置き換える。
// 例: tx('preview.hint', { key: <kbd>⌘R</kbd> })（文言は「{key} で読み込み直す」）。parts.count が 1 なら単数形を使う
export function tx(key: MessageKey, parts: Record<string, ReactNode>): ReactNode {
  return message(key, parts.count)
    .split(/(\{\w+\})/)
    .map((piece, i) => {
      const name = /^\{(\w+)\}$/.exec(piece)?.[1];
      return name !== undefined && name in parts ? <Fragment key={i}>{parts[name]}</Fragment> : piece;
    });
}
