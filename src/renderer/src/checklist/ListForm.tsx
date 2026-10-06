import { useState } from 'react';

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
      <input autoFocus placeholder="名前（例: やること・完了前チェック・確認事項）" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        rows={3}
        placeholder="使い方のルール（例: 作業を終える前に、すべて満たされているか確かめる）。Claude はリストを読むたびに、これを読んで従います"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="checklist-form-foot">
        <button type="button" className="ghost-button" onClick={onCancel}>
          キャンセル
        </button>
        <button type="submit" className="send-button" disabled={!name.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
