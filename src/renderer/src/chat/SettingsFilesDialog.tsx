import { useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import type { SettingsFile } from '@shared/settings-file';
import { errorMessage } from '../errorMessage';
import { AddIcon, CloseIcon, IconButton, TrashIcon } from '../icons';
import { useSettingsFiles } from './settingsFiles';

// 登録した設定ファイルの管理。登録・名前の変更・登録から外す（ファイル自体は触らない）
export function SettingsFilesDialog({ onClose }: { onClose: () => void }) {
  const files = useSettingsFiles();
  const [picking, setPicking] = useState(false);
  // 追加した行の名前の入力にフォーカスを移す。一覧が届くのは追加の返事の前後どちらもありうるので、行が現れるのを待つ
  const [focusId, setFocusId] = useState<string | null>(null);
  const nameInputs = useRef(new Map<string, HTMLInputElement>());
  // Escape で閉じるには、ダイアログの中にフォーカスが要る。閉じたら、開く前にいた場所（選択欄など）に戻す
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  useEffect(() => {
    const input = focusId ? nameInputs.current.get(focusId) : undefined;
    if (!input) return;
    input.focus();
    input.select();
    setFocusId(null);
  }, [focusId, files]);

  // 名前を直している途中なら、閉じる前に確定させる（入力欄が消えると blur が届かない）
  const close = () => {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    onClose();
  };

  const add = async () => {
    setPicking(true);
    try {
      const path = await window.tanacode.settingsFiles.pick();
      if (!path) return;
      const file = await window.tanacode.settingsFiles.add(path);
      setFocusId(file.id);
    } catch (error) {
      window.alert(t('settingsFiles.dialog.addFailed', { error: errorMessage(error) }));
    } finally {
      setPicking(false);
    }
  };

  const remove = async (file: SettingsFile) => {
    // 使っているセッションは、次に起動するときに理由を出して断られる
    const sessions = await window.tanacode.sessions.list();
    const used = Array.isArray(sessions) ? sessions.filter((s) => s.settingsFile === file.id).length : 0;
    const note = used > 0 ? `\n${t('settingsFiles.dialog.usedBy', { count: used })}` : '';
    if (!window.confirm(t('settingsFiles.dialog.removeConfirm', { name: file.name }) + note)) return;
    try {
      await window.tanacode.settingsFiles.remove(file.id);
    } catch (error) {
      window.alert(t('settingsFiles.dialog.removeFailed', { error: errorMessage(error) }));
    }
    // 押した「削除」ごと行が消えて、フォーカスが外れる
    dialog.current?.focus();
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="quick-open settings-files-dialog"
        ref={dialog}
        role="dialog"
        aria-label={t('settingsFiles.dialog.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') close();
        }}
      >
        <div className="settings-files-head">
          <h2>{t('settingsFiles.dialog.title')}</h2>
          <p>{t('settingsFiles.dialog.description')}</p>
        </div>
        <div className="quick-open-list">
          {files.length === 0 && <div className="quick-open-empty">{t('settingsFiles.dialog.empty')}</div>}
          {files.map((file) => (
            <SettingsFileRow
              key={file.id}
              file={file}
              registerInput={(input) => {
                if (input) nameInputs.current.set(file.id, input);
                else nameInputs.current.delete(file.id);
              }}
              onRemove={() => void remove(file)}
            />
          ))}
        </div>
        <div className="settings-files-foot">
          <IconButton icon={AddIcon} label={t('common.add')} tip={t('settingsFiles.dialog.addTip')} disabled={picking} onClick={() => void add()} />
          <IconButton icon={CloseIcon} label={t('common.close')} tip={t('settingsFiles.dialog.closeTip')} onClick={close} />
        </div>
      </div>
    </div>
  );
}

function SettingsFileRow({
  file,
  registerInput,
  onRemove,
}: {
  file: SettingsFile;
  registerInput: (input: HTMLInputElement | null) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(file.name);
  // 名前は main が決めて返す（空白を除くなど）ので、届いた名前が変わったら合わせる。
  // useEffect で合わせると、表示したあとに遅れて走り、打ち始めた名前を元に戻してしまうことがあるので、描くときに変わったかを見る
  const [shownName, setShownName] = useState(file.name);
  if (file.name !== shownName) {
    setShownName(file.name);
    setName(file.name);
  }

  // Escape で戻したときは、続く blur で確定しない
  const cancelled = useRef(false);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (name === file.name) return;
    window.tanacode.settingsFiles.rename(file.id, name).catch((error: unknown) => {
      setName(file.name);
      window.alert(t('settingsFiles.dialog.renameFailed', { error: errorMessage(error) }));
    });
  };

  return (
    <div className="settings-file-row">
      <div className="settings-file-body">
        <input
          ref={registerInput}
          className="settings-file-name"
          value={name}
          spellCheck={false}
          title={t('settingsFiles.dialog.renameTip')}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              // ダイアログは閉じず、名前を戻すだけ
              e.stopPropagation();
              cancelled.current = true;
              setName(file.name);
              e.currentTarget.blur();
            }
          }}
        />
        <span className="settings-file-path" title={file.path}>
          {file.path.replace(/^\/Users\/[^/]+/, '~')}
        </span>
        {file.error !== null && <span className="settings-file-error">{file.error}</span>}
      </div>
      <IconButton size="sm" icon={TrashIcon} label={t('settingsFiles.dialog.remove')} tip={t('settingsFiles.dialog.removeTip')} onClick={onRemove} />
    </div>
  );
}
