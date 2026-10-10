import { t } from '@shared/i18n';
import type { Walkthrough } from '@shared/walkthrough';
import { shownStep, stepLocation } from '@shared/walkthrough';
import { CloseIcon, IconButton } from '../icons';

// ウォークスルーの間に、人が自分で別のファイルや画面を開いたときに、エディタの場所の上に出す帯。
// Claude が次の場所を示しても画面は動かさず、ここから戻る
export function WalkthroughBand({ walkthrough, onShow, onClose }: { walkthrough: Walkthrough; onShow: () => void; onClose: () => void }) {
  const step = shownStep(walkthrough);
  const where = walkthrough.aside
    ? t('walkthrough.band.aside', { location: stepLocation(step) })
    : t('walkthrough.band.progress', { step: walkthrough.current + 1, total: walkthrough.steps.length, title: step.title });
  return (
    <div className="walk-band">
      <span className="walk-band-dot" />
      <span className="walk-band-text">{where}</span>
      <button className="ghost-button" onClick={onShow}>
        {t('walkthrough.band.backToClaude')}
      </button>
      <IconButton size="sm" icon={CloseIcon} label={t('walkthrough.actions.close')} onClick={onClose} />
    </div>
  );
}
