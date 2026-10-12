import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@shared/i18n';
import { CloseIcon, IconButton } from '../icons';

// 札に出す冒頭の文字数（はみ出す分は CSS でも省く）
const HEAD_CHARS = 60;

// 入力欄に貼り付けた長い文（札）。Claude Code の CLI が、長い貼り付けを [Pasted text #1 +30 lines] の目印にするのと同じ。
// 冒頭の文字と行数を出し、押すと中身を確かめられる。onRemove があれば × で外せる（入力欄）。
// 送った発言・送る前の発言（起動待ち・順番待ち・予約）にも、同じ札で出す
export function PastedChips({ pastes, onRemove }: { pastes: string[]; onRemove?: (index: number) => void }) {
  const [shown, setShown] = useState<number | null>(null);
  if (pastes.length === 0) return null;
  const open = shown !== null ? pastes[shown] : undefined;
  return (
    <span className="attachments pasted-chips">
      {pastes.map((text, i) => (
        // 同じ文を 2 回貼ることもあるので、並びの位置で見分ける
        <span key={i} className="attachment paste-chip">
          <button type="button" className="paste-chip-open" data-tip={t('composer.paste.showTip')} onClick={() => setShown(i)}>
            <span className="paste-chip-head">{headOf(text)}</span>
            <span className="paste-chip-lines">{t('composer.paste.lines', { count: text.split('\n').length })}</span>
          </button>
          {onRemove && <IconButton size="sm" icon={CloseIcon} label={t('composer.input.remove')} onClick={() => onRemove(i)} />}
        </span>
      ))}
      {open !== undefined && <PastedDialog text={open} onClose={() => setShown(null)} />}
    </span>
  );
}

// 最初の、空でない行
function headOf(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.trim().slice(0, HEAD_CHARS);
}

// 札の中身。チャットの行の中からも開くので、body に出す
function PastedDialog({ text, onClose }: { text: string; onClose: () => void }) {
  // Escape で閉じるには、ダイアログの中にフォーカスが要る。閉じたら、開く前にいた場所に戻す
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);
  return createPortal(
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="quick-open pasted-dialog"
        ref={dialog}
        role="dialog"
        aria-label={t('composer.paste.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          onClose();
        }}
      >
        <div className="pasted-dialog-head">
          <h2>{t('composer.paste.title')}</h2>
          <span>{t('composer.paste.lines', { count: text.split('\n').length })}</span>
        </div>
        <pre className="pasted-dialog-text">{text}</pre>
        <div className="settings-files-foot">
          <IconButton icon={CloseIcon} label={t('common.close')} onClick={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
