import type { Author } from '@shared/checklist';
import { t } from '@shared/i18n';
import { CheckIcon } from '../icons';

// カードのチェック欄。押すと付け外しする（行を押したときの動き＝カードを開く、にはしない）。
// Claude が付けたチェックは、色を変えて見分けられるようにする
export function CardCheck({ checked, by, onToggle, size = 'sm' }: { checked: boolean; by?: Author; onToggle: () => void; size?: 'sm' | 'md' }) {
  const label = checked
    ? t(by === 'claude' ? 'checklist.check.uncheckByClaude' : by === 'human' ? 'checklist.check.uncheckByHuman' : 'checklist.check.uncheck')
    : t('checklist.check.check');
  return (
    <button
      type="button"
      className={`card-check ${size}${checked ? ' on' : ''}${checked && by === 'claude' ? ' by-claude' : ''}`}
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-tip={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {checked && <CheckIcon size={size === 'sm' ? 12 : 14} />}
    </button>
  );
}
