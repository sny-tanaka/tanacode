import { useState } from 'react';
import { t } from '@shared/i18n';

// リストを作る・名前と説明を変えるフォーム（サイドパネルの中）
export function ListForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; description: string };
  submitLabel: string;
  onSubmit: (name: string, description: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const submit = () => {
    if (name.trim()) void onSubmit(name.trim(), description.trim());
  };
  return (
    <form
      className="checklist-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter' && e.metaKey) submit();
      }}
    >
      <input autoFocus placeholder={t('checklist.listForm.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        rows={3}
        placeholder={t('checklist.listForm.descriptionPlaceholder')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="checklist-form-foot">
        <button type="button" className="ghost-button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="send-button" disabled={!name.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
