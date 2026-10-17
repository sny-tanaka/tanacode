import { useState } from 'react';
import { t } from '@shared/i18n';
import { errorMessage } from '../errorMessage';

// 別のフォルダへ移る（エディタを作り直す）前の確認。エディタに保存していない変更があるときだけ出す。
// 保存して移る・保存せずに移る・やめる（移らない）の 3 つから選ぶ。files: 保存していないファイル（タブの順）
export function UnsavedDialog({
  files,
  onSave,
  onDiscard,
  onCancel,
}: {
  files: string[];
  // 保存し終えたら移る。保存できなければ理由を出し、ダイアログは開いたまま（移らない）
  onSave: () => Promise<void>;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave();
    } catch (error) {
      window.alert(t('editor.unsaved.saveFailed', { error: errorMessage(error) }));
      setSaving(false);
    }
  };

  const cancel = () => {
    if (!saving) onCancel();
  };

  return (
    <div className="overlay" onMouseDown={cancel}>
      <div
        className="quick-open worktree-dialog"
        role="dialog"
        aria-label={t('editor.unsaved.label')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') cancel();
        }}
      >
        <div className="worktree-dialog-head">
          <h2>{t('editor.unsaved.title', { count: files.length })}</h2>
          <p>{t('editor.unsaved.about')}</p>
        </div>
        <div className="worktree-dialog-body">
          <ul className="worktree-leftovers">
            {files.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </div>
        <div className="worktree-dialog-foot">
          <button className="ghost-button" disabled={saving} onClick={cancel}>
            {t('editor.unsaved.cancel')}
          </button>
          <div className="spacer" />
          <button className="ghost-button danger" disabled={saving} onClick={onDiscard}>
            {t('editor.unsaved.discard')}
          </button>
          <button className="send-button" disabled={saving} onClick={() => void save()} autoFocus>
            {saving ? t('editor.unsaved.saving') : t('editor.unsaved.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
