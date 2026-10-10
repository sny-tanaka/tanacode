import { t } from '@shared/i18n';
import { lineRange, type Walkthrough } from '@shared/walkthrough';
import { ExportIcon, IconButton } from '../icons';

// ソース管理パネルの「ウォークスルー」。ステップを順に並べ、押すとそのステップをエディタ（か差分）で開く。
// 閉じたウォークスルーも、Claude が作り直すまではここから、もう一度見られる
export type WalkthroughListProps = {
  walkthrough: Walkthrough;
  onGo: (index: number) => void;
  onPublish: () => void;
};

export function WalkthroughList({ walkthrough, onGo, onPublish }: WalkthroughListProps) {
  const { steps, current, open, aside, visited } = walkthrough;
  return (
    <div className="review-comments walk-list">
      <div className="review-comments-head">
        <span className="walk-list-label">{t('walkthrough.list.label')}</span>
        <span className="scm-count">{steps.length}</span>
        <span className="walk-list-title" title={walkthrough.title}>
          {walkthrough.title}
        </span>
        <IconButton size="sm" icon={ExportIcon} label={t('walkthrough.actions.publish')} onClick={onPublish} />
      </div>
      {steps.map((s, i) => {
        const here = open && !aside && i === current;
        return (
          <button key={i} className={`walk-list-step${here ? ' active' : ''}`} onClick={() => onGo(i)} aria-current={here ? 'step' : undefined}>
            <span className="walk-list-number">{i + 1}</span>
            <span className="walk-list-body">
              <span className="walk-list-step-title">{s.title}</span>
              <span className="walk-list-where">
                {s.path}:{lineRange(s)}
              </span>
            </span>
            {visited.includes(i) && !here && <span className="walk-list-seen">{t('walkthrough.list.seen')}</span>}
          </button>
        );
      })}
      <div className="review-hint">
        {open ? t('walkthrough.list.hintOpen') : t('walkthrough.list.hintClosed')}
      </div>
    </div>
  );
}
