import { useState } from 'react';
import { LIST_KINDS, type ListKind } from '@shared/checklist';
import { t } from '@shared/i18n';

const KIND_LABELS = { normal: 'checklist.listForm.kindNormal', review: 'checklist.listForm.kindReview', decisions: 'checklist.listForm.kindDecisions', state: 'checklist.listForm.kindState' } as const;

// リストを作る・名前と説明と種類を変えるフォーム（サイドパネルの中）。種類を変えられるのは人だけ（Claude は作るときに決める）
export function ListForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; description: string; kind: ListKind };
  submitLabel: string;
  onSubmit: (name: string, description: string, kind: ListKind) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [kind, setKind] = useState<ListKind>(initial.kind);
  const submit = () => {
    if (name.trim()) void onSubmit(name.trim(), description.trim(), kind);
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
      <label className="checklist-form-kind">
        {t('checklist.listForm.kind')}
        <select value={kind} onChange={(e) => setKind(e.target.value as ListKind)}>
          {LIST_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(KIND_LABELS[k])}
            </option>
          ))}
        </select>
      </label>
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
