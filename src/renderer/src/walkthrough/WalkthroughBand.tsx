import type { Walkthrough } from '@shared/walkthrough';
import { shownStep, stepLocation } from '@shared/walkthrough';
import { CloseIcon, IconButton } from '../icons';

// ウォークスルーの間に、人が自分で別のファイルや画面を開いたときに、エディタの場所の上に出す帯。
// Claude が次の場所を示しても画面は動かさず、ここから戻る
export function WalkthroughBand({ walkthrough, onShow, onEnd }: { walkthrough: Walkthrough; onShow: () => void; onEnd: () => void }) {
  const step = shownStep(walkthrough);
  const where = walkthrough.aside
    ? `寄り道 · ${stepLocation(step)}`
    : `ウォークスルー ${walkthrough.current + 1}/${walkthrough.steps.length}「${step.title}」`;
  return (
    <div className="walk-band">
      <span className="walk-band-dot" />
      <span className="walk-band-text">{where}</span>
      <button className="ghost-button" onClick={onShow}>
        Claude が示している場所へ戻る
      </button>
      <IconButton size="sm" icon={CloseIcon} label="ウォークスルーを終える" onClick={onEnd} />
    </div>
  );
}
