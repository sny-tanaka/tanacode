import { useState } from 'react';
import { t } from '@shared/i18n';
import { errorMessage } from '../errorMessage';
import type { EditorHandle } from './EditorPane';

// 「保存して移る」の保存。エディタが閉じていたら（ダイアログを出している間に外れた）保存できないので、失敗にして移らない。
// 保存しても残ったもの（ディスク側でも変わっていたので書かなかった）があるときも、移るとその変更が消えるので、失敗にして移らない
export async function saveForLeaving(editor: EditorHandle | null): Promise<void> {
  if (!editor) throw new Error(t('editor.unsaved.editorClosed'));
  await editor.saveAll();
  const left = editor.unsaved();
  if (left.length > 0) throw new Error(t('editor.unsaved.changedOnDisk', { files: left.join(t('main.format.listSeparator')) }));
}

// 別のフォルダへ移る（エディタを作り直す）前の確認。エディタに保存していない変更があるときだけ出す。
// 保存して移る・保存せずに移る・やめる（移らない）の 3 つから選ぶ。files: 保存していないファイル（タブの順）。
// conflicts: そのうちディスク側でも変わったもの（衝突中）。分けて示し、あるうちは「保存して移る」を押せない（エディタで、どちらを残すか選ばせる）
export function UnsavedDialog({
  files,
  conflicts = [],
  onSave,
  onDiscard,
  onCancel,
}: {
  files: string[];
  conflicts?: string[];
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
          <h2>{t('editor.unsaved.title', { count: files.length + conflicts.length })}</h2>
          <p>{t('editor.unsaved.about')}</p>
        </div>
        <div className="worktree-dialog-body">
          {files.length > 0 && <FileList paths={files} />}
          {conflicts.length > 0 && (
            <>
              <p className="worktree-dialog-status warn">{t('editor.unsaved.conflictNote')}</p>
              <FileList paths={conflicts} />
            </>
          )}
        </div>
        <div className="worktree-dialog-foot">
          <button className="ghost-button" disabled={saving} onClick={cancel}>
            {t('editor.unsaved.cancel')}
          </button>
          <div className="spacer" />
          <button className="ghost-button danger" disabled={saving} onClick={onDiscard}>
            {t('editor.unsaved.discard')}
          </button>
          <button className="send-button" disabled={saving || conflicts.length > 0} onClick={() => void save()} autoFocus>
            {saving ? t('editor.unsaved.saving') : t('editor.unsaved.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function FileList({ paths }: { paths: string[] }) {
  return (
    <ul className="worktree-leftovers">
      {paths.map((path) => (
        <li key={path}>
          <code>{path}</code>
        </li>
      ))}
    </ul>
  );
}
